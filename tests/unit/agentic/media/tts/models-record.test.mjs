// W11 tts · 模型台账先行单测：scripts/agentic/tts/models.md 必须记录模型来源 URL 与
// SHA256（BUILD-PLAN §3 W11.4："下载到 asr-lab/models/tts/，记录模型来源与校验和"）。
// 模型二进制不入库；台账文件是唯一凭证。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const modelsMd = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'scripts', 'agentic', 'tts', 'models.md');

test('models.md records at least one source URL and its SHA256 checksum', () => {
  const text = readFileSync(modelsMd, 'utf8');
  assert.match(text, /https:\/\/\S+/, '必须记录模型下载来源 URL');
  assert.match(text, /[0-9a-f]{64}/i, '必须记录 64 位十六进制 SHA256 校验和');
  assert.match(text, /asr-lab\/models\/tts\//, '必须写明安装位置 asr-lab/models/tts/');
});
