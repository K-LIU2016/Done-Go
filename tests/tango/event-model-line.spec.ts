import { test, expect, type Page } from '@playwright/test';

const day = '2026-10-21';
const entries = [
  { id: 'read', title: '读论文', kind: 'explore', start: '09:00', end: '10:00' },
  { id: 'code', title: '调试代码', kind: 'create', start: '10:00', end: '11:00' },
  { id: 'long', title: '开发程序', kind: 'create', start: '07:00', end: '19:00' },
  { id: 'parcel', title: '拿快递', kind: 'necessary', start: '17:30', end: '18:30' },
  { id: 'rest', title: '休息', kind: 'restore', start: '19:00', end: '20:00' },
].map(entry => ({ ...entry, date: day, prio: 2 }));
async function open(page: Page, patch = {}) {
  await page.clock.install({ time: new Date(day + 'T09:30:00+08:00') });
  await page.route('https://**', route => route.abort());
  await page.route('**/api/assistant/config', route => route.fulfill({ json: { available: false } }));
  await page.route('**/api/llm/config', route => route.fulfill({ json: { endpoints: [] } }));
  await page.route('**/api/assistant/chat', () => { throw new Error('Recommendation preview must not send private events automatically'); });
  await page.addInitScript(state => {
    localStorage.setItem('tango-donego.web.v1', JSON.stringify(state));
    localStorage.setItem('tango-donego.lang', 'zh');
    localStorage.setItem('tango-donego.llm.v1', JSON.stringify({ consent: false }));
  }, { v: 1, pv: 5, mode: 'real', name: '', wake: 960, entries, trials: [], drafts: [], methods: [], methodUses: [], fw: {}, sound: false, pal: 0, ...patch });
  await page.goto('/#today');
}
const advice = (page: Page, id: string) => page.locator('.event-model-line[data-id="' + id + '"]');

test('event rows replace duplicate completion with task-specific model advice in both themes and all languages', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page);
  const before = await page.evaluate(() => localStorage.getItem('tango-donego.web.v1'));
  for (const theme of ['standard', 'designer']) {
    await page.locator('#appearance-select').selectOption(theme);
    for (const language of ['zh', 'en', 'ru', 'th', 'ar', 'ko']) {
      await page.locator('#lang').selectOption(language);
      await expect(page.locator('.paper-route [data-act="task-finish"]')).toHaveCount(0);
      await expect(advice(page, 'read')).toHaveAttribute('data-estimate-source', 'insufficient');
      await expect(advice(page, 'read')).not.toContainText(/\d+\s*[–-]\s*\d+\s*min/i);
      await expect(advice(page, 'code')).toContainText('GPT-5.4');
      await expect(advice(page, 'long')).toHaveAttribute('data-estimate-source', 'insufficient');
      await expect(advice(page, 'parcel')).not.toContainText(/Claude|GPT|Gemini/);
      await expect(advice(page, 'rest')).not.toContainText(/Claude|GPT|Gemini/);
      if (language !== 'zh') {
        const copy = await page.locator('.event-model-line').allTextContents();
        expect(copy.join('')).not.toMatch(/[一-鿿]/);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (['zh', 'ar'].includes(language)) await page.locator('.paper-route').screenshot({ path: info.outputPath(theme + '-' + language + '-event-models.png') });
    }
  }
  await page.locator('#lang').selectOption('zh');
  await advice(page, 'read').click();
  await expect(page.locator('.sheet')).toContainText('样本不足');
  await expect(page.locator('.sheet [data-act="assistant-models"]')).toHaveAttribute('data-target', 'entry:read');
  await page.keyboard.press('Escape');
  await page.locator('.bubble[data-id="read"]').dblclick();
  await expect(page.locator('#finish-min')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => localStorage.getItem('tango-donego.web.v1'))).toBe(before);
  expect(errors).toEqual([]);
});

test('event estimates use matching personal history and label it as observational evidence', async ({ page }) => {
  const trial = (taskId: string, date: string, after: number, dataMode: 'real' | 'demo') => ({ taskId, date, before: 60, after, usedAI: true, category: 'read', confirmed: true, quality: 'accepted', dataMode });
  await open(page, { trials: [trial('r1', '2026-10-19', 40, 'real'), trial('r2', '2026-10-18', 30, 'real'), trial('d1', '2026-10-17', 55, 'demo'), trial('d2', '2026-10-16', 50, 'demo')] });
  await expect(advice(page, 'read')).toHaveAttribute('data-estimate-source', 'history');
  await expect(advice(page, 'read')).toContainText('20–30 min');
  await advice(page, 'read').click();
  await expect(page.locator('.sheet')).toContainText('个人历史差值参考');
  await expect(page.locator('.sheet')).toContainText('差值不等于 AI 的贡献');
  await page.keyboard.press('Escape');
});

test('demo estimates use only demo history and identify it as sample data', async ({ page }) => {
  const trial = (taskId: string, date: string, after: number, dataMode: 'real' | 'demo') => ({ taskId, date, before: 60, after, usedAI: true, category: 'read', confirmed: true, quality: 'accepted', dataMode });
  await open(page, { mode: 'demo', trials: [trial('r1', '2026-10-19', 40, 'real'), trial('r2', '2026-10-18', 30, 'real'), trial('d1', '2026-10-17', 50, 'demo'), trial('d2', '2026-10-16', 40, 'demo')] });
  await expect(advice(page, 'read')).toHaveAttribute('data-estimate-source', 'history');
  await expect(advice(page, 'read')).toContainText('示例历史差值参考');
  await expect(advice(page, 'read')).toContainText('10–20 min');
  await expect(advice(page, 'read')).toContainText('非本人实测');
  await expect(advice(page, 'read')).not.toContainText('个人历史差值参考');
  await advice(page, 'read').click();
  await expect(page.locator('.sheet')).toContainText('示例记录，非本人实测');
});

test('recommendation and detail share account availability and adopted model preferences', async ({ page }) => {
  await open(page, { entries: entries.map(entry => entry.id === 'read' ? { ...entry, modelPreference: 'gpt-5.4' } : entry), modelAvailability: { 'claude-sonnet-5.5': { state: 'unavailable' }, 'gpt-5.4': { state: 'available' } } });
  await expect(advice(page, 'read')).toContainText('GPT-5.4');
  await advice(page, 'read').click();
  await expect(page.locator('.sheet .tools').first()).toContainText('GPT-5.4');
});

test('muting a category suppresses proactive advice and no usable account produces no recommendation', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('tango-donego.hints.v1', JSON.stringify({ muted: { read: true } })));
  await open(page, { modelAvailability: Object.fromEntries(['claude-sonnet-5.5', 'gpt-5.4', 'gemini-3.1-pro-preview'].map(id => [id, { state: 'unavailable' }])) });
  await expect(advice(page, 'read')).toHaveCount(0);
  await expect(advice(page, 'code')).toContainText('暂无可用模型');
});
