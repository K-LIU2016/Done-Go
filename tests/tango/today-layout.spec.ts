import { test, expect, type Page } from '@playwright/test';

async function open(page: Page) {
  await page.clock.install({ time: new Date('2026-10-21T17:00:00+08:00') });
  await page.route('https://**', route => route.abort());
  await page.route('**/api/assistant/config', route => route.fulfill({ json: { available: false } }));
  await page.route('**/api/llm/config', route => route.fulfill({ json: { endpoints: [] } }));
  await page.route('**/api/assistant/chat', () => { throw new Error('Layout changes must not call a model'); });
  await page.addInitScript(() => {
    localStorage.setItem('tango-donego.web.v1', JSON.stringify({ v: 1, pv: 5, mode: 'real', name: '', wake: 960, entries: [{ id: 'parcel', title: '拿快递', date: '2026-10-21', start: '17:30', end: '18:00', kind: 'necessary', prio: 2 }, { id: 'read', title: '读论文', date: '2026-10-21', start: '20:00', end: '20:30', kind: 'explore', prio: 3 }], trials: [], drafts: [], methods: [], methodUses: [], fw: {}, sound: false, pal: 0 }));
    localStorage.setItem('tango-donego.lang', 'zh');
    localStorage.setItem('tango-donego.llm.v1', JSON.stringify({ consent: false }));
  });
  await page.goto('/#today');
}

test('today orders input, bubble and personal time workspace, companion, then event route in both themes and languages', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page);
  const original = await page.evaluate(() => localStorage.getItem('tango-donego.web.v1'));
  const widths = info.project.name === 'mobile' ? [390, 360] : [1440, 768];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['standard', 'designer']) {
      await page.locator('#appearance-select').selectOption(theme);
      for (const language of ['zh', 'en', 'ru', 'th', 'ar', 'ko']) {
        await page.locator('#lang').selectOption(language);
        await expect(page.locator('.today-workspace #bubbles')).toBeVisible();
        await expect(page.locator('.today-workspace .paper-tools .picker')).toBeVisible();
        await expect(page.locator('.time-overview .metric-help,.daily-review-link')).toHaveCount(0);
        const voice = (await page.locator('.voice').boundingBox())!;
        const bubbles = (await page.locator('.today-bubble-panel').boundingBox())!;
        const tools = (await page.locator('.paper-tools').boundingBox())!;
        const invite = (await page.locator('.page-today .companion-invite').boundingBox())!;
        const route = (await page.locator('.paper-route').boundingBox())!;
        expect(bubbles.y).toBeGreaterThanOrEqual(voice.y + voice.height);
        expect(tools.y).toBeGreaterThanOrEqual(voice.y + voice.height);
        if (width >= 720) {
          expect(Math.abs(bubbles.y - tools.y)).toBeLessThan(2);
          expect(language === 'ar' ? tools.x + tools.width <= bubbles.x + 1 : bubbles.x + bubbles.width <= tools.x + 1).toBe(true);
        } else expect(tools.y).toBeGreaterThanOrEqual(bubbles.y + bubbles.height);
        expect(invite.y).toBeGreaterThanOrEqual(Math.max(bubbles.y + bubbles.height, tools.y + tools.height));
        expect(route.y).toBeGreaterThanOrEqual(invite.y + invite.height);
        await expect(page.locator('.page-today .page > :last-child')).toHaveClass(/paper-route/);
        await expect.poll(() => page.locator('#bubbles').evaluate((el: any) => Math.abs(el._W - el.clientWidth) + Math.abs(el._H - el.clientHeight))).toBe(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        if (['zh', 'ar'].includes(language)) {
          await page.locator('#cap-text').focus();
          await page.screenshot({ path: info.outputPath(theme + '-' + language + '-' + width + '-today.png'), fullPage: true });
        }
      }
    }
  }
  expect(await page.evaluate(() => localStorage.getItem('tango-donego.web.v1'))).toBe(original);
  expect(errors).toEqual([]);
});

test('personal time selection updates the same bubble field and route, while draft and completion stay usable', async ({ page }) => {
  await open(page);
  await page.locator('#cap-text').fill('保留输入中的草稿');
  await page.locator('[data-act="pick"][data-m="1260"]').click();
  await expect(page.locator('#cap-text')).toHaveValue('保留输入中的草稿');
  await expect(page.locator('[data-act="pick-save"]')).toBeEnabled();
  await page.locator('[data-act="pick-save"]').click();
  await expect(page.locator('.bubble.pb')).toHaveCount(1);
  await expect(page.locator('.paper-stop')).toHaveCount(3);
  await expect(page.locator('#cap-text')).toHaveValue('保留输入中的草稿');
  await page.locator('[data-act="budget-edit"]').click();
  await expect.poll(() => page.locator('#bubbles').evaluate((el: any) => el._H === el.clientHeight)).toBe(true);
  await page.locator('#today-budget').fill('14');
  await page.locator('#budgetForm button[type="submit"]').click();
  await expect(page.locator('.time-overview .metric-help,.daily-review-link')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('tango-donego.web.v1')!).wake)).toBe(840);
  await page.locator('.bubble[data-id="read"]').dblclick();
  await expect(page.locator('#finish-min')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.page-today .page > :last-child')).toHaveClass(/paper-route/);
  await page.locator('.tabs a[href="#review"]').click();
  await expect(page.locator('.user-review-summary')).toBeVisible();
  await expect(page.locator('.cal')).toBeVisible();
  await page.locator('.tabs a[href="#today"]').click();
  await expect(page.locator('.bubble.pb')).toHaveCount(1);
  await expect(page.locator('.paper-stop')).toHaveCount(3);
  await expect(page.locator('.time-overview .metric-help,.daily-review-link')).toHaveCount(0);
});

test('personal time shows icons and times in two scrollable rows in every language', async ({page}, info) => {
  await open(page);
  await page.clock.setFixedTime(new Date('2026-10-21T09:00:00+08:00'));
  await page.reload();
  await page.setViewportSize({width:info.project.name === 'mobile' ? 360 : 1440,height:1000});
  for (const theme of ['standard','designer']) {
    await page.locator('#appearance-select').selectOption(theme);
    for (const language of ['zh','en','ru','th','ar','ko']) {
      await page.locator('#lang').selectOption(language);
      const frame=page.locator('.picker .avs'),tiles=frame.locator('.tile-av');
      await expect(frame.locator('.slot-label')).toHaveCount(0);
      for (const text of await tiles.allTextContents()) expect(text.trim()).toMatch(/^\d{2}:\d{2}$/);
      expect((await tiles.first().getAttribute('aria-label'))!.length).toBeGreaterThan(6);
      await frame.evaluate(el=>{el.scrollTop=0;});
      const geometry=await frame.evaluate(el=>{
        const tile=el.querySelector('.tile-av')!,style=getComputedStyle(el);
        return {height:el.clientHeight,tileHeight:tile.getBoundingClientRect().height,gap:parseFloat(style.rowGap),padding:parseFloat(style.paddingTop)+parseFloat(style.paddingBottom),scrollHeight:el.scrollHeight};
      });
      expect(Math.abs(geometry.height-(2*geometry.tileHeight+geometry.gap+geometry.padding))).toBeLessThanOrEqual(1);
      expect(geometry.scrollHeight).toBeGreaterThan(geometry.height);
      await frame.scrollIntoViewIfNeeded();
      await frame.hover();await page.mouse.wheel(0,1500);
      await expect.poll(()=>frame.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
      const last=frame.locator('[data-m="1410"]');await last.scrollIntoViewIfNeeded();
      const scroll=await frame.evaluate(el=>el.scrollTop);
      await last.click();await expect(last).toHaveAttribute('aria-pressed','true');
      expect(Math.abs(await frame.evaluate(el=>el.scrollTop)-scroll)).toBeLessThanOrEqual(1);
      await expect(last).toBeFocused();await last.press('Space');await expect(last).toHaveAttribute('aria-pressed','false');
      await frame.evaluate(el=>{el.scrollTop=0;});
      if (language==='zh'||language==='ar') await page.locator('.picker').screenshot({path:info.outputPath(theme+'-'+language+'-two-row-picker.png')});
    }
  }
  await page.locator('#lang').selectOption('zh');await page.locator('.picker [data-m="1410"]').click();
  await page.locator('[data-act="pick-save"]').click();await expect(page.locator('.bubble.pb')).toHaveCount(1);
  const reserved=await page.evaluate(()=>JSON.parse(localStorage.getItem('tango-donego.web.v1')!).entries.filter((entry:any)=>entry.kind==='stillness'));
  expect(reserved).toHaveLength(1);expect(reserved[0].start).toBe('23:30');
});
