// web/relay/i18n.js — AI 接力 v2 文案集中地（SPEC design/relay-v2/SPEC.md §6 多语言）。
//
// L10多语言 line deliverable. Every relay v2 UI string lives here; view
// modules (web/relay/home.js, baton.js, …) keep zh defaults for standalone
// use, and the integration line overrides them from this module:
//   createHome({ copy: copyGroup(lang, 'home'), speechLang: speechLangFor(lang) })
//   createBaton({ strings: copyGroup(lang, 'baton') })   // baton.js options.strings
//   applyLangToDocument(document, lang)                   // on language change
// Zh wording is the prototype's verbatim (design/relay-v2/prototype.html
// sections #s-home…#s-fail + shots/m-*.png / d-*.png); states the prototype
// does not cover are worded from SPEC §4 and marked below.
//
// Languages: zh default + en complete (SPEC §6 先做 zh 和 en); ru/th/ar/ko are
// recognized but resolve to the en dictionary (其余语言回退到 en). The set
// mirrors the app shell LANGS (web/index.html:3378) and shares its storage
// key 'tango-donego.lang' (web/index.html:3381) so one pick drives the whole
// app. ar is the only RTL language: direction is carried by the dir attribute
// on <html> (applyLangToDocument), exactly like the v1 shell applyLang
// (web/index.html:3599-3600); relay.css (skeleton line) must use logical
// properties so the mirrored layout does not break.
//
// Enum-keyed groups align 1:1 with web/relay/contracts.js — never redefined:
//   RATINGS   → ratings          (§1.5 三档自评 / §5.4 rating)
//   FAIL_TYPES → fail.reasons    (§4⑧ 未配置/超时/限流/上游失败/格式错误)
//   PERSONAS  → personas         (§4① 学生/老师/上班族/长辈)
//   CATEGORIES → discover.categories (§4⑥ 写/读/整理/计划/翻译/生活)
// tests/unit/rv2-i18n.test.mjs enforces the parity; the metric counters
// (§5.5 rate:<rating>, relay_fail:<type>) reuse the same enum ids, so a
// button labelled by copy.ratings.much emits rate:much — labels and events
// cannot drift apart.
//
// Pure module: no DOM access at import time, no storage IO — applyLangTo
// Document takes the document as an argument. Directly importable by
// `node --test` and by the browser via dynamic import(), like contracts.js.
//
// D3: no string here shows model-estimated minutes (SPEC §1.5); elapsed-time
// copy uses 秒/seconds only.

// ---------------------------------------------------------------------------
// Language set — mirrors web/index.html:3378 LANGS.
// ---------------------------------------------------------------------------
export var RELAY_LANGS = ['zh', 'en', 'ru', 'th', 'ar', 'ko'];
export var RELAY_DEFAULT_LANG = 'zh';
// Same key the shell already persists (web/index.html:3381); relay never
// introduces a second language preference.
export var RELAY_LANG_STORAGE_KEY = 'tango-donego.lang';

// SPEC §6: 阿拉伯语从右到左. Only ar is RTL among the supported set.
export var RTL_LANGS = ['ar'];

// <html lang> values mirror the v1 applyLang map (web/index.html:3599).
var HTML_LANGS = { zh: 'zh-CN', en: 'en', ru: 'ru', th: 'th', ar: 'ar', ko: 'ko' };
// Speech transcription locales mirror web/index.html:3379 SPEECH_LANG,
// consumed by home.js via its speechLang option.
var SPEECH_LANGS = { zh: 'zh-CN', en: 'en-US', ru: 'ru-RU', th: 'th-TH', ar: 'ar-SA', ko: 'ko-KR' };

// ---------------------------------------------------------------------------
// Dictionaries. Keys are stable API — views and tests reference them by
// dotted path ('match.send'). Placeholders use {name} and are filled by tr();
// an unknown placeholder is left visible on purpose (gaps must surface).
// ---------------------------------------------------------------------------

export var RELAY_COPY = {
  zh: {
    // App shell (SPEC §2; prototype header + mobile tabbar + guest badge).
    shell: {
      appName: '探戈',
      appSub: 'Done&Go',
      docTitle: '探戈 Done&Go',
      tabStart: '开始',
      tabMe: '我的用法',
      tabDiscover: '发现',
      guest: '访客',
      more: '更多',
      login: '登录',
    },
    // 三步接力 step bar (SPEC §1.2; prototype #s-match .steps).
    steps: {
      s1: '说清楚',
      s2: 'AI 先做',
      s3: '你来接棒',
      doneMark: '✓',
    },
    // Keys mirror HOME_COPY in web/relay/home.js 1:1 (values identical to the
    // view defaults) so createHome({copy: copyGroup(lang,'home')}) is a full
    // override. Wording: prototype #s-home / shots m-home.png d-home.png.
    home: {
      hero: '今天要做什么？',
      lead: '说一件手头的事，探戈帮你交给合适的 AI。',
      placeholder: '说一件今天要做的事',
      inputLabel: '今天要做的事',
      submit: '开始',
      segLabel: '我是',
      sectionTitle: '我学会的用法',
      allLink: '全部',
      emptyText: '完成第一次接力，这里会出现你学会的第一个用法',
      micLabel: '语音输入',
      preparing: '准备话筒…',
      listening: '在听…说完会自动停',
      transcribing: '转写中…',
      heardNothing: '没听到声音，再点一次说',
      transcribeFail: '转写未成功 · 点击话筒重试',
      micDenied: '请允许麦克风 · 然后重试',
      micBroken: '无法使用话筒 · 检查设备后重试',
      speechOff: '语音转写暂不可用 · 可以直接打字',
      speechJoin: '，',
    },
    // Keys == contracts.PERSONAS (§4① 人群切换).
    personas: {
      student: '学生',
      teacher: '老师',
      worker: '上班族',
      elder: '长辈',
    },
    // §4② 说清楚 (prototype #s-match / shots m-match.png).
    match: {
      back: '换一件事',
      kicker: '这件事适合交给 AI',
      youSaid: '你说的是：',
      doesLabel: 'AI 会先做',           // SPEC §4②「AI 会先做」三个标签的组标签
      materialNote: '粘贴文字，或直接说',
      toolsSpeak: '说给我听',
      toolsPaste: '从剪贴板粘贴',
      privacy: '点下面的按钮后，这段内容会发给 AI 处理。不包含你的账号信息，不会给任何人看。',
      send: '让 AI 先做一版',
      altPrefix: '不太对？换成',
      altJoin: '或',
      lowConfidenceTitle: '你想让 AI 帮哪一种？', // SPEC §4② 置信度 <0.5
      tooLong: '太长了，先贴最重要的一段',          // SPEC §4② >8000 字
    },
    // §4③ AI 先做（流式）(prototype #s-running; slowHint 原型未覆盖，按 SPEC 补).
    running: {
      title: 'AI 正在整理…',
      timer: '已用 {n} 秒',
      stop: '先停一下',
      note: '一般 5–15 秒。你的内容都留着，随时可以停。',
      slowHint: '它想得有点久，再等一下或换到下面的「自己接力」',
    },
    // §4④ 结果 (prototype #s-result / shots m-result.png d-result.png).
    // 三枚微调 chips 的标签由 SPEC 固定；learned 正文来自场景库，不在此处。
    result: {
      title: 'AI 先做好的一版',
      aiTag: 'AI 生成 · 请你核对',
      copy: '复制',
      edit: '直接改',
      redo: '再来一版',
      tweakShorter: '更短一点',
      tweakFormal: '更正式',
      tweakTime: '加上时间',
      rateTitle: '这次帮上忙了吗？',
      learnedKicker: '你学会了一个新用法',
      guestNudge: '已存到这台设备。{login}后换手机也能看到。',
    },
    // Keys == contracts.RATINGS (§1.5 / §5.4). 😀🙂😐 前缀是语言无关的
    // 表情字形，由视图层加（prototype .rate 的 <span class="e">）。
    ratings: {
      much: '省了不少',
      little: '省了一点',
      none: '没省时间',
    },
    // Keys mirror BATON_STRINGS_ZH in web/relay/baton.js 1:1 (values
    // identical), so baton options.strings is a full override. 应用名（豆包/
    // DeepSeek/…）来自 external-apps.js，是专有名词，不进文案表。
    baton: {
      resultKicker: '接力棒 · 下次你自己来',
      resultTitle: '在你常用的 AI 里，自己做一次',
      resultBody: '复制这段话，粘贴到下面任意一个 AI，再贴上你的会议内容。做到一次，这个用法就真正是你的了。',
      failKicker: '不想等？自己接力',
      failTitle: '把这件事带去豆包，自己做',
      failBody: '复制下面这段话，粘贴到豆包，再贴上你的会议内容。',
      moreApps: '更多',
      fewerApps: '收起',
      appsLabel: '选择外部 AI 应用',
      copy: '复制',
      copyAndOpen: '复制并打开',
      doneLink: '✓ 我自己做到了',
    },
    // §4⑤ 我的用法 (prototype #s-passport / shots m-passport.png)。
    // detailTitle/detailCopy：原型未覆盖的只读详情（SPEC §4⑤ 点开可查看当时
    // 的结果（只读）并复制），按规格补齐。
    passport: {
      title: '我的用法',
      lead: '你和 AI 一起做过的事，都在这里。',
      statLearned: '学会的用法',
      statRelay: '次 AI 接力',
      statGraduated: '次自己做到',
      skillsTitle: '学会的用法',
      relayTimes: '接力 {relay} 次 · 自己做到 {graduated} 次',
      notYetGraduated: '还没自己试',
      doAgain: '再做一次 →',
      tryOnce: '去试一次 →',
      recentTitle: '最近',
      gradBadge: '自己做到',
      today: '今天',
      yesterday: '昨天',
      exportJson: '导出我的记录（JSON）',
      detailTitle: '当时的结果',
      detailCopy: '复制结果',
    },
    // §4⑥ 发现 (prototype #s-discover / shots m-discover.png)。原型示例里的
    // 「备课」是教师人群的样例分组，正典分组以 SPEC §4⑥/contracts 为准。
    // Keys == contracts.CATEGORIES（zh 文本即枚举值本身）。
    discover: {
      title: '发现',
      lead: '挑一件跟你有关的事，点一下就开始。',
      categories: { '写': '写', '读': '读', '整理': '整理', '计划': '计划', '翻译': '翻译', '生活': '生活' },
    },
    // §4⑦ 更多 (prototype #s-more / shots m-more.png)。languageNames 用各语言
    // 的自称（两种字典里相同，不随界面语言翻译）。
    more: {
      title: '更多',
      account: '账号',
      accountGuest: '访客 · 去登录',
      goLogin: '去登录',
      language: '语言',
      appearance: '外观',
      appearanceStandard: '标准',
      aiUsed: '我们用了哪些 AI',
      aiUsedNote: '说明与出处',
      privacyData: '隐私与数据',
      privacyNote: '导出 · 删除',
      exportData: '导出',
      deleteData: '删除本机记录',
      labTitle: '实验室（早期功能，不影响主流程）',
      labTime: '时间记录与回顾',
      labAgreements: '约定与小组',
      labOldTag: '旧版',
      languageNames: { zh: '中文', en: 'English', ru: 'Русский', th: 'ไทย', ar: 'العربية', ko: '한국어' },
    },
    // §4⑧ 失败态 (prototype #s-fail / shots m-fail.png)。
    // reasons 的 keys == contracts.FAIL_TYPES；同一 id 也用于 relay_fail:<type>
    // 漏斗计数与记录的 failed 字段，文案与事件不可能错位。
    fail: {
      title: 'AI 这次没接上',
      notYourFault: '不是你的问题。',
      kept: '你填的内容都还在。',
      retry: '再试一次',
      reasons: {
        unconfigured: 'AI 暂时没开，先自己接力试试',
        timeout: '它想得太久了（超过 60 秒）',
        ratelimit: '今天的体验次数用完了，明天再来',
        upstream: 'AI 服务这会儿忙',
        format: 'AI 回答乱了，再试一次',
      },
    },
  },

  en: {
    shell: {
      appName: 'Tango',
      appSub: 'Done&Go',
      docTitle: 'Done&Go',
      tabStart: 'Start',
      tabMe: 'My skills',
      tabDiscover: 'Discover',
      guest: 'Guest',
      more: 'More',
      login: 'Log in',
    },
    steps: {
      s1: 'Describe it',
      s2: 'AI goes first',
      s3: 'You take the baton',
      doneMark: '✓',
    },
    home: {
      hero: 'What do you need to do today?',
      lead: 'Name one thing on your plate. Tango hands it to the right AI.',
      placeholder: 'Type one thing to do today',
      inputLabel: 'One thing to do today',
      submit: 'Start',
      segLabel: 'I am',
      sectionTitle: 'Skills I’ve learned',
      allLink: 'All',
      emptyText: 'Finish your first relay and the first skill you learn will show up here',
      micLabel: 'Voice input',
      preparing: 'Getting the mic ready…',
      listening: 'Listening… it stops when you stop',
      transcribing: 'Transcribing…',
      heardNothing: 'Didn’t hear anything — tap again and speak',
      transcribeFail: 'Transcription failed · tap the mic to retry',
      micDenied: 'Please allow the microphone · then try again',
      micBroken: 'Mic not working · check your device and try again',
      speechOff: 'Speech input unavailable · you can just type',
      speechJoin: ', ',
    },
    personas: {
      student: 'Student',
      teacher: 'Teacher',
      worker: 'Office worker',
      elder: 'Older adult',
    },
    match: {
      back: 'Switch to something else',
      kicker: 'This is a good fit for AI',
      youSaid: 'You said: ',
      doesLabel: 'AI will start with',
      materialNote: 'Paste text, or just speak',
      toolsSpeak: 'Speak it to me',
      toolsPaste: 'Paste from clipboard',
      privacy: 'When you tap the button below, this text goes to an AI service. It contains no account information and is shown to no one.',
      send: 'Let AI make a first draft',
      altPrefix: 'Not quite? Switch to ',
      altJoin: ' or ',
      lowConfidenceTitle: 'Which kind of help do you want from AI?',
      tooLong: 'Too long — paste just the most important part first',
    },
    running: {
      title: 'AI is putting it together…',
      timer: '{n} s so far',
      stop: 'Pause for now',
      note: 'Usually 5–15 seconds. Everything you typed stays here — you can stop any time.',
      slowHint: 'It is taking a while — wait a little, or scroll down and run it yourself',
    },
    result: {
      title: 'A first draft from AI',
      aiTag: 'AI-generated · please check',
      copy: 'Copy',
      edit: 'Edit directly',
      redo: 'Another draft',
      tweakShorter: 'Shorter',
      tweakFormal: 'More formal',
      tweakTime: 'Add dates',
      rateTitle: 'Did this help?',
      learnedKicker: 'You just learned a new skill',
      guestNudge: 'Saved on this device. {login} to see it on your other phone.',
    },
    ratings: {
      much: 'Saved a lot',
      little: 'Saved a little',
      none: 'No time saved',
    },
    baton: {
      resultKicker: 'Relay baton · next time you take it',
      resultTitle: 'Do it once yourself, in an AI you already use',
      resultBody: 'Copy this text, paste it into any AI below, then add your meeting notes. Do it once and this way of working is truly yours.',
      failKicker: 'Don’t want to wait? Take the baton',
      failTitle: 'Take it to Doubao and do it yourself',
      failBody: 'Copy the text below, paste it into Doubao, then add your meeting notes.',
      moreApps: 'More',
      fewerApps: 'Show less',
      appsLabel: 'Choose an AI app',
      copy: 'Copy',
      // Trailing space on purpose: baton.js concatenates the app name after
      // this label (zh needs no space, en does).
      copyAndOpen: 'Copy and open ',
      doneLink: '✓ I did it myself',
    },
    passport: {
      title: 'My skills',
      lead: 'Everything you and AI have done together lives here.',
      statLearned: 'skills learned',
      statRelay: 'AI relays',
      statGraduated: 'done yourself',
      skillsTitle: 'Skills learned',
      relayTimes: 'Relayed {relay} times · did it myself {graduated} times',
      notYetGraduated: 'not tried yourself yet',
      doAgain: 'Do it again →',
      tryOnce: 'Give it a try →',
      recentTitle: 'Recent',
      gradBadge: 'Did it myself',
      today: 'Today',
      yesterday: 'Yesterday',
      exportJson: 'Export my records (JSON)',
      detailTitle: 'The result from that time',
      detailCopy: 'Copy result',
    },
    discover: {
      title: 'Discover',
      lead: 'Pick something that matters to you — one tap to start.',
      categories: { '写': 'Writing', '读': 'Reading', '整理': 'Organizing', '计划': 'Planning', '翻译': 'Translating', '生活': 'Daily life' },
    },
    more: {
      title: 'More',
      account: 'Account',
      accountGuest: 'Guest · log in',
      goLogin: 'Log in',
      language: 'Language',
      appearance: 'Appearance',
      appearanceStandard: 'Standard',
      aiUsed: 'Which AIs we use',
      aiUsedNote: 'Notes and sources',
      privacyData: 'Privacy and data',
      privacyNote: 'Export · delete',
      exportData: 'Export',
      deleteData: 'Delete records on this device',
      labTitle: 'Lab (early features, outside the main flow)',
      labTime: 'Time log and review',
      labAgreements: 'Pacts and groups',
      labOldTag: 'Legacy',
      languageNames: { zh: '中文', en: 'English', ru: 'Русский', th: 'ไทย', ar: 'العربية', ko: '한국어' },
    },
    fail: {
      title: 'AI didn’t catch it this time',
      notYourFault: 'It’s not your fault.',
      kept: 'Everything you entered is still here.',
      retry: 'Try again',
      reasons: {
        unconfigured: 'AI isn’t switched on right now — try the relay baton yourself',
        timeout: 'It thought for too long (over 60 seconds)',
        ratelimit: 'Today’s free tries are used up — come back tomorrow',
        upstream: 'The AI service is busy right now',
        format: 'The AI’s answer came out scrambled — try once more',
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Language resolution.
// ---------------------------------------------------------------------------

// 'zh' | 'en' | 'ru' | 'th' | 'ar' | 'ko'; case-insensitive; accepts BCP-47
// subtags ('zh-CN', 'en_US' → primary). Anything else → null.
export function normalizeLang(value) {
  var raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return null;
  if (RELAY_LANGS.indexOf(raw) !== -1) return raw;
  var primary = raw.split(/[-_]/)[0];
  return RELAY_LANGS.indexOf(primary) !== -1 ? primary : null;
}

// SPEC §6: zh 用中文字典；en 及其余支持语言（ru/th/ar/ko）一律用英文字典；
// 无法识别的输入回落默认语言 zh（与 shell 的 LANG 门禁一致，index.html:3380）。
export function copyForLang(lang) {
  var normalized = normalizeLang(lang) || RELAY_DEFAULT_LANG;
  return normalized === 'zh' ? RELAY_COPY.zh : RELAY_COPY.en;
}

// One group ('home', 'baton', …) as a detached shallow copy, ready to hand to
// createHome({copy}) / baton options.strings. Unknown group → null.
export function copyGroup(lang, group) {
  var dict = copyForLang(lang);
  var node = dict[String(group == null ? '' : group)];
  return node && typeof node === 'object' && !Array.isArray(node) ? Object.assign({}, node) : null;
}

function lookupPath(dict, path) {
  var node = dict;
  var parts = path.split('.');
  for (var i = 0; i < parts.length; i += 1) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[parts[i]];
  }
  return typeof node === 'string' ? node : undefined;
}

// Translate a dotted key ('match.send'). Missing key in the resolved
// dictionary falls back to the other one, then to the key itself (a visible
// gap beats a crash). {name} placeholders are replaced only when a non-null
// value is supplied; unknown placeholders stay visible.
export function tr(lang, key, values) {
  var path = String(key == null ? '' : key);
  if (!path) return '';
  var resolved = copyForLang(lang);
  var other = resolved === RELAY_COPY.zh ? RELAY_COPY.en : RELAY_COPY.zh;
  var text = lookupPath(resolved, path);
  if (text === undefined) text = lookupPath(other, path);
  if (text === undefined) return path;
  if (!values) return text;
  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, function (raw, name) {
    return values[name] == null ? raw : String(values[name]);
  });
}

// ---------------------------------------------------------------------------
// Direction attributes — SPEC §6 阿拉伯语从右到左时布局不能乱。
// The contract is the dir attribute on <html>; relay.css uses logical
// properties so the same sheet mirrors cleanly.
// ---------------------------------------------------------------------------
export function dirForLang(lang) {
  return RTL_LANGS.indexOf(normalizeLang(lang)) !== -1 ? 'rtl' : 'ltr';
}

// <html lang> value ('zh-CN', 'en', …), mirroring web/index.html:3599;
// null for unrecognized input (caller decides; applyLangToDocument degrades
// to the zh default itself).
export function htmlLangForLang(lang) {
  var normalized = normalizeLang(lang);
  return normalized == null ? null : HTML_LANGS[normalized];
}

// Set lang + dir on doc.documentElement. Unrecognized input degrades to the
// zh default rather than throwing, so a bad stored value can never strip the
// direction attribute. Returns {lang, htmlLang, dir}; null when doc has no
// documentElement. Pure with respect to the passed document — no global DOM.
export function applyLangToDocument(doc, lang) {
  var el = doc && doc.documentElement;
  if (!el) return null;
  var normalized = normalizeLang(lang) || RELAY_DEFAULT_LANG;
  var htmlLang = HTML_LANGS[normalized] || HTML_LANGS[RELAY_DEFAULT_LANG];
  var dir = dirForLang(normalized);
  el.lang = htmlLang;
  el.dir = dir;
  return { lang: normalized, htmlLang: htmlLang, dir: dir };
}

// Speech-bridge locale for speech-capture.js, mirroring the shell SPEECH_LANG
// (web/index.html:3379); unknown → zh-CN.
export function speechLangFor(lang) {
  var normalized = normalizeLang(lang);
  return SPEECH_LANGS[normalized] || SPEECH_LANGS[RELAY_DEFAULT_LANG];
}
