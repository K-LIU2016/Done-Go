// M03 shape 渲染器 A · 文本结构类（outline/facts/caveat/table/cards）
// 结构照 prototype.html（唯一视觉标准）：
//   outline      L396：ol.outline > li(class=add/del/chg 可空) > b + div.q（差异类 L265-269）
//   facts        L398：dl.kv > dt/dd 对
//   table        L79-80/L397：table.units，thead 表头 + tbody 数据行
//   caveat       L404：p.caveat，⚠ 前缀
//   cards        无原型直对应：条目卡（title + body），与 .sample/.card 卡片语汇一致
// 数据形状照 PRD §10.3 shape.blocks[]。全部纯函数：block → html，无 DOM、无副作用，
// node --test 可直接测（DOM 壳 mount/update 供组件页与 demo 装配，见文末）。
import { esc, setHTML, registerShape, renderShape } from './registry.js';

const txt = (v) => esc(v ?? '');
const arr = (v) => (Array.isArray(v) ? v : []);

/** outline：目录骨架。items[]: { h 标题, q 问题, d 差异类 'add'|'del'|'chg'（可缺省） } */
export function outline(block) {
  const lis = arr(block?.items).map((it) => {
    const d = it && typeof it.d === 'string' ? it.d : '';
    return `<li class="${txt(d)}"><b>${txt(it?.h)}</b><div class="q">${txt(it?.q)}</div></li>`;
  }).join('');
  return `<ol class="outline">${lis}</ol>`;
}

/** facts：键值事实。items[]: { k, v } */
export function facts(block) {
  const pairs = arr(block?.items).map((it) => `<dt>${txt(it?.k)}</dt><dd>${txt(it?.v)}</dd>`).join('');
  return `<dl class="kv">${pairs}</dl>`;
}

/** caveat：限制说明，⚠ 前缀（prototype L404） */
export function caveat(block) {
  return `<p class="caveat">⚠ ${txt(block?.text)}</p>`;
}

/** table：课时表。head[] 表头；rows[][] 数据行（表头行 tr 带 hd 类，区别于数据行） */
export function table(block) {
  const head = arr(block?.head).map((h) => `<th>${txt(h)}</th>`).join('');
  const thead = head ? `<thead><tr class="hd">${head}</tr></thead>` : '';
  const tbody = arr(block?.rows).map((r) => `<tr>${arr(r).map((c) => `<td>${txt(c)}</td>`).join('')}</tr>`).join('');
  return `<table class="units">${thead}<tbody>${tbody}</tbody></table>`;
}

/** cards：条目卡组。title 组标题（可缺省）；items[]: { title, body } */
export function cards(block) {
  const head = block?.title ? `<h4>${txt(block.title)}</h4>` : '';
  const list = arr(block?.items).map((it) =>
    `<div class="card"><b>${txt(it?.title)}</b><div class="body">${txt(it?.body)}</div></div>`).join('');
  return `<div class="cards">${head}${list}</div>`;
}

/** 五个渲染器的具名集合（测试与装配入口） */
export const textShapes = { outline, facts, caveat, table, cards };

// 导入即注册内置类型（renderShape 分发的先决条件；组件页/demo 需 import 本模块）
for (const [type, fn] of Object.entries(textShapes)) registerShape(type, fn);

/** blocks[] → 逐块 HTML（每块包一层 .shape[data-shape]，容器由调用方给） */
export function shapeListHTML(blocks) {
  return arr(blocks).filter(Boolean).map((b) =>
    `<div class="shape" data-shape="${txt(b.type)}">${renderShape(b)}</div>`).join('');
}

/**
 * DOM 壳（组件页 ?c=shape-text / demo 装配）：mount(el, { blocks }) → handle。
 * handle.update({ blocks }) 增量更新：setHTML 内容比对，没变不重写（不闪变）。
 */
export function mount(el, props) {
  const render = (p) => setHTML(el, shapeListHTML(p?.blocks));
  render(props ?? {});
  return {
    update(p) {
      render(p ?? {});
      return this;
    },
  };
}

/** 别名：避免与组件页其它 mount 混淆 */
export const mountShapes = mount;
