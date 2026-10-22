import { test, expect, type Page } from '@playwright/test';

const day = '2026-10-21';
const entries = [
  { id: 'read', title: '读论文', kind: 'explore', start: '09:00', end: '10:00', date: day, prio: 2 },
  { id: 'parcel', title: '拿快递', kind: 'necessary', start: '17:30', end: '18:30', date: day, prio: 2 },
];
const trial = (taskId: string, date: string, after: number, dataMode: 'real' | 'demo') =>
  ({ taskId, date, before: 60, after, usedAI: true, category: 'read', confirmed: true, quality: 'accepted', dataMode });

const languages = ['zh', 'en', 'ru', 'th', 'ar', 'ko'] as const;
const personal: Record<string, string> = {
  zh: '个人历史差值参考', en: 'Your past time differences', ru: 'Разница по вашим прошлым записям',
  th: 'ส่วนต่างเวลาจากบันทึกของคุณ', ar: 'الفارق الزمني من سجلاتك السابقة', ko: '내 이전 기록의 시간 차이 참고',
};
const sample: Record<string, string> = {
  zh: '示例历史差值参考', en: 'Sample-record time differences', ru: 'Разница по примерам записей',
  th: 'ส่วนต่างเวลาจากบันทึกตัวอย่าง', ar: 'الفارق الزمني من سجلات نموذجية', ko: '예시 기록의 시간 차이 참고',
};
const sampleMarker: Record<string, string> = {
  zh: '（示例记录，非本人实测）', en: '(sample records, not measured by you)', ru: '(примеры записей, не ваши личные замеры)',
  th: '(บันทึกตัวอย่าง ไม่ใช่เวลาจริงที่คุณวัด)', ar: '(سجلات نموذجية، ليست قياساتك الفعلية)', ko: '(예시 기록, 본인 실측 시간 아님)',
};
const notApplicable: Record<string, string> = {
  zh: '不适用', en: 'Not applicable', ru: 'Неприменимо', th: 'ไม่เกี่ยวข้อง', ar: 'لا ينطبق', ko: '해당 없음',
};
const evidenceNote: Record<string, string> = {
  zh: '这不是统计置信区间', en: 'not a statistical confidence interval', ru: 'не статистический доверительный интервал',
  th: 'ไม่ใช่ช่วงความเชื่อมั่นทางสถิติ', ar: 'فترة ثقة إحصائية', ko: '통계적 신뢰 구간',
};
const cjk = /[\u4e00-\u9fff]/;

async function open(page: Page, patch = {}) {
  await page.clock.install({ time: new Date(day + 'T09:30:00+08:00') });
  await page.route('https://**', route => route.abort());
  await page.route('**/api/assistant/config', route => route.fulfill({ json: { available: false } }));
  await page.route('**/api/llm/config', route => route.fulfill({ json: { endpoints: [] } }));
  await page.route('**/api/assistant/chat', () => { throw new Error('Locale preview must not send private events automatically'); });
  await page.addInitScript(state => {
    localStorage.setItem('tango-donego.web.v1', JSON.stringify(state));
    localStorage.setItem('tango-donego.lang', 'zh');
    localStorage.setItem('tango-donego.llm.v1', JSON.stringify({ consent: false }));
  }, { v: 1, pv: 5, mode: 'real', name: '', wake: 960, entries, trials: [], drafts: [], methods: [], methodUses: [], fw: {}, sound: false, pal: 0, ...patch });
  await page.goto('/#today');
}

test('personal history estimate copy renders in six languages on card and sheet', async ({ page }) => {
  await open(page, { trials: [trial('r1', '2026-10-19', 40, 'real'), trial('r2', '2026-10-18', 30, 'real')] });
  const line = page.locator('.event-model-line[data-id="read"]');
  const manual = page.locator('.event-model-line[data-id="parcel"]');
  for (const language of languages) {
    await page.locator('#lang').selectOption(language);
    await expect(line).toHaveAttribute('data-estimate-source', 'history');
    await expect(line).toContainText('20–30 min');
    await expect(line).toContainText(personal[language]);
    await expect(line).not.toContainText(sample[language]);
    await expect(manual).toContainText(notApplicable[language]);
    if (language !== 'zh') {
      await expect(line).not.toContainText(cjk);
      await expect(manual).not.toContainText(cjk);
    }
    await line.click();
    const sheet = page.locator('.sheet');
    await expect(sheet).toContainText(personal[language]);
    await expect(sheet.locator('.estimate-help summary')).toContainText(personal[language]);
    await expect(sheet.locator('.estimate-help p')).toContainText(evidenceNote[language]);
    if (language !== 'zh') await expect(sheet.locator('.estimate-help p')).not.toContainText(cjk);
    await page.keyboard.press('Escape');
  }
});

test('demo history estimate copy is labeled as sample data in six languages', async ({ page }) => {
  await open(page, {
    mode: 'demo',
    trials: [trial('r1', '2026-10-19', 40, 'real'), trial('r2', '2026-10-18', 30, 'real'), trial('d1', '2026-10-17', 50, 'demo'), trial('d2', '2026-10-16', 40, 'demo')],
  });
  const line = page.locator('.event-model-line[data-id="read"]');
  for (const language of languages) {
    await page.locator('#lang').selectOption(language);
    await expect(line).toHaveAttribute('data-estimate-source', 'history');
    await expect(line).toContainText('10–20 min');
    await expect(line).toContainText(sample[language]);
    await expect(line).toContainText(sampleMarker[language]);
    await expect(line).not.toContainText(personal[language]);
    if (language !== 'zh') await expect(line).not.toContainText(cjk);
  }
});
