import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { speechCapabilities, transcribeSpeech, MAX_AUDIO_BYTES } from './tango-speech.mjs';
import { createAssistant, MAX_CHAT_BYTES } from './ai-assistant.mjs';
import { createDiscovery } from './ai-discovery.mjs';
import { loadAssistantConfig } from './assistant-config.mjs';

const root = fileURLToPath(new URL('../web/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
export function createTangoServer(options = {}) {
 const getSpeechCapabilities = options.speechCapabilities || speechCapabilities;
 const assistant = options.assistant || createAssistant();
 const discovery = options.discovery || createDiscovery();
 const server = createServer(async (req, res) => {
  let apiRequest = false;
  const send = (status, data) => {
    if (data.error) data = { ...data, code: 'TANGO_' + data.error.toUpperCase().replace(/-/g, '_') };
    if (!res.destroyed) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
  };
  try {
    const url = new URL(req.url, 'http://127.0.0.1'), pathname = decodeURIComponent(url.pathname);
    if (pathname === '/api/status' || pathname === '/api/speech' || pathname === '/api/speech/transcribe' || pathname.startsWith('/api/assistant/') || pathname === '/api/discovery') {
      apiRequest = true;
      const port = server.address()?.port;
      const allowedHost = req.headers.host === 'localhost:' + port || req.headers.host === '127.0.0.1:' + port;
      if (!allowedHost || (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) { send(403, { error: 'origin-rejected' }); return; }
      if (pathname.startsWith('/api/assistant/') || pathname === '/api/discovery') {
        if (pathname === '/api/assistant/config') {
          if (req.method !== 'GET') { send(405, { error: 'method-rejected' }); return; }
          if (url.search) { send(400, { error: 'ai-input-invalid' }); return; }
          send(200, assistant.configuration()); return;
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
        const abort = new AbortController(); res.once('close', () => { if (!res.writableEnded) abort.abort(); });
        try { send(200, await assistant.chat(input, abort.signal)); }
        catch (error) {
          const codes = ['TANGO_AI_INPUT_INVALID', 'TANGO_AI_NOT_CONFIGURED', 'TANGO_AI_BUSY', 'TANGO_AI_TIMEOUT', 'TANGO_AI_ABORTED', 'TANGO_AI_UPSTREAM_FAILED', 'TANGO_AI_RESPONSE_TOO_LARGE', 'TANGO_AI_RESPONSE_INVALID'];
          const code = codes.includes(error.code) ? error.code : 'TANGO_AI_UPSTREAM_FAILED';
          const status = { TANGO_AI_INPUT_INVALID: 400, TANGO_AI_NOT_CONFIGURED: 503, TANGO_AI_BUSY: 429, TANGO_AI_TIMEOUT: 504, TANGO_AI_ABORTED: 499 }[code] || 502;
          send(status, { error: code.slice(6).toLowerCase().replace(/_/g, '-') });
        }
        return;
      }
      if (pathname === '/api/status') {
        if (req.method !== 'GET') { send(405, { error: 'method-rejected' }); return; }
        const speech = await getSpeechCapabilities();
        send(200, { app: 'Tango', version: '0.1.0-local', runtime: 'web-local', status: 'ok', speech: { available: speech.available === true, languages: Array.isArray(speech.languages) ? speech.languages.filter(language => typeof language === 'string' && /^[a-z]{2}-[A-Z]{2}$/.test(language)) : [] } });
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
    res.writeHead(200, { 'Content-Type': types[extension] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch {
    if (apiRequest) send(503, { error: 'service-unavailable' });
    else if (!res.destroyed) res.writeHead(404).end();
  }
 });
 return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bind = process.env.TANGO_BIND === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
  const port = Number.isInteger(Number(process.env.TANGO_PORT)) && Number(process.env.TANGO_PORT) > 0 ? Number(process.env.TANGO_PORT) : 5207;
  let config;
  try { config = await loadAssistantConfig({ projectRoot: fileURLToPath(new URL('../', import.meta.url)) }); }
  catch { config = {}; process.stderr.write('TANGO_AI_CONFIG_INVALID: assistant disabled; check local configuration.\n'); }
  createTangoServer({ assistant: createAssistant({ config }) }).listen(port, bind, () => process.stdout.write('Tango local server: http://127.0.0.1:' + port + '\n'));
}
