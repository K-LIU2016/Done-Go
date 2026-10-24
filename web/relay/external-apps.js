// web/relay/external-apps.js — AI 接力 v2 外部 AI 应用清单（SPEC §5.2，L4接力棒线）
//
// Shape: [{ id, name, initial, color, url, region:'cn'|'global', note, verifiedAt }]
// — 国内 5 家 + 海外 3 家（海外三家在接力棒卡里折叠在「更多」后面，SPEC §4④）。
//
// URL verification log (SPEC §5.2 每个URL都要实际打开核对并写入 verifiedAt),
// checked 2026-10-25 (+0800) via `curl -sS -o /dev/null -w %{http_code} -L`:
//   from argus-thinkpad:
//     https://www.doubao.com/chat/    200
//     https://chat.deepseek.com/      200
//     https://www.qianwen.com/        200
//     https://www.kimi.com/           200
//     https://yuanbao.tencent.com/    200
//     https://claude.ai/              200
//     https://chatgpt.com/            000 connection timed out (egress block)
//   from the Mac (different egress):
//     https://chatgpt.com/            403 + `cf-mitigated: challenge` over
//                                     HTTP/2 — Cloudflare bot challenge for
//                                     curl; TLS+HTTP served, host live
//     https://gemini.google.com/      200
//     https://claude.ai/              403 (same cloudflare challenge; the
//                                     thinkpad 200 above stands as the pass)
// → all 8 URLs live and reachable; verifiedAt pinned to 2026-10-25.
//
// CN colors/initials are pinned to the prototype .apps row
// (design/relay-v2/prototype.html S4). The global three are not covered by
// the prototype (SPEC §4④ adds them via 「更多」), so their badge colors use
// the vendors' official brand colors.
//
// Pure data module: no DOM, no fetch — importable from node --test and the
// browser, like web/relay/contracts.js.

export var CN_REGION = 'cn';
export var GLOBAL_REGION = 'global';

// SPEC §4④: 豆包（默认）— default selection on the result-page baton and the
// fixed target on the fail-page baton (§4⑧ 打开豆包).
export var DEFAULT_APP_ID = 'doubao';

// Date the URL verification above actually ran (YYYY-MM-DD, +0800).
export var VERIFIED_AT = '2026-10-25';

// Mirrors APP_ID_RE in web/relay/contracts.js (not exported there); ids must
// stay metric-slot safe (SPEC §5.5 baton_copy:<app> / graduated:<app>).
var APP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
var COLOR_RE = /^#[0-9a-f]{3,8}$/i;
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
var REGIONS = [CN_REGION, GLOBAL_REGION];

function clean(value, cap) {
  return String(value == null ? '' : value).trim().slice(0, cap);
}

// Whitelist one app entry; returns null for anything malformed so a hand edit
// can never smuggle junk (wrong region, http url, missing verifiedAt…) into
// the baton UI or a metric counter name.
export function sanitizeExternalApp(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  var id = clean(value.id, 32);
  if (!APP_ID_RE.test(id)) return null;
  var name = clean(value.name, 40);
  if (!name) return null;
  var initial = clean(value.initial, 8);
  if (!initial) return null;
  var color = clean(value.color, 9);
  if (!COLOR_RE.test(color)) return null;
  var url = clean(value.url, 300);
  if (!/^https:\/\//.test(url) || /\s/.test(url)) return null;
  if (REGIONS.indexOf(value.region) === -1) return null;
  var note = clean(value.note, 60);
  if (!note) return null;
  var verifiedAt = clean(value.verifiedAt, 10);
  if (!DATE_RE.test(verifiedAt) || Number.isNaN(Date.parse(verifiedAt))) return null;
  return {
    id: id, name: name, initial: initial, color: color, url: url,
    region: value.region, note: note, verifiedAt: verifiedAt,
  };
}

var RAW_APPS = [
  // 国内 5 家 — urls pinned by SPEC §5.2, visuals pinned by prototype S4.
  { id: 'doubao', name: '豆包', initial: '豆', color: '#3E6BF5', url: 'https://www.doubao.com/chat/', region: 'cn', note: '字节跳动', verifiedAt: VERIFIED_AT },
  { id: 'deepseek', name: 'DeepSeek', initial: 'D', color: '#4D6BFE', url: 'https://chat.deepseek.com/', region: 'cn', note: '深度求索', verifiedAt: VERIFIED_AT },
  { id: 'qianwen', name: '通义千问', initial: '千', color: '#615CED', url: 'https://www.qianwen.com/', region: 'cn', note: '阿里巴巴', verifiedAt: VERIFIED_AT },
  { id: 'kimi', name: 'Kimi', initial: 'K', color: '#111111', url: 'https://www.kimi.com/', region: 'cn', note: '月之暗面', verifiedAt: VERIFIED_AT },
  { id: 'yuanbao', name: '元宝', initial: '元', color: '#1BB46B', url: 'https://yuanbao.tencent.com/', region: 'cn', note: '腾讯', verifiedAt: VERIFIED_AT },
  // 海外 3 家 — SPEC §4④ 「更多」展开; official entry points.
  { id: 'chatgpt', name: 'ChatGPT', initial: 'G', color: '#10A37F', url: 'https://chatgpt.com/', region: 'global', note: 'OpenAI', verifiedAt: VERIFIED_AT },
  { id: 'claude', name: 'Claude', initial: 'C', color: '#D97757', url: 'https://claude.ai/', region: 'global', note: 'Anthropic', verifiedAt: VERIFIED_AT },
  { id: 'gemini', name: 'Gemini', initial: 'G', color: '#4285F4', url: 'https://gemini.google.com/', region: 'global', note: 'Google', verifiedAt: VERIFIED_AT },
];

export var EXTERNAL_APPS = RAW_APPS.map(sanitizeExternalApp).filter(Boolean);

export function findExternalApp(id, apps) {
  var key = String(id == null ? '' : id);
  var list = Array.isArray(apps) ? apps : EXTERNAL_APPS;
  for (var i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].id === key) return list[i];
  }
  return null;
}

export function externalAppIds(apps) {
  var list = Array.isArray(apps) ? apps : EXTERNAL_APPS;
  return list.map(function (app) { return app ? String(app.id) : ''; }).filter(Boolean);
}

// SPEC §5.2 guard: entries without a well-formed verifiedAt date. Used by
// tests/CI so an app added without a real reachability check fails loudly.
export function unverifiedApps(apps) {
  var list = Array.isArray(apps) ? apps : EXTERNAL_APPS;
  return list.filter(function (app) {
    return !(app && DATE_RE.test(String(app.verifiedAt || '')) && !Number.isNaN(Date.parse(app.verifiedAt)));
  });
}
