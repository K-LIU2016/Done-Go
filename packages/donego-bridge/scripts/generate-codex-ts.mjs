#!/usr/bin/env node
// 生成 Codex App Server 类型绑定；版本随 codex-cli 记录，失败时不留下半成品。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function codexVersion(codex) {
  return execFileSync(codex, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function generateCodexTypes({
  codex = 'codex',
  outDir = new URL('../src/codex/types/', import.meta.url).pathname,
  exec = execFileSync,
} = {}) {
  const destination = resolve(outDir);
  const parent = resolve(destination, '..');
  mkdirSync(parent, { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });
  try {
    const version = exec(codex, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    exec(codex, ['app-server', 'generate-ts', '--out', temporary], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (readdirSync(temporary).length === 0) throw new Error('Codex generated no type files');
    rmSync(destination, { recursive: true, force: true });
    renameSync(temporary, destination);
    writeFileSync(join(destination, 'GENERATED.md'), `# Generated Codex bindings\n\n- codex: ${version}\n- command: codex app-server generate-ts\n`, { mode: 0o644 });
    return { outDir: destination, version };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw new Error(`Codex TypeScript generation failed: ${error?.message || error}`, { cause: error });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  generateCodexTypes({ codex: process.env.CODEX_BIN || 'codex', outDir: process.argv[2] });
}
