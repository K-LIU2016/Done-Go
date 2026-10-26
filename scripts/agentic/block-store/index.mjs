// W1 block-store 统一出口：store（blocks 表服务端权威存储）+ routes（HTTP 层）。
// 挂载（第 3 批 W13）与前端 sync.js 的服务端契约只从这里取（BUILD-PLAN §3 W1-1、§2.1 L46）。
export { createBlocksStore, blocksError } from './store.mjs';
export { createBlockRoutes } from './routes.mjs';
