(function (root) {
  'use strict';

  var STORE = 'tango-donego.ai-relay.v1';
  var MAX_RECORDS = 20;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function text(value) {
    return esc(value).replace(/\n/g, '<br>');
  }

  function load(storage) {
    try {
      var value = JSON.parse(storage.getItem(STORE) || 'null');
      if (value && Array.isArray(value.records)) return { v: 1, records: value.records.slice(0, MAX_RECORDS) };
    } catch { /* A broken local record should not block today's work. */ }
    return { v: 1, records: [] };
  }

  function matchEvent(event) {
    var value = String(event || '').trim();
    var rules = [
      { re: /会议|开会|纪要|组会|周会|例会|录音/, type: '会议整理', action: '把讨论整理成重点和待办', learn: '把会议材料交给 AI，先生成重点和待办。', minutes: 15 },
      { re: /邮件|回复|消息|客户|微信|短信/, type: '消息起草', action: '先生成一版可以修改的回复', learn: '把对方的问题和你的意图交给 AI，先起草回复。', minutes: 10 },
      { re: /论文|资料|文章|报告|文档|阅读|读书|总结/, type: '资料整理', action: '先提取重点、结论和下一步', learn: '让 AI 先读材料，再用自己的问题核对重点。', minutes: 15 },
      { re: /翻译|英文|日文|韩文|translate/i, type: '翻译整理', action: '先得到一版可校对的译文', learn: '告诉 AI 读者和语气，翻译结果会更好改。', minutes: 10 },
      { re: /计划|安排|旅行|行程|清单|准备/, type: '计划拆解', action: '把想法拆成下一步和检查清单', learn: '把目标、限制和截止时间一起告诉 AI。', minutes: 12 },
      { re: /写|撰写|文案|润色|改稿|起草|代码|编程/, type: '写作起草', action: '先生成一版可以继续修改的草稿', learn: '先告诉 AI 目标和对象，再让它起草。', minutes: 20 },
    ];
    for (var i = 0; i < rules.length; i += 1) {
      if (rules[i].re.test(value)) return { type: rules[i].type, action: rules[i].action, learn: rules[i].learn, minutes: rules[i].minutes };
    }
    return { type: '通用整理', action: '先把这件事整理成清楚的下一步', learn: '把一件小事说清楚，就是开始使用 AI。', minutes: 10 };
  }

  function normalizeResult(value) {
    var result = value && typeof value === 'object' ? value : {};
    var body = typeof result.result === 'string' ? result.result.trim() : '';
    var learned = typeof result.learned === 'string' ? result.learned.trim() : '';
    var minutes = Number(result.estimatedSavedMinutes);
    if (!body || !learned || !Number.isInteger(minutes) || minutes < 0 || minutes > 240) throw new Error('invalid relay result');
    return { result: body.slice(0, 12000), learned: learned.slice(0, 500), estimatedSavedMinutes: minutes };
  }

  function create(options) {
    options = options || {};
    var storage = options.storage || root.TangoAccountStorage || root.localStorage;
    var data = load(storage);
    var state = { stage: 'start', event: '', match: null, material: '', busy: false, notice: '', result: null, records: data.records };
    var target = null;

    function save() {
      try { storage.setItem(STORE, JSON.stringify({ v: 1, records: state.records.slice(0, MAX_RECORDS) })); return true; }
      catch { return false; }
    }

    function notice() {
      return state.notice ? '<p id="relay-notice" class="relay-notice" role="status">' + text(state.notice) + '</p>' : '<p id="relay-notice" class="relay-notice" role="status"></p>';
    }

    function history() {
      if (!state.records.length) return '<section id="relay-history" class="relay-history"><div class="relay-history-head"><h2>我的 AI 接力</h2><span class="small muted">先完成一次，再回来复用</span></div><p class="small muted">还没有接力记录</p></section>';
      return '<section id="relay-history" class="relay-history"><div class="relay-history-head"><h2>我的 AI 接力</h2><span class="small muted">最近 ' + state.records.length + ' 次</span></div><ol>' + state.records.map(function (record) {
        return '<li><div><b>' + esc(record.event) + '</b><p class="small muted">' + esc(record.type) + ' · ' + esc(record.savedAt || '') + '</p></div><span class="relay-history-state">已记录</span></li>';
      }).join('') + '</ol></section>';
    }

    function view() {
      var match = state.match;
      var eventValue = state.stage === 'start' || state.stage === 'saved' ? '' : state.event;
      var input = '<form id="relay-event-form" class="relay-event-form"><label class="sr" for="relay-event-input">今天要做的事</label><input id="relay-event-input" maxlength="600" value="' + esc(eventValue) + '" placeholder="例如：整理会议记录、写一封回复" autocomplete="off"><button id="relay-event-submit" class="btn primary" type="submit">开始匹配</button></form>';
      var matchView = match && (state.stage === 'match' || state.stage === 'start') ? '<section id="relay-match" class="relay-card relay-match"><div class="relay-match-title"><span class="relay-dot" aria-hidden="true"></span><div><span class="relay-label">适合用 AI · AI 匹配</span><h2>' + esc(match.type) + '</h2></div><span class="relay-minutes">预计省约 ' + match.minutes + ' 分钟</span></div><p>' + esc(match.action) + '</p><p class="small muted">探戈会先选择合适的 AI 用法，你只需要补充材料。</p><button class="btn primary" type="button" data-relay-start>开始 AI 接力</button></section>' : '';
      var workspace = state.stage === 'relay' ? '<section id="relay-workspace" class="relay-card relay-workspace"><div class="relay-step"><span>1</span><div><span class="relay-label">已匹配</span><b>' + esc(match.type) + '</b></div></div><p class="small muted">事件：' + esc(state.event) + '</p><label for="relay-material">把材料交给探戈</label><textarea id="relay-material" rows="6" maxlength="12000" placeholder="粘贴文字，或把你想让 AI 处理的内容补充在这里">' + esc(state.material) + '</textarea><p class="small muted">探戈会先做一版，你可以检查、修改或再试一次。</p><button class="btn primary wide" type="button" data-relay-run' + (state.busy ? ' disabled' : '') + '>' + (state.busy ? 'AI 接力中…' : '让 AI 先做') + '</button></section>' : '';
      var result = state.result ? '<section id="relay-result" class="relay-card relay-result"><div class="relay-step"><span>2</span><div><span class="relay-label">AI 已先做一版</span><b>请你确认结果</b></div></div><div class="relay-output" data-user-content>' + text(state.result.result) + '</div><div class="relay-learn"><span class="relay-label">这次学会了</span><p>' + text(state.result.learned) + '</p></div><p class="small muted">预计省约 ' + state.result.estimatedSavedMinutes + ' 分钟 · 这是本次记录的估计值</p><div class="btns"><button class="btn primary" type="button" data-relay-save>确认并保存</button><button class="btn" type="button" data-relay-retry>再试一次</button></div></section>' : '';
      var saved = state.stage === 'saved' ? '<p class="relay-saved" role="status">✓ 这次 AI 接力已记录。再输入一件事，继续试。</p>' : '';
      return '<section id="relay-core" class="relay-shell" data-relay-stage="' + esc(state.stage) + '"><div class="relay-heading"><span class="relay-kicker">AI 接力</span><h1>今天要做什么？</h1><p>说一件手头的事，探戈帮你找到合适的 AI 用法。</p></div>' + input + notice() + matchView + workspace + result + saved + history() + '</section>';
    }

    function render() { if (target) target.innerHTML = view(); }

    function eventSubmit(event) {
      event.preventDefault();
      var input = target && target.querySelector('#relay-event-input');
      var value = input && input.value.trim();
      if (!value) { state.notice = '先写一件今天真实要做的事。'; render(); return; }
      state.event = value; state.match = matchEvent(value); state.material = ''; state.result = null; state.notice = ''; state.stage = 'match'; render();
    }

    function run() {
      if (state.busy) return;
      if (typeof options.ready === 'function' && !options.ready()) { state.notice = 'AI 还没连接，请先在设置中配置 AI 通道。'; render(); return; }
      var material = state.material.trim() || state.event;
      state.material = material; state.busy = true; state.notice = ''; render();
      var prompt = '【AI 接力】\n只输出一个 JSON 对象，不要解释或代码块。字段固定为 result（给用户的可修改结果）、learned（用一句话说明这次学会的 AI 用法）、estimatedSavedMinutes（本次估计省下的分钟数，0 到 240 的整数）。\n事件类型：' + state.match.type + '\n用户事件：<event>' + state.event.slice(0, 600) + '</event>\n用户材料：<material>' + material.slice(0, 12000) + '</material>\n请把结果写得直接、可执行，并提醒用户自行确认事实。';
      Promise.resolve().then(function () { return options.request(prompt); }).then(function (value) {
        state.result = normalizeResult(value); state.stage = 'result'; state.busy = false; state.notice = ''; render();
      }).catch(function () {
        state.busy = false; state.notice = '这次 AI 接力没有完成，原文已保留，可以稍后再试。'; render();
      });
    }

    function saveResult() {
      if (!state.result || !state.match) return;
      state.records.unshift({ id: String(Date.now()), event: state.event, type: state.match.type, result: state.result.result, learned: state.result.learned, estimatedSavedMinutes: state.result.estimatedSavedMinutes, savedAt: new Date().toISOString().slice(0, 10) });
      state.records = state.records.slice(0, MAX_RECORDS);
      if (!save()) { state.records.shift(); state.notice = '记录暂时没保存成功，请检查浏览器存储后再试。'; render(); return; }
      state.stage = 'saved'; state.result = null; state.material = ''; state.notice = ''; render();
    }

    function handleClick(event) {
      var button = event.target.closest('[data-relay-start], [data-relay-run], [data-relay-save], [data-relay-retry]');
      if (!button || !target || !target.contains(button)) return;
      if (button.hasAttribute('data-relay-start')) { state.stage = 'relay'; state.notice = ''; render(); var material = target.querySelector('#relay-material'); if (material) material.focus(); return; }
      if (button.hasAttribute('data-relay-run')) { run(); return; }
      if (button.hasAttribute('data-relay-save')) { saveResult(); return; }
      if (button.hasAttribute('data-relay-retry')) { state.result = null; state.stage = 'relay'; state.notice = ''; render(); var retryInput = target.querySelector('#relay-material'); if (retryInput) retryInput.focus(); }
    }

    function handleInput(event) {
      if (!target || !target.contains(event.target)) return;
      if (event.target.id === 'relay-material') state.material = event.target.value;
    }

    function mount(node) {
      if (!node) { target = null; return; }
      target = node; target.onsubmit = eventSubmit; target.onclick = handleClick; target.oninput = handleInput; render();
    }

    return { mount: mount, unmount: function () { target = null; }, connectionChanged: render, matchEvent: matchEvent };
  }

  root.TangoAIRelay = { create: create, matchEvent: matchEvent, normalizeResult: normalizeResult };
})(window);
