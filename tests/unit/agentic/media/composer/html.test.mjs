// W11 composer · html.mjs 安全门禁先行单测（RED 契约）。
// 依据：DAG 组1c(4)：统一 escapeHtml（安全门禁『HTML 模板转义』的落点）、属性转义、
// class 前缀作用域；恶意文本注入用例必测。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { escapeHtml, escapeAttr, scopeClass } from '../../../../../scripts/agentic/composer/html.mjs';

test('escapeHtml neutralizes the five HTML metacharacters and keeps CJK text intact', () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml("a'b&c"), 'a&#39;b&amp;c');
  assert.equal(escapeHtml('AI 进课堂 · 第 2 课时'), 'AI 进课堂 · 第 2 课时');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(null), '');
});

test('escapeAttr keeps values safe inside double-quoted attributes', () => {
  const nasty = 'x" onmouseover="alert(1)';
  const escaped = escapeAttr(nasty);
  assert.ok(!escaped.includes('"'), '属性值里不得残留裸双引号');
  assert.equal(escapeAttr("it's"), 'it&#39;s');
  assert.equal(escapeAttr('/api/media/a.png'), '/api/media/a.png');
});

test('scopeClass prefixes and refuses class-token injection', () => {
  assert.equal(scopeClass('dg', 'slide'), 'dg-slide');
  assert.equal(scopeClass('dg', 'wm'), 'dg-wm');
  assert.throws(() => scopeClass('dg', 'slide wm'), /invalid/i);
  assert.throws(() => scopeClass('dg', 'slide"onclick="x'), /invalid/i);
  assert.throws(() => scopeClass('bad prefix', 'slide'), /invalid/i);
});
