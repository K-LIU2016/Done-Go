// web/relay/home.js — AI 接力 v2 开始页（SPEC design/relay-v2/SPEC.md §4①，hash #/start）。
//
// L2开始页 line deliverable. Visual contract: design/relay-v2/prototype.html
// section #s-home (shots m-home.png / d-home.png). The emitted markup uses the
// prototype class names verbatim — hello / h1 / lead / ask / mic / btn pri /
// seg / grid / scene c1-c3 / sec / badges / badge / empty — plus one extra
// `.micnote` live region for speech status. Those styles (and the #i-* SVG
// sprite symbols) live in web/relay/relay.css / the app shell owned by the
// skeleton + integration lines; this module only produces markup + behaviour.
//
// Data shapes come exclusively from web/relay/contracts.js (PERSONAS,
// EVENT_MAX). Never redefined here. All dynamic text is HTML-escaped on the
// way into the view string, like web/ai-relay.js.
//
// Pure exports (greetingFor, normalizePersona, loadPersona, savePersona,
// featuredScenes, sceneIcon, sceneClass, learnedBadges, speechAvailable,
// homeView) carry no DOM/fetch/storage IO and are directly importable by
// `node --test`. createHome(options) returns the controller:
//   { mount(el), unmount(), update({usages, records}), persona() }
//
// Integration hooks (all optional; defaults degrade to hash navigation):
//   onSubmit(eventText)      — 回车/点击"开始"，事件原话（已 trim，≤ EVENT_MAX）
//   onScene({usageId,event}) — 场景卡点击，带预填事件（persona 卡标题）
//   onOpenMe()               — "全部"进入 #/me
//   onMetric(name)           — §5.5 漏斗：start_submit / scene_click
//   copy                     — 文案覆盖（i18n 线接入点；默认 zh 与原型一致）
//   fetchImpl, storage, root, usages, records, now, greeting, speechLang
// Default handoff URLs (no callbacks given):
//   #/relay?event=…          #/relay?usage=…&event=…          #/me
// The exact #/relay query scheme is an integration-line alignment point.
//
// Persona persistence: SPEC §4① 要求记住人群选择，但契约只为 records 定义了
// tango-donego.relay.v2 一个 key。人群选择是 UI 偏好而非记录，存到同前缀的
// 兄弟 key tango-donego.relay.v2.persona（裸字符串），该前缀已被 contracts.js
// 里 D9 scope() 扩展计划覆盖（'relay\\.v2' 同时罩住 .quarantine 与本 key）。
// 访客直接走 localStorage（D5：访客不登录走完全流程），登录后由
// TangoAccountStorage 作用域改写（同 v1 惯例 options.storage || root.TangoAccountStorage || root.localStorage）。
//
// Scene card visuals: the usage schema carries no icon/color slot, so this
// module derives them — icon from category (写→pen 读→doc 整理→notes 计划→list
// 翻译→globe 生活→cal) with a 邮件 title refinement (prototype home shows the
// envelope for the advisor-mail card), and the c1/c2/c3 soft-color cycle by
// card index. Badge text on the start page is the usage title from the scene
// library (migrated v1 rows have usageId null and stay nameless, per contracts).

import { PERSONAS, EVENT_MAX } from './contracts.js';

export var RELAY_PERSONA_KEY = 'tango-donego.relay.v2.persona';
export var DEFAULT_PERSONA = 'student'; // SPEC §4① 首次默认"学生"
export var PERSONA_LABELS = { student: '学生', teacher: '老师', worker: '上班族', elder: '长辈' };

export var HOME_COPY = {
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
};

var FEATURED_MAX = 6; // SPEC §4① 场景卡 6 张
var DAYPARTS = [ // greeting buckets, prototype wording 周六下午好
  [5, '凌晨'], [9, '早上'], [11, '上午'], [13, '中午'], [18, '下午'], [24, '晚上'],
];
var WEEKDAY_CHARS = '日一二三四五六';
var ICON_BY_CATEGORY = { '写': '#i-pen', '读': '#i-doc', '整理': '#i-notes', '计划': '#i-list', '翻译': '#i-globe', '生活': '#i-cal' };

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

export function greetingFor(date) {
  var d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  var hour = d.getHours();
  for (var i = 0; i < DAYPARTS.length; i += 1) {
    if (hour < DAYPARTS[i][0]) return '周' + WEEKDAY_CHARS.charAt(d.getDay()) + DAYPARTS[i][1] + '好';
  }
  return '周' + WEEKDAY_CHARS.charAt(d.getDay()) + '晚上好';
}

export function normalizePersona(value) {
  var persona = String(value == null ? '' : value).trim().toLowerCase();
  return PERSONAS.indexOf(persona) !== -1 ? persona : null;
}

export function loadPersona(storage) {
  try {
    var raw = storage && typeof storage.getItem === 'function' ? storage.getItem(RELAY_PERSONA_KEY) : null;
    return normalizePersona(raw) || DEFAULT_PERSONA;
  } catch (e) {
    return DEFAULT_PERSONA;
  }
}

export function savePersona(storage, persona) {
  var valid = normalizePersona(persona);
  if (!valid) return false;
  try {
    if (storage && typeof storage.setItem === 'function') {
      storage.setItem(RELAY_PERSONA_KEY, valid);
      return true;
    }
  } catch (e) { /* blocked storage must not break the page */ }
  return false;
}

export function featuredScenes(usages, persona) {
  var list = Array.isArray(usages) ? usages : [];
  var want = normalizePersona(persona) || DEFAULT_PERSONA;
  var out = [];
  for (var i = 0; i < list.length && out.length < FEATURED_MAX; i += 1) {
    var usage = list[i];
    if (!usage || typeof usage !== 'object') continue;
    var slot = usage.personas && typeof usage.personas === 'object' ? usage.personas[want] : null;
    if (!slot || slot.featured !== true) continue;
    var title = String(slot.title == null ? '' : slot.title).trim() || String(usage.title == null ? '' : usage.title).trim();
    if (!title) continue;
    var hint = String(slot.hint == null ? '' : slot.hint).trim();
    if (!hint) {
      var does = Array.isArray(usage.does) ? usage.does : [];
      hint = does.map(function (item) { return String(item == null ? '' : item).trim(); }).filter(Boolean).join('、');
    }
    out.push({ usageId: String(usage.id == null ? '' : usage.id), title: title, hint: hint, category: usage.category });
  }
  return out;
}

export function sceneIcon(category, title) {
  var text = String(title == null ? '' : title);
  if (text.indexOf('邮件') !== -1 || /mail/i.test(text)) return '#i-mail';
  return ICON_BY_CATEGORY[category] || '#i-spark';
}

export function sceneClass(index) {
  return 'c' + (((Number(index) || 0) % 3) + 1);
}

export function learnedBadges(records, usages) {
  var lib = {};
  (Array.isArray(usages) ? usages : []).forEach(function (usage) {
    if (usage && typeof usage === 'object' && usage.id) lib[String(usage.id)] = String(usage.title == null ? '' : usage.title);
  });
  var latest = {};
  (Array.isArray(records) ? records : []).forEach(function (record) {
    if (!record || typeof record !== 'object') return;
    var id = record.usageId == null ? '' : String(record.usageId);
    if (!id || !lib[id]) return; // v1 迁移行 usageId=null 与未知 id 都无徽章可命名
    var at = Date.parse(String(record.at == null ? '' : record.at));
    if (Number.isNaN(at)) at = 0;
    if (!latest[id] || at > latest[id]) latest[id] = at;
  });
  return Object.keys(latest).sort(function (a, b) { return latest[b] - latest[a]; })
    .slice(0, 3).map(function (id) { return { usageId: id, title: lib[id] }; });
}

export function speechAvailable(root) {
  if (!root || typeof root !== 'object') return false;
  var speech = root.TangoSpeech;
  var media = root.navigator && root.navigator.mediaDevices;
  return !!(speech && typeof speech.createRecorder === 'function'
    && media && typeof media.getUserMedia === 'function'
    && (typeof root.AudioContext === 'function' || typeof root.webkitAudioContext === 'function'));
}

function mergeCopy(over) {
  var out = {};
  Object.keys(HOME_COPY).forEach(function (key) {
    out[key] = over && over[key] != null ? String(over[key]) : HOME_COPY[key];
  });
  return out;
}

// ---------------------------------------------------------------------------
// homeView — pure render of SPEC §4①. Markup mirrors prototype #s-home.
// state: { greeting, event, persona, scenes[], badges[], mic, micBusy, micNote }
// ---------------------------------------------------------------------------

export function homeView(state, copyOver) {
  var s = state || {};
  var copy = mergeCopy(copyOver);
  var html = '<p class="hello">' + esc(s.greeting) + '</p>'
    + '<h1>' + esc(copy.hero) + '</h1>'
    + '<p class="lead">' + esc(copy.lead) + '</p>';
  var disabled = String(s.event == null ? '' : s.event).trim() ? '' : ' disabled';
  html += '<form class="ask" id="relay-home-ask">'
    + '<label class="sr" for="relay-home-input">' + esc(copy.inputLabel) + '</label>'
    + '<textarea id="relay-home-input" rows="1" maxlength="' + EVENT_MAX + '" placeholder="' + esc(copy.placeholder) + '" autocomplete="off" enterkeyhint="go">' + esc(s.event) + '</textarea>';
  if (s.mic) {
    html += '<button type="button" class="mic" id="relay-home-mic" aria-label="' + esc(copy.micLabel) + '"' + (s.micBusy ? ' disabled' : '') + '><svg width="22" height="22"><use href="#i-mic"/></svg></button>';
  }
  html += '<button type="submit" class="btn pri" id="relay-home-go"' + disabled + '>' + esc(copy.submit) + '<svg><use href="#i-arrow"/></svg></button></form>';
  html += '<div class="seg" role="tablist" aria-label="' + esc(copy.segLabel) + '">';
  PERSONAS.forEach(function (id) {
    var on = id === s.persona;
    html += '<button type="button" role="tab" aria-selected="' + on + '"' + (on ? ' class="on"' : '') + ' data-persona="' + id + '">' + esc(PERSONA_LABELS[id]) + '</button>';
  });
  html += '</div><div class="grid">';
  (Array.isArray(s.scenes) ? s.scenes : []).forEach(function (scene, index) {
    html += '<button type="button" class="scene ' + sceneClass(index) + '" data-scene="' + esc(scene.usageId) + '" data-event="' + esc(scene.title) + '">'
      + '<span class="ic"><svg><use href="' + sceneIcon(scene.category, scene.title) + '"/></svg></span>'
      + '<b>' + esc(scene.title) + '</b><span>' + esc(scene.hint) + '</span></button>';
  });
  html += '</div>';
  html += '<div class="sec"><h3>' + esc(copy.sectionTitle) + '</h3><a class="sec-all" href="#/me" data-relay-all>' + esc(copy.allLink) + '</a></div>';
  var badges = Array.isArray(s.badges) ? s.badges : [];
  if (badges.length) {
    html += '<div class="badges">';
    badges.forEach(function (badge) {
      html += '<span class="badge"><i><svg><use href="#i-check"/></svg></i>' + esc(badge.title) + '</span>';
    });
    html += '</div>';
  } else {
    html += '<p class="empty">' + esc(copy.emptyText) + '</p>';
  }
  if (s.micNote) html += '<p class="micnote" role="status">' + esc(s.micNote) + '</p>';
  return html;
}

// ---------------------------------------------------------------------------
// Controller.
// ---------------------------------------------------------------------------

export function createHome(options) {
  options = options || {};
  var root = options.root || (typeof window !== 'undefined' ? window : globalThis);
  var storage = options.storage || root.TangoAccountStorage || root.localStorage || null;
  var copy = mergeCopy(options.copy);
  var state = {
    greeting: options.greeting != null ? String(options.greeting) : greetingFor(new Date(options.now == null ? Date.now() : options.now)),
    event: '',
    persona: loadPersona(storage),
    usages: Array.isArray(options.usages) ? options.usages : [],
    records: Array.isArray(options.records) ? options.records : [],
    mic: speechAvailable(root),
    micBusy: false,
    micNote: '',
  };
  var target = null;
  var refs = {};
  var micSession = 0;

  function snapshot() {
    return {
      greeting: state.greeting, event: state.event, persona: state.persona,
      scenes: featuredScenes(state.usages, state.persona),
      badges: learnedBadges(state.records, state.usages),
      mic: state.mic, micBusy: state.micBusy, micNote: state.micNote,
    };
  }

  function refreshRefs() {
    refs = {};
    if (!target) return;
    refs.input = target.querySelector('#relay-home-input');
    refs.go = target.querySelector('#relay-home-go');
    refs.mic = target.querySelector('#relay-home-mic');
  }

  function render() {
    if (!target) return;
    var refocus = false;
    try {
      refocus = !!(root.document && root.document.activeElement && root.document.activeElement === refs.input);
    } catch (e) { /* stub environments have no document */ }
    target.innerHTML = homeView(snapshot(), copy);
    refreshRefs();
    if (refs.input && state.event) refs.input.value = state.event;
    if (refs.input && refocus) refs.input.focus();
  }

  function metric(name) {
    if (typeof options.onMetric === 'function') {
      try { options.onMetric(name); } catch (e) { /* metrics must never break the page */ }
    }
  }

  function autoGrow(node) {
    try {
      var media = root.matchMedia ? root.matchMedia('(min-width: 900px)') : null; // 桌面自动增高，手机单行
      if (!media || !media.matches || !node || !node.style) return;
      node.style.height = 'auto';
      if (node.scrollHeight) node.style.height = node.scrollHeight + 'px';
    } catch (e) { /* cosmetic only */ }
  }

  function handoff(hash) {
    if (root.location) root.location.hash = hash;
  }

  function doSubmit() {
    if (!refs.input) return;
    var value = String(refs.input.value == null ? '' : refs.input.value).trim().slice(0, EVENT_MAX);
    if (!value) return; // 空态：按钮已置灰，这里兜底回车路径
    state.event = value;
    metric('start_submit');
    if (typeof options.onSubmit === 'function') options.onSubmit(value);
    else handoff('#/relay?event=' + encodeURIComponent(value));
  }

  // ----- speech input: 复用 web/speech-capture.js + /api/speech（同 v1 约定） -----
  function fetchImpl() {
    if (typeof options.fetchImpl === 'function') return options.fetchImpl;
    return typeof root.fetch === 'function' ? root.fetch.bind(root) : null;
  }

  function timedFetch(url, init, ms, onDone) {
    var fetch = fetchImpl();
    if (!fetch) { onDone(new Error('no-fetch')); return; }
    var timer = null;
    var controller = null;
    try {
      if (typeof AbortController !== 'undefined') {
        controller = new AbortController();
        init.signal = controller.signal;
        timer = setTimeout(function () { controller.abort(); }, ms);
      }
      fetch(url, init).then(function (response) {
        if (!response || !response.ok) throw new Error('http-' + (response && response.status));
        return response.json();
      }).then(function (data) { onDone(null, data); })
        .catch(function (error) { onDone(error); })
        .finally(function () { if (timer) clearTimeout(timer); });
    } catch (error) {
      onDone(error);
    }
  }

  function micDone(note) {
    state.micBusy = false;
    state.micNote = note || '';
    render();
  }

  function appendSpeech(text) {
    var normalized = String(text == null ? '' : text);
    try {
      if (root.TangoSpeech && typeof root.TangoSpeech.normalizeTranscript === 'function') normalized = root.TangoSpeech.normalizeTranscript(normalized);
    } catch (e) { /* keep raw text */ }
    normalized = String(normalized).trim();
    if (!normalized) { micDone(copy.heardNothing); return; }
    var current = refs.input ? String(refs.input.value == null ? '' : refs.input.value).trim() : '';
    var joined = (current ? current + copy.speechJoin + normalized : normalized).slice(0, EVENT_MAX);
    state.event = joined;
    if (refs.input) refs.input.value = joined;
    if (refs.go) refs.go.disabled = false;
    state.micBusy = false;
    state.micNote = '';
    render();
  }

  function onMicTap() {
    if (!state.mic || state.micBusy) return;
    var session = ++micSession;
    state.micBusy = true;
    state.micNote = copy.preparing;
    render();
    timedFetch('/api/speech', {}, 3000, function (error, config) {
      if (session !== micSession) return;
      if (error || !config || !config.available) { micDone(copy.speechOff); return; }
      var recorder;
      try {
        recorder = root.TangoSpeech.createRecorder(function (audio) {
          if (session !== micSession) return;
          if (!audio || !audio.length || audio.length <= 44) { micDone(copy.heardNothing); return; }
          state.micNote = copy.transcribing;
          render();
          var body = typeof Blob === 'function' ? new Blob([audio], { type: 'audio/wav' }) : audio;
          timedFetch('/api/speech/transcribe?lang=' + encodeURIComponent(options.speechLang || 'zh-CN'), {
            method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: body,
          }, 25000, function (transcribeError, data) {
            if (session !== micSession) return;
            if (transcribeError) { micDone(copy.transcribeFail); return; }
            appendSpeech(data && typeof data.text === 'string' ? data.text : '');
          });
        }, function () {
          if (session === micSession && state.micBusy) { state.micNote = copy.listening; render(); }
        });
      } catch (e) {
        micDone(copy.micBroken);
        return;
      }
      Promise.resolve().then(function () { return recorder.start(); }).catch(function (error) {
        if (session !== micSession) return;
        var denied = error && (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError');
        micDone(denied ? copy.micDenied : copy.micBroken);
      });
    });
  }

  // ----- delegated events (mount container only) -----
  function onSubmit(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    doSubmit();
  }

  function onInput(event) {
    if (!event || !event.target || event.target.id !== 'relay-home-input') return;
    state.event = String(event.target.value == null ? '' : event.target.value);
    if (refs.go) refs.go.disabled = !state.event.trim();
    autoGrow(event.target);
  }

  function onKeydown(event) {
    if (!event || !event.target || event.target.id !== 'relay-home-input') return;
    if (event.key !== 'Enter' || event.shiftKey) return; // 回车等同点击"开始"
    if (typeof event.preventDefault === 'function') event.preventDefault();
    doSubmit();
  }

  function onClick(event) {
    if (!event || !event.target || typeof event.target.closest !== 'function') return;
    var node = event.target.closest('[data-persona],[data-scene],[data-relay-all],#relay-home-mic');
    if (!node || !target || !target.contains(node)) return;
    var persona = normalizePersona(node.getAttribute('data-persona'));
    if (persona) {
      if (persona === state.persona) return;
      state.persona = persona;
      savePersona(storage, persona); // 记住选择
      render();
      return;
    }
    var usageId = node.getAttribute('data-scene');
    if (usageId) {
      var eventText = String(node.getAttribute('data-event') == null ? '' : node.getAttribute('data-event'));
      metric('scene_click');
      if (typeof options.onScene === 'function') options.onScene({ usageId: usageId, event: eventText });
      else handoff('#/relay?usage=' + encodeURIComponent(usageId) + '&event=' + encodeURIComponent(eventText));
      return;
    }
    if (node.getAttribute('data-relay-all') != null) {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      if (typeof options.onOpenMe === 'function') options.onOpenMe();
      else handoff('#/me');
      return;
    }
    if (node.id === 'relay-home-mic') onMicTap();
  }

  return {
    mount: function (node) {
      target = node || null;
      if (!target) return;
      target.addEventListener('submit', onSubmit);
      target.addEventListener('click', onClick);
      target.addEventListener('input', onInput);
      target.addEventListener('keydown', onKeydown);
      render();
    },
    unmount: function () {
      micSession += 1; // 进行中的语音流程随卸载作废
      target = null;
      refs = {};
    },
    update: function (patch) {
      patch = patch || {};
      if (Array.isArray(patch.usages)) state.usages = patch.usages;
      if (Array.isArray(patch.records)) state.records = patch.records;
      render();
    },
    persona: function () { return state.persona; },
  };
}
