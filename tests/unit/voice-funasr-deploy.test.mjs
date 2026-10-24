// tests/unit/voice-funasr-deploy.test.mjs — V6FunASR 线定向单测（静态校验）。
// 唯一标准：design/voice-intent/SPEC.md §2.1（FunASR 容器 donego-funasr）
//   · 镜像只用本地已有的 funasr-runtime-sdk-online-cpu-0.1.13，不得拉取
//   · 模型只读挂载 Salon9 models；端口 127.0.0.1:10195；项目名 donego-asr
//   · mem_limit 1500m / cpus 2 / restart unless-stopped
//   · run-light.sh = Salon9 services/funasr/run-light.sh 的副本改三处：
//     端口 10195、线程数 ≤2、关闭自动下载（全部模型目录显式指定 + 挂载只读）
//   · donego-funasr-restart.{service,timer} 只入仓、不安装（安装由 CTO 发令）
// 夜窗纪律：本测试只做静态/文件校验，不起容器、不连网关（真实 2pass 实测
// 由窗口后的节点执行）。fixtures 为纯合成 TTS 音频，无真人隐私。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
// 契约一律 import web/voice/contracts.js（commit 77a59d5）：
// fixtures 的采样率必须等于 VOICE_SAMPLE_RATE（SPEC §2：16kHz/16bit/mono）。
import { VOICE_SAMPLE_RATE } from '../../web/voice/contracts.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const deployDir = join(root, 'deploy', 'funasr');
const composePath = join(deployDir, 'compose.yml');
const runLightPath = join(deployDir, 'run-light.sh');
const servicePath = join(deployDir, 'donego-funasr-restart.service');
const timerPath = join(deployDir, 'donego-funasr-restart.timer');
const fixturesDir = join(root, 'tests', 'voice', 'fixtures');

const LOCAL_IMAGE = 'registry.cn-hangzhou.aliyuncs.com/funasr_repo/funasr:funasr-runtime-sdk-online-cpu-0.1.13';

function readIfExists(p) {
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}
// 取 YAML 中某个 key（如 `ports:`）的缩进块（其下更深缩进的行）。
function block(text, key) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^\\s*${key}:\\s*$`).test(l));
  if (start === -1) return [];
  const baseIndent = lines[start].length - lines[start].trimStart().length;
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (line.trimStart().startsWith('#')) continue; // 注释行不是条目
    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent) break;
    out.push(line.trim().replace(/^-\s+/, ''));
  }
  return out;
}

test('deploy/funasr 四件套齐备（compose.yml / run-light.sh / service / timer）', () => {
  for (const p of [composePath, runLightPath, servicePath, timerPath]) {
    assert.ok(existsSync(p), `missing deploy file: ${p}`);
  }
});

test('compose：项目名 donego-asr、容器名 donego-funasr、本地镜像、禁止拉取', () => {
  const c = readIfExists(composePath);
  assert.ok(c, 'deploy/funasr/compose.yml 不存在');
  assert.match(c, /^name:\s*donego-asr$/m, 'compose 顶层 name 必须是 donego-asr');
  assert.match(c, new RegExp(`^\\s*image:\\s*${LOCAL_IMAGE.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*$`, 'm'), '镜像必须是本地已有的 funasr 0.1.13');
  assert.match(c, /^\s*pull_policy:\s*never\s*$/m, 'pull_policy: never —— 绝不从 registry 拉取（红线：不拉新镜像）');
  assert.match(c, /^\s*container_name:\s*donego-funasr\s*$/m, 'container_name 必须是 donego-funasr');
  assert.doesNotMatch(c, /^\s*build:/m, '不允许 build：，只能用本地镜像');
  assert.doesNotMatch(c, /\$\{/, 'compose 不做变量插值（免 .env，定时器可直接 restart）');
});

test('compose：端口只暴露 127.0.0.1:10195（回环，不对外）', () => {
  const c = readIfExists(composePath);
  assert.ok(c);
  const ports = block(c, 'ports');
  assert.ok(ports.length > 0, '缺 ports: 块');
  const mappings = ports.join('\n').match(/"?((?:\d{1,3}\.){3}\d{1,3}:)?(\d+):(\d+)"?/g) ?? [];
  assert.equal(mappings.length, ports.length, 'ports 块里存在无法解析的行');
  assert.deepEqual(
    ports.map((p) => p.replace(/"/g, '')),
    ['127.0.0.1:10195:10195'],
    '唯一端口映射必须是 127.0.0.1:10195:10195',
  );
  assert.doesNotMatch(c, /0\.0\.0\.0/, '不得绑定 0.0.0.0');
});

test('compose：模型只读挂 Salon9 + run-light.sh 只读挂载', () => {
  const c = readIfExists(composePath);
  assert.ok(c);
  const vols = block(c, 'volumes');
  assert.ok(vols.some((v) => v === '/home/jc/projects/Salon9/models:/workspace/models:ro'), 'Salon9 models 必须只读挂到 /workspace/models');
  assert.ok(vols.some((v) => v === './run-light.sh:/usr/local/bin/run-light.sh:ro'), 'run-light.sh 必须挂到 /usr/local/bin/run-light.sh:ro');
  assert.ok(!vols.some((v) => v.includes('Salon9') && !v.endsWith(':ro')), '任何 Salon9 路径挂载都必须 :ro（红线：绝不改 Salon9）');
});

test('compose：资源与重启（mem_limit 1500m / cpus 2 / unless-stopped）+ 健康检查', () => {
  const c = readIfExists(composePath);
  assert.ok(c);
  const mem = c.match(/^\s*mem_limit:\s*(\d+)m\s*$/m);
  assert.ok(mem, '缺 mem_limit（SPEC §2.1 指定用 mem_limit 键）');
  assert.ok(Number(mem[1]) <= 1500, `mem_limit ${mem[1]}m 超过红线 1500m`);
  const cpus = c.match(/^\s*cpus:\s*'?([\d.]+)'?\s*$/m);
  assert.ok(cpus, '缺 cpus（SPEC §2.1 指定用 cpus 键）');
  assert.ok(Number(cpus[1]) <= 2, `cpus ${cpus[1]} 超过红线 2`);
  assert.match(c, /^\s*restart:\s*unless-stopped\s*$/m, 'restart 必须 unless-stopped');
  assert.doesNotMatch(c, /^\s*deploy:/m, '资源限制走 mem_limit/cpus，不再叠加 deploy.resources');
  assert.doesNotMatch(c, /privileged:\s*true/, '不得 privileged');
  const hc = block(c, 'healthcheck');
  assert.ok(hc.some((l) => l.includes('/dev/tcp/127.0.0.1/10195')), 'healthcheck 必须探容器内 10195（bash /dev/tcp/host/port 语法，同 Salon9）');
  const sp = c.match(/start_period:\s*(\d+)s/);
  assert.ok(sp, 'healthcheck 缺 start_period');
  assert.ok(Number(sp[1]) >= 600, 'start_period ≥ 600s（模型加载慢，Salon9 实测需要）');
});

test('run-light.sh：Salon9 副本改三处 —— 端口 10195 / 线程 ≤2 / 关闭自动下载', () => {
  const s = readIfExists(runLightPath);
  assert.ok(s, 'deploy/funasr/run-light.sh 不存在');
  assert.match(s, /^#!\/bin\/bash/, '必须是 bash 脚本');
  assert.match(s, /^set -e$/m, '必须 set -e');
  // 复制血缘：仍通过 find 定位镜像内 run_server_2pass.sh（Salon9 原结构）
  assert.match(s, /find \/workspace -name run_server_2pass\.sh/, '丢失 Salon9 原始的 run_server_2pass.sh 定位逻辑');
  // ① 端口 10195（参数行允许行尾续行符 \）
  assert.match(s, /^\s*--port\s+10195\s*\\?$/m, '必须 --port 10195（SPEC §2/§2.1）');
  // ② 线程 ≤2：decoder/model/io 全部显式并 ≤2
  for (const flag of ['decoder-thread-num', 'model-thread-num', 'io-thread-num']) {
    const m = s.match(new RegExp(`^\\s*--${flag}\\s+(\\d+)\\s*\\\\?$`, 'm'));
    assert.ok(m, `缺 --${flag}`);
    assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= 2, `--${flag} ${m[1]} 不在 [1,2]（SPEC：线程数 ≤2）`);
  }
  // ③ 关闭自动下载 = 五个模型目录全部显式指定（ro 挂载下无处可写）
  assert.match(s, /^\s*--download-model-dir\s+\/workspace\/models\s*\\?$/m, '--download-model-dir 指向只读挂载');
  for (const [flag, val] of [
    ['model-dir', 'damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-onnx'],
    ['online-model-dir', 'damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online-onnx'],
    ['vad-dir', 'damo/speech_fsmn_vad_zh-cn-16k-common-onnx'],
    ['punc-dir', 'damo/punc_ct-transformer_zh-cn-common-vad_realtime-vocab272727-onnx'],
    ['itn-dir', 'thuduj12/fst_itn_zh'],
  ]) {
    const m = s.match(new RegExp(`^\\s*--${flag}\\s+(\\S+)\\s*\\\\?$`, 'm'));
    assert.ok(m, `缺 --${flag}`);
    assert.equal(m[1], val, `--${flag} 应为 ${val}`);
  }
  // 轻量栈：禁 ngram LM（默认 lm_dir 本地不存在）+ plain ws
  assert.match(s, /^\s*--lm-dir\s+""\s*\\?$/m, '必须 --lm-dir ""（禁 ngram LM，Salon9 轻量栈）');
  assert.match(s, /^\s*--certfile\s+0\s*\\?$/m, '必须 --certfile 0（plain ws，网关走 ws://127.0.0.1:10195）');
  assert.match(s, /^sleep infinity$/m, '必须 sleep infinity 维持容器（Salon9 原结构）');
  // 静态安全：无网络下载、无删除
  assert.doesNotMatch(s, /\b(curl|wget)\b/, '脚本不得自行联网下载');
  assert.doesNotMatch(s, /rm\s+-rf/, '脚本不得 rm -rf');
});

test('run-light.sh：bash -n 语法检查通过', () => {
  const res = spawnSync('bash', ['-n', runLightPath], { encoding: 'utf8' });
  assert.equal(res.status, 0, `bash -n 失败: ${res.stderr}`);
});

test('restart.service：仅重启 donego-funasr，不启动、不触碰 Salon9', () => {
  const u = readIfExists(servicePath);
  assert.ok(u, 'deploy/funasr/donego-funasr-restart.service 不存在');
  assert.match(u, /^\[Unit\]$/m);
  assert.match(u, /^\[Service\]$/m);
  assert.match(u, /^Type=oneshot$/m, 'oneshot');
  const exec = u.match(/^ExecStart=(.+)$/m);
  assert.ok(exec, '缺 ExecStart');
  assert.match(exec[1], /sg docker -c/, 'user@1000 补充组问题需 sg docker（Salon9 同款）');
  assert.match(exec[1], /docker compose .*deploy\/funasr\/compose\.yml/, '必须用仓库内 compose.yml');
  assert.match(exec[1], /-p donego-asr/, '必须固定项目名 donego-asr');
  assert.match(exec[1], /restart funasr['"]?$/, '只做 restart funasr（不 up / 不 start）');
  assert.doesNotMatch(u, /projects\/Salon9/, 'unit 不得引用 Salon9 路径（模型挂载只在 compose 里且 :ro）');
  assert.doesNotMatch(u, /^\[Install\]$/m, 'service 不带 [Install]（不被单独 enable；随 timer 生效）');
});

test('restart.timer：每日 04:10（SPEC §2.1），Persistent，入仓不安装', () => {
  const t = readIfExists(timerPath);
  assert.ok(t, 'deploy/funasr/donego-funasr-restart.timer 不存在');
  assert.match(t, /^OnCalendar=\*-\*-\* 04:10:00$/m, '每日 04:10（SPEC §2.1）');
  assert.match(t, /^Persistent=true$/m, 'Persistent=true（错过也补跑）');
  assert.match(t, /^\[Install\]$/m);
  assert.match(t, /^WantedBy=timers\.target$/m);
});

test('fixtures：纯合成中文 WAV（16kHz/16bit/mono，对齐 contracts VOICE_SAMPLE_RATE）', () => {
  assert.ok(existsSync(fixturesDir), 'tests/voice/fixtures/ 不存在');
  const names = readdirSync(fixturesDir).filter((n) => n.endsWith('.wav'));
  assert.ok(names.length >= 5, `合成 wav 至少 5 条，实际 ${names.length}`);
  for (const n of names) {
    assert.match(n, /^asr-[a-z0-9-]+\.wav$/, `文件名应 ASCII kebab-case：${n}`);
    const buf = readFileSync(join(fixturesDir, n));
    assert.equal(buf.length % 2, 0, `${n}: 字节数应为偶数（s16）`);
    assert.equal(buf.toString('latin1', 0, 4), 'RIFF', `${n}: 非 RIFF`);
    assert.equal(buf.toString('latin1', 8, 12), 'WAVE', `${n}: 非 WAVE`);
    assert.equal(buf.readUInt16LE(20), 1, `${n}: audioFormat 必须是 PCM(1)`);
    assert.equal(buf.readUInt16LE(22), 1, `${n}: 必须单声道`);
    assert.equal(buf.readUInt32LE(24), VOICE_SAMPLE_RATE, `${n}: 采样率必须 ${VOICE_SAMPLE_RATE}`);
    assert.equal(buf.readUInt16LE(34), 16, `${n}: 位深必须 16bit`);
    const seconds = (buf.length - 44) / 2 / VOICE_SAMPLE_RATE;
    assert.ok(seconds >= 1 && seconds <= 15, `${n}: 时长 ${seconds.toFixed(2)}s 应在 1–15s`);
  }
  const readme = join(fixturesDir, 'README.md');
  assert.ok(existsSync(readme), 'fixtures 缺 README.md（合成来源声明）');
  const rm = readFileSync(readme, 'utf8');
  assert.match(rm, /合成/, 'README 必须声明为合成音频');
  assert.match(rm, /无真人/, 'README 必须声明无真人隐私');
});

test('fixtures README 记录了再生成方式', () => {
  const readme = join(fixturesDir, 'README.md');
  assert.ok(existsSync(readme) && statSync(readme).size > 100);
});
