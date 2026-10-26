// M02 测试 harness 冒烟（RED 先行 · harness/组件未实现前必红）
// 契约（plan.md M02，实现方 tests/agentic/ui/component.html + helpers/serve.mjs + playwright.config.ts）：
//   - serve.mjs 零依赖静态服务 web/agentic/ 于 127.0.0.1:17621（playwright.config.ts webServer）
//   - GET /component.html?c=<name>[&p=<encodeURIComponent(JSON)>]
//   - component.html 引 web/agentic/agentic.css；挂载点 #host；
//     window.__defaults(name) → fixtures 深拷贝默认 props
//     window.__mount(name, props) → mount(host, props)，置 window.__handle/__el，返回 handle
//     window.__update(props) → window.__handle.update(props)
import { test, expect } from '@playwright/test';

test('M02 服务可达：/agentic.css 200 且含 Kira 设计变量声明', async ({ request }) => {
  const res = await request.get('/agentic.css');
  expect(res.status()).toBe(200);
  const css = await res.text();
  expect(css).toContain(':root');
  expect(css).toContain('--you'); // prototype L12 扩展 token（M01）
});

test('M02 component.html 可达且暴露 __mount/__defaults', async ({ page }) => {
  await page.goto('/component.html?c=block-card');
  await expect(page.locator('#host')).toBeAttached();
  const api = await page.evaluate(() => ({
    mount: typeof window.__mount,
    defaults: typeof window.__defaults,
    update: typeof window.__update,
  }));
  expect(api.mount).toBe('function');
  expect(api.defaults).toBe('function');
  expect(api.update).toBe('function');
});

test('M02 __defaults 返回 fixtures 默认 props（block-card 含黄金场景 5 块）', async ({ page }) => {
  await page.goto('/component.html?c=block-card');
  const props = await page.evaluate(() => window.__defaults('block-card'));
  expect(Array.isArray(props?.blocks)).toBeTruthy();
  expect(props.blocks.map((b: { id: string }) => b.id)).toEqual(['r', 'c', 'f', 'b', 's']);
});

test('M02 esc 注入安全：恶意标题原样呈现、不产生元素注入（M01 XSS 基线）', async ({ page }) => {
  await page.goto('/component.html?c=block-card');
  const evil = await page.evaluate(() => {
    const props = window.__defaults('block-card');
    props.blocks = [{ ...props.blocks[0], id: 'x', title: '<img src=x onerror="window.__pwned=1">' }];
    window.__mount('block-card', props);
    return props.blocks[0].title;
  });
  await expect(page.locator('.block .ttl').first()).toContainText('<img src=x onerror="window.__pwned=1">');
  const injected = await page.evaluate(() => ({
    imgs: document.querySelectorAll('#host img').length,
    pwned: (window as unknown as { __pwned?: number }).__pwned ?? 0,
  }));
  expect(injected.imgs).toBe(0);
  expect(injected.pwned).toBe(0);
});

test('M02 shape 页可用：?c=shape-text 渲染 outline 条目', async ({ page }) => {
  await page.goto('/component.html?c=shape-text');
  const rendered = await page.evaluate(() => {
    const props = window.__defaults('shape-text');
    window.__mount('shape-text', props);
    return document.querySelectorAll('.outline li').length;
  });
  expect(rendered).toBeGreaterThan(0);
});
