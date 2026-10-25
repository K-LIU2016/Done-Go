// web/story/definitions.js — 每个指标的口径卡文本（SPEC design/story-recap/
// SPEC.md §1.3 求真：每个数字都可以长按查看口径和数据来源——数据源、计算
// 方式、样本数；红线：口径卡与数据一一对应、省时只统计本人确认过的、
// 不夸大、不与他人在同频之外做排名、不使用「留白」一词）。
//
// 纯文本模块：无计算、无 IO；键集合恰好覆盖 web/story/stats.js 输出的全部
// 块与 song 子字段（外加章节变体 variant），由 tests/unit/story-
// definitions.test.mjs 钉死一一对应。键语法对齐 contracts.js 的
// METRIC_KEY_RE（^[a-zA-Z][a-zA-Z0-9.]{0,39}$），poster metricKeys 可直接引用。
//
// 数据源命名（SPEC §6，全部本地）：
//   账本  = tango-donego.web.v1 的 entries（旧账本 + 语音/首页新增事项）
//   接力  = tango-donego.relay.v2 的接力记录（用法、自评、毕业、应用）
//   章节存储 = tango-donego.story.v1（上一章的事数与心愿从这读）

export var METRIC_DEFINITIONS = {
  totals: {
    title: '开篇数字',
    source: '账本事项 + 上一章（章节存储）',
    method: '本期事项总数、其中标记「用了 AI」的条目数，以及与上一章同类数字的环比。三个子数字各有口径，见下。',
    samples: '本期 N 条事项、上一章 M 条',
  },
  'totals.events': {
    title: '事项总数',
    source: '账本事项（按章节期间的本地日期筛选，含首尾两天）',
    method: '期间内记下的账本条目数。六个类别都算（必要、创造、连接、探索、恢复、自己的时间），含未完成和静驻，不含被清洗掉的无效条目。',
    samples: '样本即本期全部事项条目',
  },
  'totals.aiRelays': {
    title: 'AI 接力数',
    source: '账本事项上的 AI 标记（entry.ai.used）',
    method: '本期事项中标记「用了 AI」的条目数，即页面上的金色圆点。按事项计，不按接力次数计。',
    samples: '本期 N 条事项中标记 AI 的 M 条',
  },
  'totals.prevEvents': {
    title: '上一章事项数',
    source: '章节存储里上一章的 stats.totals.events',
    method: '直接读取上一章保存的数字，不重算，保证与上一章翻开时看到的完全一致。没有上一章时不显示。',
    samples: '上一章 1 个数字',
  },
  'totals.delta': {
    title: '环比',
    source: '本期事项数 − 上一章事项数',
    method: '两个数字相减。正数是多做的，负数是少做的，不做好坏评价。没有上一章时为空。',
    samples: '本期与上一章各 1 个数字',
  },
  kindMinutes: {
    title: '时间的颜色',
    source: '账本事项',
    method: '把每件事的计划时长（完成记录里的原计划分钟优先，否则按结束−开始，负值按 0）累加到六个类别；色块高度=该类分钟÷全部分钟。类别顺序固定：必要、创造、连接、探索、恢复、自己的时间。',
    samples: '本期 N 条事项的计划时长，合计 X 分钟',
  },
  topDay: {
    title: '最特别的一天',
    source: '账本事项',
    method: '本期事项条目数最多的一天；并列时取更早的一天。时间线按开始时间排序，超过 24 条时取最早开始的 24 条。',
    samples: '当天 M 条事项',
  },
  'topDay.events': {
    title: '最忙一天的事数',
    source: '账本事项（同最特别的一天）',
    method: '本期事项条目数最多那一天的事数。并列时取更早的一天。',
    samples: '当天 M 条事项',
  },
  'topDay.timeline': {
    title: '当天时间线',
    source: '账本事项',
    method: '最忙一天的事项按开始时间排序展示；超过 24 条时取最早开始的 24 条并注明「等 N 件事」。事项名是你自己写下的原文。',
    samples: '当天 M 条事项',
  },
  'topDay.warmIndex': {
    title: '温暖的事',
    source: '账本事项',
    method: '当天时间线里最晚的一条「连接」或「恢复」类事项的位置，作为结语素材。当天没有这两类事项时为空。',
    samples: '当天 M 条事项中的 1 条',
  },
  lessons: {
    title: '学会的用法',
    source: '接力记录 + 用法目录',
    method: '新学会=该用法第一次成功接力（失败的尝试不算）落在本期，按记录时刻的本地日期判断；使用次数=本期该用法的成功接力次数。名称取用法目录，目录里没有时显示用法 ID。最多列 12 个，按次数排序。',
    samples: '本期成功接力 R 条',
  },
  'lessons.learned': {
    title: '新学会的用法',
    source: '接力记录 + 用法目录',
    method: '本期新学会的用法列表：每个用法第一次成功接力（失败尝试不算）落在本期才算新学会。奖章按本期使用次数排序，只用过 1 次的置灰。',
    samples: '本期成功接力 R 条',
  },
  'lessons.firstGraduation': {
    title: '第一次毕业',
    source: '接力记录（graduated=true 且带毕业应用，含期间外全部历史）',
    method: '每个应用生平第一条毕业记录；只有当这个「生平第一次」恰好落在本期时才展示日期、时刻与应用。同一应用更早的毕业已在上期说过，本期不再重复自称「第一次」。',
    samples: '全部历史里每个应用的第 1 条毕业',
  },
  savedTime: {
    title: '省下的时间',
    source: '账本静驻（stillness）事项的预留与使用确认',
    method: '只统计本人确认过的：预留状态为「已用/部分用」且确认分钟是 0 到预留时长之间的整数才计入；未确认、已让渡、确认分钟超出预留时长的一律不计。合计=所有确认分钟之和。',
    samples: '本期静驻 S 条，其中本人确认 C 条',
  },
  'savedTime.confirmedMinutes': {
    title: '确认省时合计',
    source: '账本静驻（stillness）事项的确认',
    method: '只统计本人确认过的分钟数（「已用/部分用」且确认分钟在 0 到预留时长之间）；未确认、已让渡或确认超限的一律不计。页面主数字 = 合计小时。',
    samples: '本期静驻 S 条，其中本人确认 C 条',
  },
  'savedTime.allocations': {
    title: '省时去向',
    source: '同上（确认分钟的去向类别）',
    method: '按确认时选择的使用类别（use）累加确认分钟；没选类别的计入「自己的时间」。条形按分钟从多到少排列。只呈现本人确认过的部分。',
    samples: '本期确认的 C 条记录',
  },
  rhythm: {
    title: '节律',
    source: '账本事项',
    method: '按事项开始时刻做 24 小时热力计数；黄金时段=计数最高的整点。子项各有口径，见下。',
    samples: '本期 N 条事项的开始时刻',
  },
  'rhythm.hourly': {
    title: '24 小时热力',
    source: '账本事项的开始时刻',
    method: '每件事按开始时间的整点计入 24 格之一；24:00 开始的计入 23 点档。只看开始时刻，不看时长。',
    samples: '本期 N 条事项',
  },
  'rhythm.goldenHour': {
    title: '黄金时段',
    source: '同上（24 小时热力）',
    method: '热力计数最高的那个整点；并列时取更早的小时。本期没有事项时为空。',
    samples: '本期 N 条事项',
  },
  'rhythm.genre': {
    title: '时间流派',
    source: '与「同频」分支共用的流派规则（规则可解释）',
    method: '流派算法与同频共用，同频线尚未定稿落地，本章如实为空，不用近似规则顶替；接入方式待 CTO 裁决。',
    samples: '暂无（待同频算法接入）',
  },
  panels: {
    title: '四格',
    source: '账本事项',
    method: '月章按自然周（周一为一周之始）把期间切成格，年章按日历月；跨 13 个月的周年书把第 13 格并入第 12 格。每格文案是事实描述（该格事项数与 AI 接力数），是 AI 润色前的模板兜底，可以编辑。',
    samples: '期间切成 K 格，每格按该格事项计数',
  },
  keywords: {
    title: '关键词',
    source: '账本事项的标题',
    method: '无词典的朴素分词：标题按常见虚词切出 2–4 字词组；5 字及以上的长标题只取在 2 个以上不同标题里出现过的 2–3 字片段；英文按单词。同一标题重复出现只计一次。按出现的不同标题数排序（并列取更长、再按字典序），去掉相互包含的重复后取前 6。样本不足时宁缺毋滥。',
    samples: '本期 N 个不同标题',
  },
  wishEcho: {
    title: '写给下一章',
    source: '章节存储里上一章的心愿 + 两期账本',
    method: '可量化心愿用数据回应：早睡=有记录且最后一件事在 24 点前结束的天数；运动=恢复类计划时长；学习=新学会用法数+探索类时长；陪伴=连接类时长；都给出上一期对照。不可量化的心愿只温柔复述，不编数据。',
    samples: '本期与上一期各按其期间统计',
  },
  song: {
    title: '配乐输入',
    source: '本章统计（上述各块）',
    method: '数据作曲的五个输入：忙碌度、自评、主导类别、每周事项数、每周毕业数。映射规则（速度、调式、音色）见 soundtrack 契约。子项各有口径，见下。',
    samples: '随各子项',
  },
  'song.busyness': {
    title: '忙碌度',
    source: '账本事项（只用本期之前的个人历史）',
    method: '本期每天事项数，在个人历史里「有记录的日子」的每天事项数中占的分位（0–1）。没有历史（第一章）时取 0.5。期间之后的数据不参与。',
    samples: '历史 H 个有记录的日子',
  },
  'song.mood': {
    title: '自评',
    source: '接力记录的自评（省了不少/省了一点/没省时间）',
    method: '本期成功接力中自评「省了不少」的占比（0–1）。本期没有带自评的接力时取 0.5。',
    samples: '本期带自评的成功接力 R 条',
  },
  'song.dominantKind': {
    title: '主导类别',
    source: '时间颜色（六类计划时长）',
    method: '计划时长最大的类别；并列取固定顺序在前者；本期时长全为 0 时按事项数；完全零数据时取「必要」。',
    samples: '本期 N 条事项',
  },
  'song.weeklyCounts': {
    title: '每周事项数',
    source: '账本事项',
    method: '按周一为一周之始的自然周计数本期事项（第 1 周从包含期间首日的周开始）。年章超过 53 周时，多出的周并入最后一周。',
    samples: '期间切成 K 周',
  },
  'song.graduations': {
    title: '每周毕业',
    source: '接力记录（graduated=true）',
    method: '与每周事项数同一套周切分，数每周的毕业记录数。每次毕业会在当周配乐里加一声钟琴。',
    samples: '期间切成 K 周',
  },
  variant: {
    title: '章节变体',
    source: '本期事项总数',
    method: '本期事项少于 5 件时只生成 3 页短章，写明「这个月记得不多，下一章一起写满一点」，不硬凑成完整篇幅。',
    samples: '本期 N 件，阈值 5 件',
  },
  year: {
    title: '年度专属数据',
    source: '账本事项（+ 事项上的 AI 标记）',
    method: '年书专属的三个统计：逐月时间光谱（每月事项数与六类分钟占比）、年度第一件/最后一件事、最长连续接力段。子项各有口径，见下。',
    samples: '期间切成 K 个月',
  },
  'keywords.top': {
    title: '关键词榜',
    source: '账本事项的标题（同关键词）',
    method: '同「关键词」口径（朴素分词 + 去停用 + 去包含重复），年书页取 Top 10，月章四格页取 Top 6。',
    samples: '本期 N 个不同标题',
  },
  'year.months': {
    title: '逐月时间光谱',
    source: '账本事项（按章节期间逐日历月分桶）',
    method: '期间覆盖的每个日历月一行：该月事项数与六类计划时长占比；跨 13 个月时多出的月份并入第 12 格。色带高度 = 该类分钟 ÷ 该月全部分钟。',
    samples: '期间切成 K 个月',
  },
  'year.first': {
    title: '年度第一件事',
    source: '账本事项',
    method: '期间内按日期 + 开始时间最早的一条事项，展示日期、开始时刻、事项名与类别（含是否交给 AI）。',
    samples: '期间第 1 条事项',
  },
  'year.last': {
    title: '年度最后一件事',
    source: '账本事项',
    method: '期间内按日期 + 结束时间最晚的一条事项（并列取开始更晚的），展示口径同第一件事。',
    samples: '期间最后 1 条事项',
  },
  'year.streak': {
    title: '最长连续接力',
    source: '账本事项上的 AI 标记（entry.ai.used）',
    method: '连续每天至少 1 件交给 AI 的事项的最长一段；天数 = 起止日期差 + 1，累计次数 = 段内 AI 事项总数。没有连着两天以上的段时不展示（页面如实说明「没有连成串」）。',
    samples: '段内 D 天 / R 次 AI 事项',
  },
  'year.streak.days': {
    title: '连续天数',
    source: '同「最长连续接力」',
    method: '最长一段连续日的天数（起止日期差 + 1 的真值守卫，见「最长连续接力」）。',
    samples: '段内 D 天',
  },
  'year.genres': {
    title: '年度流派变化',
    source: '逐月流派（拟扩展形状 stats.year.months[].genre）',
    method: '逐月流派与同频分支共用规则；同频线尚未定稿落地，当前逐月如实为空、只展示年度卡，不用近似规则顶替。',
    samples: '暂无（待同频算法接入）',
  },
  'poster.title': {
    title: '海报标题',
    source: '本章统计 + 文案模板（可编辑 captions）',
    method: '与封面同章同题：模板按「有确认省时 → 省时句」「生平第一次毕业 → 第一棒句」等条件选取，可编辑、可 AI 润色（润色输入只有统计数字）。',
    samples: '本章 1 句标题',
  },
  'poster.metric': {
    title: '海报数字格',
    source: '本章统计（契约 metricKeys 白名单键）',
    method: '海报页 4 个数字由契约 params.metricKeys 指定（默认：事项总数 / AI 接力数 / 新用法数 / 流派）；每个数字长按可见它自己的口径。流派在同频线定稿前为空格「—」。',
    samples: '本章 4 个数字',
  },
};

// 前缀别名：页面发出的派生键（kindMinutes.create / savedTime.allocations.restore /
// rhythm.hourly.8 / panels.2 / keywords.论文 / wishEcho.fact.早睡天数 …）回落到
// 对应块口径——口径卡与数据一一对应（SPEC §1.3），绝不因键名变体显示「暂无」。
var PREFIX_ALIASES = [
  { prefix: 'kindMinutes.', key: 'kindMinutes' },
  { prefix: 'savedTime.allocations.', key: 'savedTime.allocations' },
  { prefix: 'rhythm.hourly.', key: 'rhythm.hourly' },
  { prefix: 'panels.', key: 'panels' },
  { prefix: 'keywords.', key: 'keywords' },
  { prefix: 'wishEcho.fact.', key: 'wishEcho' },
  { prefix: 'year.spectrum.', key: 'year.months' },
];

export function definitionFor(key) {
  var d = METRIC_DEFINITIONS[key];
  if (!d) {
    var name = String(key == null ? '' : key);
    for (var i = 0; i < PREFIX_ALIASES.length; i += 1) {
      if (name.indexOf(PREFIX_ALIASES[i].prefix) === 0) {
        d = METRIC_DEFINITIONS[PREFIX_ALIASES[i].key];
        break;
      }
    }
  }
  if (!d) return null;
  return { title: d.title, source: d.source, method: d.method, samples: d.samples };
}

export function definitionKeys() {
  return Object.keys(METRIC_DEFINITIONS);
}
