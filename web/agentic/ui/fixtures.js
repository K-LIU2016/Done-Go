// M02 fixtures：黄金场景数据（PRD §3.2 黄金场景、§10.3 Preview JSON 字段名；
// prototype.html L249-322/L354-364/L415-433/L493-504 原文）。
// 具名导出：blocks / preview(blockId,{patched}) / boundaries / SYS_WONT / script /
//   storyEvents / narration(patched) / samplesFor(blockId) / needs / traceText / DAY0 / DAY1
// 数据与 app.js LOCAL_FIXTURES 兜底逐字同源（M02 落地后同名导出自动接管，切换无缝）；
// app 侧补充数据（examples/artifacts/gains/agentsOf/coverPatched）不在本契约，恒由 app.js 提供。
// W0 契约一致性：M21 以 scripts/agentic/contracts.mjs 校验 preview() 产物（tests/agentic/ui/unit/contracts-consistency.test.mjs）。

const T = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
const DAY0 = 780; // 13:00（prototype L246）
const DAY1 = 1140; // 19:00

export { DAY0, DAY1 };

export const blocks = [
  { id: 'r', start: '14:00', end: '15:00', title: 'AI 教育的深度研究', kind: 'explore', type: '研究报告', feas: ['hi', '可交付度 高'], needs: 1 },
  { id: 'c', start: '15:00', end: '17:00', title: '课程设计', kind: 'create', type: '课程方案', feas: ['mid', '可交付度 中 · 缺学员与课时'], needs: 2 },
  { id: 'f', start: '19:00', end: '21:00', title: '和小王吃饭', kind: 'connect', type: '现实 · 会面', feas: ['hi', '简报 + 路线 + 行后记录'], needs: 0 },
  { id: 'b', start: '21:00', end: '21:50', title: '做木质小书架', kind: 'restore', type: '现实 · 动手', feas: ['hi', '效果图 + 步骤 + 现场感知'], needs: 0 },
  { id: 's', start: '22:00', end: '23:00', title: '自己的时间', kind: 'stillness', type: '零打扰', feas: ['', 'agent 不介入'], needs: 0 },
];

export const boundaries = {
  r: { will: ['检索公开网页与论文', '筛选来源并标注可信度', '写约 3000 字研究报告', '存入 Done&Go 交付库并可导出 Markdown'], wont: ['不发给任何人', '不访问你的邮箱与聊天', '不付费购买资料'], needs: ['14:00 前确认目标受众（30 秒）'], budget: ['约 40 次模型调用', '全部免费模型 / 本地模型', '提前 30 分钟开始准备'] },
  c: { will: ['基于研究结论设计 4 课时', '产出课时表 + 每课时活动卡', '读取 ~/Docs/课程（只读，本窗口）'], wont: ['不改动你的原文件', '不对外发送', '不使用学生真实信息'], needs: ['15:00 前确认学员与课时（如签约时未答）', '15:30 看一眼大纲方向（15:45 未答按方案 A 继续）'], budget: ['约 60 次模型调用', '全部免费模型', '超时：交付当前最好版本'] },
  f: { will: ['18:00 前给你一张简报卡', '按路况提醒出发', '饭后问你一句"怎么样"并整理记录'], wont: ['不订位、不付款', '不给小王发消息'], needs: ['无'], budget: ['地图查询约 6 次'] },
  b: { will: ['21:00 前给你步骤卡与物料清单', '你拍照时看进度并给出下一步建议', '关键步骤计时提醒'], wont: ['不替你下单配件', '不保存照片原图到云端（可选仅本机处理）'], needs: ['做的过程中随手拍一下（可选）'], budget: ['看图约 4 次', '生图 1 张（成品效果图）'] },
  s: { will: ['什么都不做'], wont: ['不推送', '不安排任务'], needs: ['无'], budget: ['0'] },
};

/** 系统默认禁止项（PRD §8.1：不可被合同覆盖；prototype L303） */
export const SYS_WONT = '系统禁止：付款下单 · 以你名义发送（除非逐次确认）· 读取凭据 · 删除文件';

// 执行剧本（prototype L306-322 原文；tm 为分钟数，前置计算）
export const script = [
  { t: '13:30', b: 'r', seg: ['13:30', '14:05', 'r', '检索 ×3'], text: '研究员 ×3 开始检索（政策 / 课堂实践 / 教师培训分头找）', why: '合同允许提前 30 分钟准备；三路并行去重后合并', icon: '🔎' },
  { t: '13:44', b: 'r', text: '找到 23 个来源，保留 9 个（剔除：广告 6 · 过期 5 · 重复 3）', why: '规则：2024 年以前的政策文件仅作背景；营销稿不作为证据', icon: '🗂' },
  { t: '13:55', b: 'r', need: { id: 'n1', title: '确认研究受众', body: '我按"国内 K12 · 初中教师"来写，对吗？', opts: ['对', '改成高中'], due: '14:00', def: '按"对"继续' }, icon: '✋' },
  { t: '14:05', b: 'r', seg: ['14:05', '14:40', 'w', '写作 第 1–5 节'], text: '写作者开始合成第 1–5 节', why: '按预演大纲；每段结论必须挂来源', icon: '✍️' },
  { t: '14:30', b: 'r', seg: ['14:30', '14:42', 'v', '核验'], text: '校对员核验 9 个引用：8 个通过，1 处数据与来源不符（教师培训覆盖率），已退回修改', why: '验证与写作使用不同模型，降低自我认同偏差', icon: '🧪' },
  { t: '14:46', b: 'r', text: '写作者已修正该处并重新核验：9/9 通过', icon: '✅' },
  { t: '14:52', b: 'r', seg: ['14:52', '15:00', 'd', '交付'], text: '研究报告 v1 已交付，等你验收', icon: '📦', deliver: 'r' },
  { t: '15:00', b: 'c', seg: ['15:00', '15:25', 'g', '规划 4 课时'], text: '课程设计 agent 开始：引用研究报告第 2、3 节作为依据', why: '跨块依赖：课程设计依赖研究结论（交付台连线）', icon: '🧭' },
  { t: '15:28', b: 'c', need: { id: 'n2', title: '大纲方向', body: 'A：每课时 1 个动手活动（偏实操）；B：前 2 课时讲概念、后 2 课时做项目（偏系统）', opts: ['A', 'B'], due: '15:45', def: '按 A 继续' }, icon: '✋' },
  { t: '15:46', b: 'c', seg: ['15:46', '16:35', 'w', '活动卡 ×4'], text: '设计者开始写 4 张活动卡与课时表', icon: '✍️' },
  { t: '16:35', b: 'c', seg: ['16:35', '16:50', 'v', 'DoD 检查'], text: 'DoD 逐条检查 6/6 通过（受众匹配、课时数、每课时有评估……）', icon: '🧪' },
  { t: '16:52', b: 'c', seg: ['16:52', '17:00', 'd', '交付'], text: '课程方案 v1 已交付，等你验收', icon: '📦', deliver: 'c' },
  { t: '17:40', b: 'f', seg: ['17:40', '18:00', 'r', '简报'], text: '向导整理行前简报：要点 3 条 + 带什么', icon: '🗺' },
  { t: '18:10', b: 'f', text: '路况变差：建议 18:20 出发（原 18:25）', why: '高德路线重算，地铁 2 号线晚高峰拥挤', icon: '🚇' },
  { t: '18:20', b: 'f', seg: ['18:20', '18:55', 'u', '出发 · 在路上'], need: { id: 'n3', title: '该出发了', body: '18:20 出发，19:00 到。上次借的书别忘了。', opts: ['知道了', '晚 10 分钟'], due: '18:25', def: '不再提醒' }, icon: '⏰' },
].map((s) => ({ ...s, tm: T(s.t) }));

// 分镜事件（prototype L415-418；[at, icon, text, you?]）
export const storyEvents = [
  ['13:30', '🔎', '研究员先找资料'], ['13:55', '✋', '你确认受众', true], ['14:30', '🧪', '核验引用'], ['14:52', '📦', '研究交付'],
  ['15:00', '🧭', '课程接力'], ['15:28', '✋', '你选大纲方向', true], ['16:35', '🧪', 'DoD 检查'], ['16:52', '📦', '课程交付'],
];

/** 旁白六句（prototype L426-433；patched 变体引用四课时工作坊与初中老师） */
export const narration = (patched) => [
  '下午一点半，我先派三个研究员分头找资料。',
  `两点前需要你确认一下受众${patched ? '，我理解是国内初中老师' : ''}，三十秒就好。`,
  '两点半我会让另一个模型逐条核对引用，三点前你会拿到一份带来源的研究报告。',
  `三点开始做课程设计，直接用研究结论${patched ? '，按四课时工作坊来排' : ''}。`,
  '三点半我会请你在两个大纲方向里选一个，十五分钟没回我就按方案 A 继续。',
  '五点前交付课程方案。全程不发给任何人，不读你的邮箱，只用免费模型。',
];

/** 样张（prototype L354-364；kind ∈ cover/slide/img/route，img 带 src 相对 ui/assets/） */
export const samplesFor = (id) => {
  if (id === 'r') return [{ kind: 'cover', cap: '报告封面与首页 · 代码排版 + 配图（z-image-turbo 3.9s）' }];
  if (id === 'c') return [
    { kind: 'slide', cap: '第 2 课时首页 · <b>文字由代码排版</b>，配图 z-image-turbo 3.9s（零错字、可编辑）' },
    { kind: 'img', src: 'slide-qwen.jpg', cap: '整页由 qwen-image-2.0 生成 7.4s · 图中中文也能写对，但不可编辑' },
  ];
  if (id === 'f') return [{ kind: 'route', cap: '行前简报卡 · 路线与出发时刻（高德）' }];
  if (id === 'b') return [{ kind: 'img', src: 'bookshelf-done.jpg', cap: '成品效果图 · z-image-turbo 3.8s' }];
  return [];
};

/** 「需要你」集合（由剧本 need 行派生，附所属块 b；prototype L309/315/321） */
export const needs = script.filter((s) => s.need).map((s) => ({ ...s.need, b: s.b }));

/** 追踪层纯文本（OTel GenAI 命名 span 树；prototype L493-504 / PRD §10.5） */
export const traceText = 'invoke_agent block            mission=m_r  contract={{contract}}  13:30–14:58\n├─ invoke_agent researcher#1  order=wo_1  budget 8 calls      13:30–13:52\n│  ├─ execute_tool web.search  grant=g_web  ✓ 11 results       0.8s\n│  └─ chat deepseek-v4.1-flash-fast  in 3.1k / out 0.6k       2.9s\n├─ invoke_agent researcher#2  …                               13:30–13:50\n├─ invoke_agent researcher#3  …                               13:31–13:49\n├─ donego.need n1  受众确认  waited 4m  → 「对」\n├─ invoke_agent writer        order=wo_4  budget 14 calls     14:05–14:46\n│  └─ chat kimi-k3  in 18.2k / out 4.4k                       41.0s\n├─ invoke_agent verifier      order=wo_5  (异构模型)           14:30–14:46\n│  └─ execute_tool cite.check  ✓ 8  ✗ 1 → 退回 writer\n└─ merge artifact a_r v1  → ready                              14:52';


// ---- 契约段（M21 对齐 W0 FROZEN v1 / PRD §10.3）：schema-true 构子 ----
// storyboard：at/actor/text（you 事件以 actor:'you' 标记，schema additionalProperties:false 不收 you 布尔）
const STORYBOARD = storyEvents.map(([at, icon, text, you]) => (you ? { at, actor: 'you', text } : { at, actor: icon, text }));
// narration：契约是整段散文串（PRD L753 样例）；demo 的逐句数组仍由顶层 narration() 提供（TTS 用）
const narrOf = (patched) => narration(patched).join('');
// boundary：will/wont/needs 字符串数组 + budget 整段串（PRD L754）
const boundaryOf = (id) => {
  const { will, wont, needs, budget } = boundaries[id];
  return { will, wont, needs, budget: budget.join('；') };
};
const reelOf = (id) => ({ composition: `/api/previews/m_${id}/v1/reel.html`, durationSec: 42, narrationAudio: `/api/previews/m_${id}/v1/narration.mp3`, mp4: null });
const SCENE = { status: 'off', model: 'happyhorse-1.1-t2v', url: null }; // D-9 场景片默认关

/**
 * 预演 JSON（prototype L260-294 → PRD §10.3 字段名；patched 两态）。
 * confidence 为 PRD §10.3 口径 0–1（L742 样例 0.72；W0 preview.schema.json minimum 0 maximum 1）；
 * prototype 屏显 64%/78% 由 app.js 显示层 ×100 取整还原（M21 契约对齐）。
 */

export const preview = (id, opts = {}) => {
  const patched = !!(opts && opts.patched);
  const outlineItems = patched ? [
    { h: '政策与标准', q: '2024–2026 国家与地方对中小学 AI 教育提出了什么要求？', d: 'chg' },
    { h: '课堂实践', q: '初中阶段常见的 AI 教学活动形态与课时安排？', d: 'add' },
    { h: '教师准备度', q: '一线教师最缺的能力与培训供给？', d: 'add' },
    { h: '海外案例', q: '美国、芬兰的 AI 课程框架', d: 'del' },
    { h: '可落地建议', q: '对一个 4 课时教师工作坊意味着什么？', d: 'add' },
  ] : [
    { h: '政策与标准', q: '各国对 AI 教育提出了什么要求？' },
    { h: '市场与产品', q: '主要 AI 教育产品与商业模式' },
    { h: '海外案例', q: '美国、芬兰的 AI 课程框架' },
    { h: '趋势判断', q: '未来 2–3 年的变化' },
  ];
  const kv = (pairs) => pairs.map(([k, v]) => ({ k, v }));
  if (id === 'r') return {
    missionId: 'm_r', version: 1,
    confidence: patched ? 0.78 : 0.64,
    shape: { kind: 'report', title: '研究报告 · 目录骨架', blocks: [
      { type: 'outline', items: outlineItems },
      { type: 'facts', items: kv([['来源范围', patched ? '教育部及省市官网、公开论文、主流媒体（仅国内）' : '公开网页、论文、媒体（国内外）'], ['预计篇幅', '约 3000 字 · 7–12 个引用'], ['可信度', '每条结论标注来源与可信度']]) },
      { type: 'caveat', text: '无法访问付费数据库（知网全文等），改用公开来源；实际引用数取决于检索结果。' },
    ] },
    storyboard: STORYBOARD, narration: narrOf(patched), boundary: boundaryOf('r'),
    ...(patched ? { diff: { changed: ['shape.blocks[0]', 'shape.blocks[1]'], reason: '你说只看国内 K12：新增课堂实践与教师准备度，删除海外案例，来源范围仅国内' } } : {}),
    samples: [], reel: reelOf('r'), scene: SCENE,
  };
  if (id === 'c') return {
    missionId: 'm_c', version: 1,
    confidence: patched ? 0.7 : 0.48,
    shape: { kind: 'course', title: '课程方案 · 课时表与样张', blocks: [
      { type: 'table', head: ['课时', '目标', '活动', '评估'], rows: patched ? [
        ['1', '认识生成式 AI：能做什么、不能做什么', '人机对比小实验', '课堂小测'],
        ['2', '用 AI 备课：提示词与核对', '现场改写一份教案', '教案互评'],
        ['3', '课堂活动设计：学生如何安全使用 AI', '设计一个 15 分钟活动', '活动卡展示'],
        ['4', '评价与伦理：作业、诚信与隐私', '案例辩论', '个人行动计划'],
      ] : [['?', '单元结构取决于学员与课时', '—', '—']] },
      ...(patched ? [{ type: 'sample', text: '第 2 课时活动卡（样张）：**15 分钟改教案** —— 每组拿一份真实七年级物理教案，用 AI 生成 3 个导入问题；对照课标逐条核对，删掉不准确的；最后每组用 1 分钟说"AI 帮了哪、错在哪"。' }] : []),
      { type: 'caveat', text: patched ? '课程将引用 14:00 研究报告的结论；如研究延期，课程设计顺延开始。' : '需要你告诉我：学员是谁、几课时、什么形式。' },
    ] },
    storyboard: STORYBOARD, narration: narrOf(patched), boundary: boundaryOf('c'),
    ...(patched ? { diff: { changed: ['shape.blocks[0]', 'shape.blocks[1]'], reason: '课程改为 4 课时工作坊（样张：15 分钟改教案）' } } : {}),
    samples: [], reel: reelOf('c'), scene: SCENE,
  };
  if (id === 'f') return {
    missionId: 'm_f', version: 1, confidence: 0.82,
    shape: { kind: 'brief', title: '交付内容', blocks: [
      { type: 'facts', items: kv([['出发', '18:25 从家出发（地铁 32 分钟，按当前路况）'], ['要点', '他上周说在找新工作；你想聊 Argus 的合作'], ['带什么', '上次借的书']]) },
      { type: 'caveat', text: '不会替你订位或付款；餐厅只给 2 个备选。' },
    ] },
    storyboard: [], narration: '', boundary: boundaryOf('f'),
    samples: [], reel: reelOf('f'), scene: SCENE,
  };
  if (id === 'b') return {
    missionId: 'm_b', version: 1, confidence: 0.76,
    shape: { kind: 'guide', title: '步骤与物料', blocks: [
      { type: 'facts', items: kv([['物料', '侧板 2 · 隔板 3 · 螺丝 12 · 木胶 · 夹子 2'], ['步骤', '7 步，预计 45 分钟（第一次做 +15 分钟余量）'], ['关键点', '第 3 步上胶后要夹紧固化 15 分钟再拧螺丝']]) },
      { type: 'caveat', text: '效果图是示意；实际木纹与尺寸以你的套件为准。' },
    ] },
    storyboard: [], narration: '', boundary: boundaryOf('b'),
    samples: [], reel: reelOf('b'), scene: SCENE,
  };
  return { // s：零打扰
    missionId: 'm_s', version: 1, confidence: 1,
    shape: { kind: 'stillness', title: '交付内容', blocks: [
      { type: 'facts', items: kv([['agent 行为', '无。这段时间不推送、不安排任务。']]) },
      { type: 'caveat', text: '这是你的时间。' },
    ] },
    storyboard: [], narration: '', boundary: boundaryOf('s'),
    samples: [], reel: reelOf('s'), scene: SCENE,
  };
};
