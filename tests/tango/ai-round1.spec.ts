import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

/**
 * AI Round 1 acceptance (decision D9: TANGO_AI_PARSE / TANGO_AI_PROMPTS are open
 * ONLY on temporary instances, via process environment — never in code or .env).
 *
 * Required topology (provisioned outside this spec, on the test host):
 *   17519  controlled LLM stub (markers: STUB_TIMEOUT / STUB_BADJSON / STUB_429,
 *          canned parse JSON incl. 晚上10点→22:00, canned prompt reply)
 *   17517  entry shim used only so playwright's globalSetup finds /__test/register
 *   17521  real scripts/serve-tango.mjs with TANGO_AI_PARSE=1 TANGO_AI_PROMPTS=1
 *          TANGO_AI_URL→stub TANGO_DEMO_MODE=1 (visitor, auto demo login)
 *   17520  same as 17521 but TANGO_AI_DAILY_LIMIT=1
 *
 * Skipped unless TANGO_ROUND1_E2E=1, so the shared `verify:ui` gate never needs
 * this throwaway infrastructure.
 */
const APP = 'http://127.0.0.1:17517';
const LIMIT_APP = 'http://127.0.0.1:17520';
const STUB_LOG = '/tmp/donego-ai-round1/stub-log.jsonl';

test.skip(process.env.TANGO_ROUND1_E2E !== '1', 'AI Round 1 stub instances not provisioned (set TANGO_ROUND1_E2E=1)');

async function enter(page: Page, base = APP) {
  await page.addInitScript(() => localStorage.setItem('tango-donego.lang', 'zh'));
  await page.goto(base + '/#today');
  await expect(page.locator('#capForm')).toBeVisible();
}

async function tidyOn(page: Page) {
  await expect(page.locator('#aiTidyBtn')).toBeVisible();
  await page.locator('#aiTidyBtn').click();
  await expect(page.locator('#aiTidyBtn')).toHaveAttribute('aria-pressed', 'true');
}

async function say(page: Page, text: string) {
  await page.locator('#cap-text').fill(text);
  await page.locator('#capGo').click();
}

async function armChat(page: Page) {
  return page.waitForResponse(r => r.url().includes('/api/assistant/chat') && r.request().method() === 'POST');
}

async function confirmSend(page: Page) {
  await expect(page.locator('.sheet h2')).toHaveText('发送前预览');
  await page.locator('.sheet [data-act="send-confirm"]').click();
}

function stubEntries() {
  try { return readFileSync(STUB_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
}

test('visitor: rule result first, AI diff hint appears, one-click adopt writes 22:00', async ({ page }) => {
  await enter(page);
  await tidyOn(page);
  await say(page, '晚10点收拾房间');
  const draft = page.locator('.draft').first();
  // Rule engine answers first (known gap: 晚10点 → 10:00, no 12h shift).
  await expect(draft.locator('input[data-f="start"]')).toHaveValue('10:00');
  await confirmSend(page);
  // AI diff sheet arrives asynchronously; nothing was written yet.
  await expect(page.locator('.sheet h2')).toHaveText('AI 整理建议');
  await expect(page.locator('.sheet')).toContainText('22:00');
  await page.locator('.sheet [data-act="ai-diff-adopt"]').click();
  await expect(draft.locator('input[data-f="start"]')).toHaveValue('22:00');
  await expect(draft.locator('input[data-f="end"]')).toHaveValue('23:00');
});

test('stub maps 晚上10点 to 22:00 through the real gateway chain', async ({ page }) => {
  await enter(page);
  await tidyOn(page);
  const before = stubEntries().length;
  await say(page, '晚上10点写总结');
  const draft = page.locator('.draft').first();
  await expect(draft.locator('input[data-f="start"]')).toHaveValue('22:00'); // rules already get this one right
  const respP = armChat(page);
  await confirmSend(page);
  const resp = await respP;
  expect(resp.status()).toBe(200);
  const mine = stubEntries().slice(before).filter((e: any) => e.marker === 'parse');
  expect(mine.length).toBeGreaterThan(0);
  expect((mine[mine.length - 1] as any).parseStart).toBe('22:00');
  expect((mine[mine.length - 1] as any).authMatchesStubKey).toBe(true);
});

test('capability card lists CN models zh-first and generates a dedicated prompt', async ({ page }) => {
  await enter(page);
  await say(page, '晚10点收拾房间');
  const draft = page.locator('.draft').first();
  await expect(draft).toBeVisible();
  await draft.locator('[data-act="ai-tools"]').click();
  const sheet = page.locator('.sheet');
  await expect(sheet).toBeVisible();
  const gen = sheet.locator('[data-act="ai-prompt-gen"]');
  await expect(gen).toBeVisible();
  await expect(gen).toHaveText('生成专属提示词');
  const alt = sheet.locator('details').filter({ hasText: '备选模型' }).first();
  await alt.locator('summary', { hasText: '备选模型' }).click();
  const tools = alt.locator('ul.tools > li.tool');
  await expect(tools.nth(0)).toContainText('豆包');
  await expect(tools.nth(0)).toContainText('国产模型');
  expect(await tools.filter({ hasText: '国产模型' }).count()).toBe(5);
  // Chinese locale: all five CN cards sort before the two tracked overseas cards.
  const flags = await tools.evaluateAll(els => els.map(el => (el.textContent || '').includes('国产模型') ? 1 : 0));
  expect(flags.join('')).toBe('1111100');
  const respP = armChat(page);
  await gen.click();
  await expect(page.locator('.sheet h2')).toHaveText('发送前预览');
  await page.locator('.sheet [data-act="send-confirm"]').click();
  expect((await respP).status()).toBe(200);
  await expect(page.locator('.sheet h2')).toHaveText('生成专属提示词');
  await expect(page.locator('.sheet')).toContainText('AI 生成 · 未实测');
  await expect(page.locator('#ai-prompt-out')).toContainText('收拾房间');
});

async function fallbackCase(page: Page, text: string, ruleStart: string, wantStatus: number[]) {
  await enter(page);
  await tidyOn(page);
  await say(page, text);
  const draft = page.locator('.draft').first();
  await expect(draft.locator('input[data-f="start"]')).toHaveValue(ruleStart);
  const respP = armChat(page);
  await confirmSend(page);
  const resp = await respP;
  expect(wantStatus).toContain(resp.status());
  await page.waitForTimeout(400); // let any (wrong) follow-up sheet/toast render
  await expect(page.locator('.overlay')).toHaveCount(0); // no AI-success sheet
  await expect(page.locator('.toast')).toBeHidden(); // no "已按 AI 建议更新" fake success
  await expect(draft.locator('input[data-f="start"]')).toHaveValue(ruleStart); // rule result kept
}

test('LLM unavailable (bad JSON) keeps rule result without fake success', async ({ page }) => {
  await fallbackCase(page, 'STUB_BADJSON 下午3点回邮件', '15:00', [200]);
});

test('LLM unavailable (upstream 429) keeps rule result without fake success', async ({ page }) => {
  await fallbackCase(page, 'STUB_429 晚上8点健身', '20:00', [502]);
});

test('LLM unavailable (timeout) keeps rule result without fake success', async ({ page }) => {
  test.setTimeout(90000);
  await fallbackCase(page, 'STUB_TIMEOUT 晚上9点读书', '21:00', [499, 502, 504]);
});

test('daily limit exhausted shows 今日体验额度已用完 and keeps the rule result', async ({ page }) => {
  await enter(page, LIMIT_APP);
  await tidyOn(page);
  // Call #1 fits inside TANGO_AI_DAILY_LIMIT=1 and produces an adoptable diff.
  await say(page, '晚10点收拾房间');
  const draft = page.locator('.draft').first();
  await expect(draft.locator('input[data-f="start"]')).toHaveValue('10:00');
  await confirmSend(page);
  await expect(page.locator('.sheet h2')).toHaveText('AI 整理建议');
  await page.locator('.sheet [data-act="ai-diff-adopt"]').click();
  await expect(draft.locator('input[data-f="start"]')).toHaveValue('22:00');
  await draft.locator('[data-act="draft-del"]').click();
  // Call #2 hits the daily cap server-side.
  await say(page, '晚上10点写总结');
  const draft2 = page.locator('.draft').first();
  await expect(draft2.locator('input[data-f="start"]')).toHaveValue('22:00');
  const respP = armChat(page);
  await confirmSend(page);
  expect((await respP).status()).toBe(429);
  await expect(page.locator('#capStatus')).toHaveText('今日体验额度已用完');
  await expect(page.locator('#capStatus')).toHaveClass(/warn/);
  await expect(page.locator('.overlay')).toHaveCount(0);
  await expect(draft2.locator('input[data-f="start"]')).toHaveValue('22:00'); // rule result kept
});
