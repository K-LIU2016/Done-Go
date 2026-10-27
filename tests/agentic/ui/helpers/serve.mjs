#!/usr/bin/env node
// W5 e2e 静态服务（补齐 plan.md M02 缺口：helpers/serve.mjs，RED 批 cff57cf 注明「M02 harness 待实现」）
// 契约（smoke.spec.ts 头注 / plan.md M02）：零依赖静态服务 web/agentic/ 于 127.0.0.1:--port（默认 17621）。
// '/' 回 200 极简索引——playwright webServer 健康检查不依赖 agentic.css / demo.html 是否已落地。
// 用法：node tests/agentic/ui/helpers/serve.mjs --port 17621
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// serve.mjs 位于 tests/agentic/ui/helpers/ —— 回仓库根需 4 级 ../
const ROOT = fileURLToPath(new URL('../../../../web/agentic/', import.meta.url));
// normalize() 保留尾分隔符（…/web/agentic/），比较前必须剥掉，否则 NR+sep 成双斜杠永假
const NORMALIZED_ROOT = normalize(ROOT).replace(new RegExp(sep + '+$'), '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
};

function portFromArgs(argv) {
  const i = argv.indexOf('--port');
  if (i !== -1 && argv[i + 1] && /^\d+$/.test(argv[i + 1])) return Number(argv[i + 1]);
  const env = Number(process.env.PORT);
  return Number.isInteger(env) && env > 0 ? env : 17621;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }
    if (pathname === '/' || pathname === '') {
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><title>donego w5</title>');
      return;
    }
    // 目录穿越防护：解析后必须仍在 web/agentic/ 内
    const file = normalize(join(ROOT, pathname));
    if (file !== NORMALIZED_ROOT && !file.startsWith(NORMALIZED_ROOT + sep)) {
      // 注：file 经 normalize 后无尾分隔符，NORMALIZED_ROOT 亦然（见上），此处比较成立
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    const buf = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

const port = portFromArgs(process.argv);
server.listen(port, '127.0.0.1', () => {
  console.log(`[w5-serve] web/agentic/ → http://127.0.0.1:${port}/ (pid ${process.pid})`);
});
