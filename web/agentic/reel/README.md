# web/agentic/reel · 预演片播放器（W11 组 3）

浏览器内预演片播放运行时（BUILD-PLAN §3 W11.3、PRD §5.2.1 L2「HTML 合成直接播放，不需要渲染」）。
原生 ES 模块、免构建、零依赖；顶层不触碰 DOM，可在 node 里直接 import 做纯函数单测。

## 消费的契约（上游：scripts/agentic/composer/）

`composeReel(preview)` 产出的自包含 HTML（`scripts/agentic/composer/compose-reel.mjs`）：

- 每个镜头 `.shot` / 字幕 `.cap` 带 HyperFrames 兼容 data 属性：
  `data-start` / `data-duration` / `data-track`（`visual` | `caption`，+ `data-kind`、`data-sample-id`）；
- `<script type="application/json" id="reel-data">` 数据岛内联同一份时间轴
  `{missionId, version, durationSec, narrationAudio, elements}`；
- 旁白 `<audio>`（tts 合成产物，字幕时间戳即它的逐句区间）。

播放器解析以 DOM data 属性为主（元素自带节点可直接驱动），数据岛兜底（DOM 缺属性时取时长与字幕），
`durationSec` 取两者与 `<audio>.duration` 的最大值。

## 纯函数 API（node 单测：tests/unit/agentic/media/reel/）

| 导出 | 说明 |
|---|---|
| `parseTimeline(elements)` | data 属性 → `{durationSec, tracks:{visual,caption}}`；垃圾元素丢弃；按 start 升序 |
| `timelineFromIsland(data)` | 数据岛 JSON → 同上形状（元素无 node） |
| `activeAt(tl, t)` | 主时钟 t → `{visual, captions}`；区间半开 `[start, start+duration)`，边界即切镜 |
| `progressAt(tl, t)` | → `[0,1]` 进度条比例（夹取） |
| `scrubTime(fraction, durationSec)` | 指针横向比例 → 时间轴秒（拖动 scrub 换算） |
| `formatTime(sec)` | → `'M:SS'` 时间标签 |
| `shouldReduceMotion(mql)` | 降级判定；无 matchMedia 环境默认不降级 |
| `playerState(state, event)` / `INITIAL_PLAYER_STATE` | 状态机 `idle/playing/paused/ended/closed`（交互对照 prototype:621-648；ended 按暂停 = 重播） |

## 浏览器胶水 `createReelPlayer(root, opts?)`

```js
import { createReelPlayer } from '/agentic/reel/player.js';
const player = createReelPlayer(document.querySelector('.reel'), { autoplay: true });
// player.play/pause/resume/replay/toggle/seek(sec)/next/prev/close/destroy
// player.state / player.time() / player.timeline / player.reduced / player.onstate(cb)
```

- `opts`：`audio`（默认取 root 内 `<audio>`）、`document`、`matchMedia`、`raf`、`now`（全部可注入，
  node 单测用 fake DOM 驱动）、`autoplay:true`（自动开播）、`controls:'auto'|'none'|'force'`、
  `onClose(root)`（默认整块移除 root，同 prototype:579）。
- **主时钟**：有旁白音频时 `audio.currentTime` 驱动一切（旁白逐句切镜，原型 speechSynthesis 的正式
  替代）；无音频用注入时钟的虚拟时间轴。音频 `ended` → `ended` 状态。
- **Web Animations**：镜头交叉过渡 `opacity 0→1, 600ms, forwards`（prototype:168）；配图镜头 Ken Burns
  `scale(1) translate(0,0) → scale(1.09) translate(-2%,-1%), 7000ms ease-out forwards`（prototype:171-172）；
  seek 进镜头中段时按 `(t - start)` 对齐 Ken Burns 相位；暂停同步 `pause()` 动画。
- **增量更新（PRD §5.2 工程约束）**：进度条宽度、字幕可见性、时间标签、按钮文案全部先 diff 再写，
  绝不整块重写 DOM——单测以「innerHTML 零调用 + 无变化节点零触碰」锁死。
- **交互**：控制条（播放/暂停/继续/重播 + 关闭，DOM 缺失时自建）；`Esc` 关闭（prototype:648）；
  舞台 pointer 拖动 scrub（`pointerdown` 软暂停 → `pointermove` 逐点 seek → `pointerup` 恢复播放）。
- **reduced-motion**：`prefers-reduced-motion: reduce` 时不创建任何动画（WAAPI 与 CSS 过渡全关，
  见 reel.css 末尾媒体查询），控制条换「◀ 上一步 / 下一步 ▶」，每镜头一帧手动步进，
  不自动推进、不自动播旁白（PRD §5.2.3「静态分步」）。

### 自动挂载

浏览器里 import 本模块即自动绑定页面第一个 `.reel:not([data-reel-manual]):not([data-reel-bound])`
并 autoplay（composeReel 自包含页加一行 `<script type="module" src="…/player.js">` 即可播放）。
宿主想自己控制时给 `.reel` 加 `data-reel-manual`，或直接用 `createReelPlayer`。

### 样式

`reel.css` 供宿主页引入，取值与 prototype.html:165-185 及 composeReel 内联 STYLE 同一套；
播放器的动画不依赖 CSS（WAAPI），CSS 里 `.on`/`@keyframes kb` 是无 JS 回退。

## 验证

```sh
node --test "tests/unit/agentic/media/reel/*.test.mjs"          # 纯函数 + fake DOM 胶水
node --test --experimental-test-coverage --test-reporter=dot \
  "tests/unit/agentic/media/reel/*.test.mjs" | grep player.js    # 覆盖率 ≥80%
```

浏览器侧视觉验证（对照 prototype）归 W11 组 4 真实冒烟（flock Playwright），截图存
`design/schedule-to-delivery/shots/w11/`。

## 归属（BUILD-PLAN §2.1）

本目录（`web/agentic/reel/**`）与 `tests/unit/agentic/media/reel/**` 归 W11；不挂
serve-tango.mjs 路由、不改 build-web.mjs 与发布清单（第 3 批 W13 统一接入）。
