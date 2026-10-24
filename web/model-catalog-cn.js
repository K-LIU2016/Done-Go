(function (root) {
  'use strict';
  // Mainland-China consumer AI model catalog for the "which AI for this task" card row.
  // Fields mirror the existing capability-card schema (MODEL_REFERENCES tuple +
  // MODEL_IDS slug in web/index.html) as named entries:
  //   vendor / displayName / descZh / appUrl / capabilityUrl + modelId,
  // plus the taskFit column documented in docs/model-guidance-sources.md and the
  // forensic accessDate (date the official sources were read). Every value was
  // taken from vendor-official pages on that date; anything not verified must
  // read the literal string 未核验. Pure data + pure functions: no DOM, no
  // network, no storage.
  var CN_MODELS = [
    {
      vendor: '字节跳动',
      modelId: 'doubao-seed-2.1',
      displayName: '豆包 Doubao（Doubao-Seed 2.1 / Seed-Evolving）',
      descZh: '全模态理解与多档思考；Seed-Evolving 1024k 长上下文，适合 Agent 编程与长资料任务。',
      appUrl: 'https://www.doubao.com/',
      capabilityUrl: 'https://ai.volcengine.com/model',
      taskFit: '编程与智能体任务、音视图文统一理解的长资料整理；视频/图像生成分别用 Seedance/Seedream。',
      accessDate: '2026-10-22',
      verified: true
    },
    {
      vendor: '深度求索 DeepSeek',
      modelId: 'deepseek-v4.1-flash',
      displayName: 'DeepSeek（deepseek-flash / deepseek-v4-pro）',
      descZh: '1M 上下文、思考与非思考双模式；视觉与联网抓取在 flash 档；适合深度推理与代码。',
      appUrl: 'https://chat.deepseek.com/',
      capabilityUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
      taskFit: '代码诊断与深度推理、长文档分析；需要联网资料时用 Search & Fetch API。',
      accessDate: '2026-10-22',
      verified: true
    },
    {
      vendor: '阿里巴巴',
      modelId: 'qwen3.8-max',
      displayName: '通义千问 Qwen（qwen3.8-max）',
      descZh: '1M 上下文旗舰，原生视觉理解、工具调用与结构化输出；适合编程、专业任务与多模态资料。',
      appUrl: 'https://www.qianwen.com/',
      capabilityUrl: 'https://help.aliyun.com/zh/model-studio/qwen3-8-max',
      taskFit: '复杂推理与工程级编程、长程自主开发；图像/视频/语音任务用百炼 omni 与生成系列。',
      accessDate: '2026-10-22',
      verified: true
    },
    {
      vendor: '月之暗面 Moonshot AI',
      modelId: 'kimi-k3',
      displayName: 'Kimi（kimi-k3）',
      descZh: '1M 上下文旗舰、原生视觉理解、推理强度可调；专为智能体编程与端到端知识工作。',
      appUrl: 'https://www.kimi.com/',
      capabilityUrl: 'https://platform.kimi.ai/docs',
      taskFit: '长程编程与深度研究类知识工作；通用对话与视觉理解用 kimi-k2.6。',
      accessDate: '2026-10-22',
      verified: true
    },
    {
      vendor: '腾讯',
      modelId: 'tencent-yuanbao',
      displayName: '腾讯元宝（混元 Hunyuan）',
      descZh: '聊天、写作、搜索一体助手（页面原文）；底层腾讯混元支持快慢思考、多模态理解与生图。',
      appUrl: 'https://yuanbao.tencent.com/',
      capabilityUrl: 'https://cloud.tencent.com/document/product/1729/104753',
      taskFit: '日常问答、写作与搜索辅助；图像创作与多模态理解依赖混元能力（App 内具体型号未核验）。',
      accessDate: '2026-10-22',
      verified: true
    }
  ].map(function (entry) { return Object.freeze(entry); });
  var CN_MODEL_IDS = CN_MODELS.map(function (entry) { return entry.modelId; });

  function isChineseLocale(locale) {
    return typeof locale === 'string' && (locale === 'zh' || locale.slice(0, 3) === 'zh-');
  }

  function isCNModel(entry) {
    return !!entry && typeof entry === 'object' && !Array.isArray(entry)
      && typeof entry.modelId === 'string' && CN_MODEL_IDS.indexOf(entry.modelId) >= 0;
  }

  // Stable CN-first ordering for the Chinese interface; every other locale keeps
  // the caller's order. Returns a new array; never mutates the input.
  function sortModels(models, locale) {
    var input = Array.isArray(models) ? models : [];
    if (!isChineseLocale(locale)) return input.slice();
    var cn = [], rest = [];
    for (var i = 0; i < input.length; i++) (isCNModel(input[i]) ? cn : rest).push(input[i]);
    return cn.concat(rest);
  }

  root.TangoModelCatalogCN = Object.freeze({
    CN_MODELS: Object.freeze(CN_MODELS),
    CN_MODEL_IDS: Object.freeze(CN_MODEL_IDS),
    isCNModel: isCNModel,
    sortModels: sortModels
  });
}(typeof window !== 'undefined' ? window : globalThis));
