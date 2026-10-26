// M04 shape 渲染器 B 组件页测试（RED 先行）
// 契约：?c=shape-rich → __defaults('shape-rich') = { blocks: [...checklist/timeline/slides/diffSummary/mapRoute/personCard/sample] }
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/component.html?c=shape-rich');
  await page.evaluate(() => { window.__mount('shape-rich', window.__defaults('shape-rich')!); });
});

test('M04 diffSummary：三差异类 + reason 可见（prototype L83-85）', async ({ page }) => {
  const html = await page.evaluate(() => {
    window.__mount('shape-rich', {
      blocks: [{
        type: 'diffSummary',
        added: ['课堂实践', '教师准备度'],
        removed: ['海外案例'],
        changed: ['来源范围仅国内'],
        reason: '你说只看国内 K12',
      }],
    });
    return {
      add: document.querySelectorAll('.add').length,
      del: document.querySelectorAll('.del').length,
      chg: document.querySelectorAll('.chg').length,
      reason: document.querySelector('#host')!.textContent!.includes('你说只看国内 K12'),
    };
  });
  expect(html.add).toBeGreaterThanOrEqual(1);
  expect(html.del).toBeGreaterThanOrEqual(1);
  expect(html.chg).toBeGreaterThanOrEqual(1);
  expect(html.reason).toBeTruthy();
});

test('M04 slides：.slide 双栏缩略（prototype L147-151）', async ({ page }) => {
  await page.evaluate(() => {
    window.__mount('shape-rich', {
      blocks: [{
        type: 'slides',
        pages: [{ tag: 'AI 进课堂 · 第 2 课时', title: '用 AI 备课：提示词与核对', bullets: ['用 AI 生成导入问题'] }],
      }],
    });
  });
  await expect(page.locator('.slide .txt h4')).toContainText('用 AI 备课：提示词与核对');
  await expect(page.locator('.slide ul li').first()).toContainText('用 AI 生成导入问题');
});

test('M04 sample：Markdown 子集渲染 + 白名单外标签不执行', async ({ page }) => {
  const out = await page.evaluate(() => {
    window.__mount('shape-rich', {
      blocks: [{ type: 'sample', text: '**15 分钟改教案**\n- 对照课标逐条核对\n<script>window.__s=1</script>' }],
    });
    return {
      bold: document.querySelectorAll('#host b').length,
      li: document.querySelectorAll('#host li').length,
      script: document.querySelectorAll('#host script').length,
      fired: (window as unknown as { __s?: number }).__s ?? 0,
    };
  });
  expect(out.bold).toBe(1);
  expect(out.li).toBe(1);
  expect(out.script).toBe(0);
  expect(out.fired).toBe(0);
});

test('M04 mapRoute / personCard / checklist / timeline 四类渲染', async ({ page }) => {
  const out = await page.evaluate(() => {
    window.__mount('shape-rich', {
      blocks: [
        { type: 'mapRoute', title: '18:25 出发 · 地铁 32 分钟', lines: ['家 → 2 号线', '步行 6 分钟'] },
        { type: 'personCard', name: '小王', role: '朋友', notes: ['想聊 Argus 合作'] },
        { type: 'checklist', items: [{ text: '带书', done: true }, { text: '确认画像', done: false }] },
        { type: 'timeline', items: [{ at: '13:30', text: '研究员先找资料' }, { at: '13:55', text: '你确认受众', you: true }] },
      ],
    });
    const host = document.querySelector('#host')!;
    const text = host.textContent ?? '';
    return {
      route: !!document.querySelector('.route'),
      lines: document.querySelectorAll('.route .line').length,
      person: text.includes('小王') && text.includes('想聊 Argus 合作'),
      checklist: text.includes('带书') && text.includes('确认画像'),
      timeline: text.includes('研究员先找资料') && text.includes('你确认受众'),
    };
  });
  expect(out.route).toBeTruthy();
  expect(out.lines).toBe(2);
  expect(out.person).toBeTruthy();
  expect(out.checklist).toBeTruthy();
  expect(out.timeline).toBeTruthy();
});
