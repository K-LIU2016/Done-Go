// M13 验收页 + 追踪层 组件页测试（RED 先行）
// 契约：
//   acceptance.js mount(el, { ready, artifact, accepted, gainText, onAccept, onRevise, onReject }) → handle.update
//     DOM（prototype L129-131/L479-489）：.artifact(h3+meta+.evidence) + 接受(primary)/要求修改/拒绝 + .gain
//     DAG M13 命名 onAccept({opinion})——本 spec 细化：接受→onAccept({opinion:''})；要求修改→onRevise({opinion})（带意见、保旧版）；拒绝→onReject()
//   trace-view.js mount(el, { traceText })：.trace 等宽 pre span 树（OTel GenAI 命名，prototype L132/L491-505）
import { test, expect } from '@playwright/test';

const ARTIFACT = {
  title: '国内 K12 的 AI 教育：政策、课堂与教师准备度 · v1',
  meta: '3120 字 · 5 节 · 9 个引用',
  evidence: '证据：引用核验 9/9 通过（1 处数据曾不符，已修正并复核）',
};

async function mountAcceptance(page: import('@playwright/test').Page, extra: Record<string, unknown> = {}) {
  await page.goto('/component.html?c=acceptance');
  await page.evaluate((patch) => {
    window.__calls = [];
    const props = {
      ready: true, artifact: ARTIFACT, accepted: false, gainText: '约 45 分钟', ...patch,
    } as Record<string, unknown>;
    props.onAccept = (payload: unknown) => window.__calls!.push(['accept', payload]);
    props.onRevise = (payload: unknown) => window.__calls!.push(['revise', payload]);
    props.onReject = () => window.__calls!.push(['reject']);
    window.__mount('acceptance', props);
  }, extra);
}

test('M13 未就绪：占位说明（prototype L481）', async ({ page }) => {
  await mountAcceptance(page, { ready: false });
  await expect(page.locator('#host')).toContainText('交付物完成后');
});

test('M13 artifact + 证据区（PRD §5.6 证据区）', async ({ page }) => {
  await mountAcceptance(page);
  await expect(page.locator('.artifact h3')).toContainText('国内 K12 的 AI 教育');
  await expect(page.locator('.artifact .evidence')).toContainText('引用核验 9/9 通过');
});

test('M13 接受：onAccept({opinion:\'\'})（PRD §5.6 接受计入时间收益）', async ({ page }) => {
  await mountAcceptance(page);
  await page.locator('button:has-text("接受")').click();
  expect(await page.evaluate(() => window.__calls)).toEqual([['accept', { opinion: '' }]]);
});

test('M13 要求修改：先出意见输入，带意见回调且语义保旧版（PRD §5.6）', async ({ page }) => {
  await mountAcceptance(page);
  await page.locator('button:has-text("要求修改")').click();
  const opinion = page.locator('textarea, input[type=text]');
  await expect(opinion).toBeVisible();
  await opinion.fill('第 4 节再短一点');
  // 契约：意见确认按钮统一带 data-confirm-revise 钩子（避免文案耦合）
  await page.locator('button[data-confirm-revise]').click();
  const calls = await page.evaluate(() => window.__calls);
  expect(calls).toEqual([['revise', { opinion: '第 4 节再短一点' }]]);
});

test('M13 拒绝：onReject()（原因可选）', async ({ page }) => {
  await mountAcceptance(page);
  await page.locator('button:has-text("拒绝")').click();
  expect(await page.evaluate(() => window.__calls)).toEqual([['reject']]);
});

test('M13 已接受态：.gain 计时收益（prototype L487）', async ({ page }) => {
  await mountAcceptance(page, { accepted: true });
  const gain = page.locator('.gain');
  await expect(gain).toContainText('已接受');
  await expect(gain).toContainText('约 45 分钟');
});

test('M13 trace-view：等宽 pre span 树、OTel GenAI 命名、纯文本可复制（prototype L491-505）', async ({ page }) => {
  await page.goto('/component.html?c=trace-view');
  const out = await page.evaluate(() => {
    window.__mount('trace-view', {
      traceText: 'invoke_agent block  mission=m_r  13:30–14:58\n├─ invoke_agent researcher#1  order=wo_1\n│  ├─ execute_tool web.search  ✓ 11 results\n│  └─ chat deepseek-v4.1-flash-fast\n├─ donego.need n1  受众确认  waited 4m\n└─ merge artifact a_r v1  → ready',
    });
    const el = document.querySelector('.trace') as HTMLElement;
    return {
      text: el.textContent ?? '',
      mono: getComputedStyle(el).fontFamily.toLowerCase(),
      pre: getComputedStyle(el).whiteSpace,
    };
  });
  expect(out.mono).toContain('mono');
  expect(out.pre).toBe('pre');
  for (const needle of ['invoke_agent block', 'execute_tool web.search', 'chat ', 'donego.need n1', 'merge artifact']) {
    expect(out.text).toContain(needle);
  }
});
