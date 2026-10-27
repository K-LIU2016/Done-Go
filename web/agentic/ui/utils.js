// M01 ui-utils：共享工具（esc / setHTML / T / HM / pct / on）
// 依据：BUILD-PLAN §3 W5.1；plan.md M01；prototype.html L244-247（T/HM/pct）、
// L328（setHTML 内容比对跳过——增量更新基石）、L329（esc 五实体转义）。
// M01 落地后各组件静态 import 本文件（并行落地期的「组件内探测+本地兜底」已收编，此处为唯一实现）。

/** 五实体转义（XSS 基线）：外部字符串入 HTML/属性必经（prototype L329 扩展版） */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** 内容没变就不重写 DOM（prototype L328：增量更新基石）。返回是否发生写入。 */
export function setHTML(el, html) {
  if (!el || el._h === html) return false;
  el._h = html;
  el.innerHTML = html;
  return true;
}

/** 'HH:MM' → 当日分钟数（prototype L244） */
export function T(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return h * 60 + m;
}

/** 当日分钟数 → 'HH:MM'（prototype L245；非有限数按 0，截断取整） */
export function HM(t) {
  const n = Number.isFinite(t) ? Math.max(0, Math.trunc(t)) : 0;
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

/** 分钟 → 区间百分比字符串，两位小数 + %（prototype L247） */
export function pct(v, a, b) {
  return `${(((v - a) / (b - a)) * 100).toFixed(2)}%`;
}

/**
 * 事件委托：el 上监听 type，仅当 e.target.closest(sel) 命中才回调 fn(e, target)。
 * 返回解绑函数（无 removeEventListener 的桩宿主安全跳过）。
 */
export function on(el, type, sel, fn) {
  const handler = (e) => {
    const t = e && e.target && typeof e.target.closest === 'function' ? e.target.closest(sel) : null;
    if (t) fn(e, t);
  };
  if (el && typeof el.addEventListener === 'function') el.addEventListener(type, handler);
  return () => {
    if (el && typeof el.removeEventListener === 'function') el.removeEventListener(type, handler);
  };
}
