// M6/M8 共享的假 Codex 会话（录制夹具风格）：实现 M1 createJsonRpcSession 的会话接口，
// 供 createCodexAdapter({ sessionFactory }) 注入。绝不真起 codex（§2.3 配额：单测一律 mock）。
export function fakeSessionFactory(script = {}) {
  const calls = []; // {kind:'request'|'notify', method, params}
  let hooks = null; // adapter 传入的 {onNotify, onServerRequest}
  const pendingServerReplies = [];
  const session = {
    request(method, params) {
      calls.push({ kind: 'request', method, params });
      const h = script[method];
      if (h === undefined) return new Promise(() => {}); // 无脚本：挂起（模拟未回包）
      return Promise.resolve(typeof h === 'function' ? h(params, method) : h);
    },
    notify(method, params) { calls.push({ kind: 'notify', method, params }); },
    close() { calls.push({ kind: 'close' }); },
  };
  const factory = passedHooks => { hooks = passedHooks; return session; };
  // 测试驱动一个"服务端请求"（如审批），返回 promise：adapter 回复后 resolve(reply)
  factory.serverRequest = (method, params) => new Promise(resolve => {
    const id = 900 + pendingServerReplies.length + 1;
    pendingServerReplies.push({ id, resolve });
    hooks?.onServerRequest({ jsonrpc: '2.0', id, method, params }, reply => {
      const i = pendingServerReplies.findIndex(r => r.id === id);
      if (i >= 0) pendingServerReplies.splice(i, 1)[0].resolve(reply);
    });
  });
  factory.unrepliedCount = () => pendingServerReplies.length;
  factory.calls = calls;
  return factory;
}

export const callsOf = (factory, method) => factory.calls.filter(c => c.method === method);
export const lastCall = (factory, method) => [...factory.calls].reverse().find(c => c.method === method);

export const PLAN_FIXTURE = {
  files: ['src/a.mjs'],
  summary: '给 utils 加一个 debounce 函数',
  estimatedDiffLines: 40,
  kinds: ['code'],
  tests: ['node --test tests/a.test.mjs'],
  crossModule: false,
  riskFlags: [],
  needsNewTests: true,
  signals: { architecture: false, concurrency: false, performance: false, security: false, dataMigration: false },
};

export const MISSION = () => ({
  missionId: 'm1',
  worktree: '/wt/mission-m1',
  contract: {
    id: 'c1', missionId: 'm1', goal: '加一个 debounce 函数',
    summary: '在 src/utils 加 debounce，配单测', // developerInstructions=合同摘要（PRD L412）
    definitionOfDone: ['单测全绿', '无回归'],
    deliverables: ['src/**', 'tests/**'],
  },
});
