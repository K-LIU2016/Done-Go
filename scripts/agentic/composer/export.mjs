// W11 composer · exportReel 留桩（BUILD-PLAN §3 W11.2 原文：export(reel) 接口先留桩，
// P2 用 HyperFrames 渲染 MP4；PRD §5.2.1 L2「需要分享/保存时后台用 HyperFrames 导出 MP4」）。
// 本流（P0/W11）只冻结接口形状：同步、零依赖、不读 reel 内容、绝不假装产出视频文件。

/**
 * exportReel(reel) → { status:'pending', reason:'P2 HyperFrames MP4' }。
 * P2 接入 HyperFrames 渲染时替换为真实导出（输入即 composeReel 的 HTML/时间轴），
 * 返回结构保持向后兼容：成功态额外带 mp4 字段，pending 态永远不带。
 */
export function exportReel() {
  return { status: 'pending', reason: 'P2 HyperFrames MP4' };
}
