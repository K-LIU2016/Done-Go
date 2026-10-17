(function (root) {
  'use strict';
  var STORE = 'tango-donego.assistant.v1';
  var MODES = { chat: '聊一聊', priorities: '安排轻重', models: '模型推荐', reflection: '今日回望' };
  var KINDS = { necessary: '必要', create: '创造', explore: '探索', connect: '连接', restore: '恢复' };
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function stamp() { return new Date().toISOString(); }
  function id() { return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
  function safeLink(value) { try { var u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; } catch { return ''; } }
  function create(bridge) {
    var core = root.TangoAssistant, rawAtLoad = null, protectedSession = false;
    var session = core.sanitizeSession({ v: 1, messages: [], notes: '', useChatForSuggestions: false });
    var ui = { mode: 'chat', message: '', notes: '', selected: [], shareTasks: false, shareMetrics: false, shareNotes: false, shareModels: false, period: 'today', busy: false, generation: 0, notice: '', proposals: [], context: null, applied: {}, clearConfirm: false, streaming: false, streamText: '', privacyOpen: false, recordsOpen: false };
    var discovery = { busy: false, loaded: false, topic: 'all', items: [], retrievedAt: null, stale: false, failures: 0, error: '' };
    try { rawAtLoad = localStorage.getItem(STORE); if (rawAtLoad) session = core.sanitizeSession(JSON.parse(rawAtLoad)); }
    catch { protectedSession = true; ui.notice = '聊天记录无法读取，已保留原始内容；本次仅在内存中聊天，请先导出本机对话再刷新检查。'; }
    function active() { return bridge.active(); }
    function refresh() {
      if (protectedSession && ui.notice.indexOf('聊天存储受保护') < 0) ui.notice = '聊天存储受保护，原始内容未覆盖；请先导出本机对话，再刷新检查。' + ui.notice;
      if (active()) {
        var privacy = document.getElementById('assistant-privacy'), records = document.getElementById('assistant-records');
        if (privacy) ui.privacyOpen = privacy.open;
        if (records) ui.recordsOpen = records.open;
        bridge.refresh(); var log = document.querySelector('.companion-conversation'); if (log) log.scrollTop = log.scrollHeight;
      }
    }
    function saveSession() {
      if (protectedSession) return false;
      try {
        if (localStorage.getItem(STORE) !== rawAtLoad) { protectedSession = true; ui.notice = '另一标签页已更新聊天，当前对话仅保留在内存；请先导出，再刷新。'; return false; }
        var data = JSON.stringify(core.sanitizeSession(session)); localStorage.setItem(STORE, data); rawAtLoad = data; return true;
      } catch { protectedSession = true; ui.notice = '聊天暂时无法保存，刷新可能丢失；请先导出。'; return false; }
    }
    function append(role, text, source) {
      var item = { id: id(), role: role, text: text, createdAt: stamp() }; if (source) item.source = source;
      session.messages.push(item); session.messages = session.messages.slice(-40); saveSession();
    }
    function candidates() { return bridge.tasks().filter(function (task) { return !task.done && task.kind !== 'stillness'; }); }
    function contextForTurn() {
      var tasks = candidates().filter(function (task) { return ui.selected.indexOf(task.id) >= 0; });
      return core.buildContext({ mode: ui.mode, session: session, tasks: tasks, metrics: bridge.metrics(ui.period), modelEvidence: ui.shareModels ? bridge.modelEvidence() : [], includeTasks: ui.shareTasks, includeMetrics: ui.shareMetrics, includeNotes: false });
    }
    function messageView(message) {
      var author = message.role === 'user' ? '你' : message.source === 'model' ? '探戈 · AI' : '探戈';
      return '<article class="companion-message' + (message.role === 'user' ? ' is-user' : '') + '"><span class="message-author">' + author + '</span><p>' + esc(message.text) + '</p></article>';
    }
    function factsView() {
      if (!ui.shareMetrics) return '';
      var m = bridge.metrics(ui.period);
      var personal = m.personalTime || {}, use = m.timeUse || {};
      var life = '<p class="small">已确认用到自己的时间：' + (personal.confirmedUsed || 0) + ' min；其中任务关联预留：' + (personal.taskLinkedUsed || 0) + ' min；待确认 ' + (personal.unconfirmed || 0) + ' 项。</p><p class="small muted">时间去向（按事项累计，重叠可能重复）：' + Object.keys(use).filter(function (key) { return use[key] > 0; }).map(function (key) { return (KINDS[key] || '自己的时间') + ' ' + use[key] + ' min'; }).join(' · ') + '。是否属于 AI 的帮助，需要你结合实际经历判断。</p>';
      return '<div class="companion-facts"><p class="small">' + (m.dataMode === 'demo' ? '示例数据' : '本人记录，未经独立核验') + ' · 共享时段 ' + esc(m.period.from) + ' → ' + esc(m.period.to) + '</p><dl><dt>已验收记录</dt><dd>' + m.samples + ' 项</dd><dt>计划 / 实际总用时</dt><dd>' + m.before + ' / ' + m.after + ' min</dd><dt>已验收差值</dt><dd>' + m.difference + ' min</dd><dt>扣除记录开销后的净差值</dt><dd>' + (m.netDifference === null ? '未知' : m.netDifference + ' min') + '</dd></dl>' + life + '<p class="small muted">差值不等于 AI 的贡献；未知成本不会按零计算。</p></div>';
    }
    function proposalsView() {
      if (!ui.proposals.length) return '';
      return '<section class="companion-suggestions"><h2>待你确认的建议</h2><p class="small muted">逐条检查理由。采纳只改变显示的设置，不改时间、完成状态或收益。</p>' + ui.proposals.map(function (p, index) {
        var task = ui.context.tasks.filter(function (task) { return task.targetId === p.targetId; })[0];
        return '<article class="companion-proposal"><b>' + esc(task ? task.title : '事项') + '</b><p class="small">' + (p.priority != null ? '优先级：' + p.priority + '（1 最高，5 不急） ' : '') + (p.kind ? ' · 分类：' + KINDS[p.kind] : '') + (p.modelId ? ' · 模型候选：' + esc(bridge.modelLabel(p.modelId)) : '') + '</p><p class="small">' + esc(p.reason) + '</p><button class="btn sm" data-companion-apply="' + index + '"' + (ui.applied[index] ? ' disabled' : '') + '>' + (ui.applied[index] ? '已采纳' : '确认采纳这条') + '</button></article>';
      }).join('') + '</section>';
    }
    function render() {
      var connection = bridge.connection(), tasks = candidates();
      var locked = ui.busy ? ' disabled' : '';
      var modeOptions = Object.keys(MODES).map(function (mode) { return '<option value="' + mode + '"' + (mode === ui.mode ? ' selected' : '') + '>' + MODES[mode] + '</option>'; }).join('');
      var taskOptions = !ui.shareTasks ? '<p class="small muted">勾选“分享事项”后，可选择具体事项</p>' : tasks.length ? tasks.map(function (task) { return '<label><input type="checkbox" data-companion-task="' + esc(task.id) + '"' + (ui.selected.indexOf(task.id) >= 0 ? ' checked' : '') + '> <span>' + esc(task.title) + ' · ' + esc(task.date) + ' ' + esc(task.start) + '–' + esc(task.end) + '</span></label>'; }).join('') : '<p class="small muted">暂无可选事项</p>';
      return '<section id="assistant-root" class="full"><div class="companion-heading"><h1>和探戈聊聊</h1><a href="#today" class="small">今天</a></div>' +
        '<div class="companion-toolbar"><label><span>用途</span><select id="assistant-mode" aria-label="聊天用途"' + locked + '>' + modeOptions + '</select></label></div>' +
        '<p id="assistant-connection" class="companion-connection' + (connection.available ? ' sr' : '') + '" role="status">' + esc(connection.label) + '</p>' +
        '<div class="companion-layout"><main class="companion-chat"><div class="companion-conversation" role="log" aria-label="与探戈的对话" aria-live="polite">' + (session.messages.length ? session.messages.map(messageView).join('') : '<div class="companion-empty"><p>今天想聊点什么？</p></div>') + (ui.streaming ? '<article class="companion-message"><span class="message-author">探戈 · AI</span><p id="assistant-stream">' + esc(ui.streamText) + '</p></article>' : '') + '</div>' +
        '<form id="assistant-form" class="companion-compose" aria-busy="' + ui.busy + '"><label for="assistant-message" class="sr">消息</label><textarea id="assistant-message" maxlength="4000" rows="2" placeholder="输入消息…">' + esc(ui.message) + '</textarea><div class="companion-send-row"><span class="small muted" role="status" aria-live="polite">' + (ui.busy ? '正在等待回应…' : connection.loading ? '正在连接模型…' : '') + '</span><button id="assistant-send" class="btn primary" type="submit"' + (ui.busy ? ' disabled' : '') + '>' + (ui.busy ? '等待中…' : '发送') + '</button></div></form><p id="assistant-notice" role="status" class="small">' + esc(ui.notice) + '</p>' + proposalsView() + '</main>' +
        '<section class="companion-context" aria-label="可选设置"><details id="assistant-privacy" class="companion-disclosure"' + (ui.privacyOpen ? ' open' : '') + '><summary>由你决定，分享多少</summary><div class="companion-disclosure-body"><label class="check"><input type="checkbox" id="assistant-use-chat"' + (session.useChatForSuggestions ? ' checked' : '') + '> 将聊天用于事项建议</label><label class="check"><input type="checkbox" id="assistant-share-tasks"' + (ui.shareTasks ? ' checked' : '') + '> 分享事项</label><div class="companion-task-options">' + taskOptions + '</div><label class="check"><input type="checkbox" id="assistant-share-models"' + (ui.shareModels ? ' checked' : '') + '> 分享模型使用统计</label><label class="check"><input type="checkbox" id="assistant-share-metrics"' + (ui.shareMetrics ? ' checked' : '') + '> 分享时间汇总</label><label class="small" for="assistant-period">时间范围</label> <select id="assistant-period"><option value="today"' + (ui.period === 'today' ? ' selected' : '') + '>今天</option><option value="week"' + (ui.period === 'week' ? ' selected' : '') + '>最近 7 天</option></select>' + factsView() + '</div></details>' +
        '<details id="assistant-records" class="companion-disclosure"' + (ui.recordsOpen ? ' open' : '') + '><summary>链接与记录</summary><div class="companion-disclosure-body"><p class="small muted">聊天保存在此浏览器</p><a class="btn sm" href="#settings">配置 AI</a><div class="btns"><button class="btn sm" data-companion-export>导出对话</button><button class="btn sm" data-companion-clear>' + (ui.clearConfirm ? '确认清空' : '清空对话') + '</button></div>' + (ui.clearConfirm ? '<p class="small">清空后无法恢复；已发送给模型的内容无法撤回。</p>' : '') + '</div></details></section></div>' +
        '<footer class="companion-footer"><span class="small muted">AI 回答请结合实际情况判断。</span><button class="btn sm companion-support" type="button" data-companion-support>技术支持</button></footer></section>';
    }
    async function send() {
      var input = document.getElementById('assistant-message'), message = input ? input.value.trim() : ui.message.trim();
      if (!message || ui.busy) return;
      if (message.length > 4000) { ui.notice = '这次先聊 4000 字以内的内容。'; return refresh(); }
      var context = contextForTurn(), mode = ui.mode, generation = ++ui.generation;
      ui.proposals = []; ui.applied = {}; ui.context = context; ui.message = ''; ui.busy = true; ui.notice = '';
      append('user', message); refresh();
      try {
        if (mode === 'chat') {
          ui.streaming = true; ui.streamText = ''; refresh();
          var text = await bridge.requestText(core.buildPrompt({ mode: mode, message: message, context: context }), function (chunk) {
            if (generation !== ui.generation) return;
            ui.streamText += chunk; var el = document.getElementById('assistant-stream');
            if (el) { el.textContent = ui.streamText; var log = document.querySelector('.companion-conversation'); if (log) log.scrollTop = log.scrollHeight; }
          }, mode);
          if (generation !== ui.generation) return;
          append('assistant', String(text == null ? '' : text).trim() || '（这次没有返回内容）', 'model');
        } else {
          var response = await bridge.request(core.buildPrompt({ mode: mode, message: message, context: context }), mode);
          if (generation !== ui.generation) return;
          var checked = core.validateReply(response, context);
          append('assistant', checked.reply, 'model'); ui.proposals = checked.suggestions; ui.context = context;
          ui.notice = checked.suggestions.length ? '请核对下方建议，再决定是否应用。' : '';
        }
      } catch (error) {
        if (generation !== ui.generation) return;
        ui.notice = error && error.message === 'cancelled' ? '已取消发送，没有调用模型。可以修改内容再试。' : error && error.message.indexOf('TANGO_ASSISTANT_CONTEXT_TOO_LARGE') >= 0 ? '本次上下文过长，尚未发送。请减少勾选事项或缩短内容再试。' : '歇一会儿我们再继续吧，或者联系技术支持人员来为你开通新的探戈通道吧。';
      } finally { if (generation === ui.generation) { ui.busy = false; ui.streaming = false; ui.streamText = ''; refresh(); } }
    }
    function open(mode, targetId) {
      if (MODES[mode]) ui.mode = mode;
      if (targetId) { ui.selected = [targetId]; ui.shareTasks = true; }
      if (mode === 'models') ui.shareModels = true;
      if (mode === 'reflection') { ui.shareMetrics = true; ui.period = 'today'; }
      bridge.navigate();
    }
    function onLeave() { ui.generation++; ui.busy = false; ui.streaming = false; ui.streamText = ''; }
    function connectionChanged() { if (active()) refresh(); else { var el = document.getElementById('assistant-connection'); if (el) el.textContent = bridge.connection().label; } }
    document.addEventListener('input', function (event) {
      if (event.target.id === 'assistant-message') ui.message = event.target.value;
    });
    document.addEventListener('change', function (event) {
      var el = event.target;
      if (el.id === 'assistant-mode') { ui.mode = Object.prototype.hasOwnProperty.call(MODES, el.value) ? el.value : 'chat'; refresh(); return; }
      if (el.id === 'assistant-use-chat') { session.useChatForSuggestions = el.checked; if (saveSession()) ui.notice = '共享设置已保存，仅影响后续请求。'; else ui.notice += '当前开关仅在本页生效，刷新后可能恢复原值。'; refresh(); return; }
      var fields = { 'assistant-share-tasks': 'shareTasks', 'assistant-share-metrics': 'shareMetrics', 'assistant-share-models': 'shareModels' };
      if (fields[el.id]) { ui[fields[el.id]] = el.checked; refresh(); return; }
      if (el.id === 'assistant-period') { ui.period = el.value === 'week' ? 'week' : 'today'; refresh(); return; }
      if (el.hasAttribute('data-companion-task')) { var value = el.getAttribute('data-companion-task'); ui.selected = ui.selected.filter(function (id) { return id !== value; }); if (el.checked) ui.selected.push(value); }
      if (el.id === 'discovery-topic') discovery.topic = ['all', 'research', 'work', 'learning'].indexOf(el.value) >= 0 ? el.value : 'all';
    });
    document.addEventListener('toggle', function (event) {
      if (event.target.id === 'assistant-privacy') ui.privacyOpen = event.target.open;
      if (event.target.id === 'assistant-records') ui.recordsOpen = event.target.open;
    }, true);
    document.addEventListener('submit', function (event) { if (event.target.id === 'assistant-form') { event.preventDefault(); send(); } });
    document.addEventListener('click', function (event) {
      var el = event.target.closest('[data-companion-apply], [data-companion-starter], [data-companion-clear], [data-companion-export], [data-companion-support], [data-companion-discover], [data-discovery-talk]');
      if (!el) return;
      if (el.hasAttribute('data-companion-starter')) { ui.message = el.getAttribute('data-companion-starter'); refresh(); document.getElementById('assistant-message').focus(); return; }
      if (el.hasAttribute('data-companion-apply')) {
        var index = Number(el.getAttribute('data-companion-apply')), proposal = ui.proposals[index];
        if (!proposal || ui.applied[index]) return;
        try { bridge.apply(proposal); ui.applied[index] = true; ui.notice = '已采纳。事项时间、完成记录与收益保持原值。'; }
        catch { ui.notice = '事项或存储状态已经改变，这条建议未应用。请重新选择事项再请求。'; }
        refresh(); return;
      }
      if (el.hasAttribute('data-companion-clear')) {
        if (!ui.clearConfirm) { ui.clearConfirm = true; refresh(); return; }
        if (protectedSession) { ui.notice = '原始聊天记录受保护，请先导出并刷新检查；当前未清空。'; refresh(); return; }
        onLeave(); session.messages = []; session.useChatForSuggestions = false; ui.proposals = []; ui.clearConfirm = false; ui.notice = '对话已清空。'; saveSession(); refresh(); return;
      }
      if (el.hasAttribute('data-companion-export')) { bridge.exportSession(JSON.stringify(session, null, 2), protectedSession ? rawAtLoad : null); return; }
      if (el.hasAttribute('data-companion-support')) { bridge.support(); return; }
      if (el.hasAttribute('data-companion-discover')) { loadDiscovery(); return; }
      if (el.hasAttribute('data-discovery-talk')) {
        var item = discovery.items[Number(el.getAttribute('data-discovery-talk'))]; if (!item) return;
        ui.message = '我想理解这条外部资讯。仅凭标题和来源还不能判断效果，请帮我提出核验问题：' + item.title + '\n来源：' + item.url + '\n发布日期：' + item.publishedAt;
        open('chat'); refresh();
      }
    });
    function discoveryHTML() {
      return '<section id="ai-discovery" class="ai-discovery full"><div class="companion-heading"><h2>树外的 AI 世界</h2><span class="small muted">新闻与播客 · 按需查看</span></div><p class="small muted">看一条新进展，再决定它与你的生活有什么关系。仅检索公开来源，不发送聊天或事项。</p><div class="discovery-controls"><label for="discovery-topic" class="small">关注方向</label><select id="discovery-topic">' + [['all', '全部 AI'], ['research', '研究进展'], ['work', '工作与工具'], ['learning', '学习与教育']].map(function (item) { return '<option value="' + item[0] + '"' + (item[0] === discovery.topic ? ' selected' : '') + '>' + item[1] + '</option>'; }).join('') + '</select><button class="btn sm" data-companion-discover' + (discovery.busy ? ' disabled' : '') + '>' + (discovery.busy ? '正在检索…' : discovery.loaded ? '刷新来源' : '看看最近的 AI 新闻与播客') + '</button></div><div role="status" class="small muted">' + (discovery.error ? esc(discovery.error) : discovery.retrievedAt ? '检索时间：' + esc(discovery.retrievedAt.replace('T', ' ').slice(0, 19)) + ' UTC' + (discovery.stale ? ' · 缓存结果，当前未刷新成功' : '') + (discovery.failures ? ' · 部分来源暂不可用' : '') : '尚未检索。近 45 天的来源不保证覆盖所有最新消息。') + '</div>' +
        (discovery.loaded && !discovery.items.length ? '<p class="muted small">这次没有取得可展示的近期内容。可稍后再试，时间记录仍可正常使用。</p>' : '') + '<div class="discovery-grid">' + discovery.items.slice(0, 6).map(function (item, index) { return '<article class="discovery-card"><span class="small muted">' + (item.type === 'podcast' ? '播客' : '新闻') + ' · ' + esc(item.source) + '</span><h3>' + esc(item.title) + '</h3><p class="small muted">发布 ' + esc(item.publishedAt.slice(0, 10)) + '</p><p class="small">' + esc(item.excerpt) + '</p><div class="btns"><a href="' + esc(item.url) + '" target="_blank" rel="noopener noreferrer">查看原始来源 ↗</a><button class="btn sm" data-discovery-talk="' + index + '">带着这篇聊聊</button></div></article>'; }).join('') + '</div><p class="small muted">来源摘要为外部内容；发布日期与检索时间分开显示。观点与宣传需要回到原始材料核验。</p></section>';
    }
    async function loadDiscovery() {
      if (discovery.busy) return;
      var selectedTopic = discovery.topic; discovery.busy = true; discovery.error = ''; bridge.refresh();
      var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 18000);
      try {
        var response = await fetch('/api/discovery?topic=' + encodeURIComponent(selectedTopic), { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('unavailable');
        var result = await response.json();
        if (!result || !Array.isArray(result.items) || typeof result.retrievedAt !== 'string' || !Number.isFinite(Date.parse(result.retrievedAt))) throw new Error('invalid');
        discovery.items = result.items.filter(function (item) { return item && ['news', 'podcast'].indexOf(item.type) >= 0 && typeof item.title === 'string' && typeof item.source === 'string' && typeof item.excerpt === 'string' && safeLink(item.url) && Number.isFinite(Date.parse(item.publishedAt)) && Date.parse(item.publishedAt) <= Date.now() + 86400000; }).map(function (item) { return { type: item.type, title: item.title.slice(0, 200), source: item.source.slice(0, 80), excerpt: item.excerpt.slice(0, 500), url: safeLink(item.url), publishedAt: new Date(item.publishedAt).toISOString() }; });
        // Show both formats even if one feed publishes much more frequently.
        discovery.items = discovery.items.filter(function (item) { return item.type === 'news'; }).slice(0, 3).concat(discovery.items.filter(function (item) { return item.type === 'podcast'; }).slice(0, 3));
        discovery.retrievedAt = result.retrievedAt; discovery.stale = result.stale === true; discovery.failures = Array.isArray(result.failures) ? result.failures.length : Number(result.failures) || 0; discovery.loaded = true;
      } catch { discovery.error = '公开来源暂时无法取得，未生成替代新闻。请稍后刷新。'; discovery.stale = discovery.items.length > 0; discovery.loaded = true; }
      finally { clearTimeout(timer); discovery.busy = false; if (bridge.route() === 'line') bridge.refresh(); }
    }
    return { render: render, open: open, leave: onLeave, connectionChanged: connectionChanged, discoveryHTML: discoveryHTML };
  }
  root.TangoAssistantUI = { create: create };
}(window));
