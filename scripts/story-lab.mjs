#!/usr/bin/env node
// scripts/story-lab.mjs — 时光故事书 lab 独立入口（SPEC design/story-recap/SPEC.md §7）。
//
// T10示例与lab line deliverable. Two jobs:
//
// 1. 静态服务 web/ —— lab.html 及其 import 链（web/story/**、web/relay/contracts.js、
//    scenes.zh.json）全部从本仓库读出；默认只绑 127.0.0.1。
// 2. POST /api/story/polish —— D4 润色代理：前端只送「统计数字行 + 模板基线」，
//    服务端拼提示词经 light 档快速模型（mode 'test'，MODE_TIERS: light）润色；
//    网关 key 只在服务端经 .env 符号链接（-> /home/jc/projects/Done-Go/.env）进入
//    进程环境，绝不出现在响应、日志或前端。输出逐条 ≤24 字（SPEC §5）、含
//    「留白」一律拒绝；任何失败回结构化错误码，前端落回规则模板。
//
// 不新增依赖：node:http + 既有 scripts/ai-assistant.mjs / assistant-config.mjs。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAssistant } from './ai-assistant.mjs';
import { applyDotEnv, loadAssistantConfig } from './assistant-config.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '..');
const webRootDefault = resolve(repoRoot, 'web');

// ---------------------------------------------------------------------------
// /api/story/polish 契约（本文件定义；narrative 线/二期接入时对齐这里）
// ---------------------------------------------------------------------------
export const POLISH_MAX_ITEMS = 8;
export const POLISH_KINDS = ['title', 'panel', 'closing']; // SPEC §5：只润色标题、四格旁白、结语
export const POLISH_TEXT_MAX = 24;    // SPEC §5：每条 ≤ 24 字
export const POLISH_FALLBACK_MAX = 60; // 基线即 contracts.CAPTION_MAX
export const POLISH_CONTEXT_MAX = 200; // 统计数字行（只有数字与类别，无原文）
export const POLISH_BANNED = ['留白']; // JC 红线词，出现即整批拒绝
export const POLISH_BODY_MAX_BYTES = 16 * 1024;

const KIND_LABELS = { title: '标题', panel: '四格旁白', closing: '结语' };

export function parsePolishBody(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (Object.keys(raw).some((key) => key !== 'items')) return null;
  if (!Array.isArray(raw.items) || !raw.items.length || raw.items.length > POLISH_MAX_ITEMS) return null;
  const items = [];
  for (const item of raw.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (Object.keys(item).some((key) => !['kind', 'fallback', 'context'].includes(key))) return null;
    const kind = item.kind;
    if (!POLISH_KINDS.includes(kind)) return null;
    const fallback = typeof item.fallback === 'string' ? item.fallback.trim() : '';
    if (!fallback || fallback.length > POLISH_FALLBACK_MAX) return null;
    const context = item.context == null ? '' : item.context;
    if (typeof context !== 'string' || context.length > POLISH_CONTEXT_MAX) return null;
    items.push({ kind, fallback, context });
  }
  return { items };
}

export function buildPolishPrompt(items) {
  const lines = [
    '【当前任务：润色时光故事书的文案】',
    '下面有 ' + items.length + ' 句已有的模板文案。逐句润色，规则：',
    '1. 只输出润色后的句子，一行一句，共 ' + items.length + ' 行，不加编号、引号或解释；',
    '2. 每句不超过 ' + POLISH_TEXT_MAX + ' 个字；',
    '3. 只使用各句「基线」和「本期数据」里出现的事实与数字，不新增、不夸大、不与他人比较；',
    '4. 不写空泛感叹和说教；中文书面语，句长交错。',
    '',
  ];
  items.forEach((item, index) => {
    lines.push((index + 1) + '.（' + KIND_LABELS[item.kind] + '）基线：' + item.fallback +
      (item.context ? '；本期数据：' + item.context : ''));
  });
  return lines.join('\n');
}

export function parsePolishText(text, count) {
  if (typeof text !== 'string') return null;
  let body = text.trim();
  body = body.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, ''); // 防御性剥代码围栏
  const rows = body.split(/\r?\n/).map((line) => line.trim().replace(/^\d+[.、)]\s*/, '')).filter(Boolean);
  if (rows.length !== count) return null;
  for (const row of rows) {
    if (!row || row.length > POLISH_TEXT_MAX) return null;
    if (POLISH_BANNED.some((word) => row.includes(word))) return null;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 错误映射（对齐 scripts/serve-tango.mjs 的 aiFailure 语义；未导出，这里自带小表）
// ---------------------------------------------------------------------------
const AI_ERROR_STATUS = {
  TANGO_AI_INPUT_INVALID: 400,
  TANGO_AI_NOT_CONFIGURED: 503,
  TANGO_AI_BUSY: 429,
  TANGO_AI_TIMEOUT: 504,
  TANGO_AI_ABORTED: 499,
  TANGO_AI_UPSTREAM_FAILED: 502,
  TANGO_AI_RESPONSE_TOO_LARGE: 502,
  TANGO_AI_RESPONSE_INVALID: 502,
};
const POLISH_INVALID = { error: 'story-polish-invalid' };

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.byteLength;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
};

async function serveStatic(res, webRoot, pathname) {
  const cleanPath = pathname.replace(/\/+$/, '') || '/story/lab.html';
  const target = resolve(webRoot, '.' + decodeURIComponent(cleanPath));
  if (target !== webRoot && !target.startsWith(webRoot + sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  if (!MIME[extname(target)]) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  try {
    const bytes = await readFile(target);
    res.writeHead(200, { 'content-type': MIME[extname(target)], 'cache-control': 'no-store' });
    res.end(bytes);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

// ---------------------------------------------------------------------------
// createStoryLabServer — assistant 可注入（单测用假件；不真连网关）
// ---------------------------------------------------------------------------
export function createStoryLabServer(options = {}) {
  const assistant = options.assistant || null;
  const webRoot = resolve(options.webRoot || webRootDefault);

  async function handlePolish(req, res) {
    if (req.method === 'GET') {
      const configured = !!(assistant && assistant.configuration && assistant.configuration().available);
      sendJson(res, 200, { configured });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }
    if (!assistant || !assistant.configuration || !assistant.configuration().available) {
      sendJson(res, 503, { error: 'tango-ai-not-configured' });
      return;
    }
    let raw;
    try {
      raw = await readBody(req, POLISH_BODY_MAX_BYTES);
    } catch (error) {
      sendJson(res, 413, { error: 'story-polish-too-large' });
      return;
    }
    let parsedBody;
    try {
      parsedBody = JSON.parse(raw || 'null');
    } catch {
      sendJson(res, 400, POLISH_INVALID);
      return;
    }
    const request = parsePolishBody(parsedBody);
    if (!request) {
      sendJson(res, 400, POLISH_INVALID);
      return;
    }
    try {
      const answer = await assistant.chat({ mode: 'test', prompt: buildPolishPrompt(request.items) });
      const text = answer && Array.isArray(answer.content) && answer.content[0] && typeof answer.content[0].text === 'string'
        ? answer.content[0].text
        : null;
      const texts = parsePolishText(text, request.items.length);
      if (!texts) {
        sendJson(res, 502, { error: 'story-polish-invalid' });
        return;
      }
      sendJson(res, 200, { texts });
    } catch (error) {
      const status = AI_ERROR_STATUS[error && error.code] || 502;
      const code = (error && error.code ? error.code : 'TANGO_AI_UPSTREAM_FAILED').toLowerCase().replace(/_/g, '-');
      // 只回错误码，不回上游文本（可能携带网关信息；key 永不出现在这里）
      sendJson(res, status, { error: code });
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    if (pathname === '/api/story/polish') {
      handlePolish(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'story-lab-internal' });
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }
    if (pathname === '/') {
      res.writeHead(302, { location: '/story/lab.html' });
      res.end();
      return;
    }
    serveStatic(res, webRoot, pathname).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('internal');
      }
    });
  });
  return server;
}

// ---------------------------------------------------------------------------
// 网关解析（全部服务端；key 只进 config，不进任何日志/响应）
//   1) 显式 TANGO_AI_PROVIDER/URL/MODEL/KEY（含 .env 符号链接提供的 KEY）优先；
//   2) 否则用本机网关 ~/.config/llm-gateway/endpoint.json 的 openai_base_url
//      （http://127.0.0.1:4000/v1 → …/chat/completions）+ TANGO_AI_KEY（.env）；
//      light 档模型 = TANGO_AI_MODEL_LIGHT || TANGO_AI_MODEL || qwen-flash 网关名。
//   解析不出可用配置 → 返回 null → /api/story/polish 503 → 前端用模板文案。
// ---------------------------------------------------------------------------
export const GATEWAY_LIGHT_MODEL_DEFAULT = 'alicloud-set-2/qwen-flash';

async function readJsonSafe(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function resolveGatewayConfig({ env = process.env, endpointPath } = {}) {
  const explicitUrl = env.TANGO_AI_URL;
  const key = env.TANGO_AI_KEY;
  if (explicitUrl && key && env.TANGO_AI_PROVIDER && env.TANGO_AI_MODEL) {
    return { provider: env.TANGO_AI_PROVIDER, url: env.TANGO_AI_URL, model: env.TANGO_AI_MODEL, key };
  }
  if (!key) return null;
  const path = endpointPath || (env.HOME ? env.HOME + '/.config/llm-gateway/endpoint.json' : null);
  if (!path) return null;
  const endpoint = await readJsonSafe(path);
  const base = endpoint && typeof endpoint.openai_base_url === 'string' ? endpoint.openai_base_url.replace(/\/+$/, '') : null;
  if (!base) return null;
  const model = env.TANGO_AI_MODEL_LIGHT || env.TANGO_AI_MODEL || GATEWAY_LIGHT_MODEL_DEFAULT;
  return { provider: 'openai', url: base + '/chat/completions', model, key };
}

// ---------------------------------------------------------------------------
// CLI：node scripts/story-lab.mjs [--port 17570]
//   .env 符号链接（worktree 根 -> /home/jc/projects/Done-Go/.env）只在服务端读；
//   applyDotEnv 不覆盖已有环境变量；loadAssistantConfig 优先显式 TANGO_AI_*，
//   缺 URL/模型时回退本机网关解析（resolveGatewayConfig）。
// ---------------------------------------------------------------------------
async function loadAssistantFromEnv(env) {
  await applyDotEnv({ projectRoot: repoRoot, env });
  let config;
  try {
    config = await loadAssistantConfig({ projectRoot: repoRoot, env });
  } catch {
    config = undefined;
  }
  if (!config || !config.key || !config.url) config = await resolveGatewayConfig({ env });
  if (!config || !config.key || !config.url) return null;
  const assistant = createAssistant({ env, config });
  return assistant.configuration().available ? assistant : null;
}

export async function main(argv = process.argv.slice(2), io = process) {
  let port = 17570;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port' && Number.isInteger(Number(argv[i + 1]))) port = Number(argv[i + 1]);
  }
  const assistant = await loadAssistantFromEnv(process.env);
  const server = createStoryLabServer({ assistant });
  await new Promise((resolveListen) => server.listen(port, '127.0.0.1', resolveListen));
  io.stdout.write('时光故事书 lab → http://127.0.0.1:' + port + '/story/lab.html\n');
  io.stdout.write('润色代理 /api/story/polish：' + (assistant ? '已配置（key 仅服务端）' : '未配置（前端将使用模板文案）') + '\n');
  return server;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write('story-lab 启动失败：' + (error && error.message ? error.message : error) + '\n');
    process.exit(1);
  });
}
