// M03 shape 渲染器 A 组件页测试（RED 先行）
// 契约：?c=shape-text → window.__defaults('shape-text') = { blocks: [...PRD §10.3 blocks[]] }；
// __mount 后每块经 registry 渲染进 #host（.shape 或等价容器）；__update 换 blocks 内容增量更新。
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/component.html?c=shape-text');
  await page.evaluate(() => { window.__mount('shape-text', window.__defaults('shape-text')!); });
});

test('M03 outline：li 结构 + 差异类渲染（prototype L396）', async ({ page }) => {
  const items = await page.evaluate(() => {
    window.__mount('shape-text', {
      blocks: [
        {
          type: 'outline',
          items: [
            { h: '政策与标准', q: '2024–2026 要求？', d: 'chg' },
            { h: '课堂实践', q: '活动形态？', d: 'add' },
            { h: '海外案例', q: '课程框架', d: 'del' },
          ],
        },
      ],
    });
    return Array.from(document.querySelectorAll('.outline li')).map((li) => li.className);
  });
  expect(items).toEqual(['chg', 'add', 'del']);
  await expect(page.locator('.outline li.chg b')).toContainText('政策与标准');
});

test('M03 facts/caveat/table/cards 四类齐全渲染', async ({ page }) => {
  const counts = await page.evaluate(() => {
    window.__mount('shape-text', {
      blocks: [
        { type: 'facts', items: [{ k: '来源范围', v: '教育部及省市官网' }] },
        { type: 'caveat', text: '无法访问付费数据库，改用公开来源' },
        { type: 'table', head: ['课时', '目标'], rows: [['1', '认识生成式 AI']] },
        { type: 'cards', items: [{ title: '15 分钟改教案', body: 'AI 生成 3 个导入问题' }] },
      ],
    });
    return {
      dt: document.querySelectorAll('dl.kv dt').length,
      caveat: document.querySelectorAll('p.caveat').length,
      th: document.querySelectorAll('table.units th').length,
      cardText: document.body.textContent!.includes('15 分钟改教案'),
    };
  });
  expect(counts.dt).toBe(1);
  expect(counts.caveat).toBe(1);
  expect(counts.th).toBe(2);
  expect(counts.cardText).toBeTruthy();
});

test('M03 未知类型：降级为纯文本且不执行注入（PRD §10.3 末行）', async ({ page }) => {
  const out = await page.evaluate(() => {
    window.__mount('shape-text', {
      blocks: [{ type: 'hologram', text: '神秘组件 <img src=x onerror="window.__xss=1">' }],
    });
    return {
      text: document.querySelector('#host')!.textContent ?? '',
      imgs: document.querySelectorAll('#host img').length,
      xss: (window as unknown as { __xss?: number }).__xss ?? 0,
    };
  });
  expect(out.text).toContain('神秘组件');
  expect(out.imgs).toBe(0);
  expect(out.xss).toBe(0);
});

test('M03 update：换 blocks 后内容更新、已知容器不闪变（增量约束）', async ({ page }) => {
  await page.evaluate(() => {
    const host = document.querySelector('#host')!;
    host.setAttribute('data-marker', 'keep');
    window.__update({ blocks: [{ type: 'caveat', text: '第二版内容' }] });
  });
  await expect(page.locator('#host p.caveat')).toContainText('第二版内容');
  expect(await page.getAttribute('#host', 'data-marker')).toBe('keep');
});
