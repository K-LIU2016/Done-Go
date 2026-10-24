(function (root) {
  'use strict';

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  function create(storage, userId) {
    var storageKey = 'tango-donego.user.' + encodeURIComponent(String(userId || '')) + '.demo-onboarding.dismissed.v1';
    var dismissed = false;
    var task = '';

    try { dismissed = storage && storage.getItem(storageKey) === '1'; } catch (error) { dismissed = false; }

    function render() {
      if (dismissed) return '';
      return '<section class="block full demo-onboarding" aria-labelledby="demo-onboarding-title">' +
        '<div class="demo-onboarding-head"><div><h2 id="demo-onboarding-title">第一次试试探戈？</h2><p class="small muted">用一件小事走完 AI 尝试和效果记录。</p></div>' +
        '<button type="button" class="x" data-act="demo-onboarding-dismiss" aria-label="关闭新人引导">×</button></div>' +
        '<ol><li><label for="demo-onboarding-task">选一个今天真实要完成的小任务</label><input id="demo-onboarding-task" maxlength="60" value="' + escapeHTML(task) + '" placeholder="例如：整理一封需要回复的邮件"></li>' +
        '<li><span>打开模型能力卡，复制对应提示词</span><div class="demo-onboarding-action"><button type="button" class="btn sm" data-act="demo-onboarding-guidance">打开模型能力卡</button><span class="small muted">AI 不可用时，也可按本地规则查看候选与提示词。</span></div></li>' +
        '<li>完成后记录快/差不多/慢和验收结果</li></ol>' +
        '<p class="small muted">AI 建议需逐条采纳，任务级效果未实测。</p></section>';
    }

    return {
      render: render,
      setTask: function (value) { task = String(value || '').slice(0, 60); },
      dismiss: function () {
        dismissed = true;
        try { if (storage) storage.setItem(storageKey, '1'); } catch (error) { /* Keep the dismissal for this page session. */ }
      }
    };
  }

  root.TangoDemoOnboarding = { create: create };
  if (typeof module === 'object' && module.exports) module.exports = root.TangoDemoOnboarding;
})(typeof window === 'undefined' ? globalThis : window);
