// donego-bridge CLI：pair/start/status 三个本机桥命令。
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBridgeClient } from './client/wss.mjs';
import { createJsonRpcSession } from './codex/jsonrpc.mjs';
import { createCodexAdapter } from './codex/adapter.mjs';
import { createBridgeRuntime } from './runtime/session.mjs';
import { chooseModel, chooseReviewModel } from './model/choose.mjs';
import { decideApproval } from './policy/approvals.mjs';
import { createMissionWorktree } from './git/worktree.mjs';
import { deviceConfigPath, loadDeviceConfig, saveDeviceConfig } from './config.mjs';

const usage = 'usage: donego-bridge pair <code> [--hub-url URL] | start | status';
const defaultConfigDir = home => join(home, '.config', 'donego-bridge');
const defaultRepoRoot = process.cwd();
const defaultStateDir = home => join(home, '.local', 'state', 'donego-bridge');

function print(io, line) { io?.print?.(line); }
function option(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}
function saveState(stateDir, state) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, 'state.json'), `${JSON.stringify(state)}\n`, { mode: 0o600 });
}
function loadState(stateDir) {
  try { return JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; return { lastError: 'STATE_CORRUPT' }; }
}
function toWsUrl(hubUrl) {
  const url = new URL(hubUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/api/bridge`;
  return url.toString();
}

export async function runCli(argv = [], deps = {}) {
  const io = deps.io ?? { print: line => console.log(line) };
  const configDir = deps.configDir ?? defaultConfigDir(process.env.HOME);
  const stateDir = deps.stateDir ?? defaultStateDir(process.env.HOME);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  if (!argv.length || argv[0] === '--help' || !['pair', 'start', 'status'].includes(argv[0])) {
    print(io, usage);
    return { code: 2 };
  }
  const command = argv[0];
  if (command === 'pair') {
    const code = argv[1];
    const hubUrl = option(argv, '--hub-url') ?? deps.hubUrl ?? 'https://127.0.0.1:3458';
    if (!code || argv.includes('--hub-url') && !option(argv, '--hub-url')) { print(io, usage); return { code: 2 }; }
    const ownerToken = option(argv, '--owner-token') ?? deps.ownerToken ?? process.env.DONEGO_OWNER_TOKEN;
    if (!ownerToken && !deps.fetchImpl) { print(io, 'pair failed: owner credential required (--owner-token)'); return { code: 2 }; }
    let response;
    try {
      response = await fetchImpl(`${hubUrl.replace(/\/$/, '')}/api/bridge/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(ownerToken ? { authorization: `Bearer ${ownerToken}` } : {}) },
        body: JSON.stringify({ code }),
      });
    } catch (error) { print(io, `pair failed: ${error.message}`); return { code: 1 }; }
    if (!response || response.status < 200 || response.status >= 300) {
      print(io, `pair failed: ${response?.body?.error ?? response?.status ?? 'NETWORK_ERROR'}`);
      return { code: 1 };
    }
    const body = response.body && typeof response.body === 'object' && typeof response.body.getReader !== 'function'
      ? response.body
      : await response.json();
    if (!body?.deviceId || !body?.token) { print(io, 'pair failed: invalid hub response'); return { code: 1 }; }
    saveDeviceConfig(configDir, { hubUrl, deviceId: body.deviceId, token: body.token, pairedAt: now() });
    print(io, `paired device ${body.deviceId}`);
    return { code: 0 };
  }
  if (command === 'status') {
    const state = loadState(stateDir);
    print(io, JSON.stringify(state));
    return { code: 0, state };
  }
  let config;
  try { config = loadDeviceConfig(configDir); }
  catch (error) { print(io, `start failed: ${error.code ?? error.message}`); return { code: 1 }; }
  if (!config) { print(io, 'not paired; run donego-bridge pair <code> first'); return { code: 1 }; }
  const wsUrl = toWsUrl(config.hubUrl);
  let WebSocket = deps.WebSocket;
  if (!WebSocket) {
    try {
      const wsModule = await import('ws');
      WebSocket = wsModule.default ?? wsModule.WebSocket ?? wsModule;
    } catch (error) {
      print(io, `start failed: WebSocket runtime unavailable (${error.message})`);
      return { code: 1 };
    }
  }
  let client;
  let adapter;
  let runtime;
  const sendEvent = event => client?.send({ type: 'bridge.event', event });
  const repoRoot = deps.repoRoot ?? defaultRepoRoot;
  const sessionFactory = deps.sessionFactory ?? (hooks => createJsonRpcSession({
    spawn: deps.spawn ?? spawn,
    argv: deps.codexArgv ?? ['codex', 'app-server', '--stdio'],
    ...hooks,
  }));
  const makeAdapter = hooks => {
    adapter = createCodexAdapter({
      sessionFactory,
      chooseModel,
      chooseReviewModel,
      decideApproval,
      onNeed: hooks.onNeed,
      log: deps.log,
    });
    return adapter;
  };
  if (deps.enableRuntime !== false) {
    runtime = createBridgeRuntime({
      makeAdapter,
      repoRoot,
      worktrees: deps.worktrees ?? { create: (missionId, options) => createMissionWorktree(repoRoot, missionId, options) },
      chooseModel,
      chooseReviewModel,
      sendEvent,
      stateFile: deps.stateFile ?? join(stateDir, 'runtime-state.json'),
      log: deps.log,
    });
  }
  const bridgeClient = createBridgeClient({
    url: wsUrl, token: config.token, WebSocket,
    heartbeatMs: deps.heartbeatMs, minBackoffMs: deps.minBackoffMs, maxBackoffMs: deps.maxBackoffMs,
    onMessage: message => {
      saveState(stateDir, { ...loadState(stateDir), connected: true, lastMessageType: message?.type ?? null });
      deps.onMessage?.(message);
      if (message?.type === 'mission.command' && runtime) {
        const command = message.command ? { ...message, type: message.command } : message.commandPayload;
        Promise.resolve(runtime.handleCommand(command)).then(result => sendEvent({ type: 'mission.command.result', requestId: message.requestId, result }))
          .catch(error => sendEvent({ type: 'mission.command.error', requestId: message.requestId, error: { code: error.code ?? 'INTERNAL_ERROR', message: error.message } }));
      } else if (message?.type === 'need.answer' && adapter) {
        adapter.resolveNeed(message.requestId, message.decision ?? message.answer);
      }
    },
    onRevoked: () => { saveState(stateDir, { ...loadState(stateDir), connected: false, lastError: 'DEVICE_REVOKED' }); print(io, 'device token revoked; run pair again'); deps.onRevoked?.(); },
    onStateChange: (state, info) => { saveState(stateDir, { ...loadState(stateDir), connected: state === 'connected', state, ...(info?.error ? { lastError: String(info.error.message ?? info.error) } : {}) }); deps.onStateChange?.(state, info); },
    log: deps.log,
  });
  client = {
    ...bridgeClient,
    stop() {
      bridgeClient.stop();
      runtime?.close();
    },
  };
  client.connect();
  return { code: 0, client };
}

export async function main(argv = process.argv.slice(2)) {
  const result = await runCli(argv);
  return result.code;
}
