import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { resolve, sep, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { speechCapabilities, transcribeSpeech, MAX_AUDIO_BYTES } from './tango-speech.mjs';
import { assistantError, createAssistant, MAX_CHAT_BYTES } from './ai-assistant.mjs';
import { createDiscovery } from './ai-discovery.mjs';
import { applyDotEnv, loadAssistantConfig, saveAssistantMetadata } from './assistant-config.mjs';
import { createCollaborationService } from './collaboration-service.mjs';
import { createVersionSwitch } from './version-switch.mjs';

const root = fileURLToPath(new URL('../web/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
const AI_ERROR_CODES = ['TANGO_AI_INPUT_INVALID', 'TANGO_AI_NOT_CONFIGURED', 'TANGO_AI_BUSY', 'TANGO_AI_TIMEOUT', 'TANGO_AI_ABORTED', 'TANGO_AI_UPSTREAM_FAILED', 'TANGO_AI_RESPONSE_TOO_LARGE', 'TANGO_AI_RESPONSE_INVALID', 'TANGO_AI_MODE_DISABLED', 'TANGO_AI_RATE_LIMITED', 'TANGO_AI_DAILY_LIMIT', 'TANGO_AI_VISITOR_DAILY_LIMIT', 'TANGO_AI_INPUT_TOO_LONG'];
const AI_ERROR_STATUS = { TANGO_AI_INPUT_INVALID: 400, TANGO_AI_NOT_CONFIGURED: 503, TANGO_AI_BUSY: 429, TANGO_AI_TIMEOUT: 504, TANGO_AI_ABORTED: 499, TANGO_AI_MODE_DISABLED: 400, TANGO_AI_RATE_LIMITED: 429, TANGO_AI_DAILY_LIMIT: 429, TANGO_AI_VISITOR_DAILY_LIMIT: 429, TANGO_AI_INPUT_TOO_LONG: 413 };
const AI_ERROR_MESSAGE = { TANGO_AI_MODE_DISABLED: '该 AI 功能未开放', TANGO_AI_RATE_LIMITED: '访问过于频繁，请稍后再试', TANGO_AI_DAILY_LIMIT: '今日体验额度已用完', TANGO_AI_VISITOR_DAILY_LIMIT: '今日体验额度已用完', TANGO_AI_INPUT_TOO_LONG: '输入内容过长，请精简后重试' };
function aiFailure(error) {
  const code = AI_ERROR_CODES.includes(error?.code) ? error.code : 'TANGO_AI_UPSTREAM_FAILED';
  const message = AI_ERROR_MESSAGE[code];
  return { status: AI_ERROR_STATUS[code] || 502, error: code.slice(6).toLowerCase().replace(/_/g, '-'), ...(message ? { message } : {}) };
}
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt']);
export function createAIGuard(options = {}) {
 const env = options.env || process.env;
 const flag = value => { const text = typeof value === 'string' ? value.trim().toLowerCase() : ''; return text === '1' || text === 'true'; };
 const positive = (value, fallback) => { const num = Number(value); return Number.isInteger(num) && num > 0 ? num : fallback; };
 const features = { parse: flag(env.TANGO_AI_PARSE), prompts: flag(env.TANGO_AI_PROMPTS) };
 const dailyLimit = positive(env.TANGO_AI_DAILY_LIMIT, 500);
 const visitorDailyLimit = positive(env.TANGO_AI_VISITOR_DAILY_LIMIT, 30);
 const userDailyLimit = positive(env.TANGO_AI_USER_DAILY_LIMIT, 200);
 const minuteLimit = positive(env.TANGO_AI_RATE_LIMIT, 60);
 const now = options.now || Date.now;
 let dayKey = '', dayCount = 0;
 const windows = new Map();
 const visitorDaily = new Map();
 const dayStamp = time => { const date = new Date(time); return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0'); };
 const visitorKey = req => {
  const remote = req.socket?.remoteAddress || 'unknown';
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
   const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(part => part.trim()).filter(Boolean).pop();
   if (forwarded) return forwarded.slice(0, 64);
  }
  return remote;
 };
 // D23: per-day AI budgets — anonymous visitors by IP (30), each signed-in
 // account by id (200, so one account cannot drain the global budget). The
 // global in-memory daily budget above keeps its own TANGO_AI_DAILY_LIMIT code.
 const visitorDailyKeys = (req, actor) => (actor?.id ? [['user:' + String(actor.id).slice(0, 64), userDailyLimit]] : [['ip:' + visitorKey(req), visitorDailyLimit]]);
 function check(req, actor, mode) {
  if (mode === 'parse' && !features.parse) throw assistantError('TANGO_AI_MODE_DISABLED', 400);
  if (mode === 'prompt' && !features.prompts) throw assistantError('TANGO_AI_MODE_DISABLED', 400);
  const time = now(), day = dayStamp(time);
  if (day !== dayKey) { dayKey = day; dayCount = 0; }
  if (dayCount >= dailyLimit) throw assistantError('TANGO_AI_DAILY_LIMIT', 429);
  const dailyKeys = visitorDailyKeys(req, actor);
  for (const [name, limit] of dailyKeys) { const slot = visitorDaily.get(name); if (slot && slot.day === day && slot.count >= limit) throw assistantError('TANGO_AI_VISITOR_DAILY_LIMIT', 429); }
  const key = (actor?.id ? 'user:' + String(actor.id) : visitorKey(req)).slice(0, 80);
  const window = Math.floor(time / 60000);
  const slot = windows.get(key);
  if (!slot || slot.window !== window) {
   if (windows.size > 4096) for (const [name, value] of windows) if (value.window !== window) windows.delete(name);
   windows.set(key, { window, count: 1 });
  } else if (slot.count >= minuteLimit) throw assistantError('TANGO_AI_RATE_LIMITED', 429);
  else slot.count++;
  dayCount++;
  if (dailyKeys.length) {
   if (visitorDaily.size > 16384) for (const [name, value] of visitorDaily) if (value.day !== day) visitorDaily.delete(name);
   for (const [name] of dailyKeys) { const slot = visitorDaily.get(name); if (!slot || slot.day !== day) visitorDaily.set(name, { day, count: 1 }); else slot.count++; }
  }
 }
 return { features: () => ({ ...features }), check };
}
export function createTangoServer(options = {}) {
 const getSpeechCapabilities = options.speechCapabilities || speechCapabilities;
 const assistant = options.assistant || createAssistant();
 const discovery = options.discovery || createDiscovery();
 const aiGuard = options.aiGuard || createAIGuard();
 // S2D-W13 · M18：agentic 集成路由挂载件（可注入；无配置时 legacy 行为不变）。
 // 形状同 options.collaboration.handle 先例（下方 collaboration 分支）：
 // { handle(req,res,pathname) } —— 即 M14 createAgenticDispatcher() 的返回值；
 // 真值=已处理（响应已写完），falsy=未处理（body 未读、响应未触碰）→ 原样落回
 // legacy 流程。接线错误在构造期就炸，不等到第一个请求。
 if (options.agentic && typeof options.agentic.handle !== 'function') throw new Error('options.agentic must expose handle(req,res,pathname) — the M14 dispatcher mount shape');
 const versionSwitch = options.nextPort ? createVersionSwitch({ nextPort: options.nextPort, secure: !!options.collaboration?.publicOrigin }) : null;
 const server = createServer(async (req, res) => {
  if (versionSwitch && versionSwitch.handle(req, res)) return;
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"frame-ancestors 'self'; base-uri 'self'; object-src 'none'");
  if(options.collaboration?.publicOrigin)res.setHeader('Strict-Transport-Security','max-age=31536000');
  let apiRequest = false;
  const send = (status, data) => {
    if (data.error) data = { ...data, code: 'TANGO_' + data.error.toUpperCase().replace(/-/g, '_') };
    if (!res.destroyed) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
  };
  try {
    const url = new URL(req.url, 'http://127.0.0.1'), pathname = decodeURIComponent(url.pathname);
    // S2D-W13 · M18：/api/agentic/ 前缀交注入的 dispatcher 全权处理。置于
    // collaboration /api/ 鉴权块之前：冻结错误信封与 /api/agentic/health 免鉴权
    // 探活（M17/M26 release 检查）不得被 tango 401 抢答；origin 门与既有 API
    // 分支同款（collaboration.requestAllowed / allowedHosts+origin 匹配）。
    // 未处理（falsy）时还原 apiRequest 后落回 legacy——collaboration 鉴权与静态
    // 语义如同本分支未运行。CLI 入口不自动装配：真实 gateway/model 一律由
    // harness/release 显式注入，绝不因环境变量静默启用。
    if (options.agentic && pathname.startsWith('/api/agentic/')) {
      apiRequest = true;
      const address = server.address(), allowedHosts = ['localhost:' + address.port, '127.0.0.1:' + address.port];
      if (isIP(address.address) === 4 && !['127.0.0.1', '0.0.0.0'].includes(address.address)) allowedHosts.push(address.address + ':' + address.port);
      if (options.collaboration ? !options.collaboration.requestAllowed(req) : !allowedHosts.includes(req.headers.host) || req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) { send(403, { error: 'origin-rejected' }); return; }
      const handled = await options.agentic.handle(req, res, pathname);
      if (handled) return;
      apiRequest = false;
    }
    let actor;
    if(options.collaboration&&pathname.startsWith('/api/')){
      apiRequest=true;
      if(!options.collaboration.requestAllowed(req)){send(403,{error:'origin-rejected'});return;}
      if(!pathname.startsWith('/api/auth/')&&pathname!=='/api/status'){
        try{actor=options.collaboration.authenticate(req);}catch(error){send(401,{error:error.code||'AUTH_REQUIRED'});return;}
        if(pathname==='/api/assistant/config'&&req.method==='PUT'&&actor.role!=='admin'){send(403,{error:'ADMIN_REQUIRED'});return;}
        if(pathname==='/api/assistant/chat'||pathname==='/api/speech/transcribe'){
          try{options.collaboration.auth.throttle('paid-user:'+actor.id,30);options.collaboration.auth.throttle('paid-ip:'+(options.collaboration.auth.clientAddress?.(req)||req.socket.remoteAddress),90);}catch{send(429,{error:'rate-limited'});return;}
        }
      }
    }
    if (pathname.startsWith('/api/collaboration') || pathname.startsWith('/api/auth/') || pathname.startsWith('/api/admin/')) {
      apiRequest = true;
      const address = server.address(), allowedHosts = ['localhost:' + address.port, '127.0.0.1:' + address.port];
      if (isIP(address.address) === 4 && !['127.0.0.1', '0.0.0.0'].includes(address.address)) allowedHosts.push(address.address + ':' + address.port);
      if (options.collaboration ? !options.collaboration.requestAllowed(req) : !allowedHosts.includes(req.headers.host) || req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) { send(403, { error: 'origin-rejected' }); return; }
      if (!options.collaboration) { send(503, { error: 'collaboration-unavailable' }); return; }
      await options.collaboration.handle(req, res, pathname); return;
    }
    if (pathname === '/api/status' || pathname === '/api/speech' || pathname === '/api/speech/transcribe' || pathname.startsWith('/api/assistant/') || pathname === '/api/discovery') {
      apiRequest = true;
      const port = server.address()?.port;
      const boundAddress = server.address()?.address;
      const allowedHosts = ['localhost:' + port, '127.0.0.1:' + port];
      if (isIP(boundAddress) === 4 && boundAddress !== '127.0.0.1' && boundAddress !== '0.0.0.0') allowedHosts.push(boundAddress + ':' + port);
      const allowedHost = options.collaboration ? options.collaboration.requestAllowed(req) : allowedHosts.includes(req.headers.host);
      if (!allowedHost || (!options.collaboration && req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) { send(403, { error: 'origin-rejected' }); return; }
      if (pathname.startsWith('/api/assistant/') || pathname === '/api/discovery') {
        if (pathname === '/api/assistant/config') {
          if (url.search) { send(400, { error: 'ai-input-invalid' }); return; }
          if (req.method === 'GET') { send(200, assistant.configuration()); return; }
          if (req.method !== 'PUT') { send(405, { error: 'method-rejected' }); return; }
          if (!options.assistantConfigStore) { send(405, { error: 'method-rejected' }); return; }
          if (!req.headers.origin) { send(403, { error: 'origin-required' }); return; }
          if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { send(415, { error: 'ai-json-required' }); return; }
          if (Number(req.headers['content-length']) > 16384) { send(413, { error: 'ai-body-too-large' }); req.resume(); return; }
          let size = 0; const parts = [];
          for await (const part of req) { size += part.length; if (size > 16384) { send(413, { error: 'ai-body-too-large' }); req.resume(); return; } parts.push(part); }
          let patch; try { patch = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { send(400, { error: 'ai-input-invalid' }); return; }
          try { await options.assistantConfigStore.save(patch); } catch { send(400, { error: 'ai-input-invalid' }); return; }
          send(200, assistant.configuration());
          return;
        }
        if (pathname === '/api/assistant/features') {
          if (url.search) { send(400, { error: 'ai-input-invalid' }); return; }
          if (req.method !== 'GET') { send(405, { error: 'method-rejected' }); return; }
          send(200, aiGuard.features());
          return;
        }
        if (pathname === '/api/discovery') {
          if (req.method !== 'GET') { send(405, { error: 'method-rejected' }); return; }
          const keys = [...url.searchParams.keys()], topic = url.searchParams.get('topic') || 'all';
          if (keys.some(key => key !== 'topic') || keys.length > 1 || !['all', 'research', 'work', 'learning'].includes(topic)) { send(400, { error: 'discovery-topic-invalid' }); return; }
          send(200, await discovery.get(topic)); return;
        }
        if (pathname !== '/api/assistant/chat') { send(404, { error: 'route-not-found' }); return; }
        if (req.method !== 'POST') { send(405, { error: 'method-rejected' }); return; }
        if (!req.headers.origin) { send(403, { error: 'origin-required' }); return; }
        if (url.search) { send(400, { error: 'ai-input-invalid' }); return; }
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { send(415, { error: 'ai-json-required' }); return; }
        if (Number(req.headers['content-length']) > MAX_CHAT_BYTES) { send(413, { error: 'ai-body-too-large' }); req.resume(); return; }
        let size = 0; const parts = [];
        for await (const part of req) { size += part.length; if (size > MAX_CHAT_BYTES) { send(413, { error: 'ai-body-too-large' }); req.resume(); return; } parts.push(part); }
        let input; try { input = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { send(400, { error: 'ai-input-invalid' }); return; }
        try { aiGuard.check(req, actor, typeof input?.mode === 'string' ? input.mode : 'chat'); } catch (error) { const failure = aiFailure(error); send(failure.status, { error: failure.error, ...(failure.message ? { message: failure.message } : {}) }); return; }
        const abort = new AbortController(); res.once('close', () => { if (!res.writableEnded) abort.abort(); });
        if (input && typeof input === 'object' && !Array.isArray(input) && input.stream === true) {
          const iterator = assistant.streamChat(input, abort.signal)[Symbol.asyncIterator]();
          let keepAlive;
          try {
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
            const frame = value => { if (!res.destroyed && res.writable) res.write('data: ' + JSON.stringify({ text: value }) + '\n\n'); };
            res.write('data: {"status":"waiting"}\n\n');
            keepAlive = setInterval(() => { if (!res.destroyed && res.writable) res.write(': keepalive\n\n'); }, 15000);
            keepAlive.unref?.();
            const first = await iterator.next();
            if (first.done || typeof first.value !== 'string') throw assistantError('TANGO_AI_RESPONSE_INVALID');
            frame(first.value);
            for (;;) { const next = await iterator.next(); if (next.done) break; frame(next.value); }
            if (!res.destroyed && res.writable) res.write('data: [DONE]\n\n');
          } catch (error) {
            const failure = aiFailure(error);
            if (!res.headersSent) send(failure.status, { error: failure.error });
            else if (!res.destroyed && res.writable) res.write('data: ' + JSON.stringify({ error: failure.error, ...(failure.message ? { message: failure.message } : {}) }) + '\n\n');
          } finally { clearInterval(keepAlive); if (!res.destroyed) res.end(); }
          return;
        }
        try { send(200, await assistant.chat(input, abort.signal)); }
        catch (error) { const failure = aiFailure(error); send(failure.status, { error: failure.error, ...(failure.message ? { message: failure.message } : {}) }); }
        return;
      }
      if (pathname === '/api/status') {
        if (req.method !== 'GET') { send(405, { error: 'method-rejected' }); return; }
        const speech = await getSpeechCapabilities();
        send(200, { app: 'Tango', version: '0.1.0-local', runtime: 'web-local', status: 'ok', voiceV3: !!options.voiceV3, speech: { available: speech.available === true, languages: Array.isArray(speech.languages) ? speech.languages.filter(language => typeof language === 'string' && /^[a-z]{2}-[A-Z]{2}$/.test(language)) : [] } });
        return;
      }
      if (pathname === '/api/speech' && req.method === 'GET') { send(200, await getSpeechCapabilities()); return; }
      if (pathname !== '/api/speech/transcribe' || req.method !== 'POST') { send(405, { error: 'method-rejected' }); return; }
      if (!req.headers.origin) { send(403, { error: 'origin-required' }); return; }
      if (req.headers['content-type'] !== 'audio/wav') { send(415, { error: 'audio-wav-required' }); return; }
      if (Number(req.headers['content-length']) > MAX_AUDIO_BYTES) { send(413, { error: 'audio-too-large' }); req.resume(); return; }
      const parts = []; let size = 0;
      for await (const part of req) { size += part.length; if (size > MAX_AUDIO_BYTES) { send(413, { error: 'audio-too-large' }); req.resume(); return; } parts.push(part); }
      const abort = new AbortController(); res.on('close', () => { if (!res.writableEnded) abort.abort(); });
      try { send(200, await transcribeSpeech(Buffer.concat(parts), url.searchParams.get('lang') || 'zh-CN', abort.signal)); }
      catch (error) { send(error.status || 503, { error: error.status ? error.message : 'recognition-failed' }); }
      return;
    }
    const target = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!target.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403).end(); return; }
    const body = await readFile(target);
    const extension = target.slice(target.lastIndexOf('.'));
    // 公网经隧道回源，带宽是瓶颈：文本类在源站 gzip（532KB 首页 → 约 1/4）。ponytail: 每次现压约几毫秒，慢了再加缓存
    const gzip = COMPRESSIBLE.has(extension) && body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const payload = gzip ? gzipSync(body) : body;
    res.writeHead(200, { 'Content-Type': types[extension] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': payload.length, ...(gzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) });
    for (let offset = 0; offset < payload.length; offset += 16384) res.write(payload.subarray(offset, offset + 16384));
    res.end();
  } catch {
    if (apiRequest) send(503, { error: 'service-unavailable' });
    else if (!res.destroyed) res.writeHead(404).end();
  }
 });
 const voiceV3 = options.voiceV3 || null;
 if (versionSwitch || voiceV3) server.on('upgrade', (req, socket, head) => {
   if (versionSwitch && versionSwitch.upgrade(req, socket, head)) return; // donego_version=v2 → 新版进程
   if (voiceV3 && (req.url || '').split('?')[0] === voiceV3.path) return voiceV3.handleUpgrade(req, socket, head);
   socket.destroy();
 });
 return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bind = isIP(process.env.TANGO_BIND) ? process.env.TANGO_BIND : '127.0.0.1';
  const port = Number.isInteger(Number(process.env.TANGO_PORT)) && Number(process.env.TANGO_PORT) > 0 ? Number(process.env.TANGO_PORT) : 5207;
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  try { await applyDotEnv({ projectRoot }); } catch { process.stderr.write('TANGO_DOTENV_INVALID: .env could not be read; environment unchanged.\n'); }
  let config;
  try { config = await loadAssistantConfig({ projectRoot }); }
  catch { config = {}; process.stderr.write('TANGO_AI_CONFIG_INVALID: assistant disabled; check local configuration.\n'); }
  let assistant = createAssistant({ config });
  const delegate = { configuration: () => assistant.configuration(), chat: (input, signal) => assistant.chat(input, signal), streamChat: (input, signal) => assistant.streamChat(input, signal) };
  const store = { save: async patch => { await saveAssistantMetadata({ projectRoot, patch }); config = await loadAssistantConfig({ projectRoot }); assistant = createAssistant({ config }); } };
  const configuredDatabase=process.env.AUTH_DATABASE_PATH||process.env.TANGO_AUTH_DB||process.env.TANGO_COLLAB_DB;
  if(configuredDatabase&&configuredDatabase!==':memory:'&&!isAbsolute(configuredDatabase))throw new Error('AUTH_DATABASE_PATH must be absolute');
  const collaboration = await createCollaborationService({ databaseFile: configuredDatabase || join(projectRoot, '.tango-donego', 'collaboration.sqlite'), assistant: delegate });
  // 语音管线 v3：配置了 TANGO_VOICE_MODELS（Mac 本地开发见 Done & Go/dev.sh）才启用；模型启动时预加载
  let voiceV3 = null;
  const voiceModels = process.env.TANGO_VOICE_MODELS;
  if (voiceModels) {
    // 可选能力：动态加载，核心服务不硬依赖 ws / sherpa-onnx-node（发布包与 thinkpad 未装模型时照常启动）
    const { createAsrEngine, modelsAvailable } = await import('./voice-pipeline/asr.mjs');
    const { createVoiceV3Gateway } = await import('./voice-pipeline/gateway.mjs');
    if (modelsAvailable(voiceModels)) {
    const engine = createAsrEngine({ modelsDir: voiceModels, threads: Number(process.env.TANGO_VOICE_THREADS) || 2 });
    engine.then(() => process.stdout.write('voice v3: models loaded\n'), error => process.stderr.write('voice v3: model load failed: ' + error.message + '\n'));
    voiceV3 = createVoiceV3Gateway({ engine, authenticate: req => collaboration.authenticate(req), requestAllowed: req => collaboration.requestAllowed(req), log: entry => process.stdout.write(JSON.stringify(entry) + '\n') });
    } else process.stderr.write('voice v3: TANGO_VOICE_MODELS set but models missing; voice v3 disabled\n');
  }
  createTangoServer({ assistant: delegate, assistantConfigStore: store, collaboration, nextPort: Number(process.env.TANGO_NEXT_PORT) || 0, voiceV3 }).listen(port, bind, () => process.stdout.write('Tango local server: http://' + bind + ':' + port + '\n'));
}
