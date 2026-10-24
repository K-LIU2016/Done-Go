import { test, expect, type Page } from '@playwright/test';

const state = {
  v: 1,
  pv: 5,
  mode: 'real',
  name: '',
  wake: 960,
  entries: [],
  trials: [],
  drafts: [],
  methods: [],
  methodUses: [],
  fw: {},
  sound: false,
  pal: 0,
};

async function open(page: Page, configured = true) {
  await page.clock.install({ time: new Date('2026-10-24T09:00:00+08:00') });
  await page.addInitScript(({ initialState }) => {
    localStorage.setItem('tango-donego.web.v1', JSON.stringify(initialState));
    localStorage.setItem('tango-donego.lang', 'zh');
    localStorage.setItem('tango-donego.llm.v1', JSON.stringify({ consent: false }));
  }, { initialState: state });
  await page.route('https://**', route => route.abort());
  await page.route('**/api/llm/config', route => route.fulfill({ json: { endpoints: [] } }));
  await page.route('**/api/assistant/features', route => route.fulfill({ json: { parse: false, prompts: false } }));
  await page.route('**/api/assistant/config', route => route.fulfill({ json: configured ? {
    available: true,
    provider: 'openai',
    model: 'fixture-model',
    destination: 'https://example.test/v1/chat/completions',
  } : { available: false, provider: null, model: null, destination: null } }));
  await page.goto('/#today');
  await expect(page.locator('#relay-event-input')).toBeVisible();
}

test('daily event completes the AI relay and is saved as a result record', async ({ page }) => {
  await open(page);
  await page.locator('#relay-event-input').fill('整理会议记录');
  await page.locator('#relay-event-submit').click();
  await expect(page.locator('#relay-match')).toContainText('会议整理');
  await expect(page.locator('#relay-match')).toContainText('适合用 AI');

  await page.locator('[data-relay-start]').click();
  await expect(page.locator('#relay-workspace')).toBeVisible();
  await page.locator('#relay-material').fill('讨论了本周上线安排，张三负责测试，周五前反馈。');
  await page.route('**/api/assistant/chat', async route => {
    const body = route.request().postDataJSON();
    expect(body.mode).toBe('relay');
    expect(body.prompt).toContain('整理会议记录');
    expect(body.prompt).toContain('张三负责测试');
    await route.fulfill({ json: { content: [{ type: 'text', text: JSON.stringify({
      result: '会议重点：本周上线；待办：张三负责测试，周五前反馈。',
      learned: '把会议材料交给 AI，先生成重点和待办。',
      estimatedSavedMinutes: 15,
    }) }] } });
  });
  await page.locator('[data-relay-run]').click();
  await expect(page.locator('#relay-result')).toContainText('会议重点：本周上线');
  await expect(page.locator('#relay-result')).toContainText('预计省约 15 分钟');

  await page.locator('[data-relay-save]').click();
  await expect(page.locator('#relay-history')).toContainText('整理会议记录');
  await expect(page.locator('#relay-history')).toContainText('已记录');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tango-donego.ai-relay.v1')!));
  expect(saved.records).toHaveLength(1);
  expect(saved.records[0]).toMatchObject({ event: '整理会议记录', estimatedSavedMinutes: 15 });
});

test('without an AI connection the relay keeps the event and never fabricates a result', async ({ page }) => {
  await open(page, false);
  await page.locator('#relay-event-input').fill('写一封客户回复');
  await page.locator('#relay-event-submit').click();
  await expect(page.locator('#relay-match')).toContainText('消息起草');
  await page.locator('[data-relay-start]').click();
  await page.locator('#relay-material').fill('请确认下周二的会议时间。');
  await page.locator('[data-relay-run]').click();
  await expect(page.locator('#relay-notice')).toContainText('AI 还没连接');
  await expect(page.locator('#relay-result')).toHaveCount(0);
  await expect(page.locator('#relay-history')).toContainText('还没有接力记录');
});
