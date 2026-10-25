// RV2 验收专用包装配置（不改共享的 playwright.tango.config.ts）。
// 唯一差异：去掉 globalSetup —— 它注册 fixture 用户用的 36 字密码撞上
// server/auth 8–15 字策略（基线 e77b446 即如此，见证据 rv2-L8服务端.md §
// INVALID_PASSWORD），与本分支无关；而 relay-v2 验收用例全部是访客
//（storageState 置空），本就不消费 artifacts/tango-ui-auth.json。
// 其余（testDir/projects/超时/webServer 复用）与 tango 配置逐项一致。
import tango from "./playwright.tango.config.ts";
export default { ...tango, globalSetup: undefined };
