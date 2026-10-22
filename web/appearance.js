/* Appearance is independent of records, chat state and the page renderer. */
(function () {
  'use strict';
  var root = document.documentElement;
  var key = 'tango-donego.appearance.v1';
  var current = 'standard';
  var themes = ['standard', 'swiss', 'archive', 'designer', 'workbench'];
  try {
    var saved = localStorage.getItem(key);
    if (themes.indexOf(saved) >= 0) current = saved;
  } catch {}

  var copy = {
    zh: ['外观', '标准主题', '瑞士雪境研究桌', '个人时间档案', '夜间观测花园', '知识工作台'],
    en: ['Appearance', 'Standard theme', 'Swiss snow study desk', 'Personal time archive', 'Night observatory garden', 'Knowledge workbench'],
    ru: ['Оформление', 'Стандартная тема', 'Швейцарский снежный кабинет', 'Личный архив времени', 'Ночная обсерватория', 'Рабочая мастерская знаний'],
    th: ['รูปลักษณ์', 'ธีมมาตรฐาน', 'โต๊ะศึกษาหิมะสไตล์สวิส', 'คลังเวลาส่วนตัว', 'สวนหอดูดาวยามค่ำคืน', 'โต๊ะทำงานความรู้'],
    ar: ['المظهر', 'السمة القياسية', 'مكتب الدراسة الثلجي السويسري', 'أرشيف الوقت الشخصي', 'حديقة المرصد الليلي', 'ورشة المعرفة'],
    ko: ['외관', '표준 테마', '스위스 설경 연구 데스크', '개인 시간 아카이브', '야간 관측 정원', '지식 작업대']
  };

  function labels() {
    var select = document.getElementById('appearance-select');
    if (!select) return;
    var language = (root.lang || 'zh').split('-')[0];
    var text = copy[language] || copy.zh;
    select.setAttribute('aria-label', text[0]);
    var caption = document.getElementById('appearance-label');
    if (caption) caption.textContent = text[themes.indexOf(current) + 1];
    for (var i = 0; i < select.options.length; i++) {
      var index = themes.indexOf(select.options[i].value);
      if (index >= 0) select.options[i].textContent = text[index + 1];
    }
    select.value = current;
  }

  function apply(value) {
    current = themes.indexOf(value) >= 0 ? value : 'standard';
    root.setAttribute('data-appearance', current);
    /* Pin the legacy color-scheme selector to this explicit choice. */
    root.setAttribute('data-theme', current === 'designer' ? 'dark' : 'light');
    root.setAttribute('data-tone', current === 'designer' ? 'dark' : 'light');
    labels();
  }

  apply(current);
  new MutationObserver(function (changes) {
    if (changes.some(function (change) { return change.attributeName === 'lang'; })) labels();
  }).observe(root, { attributes: true, attributeFilter: ['lang'] });

  document.addEventListener('DOMContentLoaded', function () {
    var select = document.getElementById('appearance-select');
    labels();
    select.addEventListener('change', function () {
      apply(select.value);
      try { localStorage.setItem(key, current); } catch {}
    });
  });

  window.addEventListener('storage', function (event) {
    if (event.key === key) apply(event.newValue);
  });
})();
