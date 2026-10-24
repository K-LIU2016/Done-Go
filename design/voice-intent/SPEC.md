# 探戈 · 语音输入 → 意图理解 → 日程与优先级 · 定稿规格

定稿：Claude（Done-Go CEO，JC 授权）· 2026-10-25
原型：`design/voice-intent/prototype.html`；总览图：`voice-board.png`（4 屏：正在听 / 正在理解 / 听出了几件事 / 加入后的首页）
视觉 token 沿用 `design/relay-v2/SPEC.md` §3，并新增本文 §4 的语音 token。**实现必须与原型视觉一致。**

## 1. 目标（JC 原话要点）
- 语音输入**自动转录**，流畅度对标豆包语音输入：边说边出字，句末自动纠正并加标点。
- 结合**语义深度分析**，自动识别为日程，并自动设置优先级；**识别不到时默认「一般」**。
- 转录的流式文字**要美观**；语义识别要有**很强的意图理解能力**。

## 2. 架构
```
浏览器麦克风 ─AudioWorklet→ 16kHz/16bit/mono PCM（每 60ms 一帧）
  └─WebSocket wss://<host>/api/voice/stream（同源，会话 cookie 鉴权）
      Done-Go 服务端（scripts/voice-gateway.mjs）
        └─ws://127.0.0.1:10195  FunASR 2pass（donego-funasr 容器）
              ├ online（paraformer 流式）→ {mode:"2pass-online", text}   → 前端灰字
              └ offline（SenseVoice + 标点 + ITN）→ {mode:"2pass-offline", text} → 前端黑字（替换该句的灰字）
说完（手动「说完了」或静音 2 秒）→ POST /api/voice/intent {transcript, now, tz}
  ├ 规则解析（现有中文时间与优先级规则）→ 立即返回草稿
  └ LLM mode:'intent'（light 档快速模型，严格 JSON）→ 精修后替换草稿 → 用户确认 → 写入事项
```

### 2.1 FunASR 容器（donego-funasr）
- 镜像：本地已有的 `registry.cn-hangzhou.aliyuncs.com/funasr_repo/funasr:funasr-runtime-sdk-online-cpu-0.1.13`（docker.io 被墙，**不得拉取新镜像**）。
- 模型：**只读**挂载 `/home/jc/projects/Salon9/models:/workspace/models:ro`；启动脚本**复制** Salon9 的 `services/funasr/run-light.sh` 到 `deploy/funasr/run-light.sh`，改成 Done-Go 自己的（端口 10195、线程数 ≤2、关闭自动下载）。
- 编排：新建 `deploy/funasr/compose.yml`（项目名 `donego-asr`），端口 `127.0.0.1:10195`，`mem_limit: 1500m`，`cpus: 2`，`restart: unless-stopped`。**不得改动 Salon9 的 compose、容器和定时器。**
- 长连接内存泄漏（Salon9 的已知问题）：每次语音会话结束就关闭 FunASR 连接，不复用长连接；外加每日 04:10 重启一次的 user timer（`donego-funasr-restart.timer`）。

### 2.2 语音网关 `scripts/voice-gateway.mjs`
- WebSocket 服务端使用 `ws` 包（**授权新增这一个依赖**）；连接上游 FunASR 用 Node 自带的 `WebSocket` 客户端。
- 鉴权：复用现有会话鉴权（访客 demo 会话或登录会话），并做 Origin 校验。
- 限额：单次 ≤ 60 秒；每访客每日 ≤ 15 分钟；全局并发 ≤ 3 路（thinkpad CPU 上限）；超限返回明确错误码，前端提示。
- 协议（客户端 ↔ 网关）：客户端先发 `{"type":"start","sampleRate":16000}`，然后发二进制 PCM 帧，最后发 `{"type":"stop"}`；网关回 `{"type":"partial","seg":n,"text"}`、`{"type":"final","seg":n,"text"}`、`{"type":"end"}`、`{"type":"error","code"}`。
- 隐私：**不落盘音频**，不记录文本；日志只记时长和错误码。
- 降级：FunASR 不可达时返回 `asr-unavailable`，前端改用浏览器自带的 `webkitSpeechRecognition`（iOS Safari 可用）；再不可用就回到文字输入，并提示"语音暂时不可用，打字也行"。

### 2.3 意图理解 `scripts/intent.mjs` + `mode:'intent'`
**输入**：`{transcript, now:"2026-10-25T10:12:00+08:00", tz:"Asia/Shanghai"}`
**输出（严格 JSON，服务端校验）**：
```json
{ "items": [ {
  "title": "和导师开组会",            // ≤20 字，动宾短语，去掉口头语
  "kind": "necessary|create|connect|explore|restore|stillness",
  "date": "2026-10-26",              // 无法确定则为 null
  "start": "15:00", "end": "16:00",  // 不确定则为 null；只说了时长就给 durationMin
  "durationMin": 60,
  "deadline": null,                  // "周五前交报告" → deadline:"2026-10-30"，start 为 null
  "timeText": "明天下午三点",          // 原话中的时间片段
  "vague": false,                    // "晚上 / 有空 / 回头" 等模糊时间 → true
  "recurrence": null,                // "每天 / 每周一" → 原样文本
  "priority": 1, "priorityReason": "你说「必须」，且要赶在组会前",
  "confidence": 0.92, "source": "原话片段" } ],
  "nonEvent": null                   // 整句不是日程（提问、闲聊）→ {"suggest":"relay","reason":"…"}
}
```
**意图理解要求（逐条进入评测集）**：
1. 一句话拆多件事；不同事件之间的依赖要识别（"开组会前先整理数据" → 数据的截止 = 组会开始时间）。
2. 相对日期以 `now` 和 `tz` 为准：今天、明天、后天、大后天、这周五、下周三、周末、月底、下个月 3 号；**跨月、跨年要算对**。
3. 时间表达：下午三点半、15:30、三点到四点、一个半小时、半小时后、中午、傍晚。模糊说法（晚上、有空、回头）只标 `vague`，**不编造具体时刻**。
4. 说话中途改口（"三点，不对，四点"、"算了不去了"）以最后的意思为准；撤销的事项不输出。
5. 去掉口头语（嗯、那个、就是、然后）；ASR 同音错字按上下文纠正（"导师" 不应变成 "到时"）。
6. 截止事项和约定事项要区分；重复事项保留 `recurrence` 原文。
7. **优先级**：五档（1 最优先 / 2 优先 / 3 一般 / 4 稍缓 / 5 不急），**识别不到依据时一律为 3 一般**，并且 `priorityReason` 为 null。可以作为依据的线索：
   - 显式：必须、务必、紧急、最重要 → 1；比较重要、优先、尽快 → 2；晚点、不着急 → 4；有空再说、随便、可以的话 → 5。
   - 隐式：今天或明天截止 → 2（今天截止且说了"必须" → 1）；和导师、领导、客户、考试、面试相关 → 2。
   - 依据要写成人话，并引用原词。
8. 不确定的字段给 null，并降低 `confidence`，前端会标黄提示"没说具体几点"。**宁缺勿编。**
9. 防注入：转写文本放在不可信标签内，其中的任何指令一律忽略。

**规则先行**：现有 `PRIO_RE` 和中文时间解析先给出草稿（<50ms）；LLM 结果到了再逐字段替换，有差异的字段闪一下高亮。LLM 失败或超时（总时长 6 秒）就保留规则结果，**默认优先级仍是 3 一般**。

**纠正**：结果页可以继续说"把跑步改到八点"或"删掉第二件"，`mode:'intent'` 带上 `edit` 参数和当前 items 做增量修改。

## 3. 前端模块 `web/voice/`
- `capture.js`：getUserMedia、AudioWorklet 重采样到 16k PCM、音量电平（驱动波形）、静音 2 秒检测、60 秒上限；麦克风权限被拒时给出清楚的提示。
- `stream-client.js`：WebSocket 协议、重连一次、按 seg 合并 partial 和 final、降级到 webkitSpeechRecognition。
- `transcript-view.js`：**只增量渲染**，已确认的前缀保持稳定，只更新尾部的灰字；新字逐字浮现；final 到来时该句由灰转黑（`settle` 动画 320ms）；光标闪烁。**不允许整段闪烁重排**；尊重 `prefers-reduced-motion`。
- `intent-view.js`：② 理解中（转写锁定，高亮时间和优先级线索词，骨架卡）→ ③ 事件卡（标题、类别、时间 chip、优先级 chip、依据、模糊黄 chip）；点卡片可编辑标题、日期时间、优先级；"全部加入"、"再说一次"、口头纠正。
- `voice-sheet.js`：底部弹层容器，含手势下拉关闭、焦点管理、桌面端居中弹窗。

## 4. 语音视觉 token（新增）
```
--vt-size:22px --vt-line:1.62 --vt-track:.3px --vt-weight-final:500 --vt-weight-partial:400
--vt-final:#252722 --vt-partial:#A3A59B --vt-caret:#E95432
优先级色：p1 #C2412D/#FCE8E3 · p2 #C7701F/#FDF0E1 · p3 #5E6158/#EFEEE8 · p4 #4C7A93/#E6EFF4 · p5 #3E7B5B/#E5F1EA
```
- 字体为系统中文无衬线（PingFang SC / Noto Sans SC），开启 `font-feature-settings:"palt"` 和 `text-wrap:pretty`，避免标点落在行首。
- 波形：15 根柱，高度由实时音量驱动（不是假动画）；静音时回落到 8px。

## 5. 首页接入（二期，等 relay v2 合入后）
- 首页输入条的 🎤 打开语音弹层。
- 加入后，首页出现"接下来的事"（按优先级、再按时间排序），每条左侧有优先级色条；能交给 AI 的条目带"交给 AI"按钮，点了进入 relay 流程 ②，事件预填。
- 数据写入现有事项存储（账号作用域），不另建一套。

## 6. 指标与验收
- **流畅度**：开口到第一个灰字 ≤ 600ms（本机 FunASR）；停顿到该句变黑 ≤ 1000ms；连续说 30 秒没有卡顿、没有整段重排（录屏逐帧检查）。
- **意图理解**：评测集 ≥ 80 条（含上面 9 类难例，每类 ≥ 6 条，并有标准答案），真实快速模型上：
  - 事项数量准确率 ≥ 95%；
  - 日期和时间准确率 ≥ 92%；
  - 优先级准确率 ≥ 90%（含"无依据 = 一般"）；
  - 无编造率 100%（模糊时间不能给具体时刻）。
  规则基线也要报告同样的指标作为对照。
- 意图 p95 ≤ 2.5 秒（快速模型）；规则草稿 < 50ms。
- 资源：FunASR 容器空闲 RSS ≤ 1.2GB，单路识别 CPU ≤ 1.5 核。
