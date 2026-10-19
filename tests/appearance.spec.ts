import { test, expect, type Page } from "@playwright/test";

test.use({ channel: "chromium" });

const FIXTURE_URL = "/?appearanceFixture=1";
const THEME_KEY = "tango-donego.appearance.v1";
const EVIDENCE_DIR = ".omo/evidence/appearance";

const ROUTES: Array<[string, string]> = [
  ["/", "s01"],
  ["/ledger", "s02"],
  ["/inbox", "s03"],
  ["/plan", "s04"],
  ["/preview", "s05"],
  ["/workspace", "s06"],
  ["/session", "s07"],
  ["/stillness", "s08"],
  ["/attention", "s09"],
  ["/boundaries", "s10"],
  ["/context", "s11"],
  ["/review", "s12"],
  ["/sync", "s13"],
  ["/capture", "s14"],
  ["/m/now", "s15"],
  ["/m/plan", "s16"],
  ["/m/auth", "s17"],
  ["/m/stillness", "s18"],
];

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

async function snapshotStorage(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k !== null) out[k] = localStorage.getItem(k) ?? "";
    }
    return out;
  });
}

async function inkApplied(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.getAttribute("data-theme") === "ink");
}

async function storeTheme(page: Page, value: string): Promise<void> {
  await page.addInitScript((key: string) => localStorage.setItem(key, value), THEME_KEY);
}

const inkRadio = '[data-appearance-option="ink"] input[type="radio"]';
const porcelainRadio = '[data-appearance-option="porcelain"] input[type="radio"]';

test.describe("appearance control (isolated fixture)", () => {
  test("renders labelled control, applies immediately, keyboard works, non-color selected cue", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto(FIXTURE_URL);
    const group = page.getByRole("radiogroup", { name: "外观" });
    await expect(group).toBeVisible();
    await expect(page.locator(porcelainRadio)).toBeChecked();
    expect(await inkApplied(page)).toBe(false);

    await page.locator(porcelainRadio).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(inkRadio)).toBeChecked();
    expect(await inkApplied(page)).toBe(true);
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bodyBg).toBe("rgb(245, 241, 232)");

    const selected = page.locator('[data-appearance-option="ink"]');
    await expect(selected.locator("[data-appearance-check]")).toBeVisible();
    await expect(selected.locator("[data-appearance-check]")).toHaveAccessibleName("已选择");
    await expect(selected).toContainText("宣墨");

    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(porcelainRadio)).toBeChecked();
    expect(await inkApplied(page)).toBe(false);
    expect(errors).toEqual([]);
  });

  test("corrupt stored preference falls back to porcelain with honest notice", async ({ page }) => {
    await storeTheme(page, "{not-valid-json");
    await page.goto(FIXTURE_URL);
    expect(await inkApplied(page)).toBe(false);
    const status = page.locator("[data-appearance-status]");
    await expect(status).toContainText("无法识别");
    await expect(page.locator(porcelainRadio)).toBeChecked();
  });

  test("storage write failure: session theme applies with honest feedback, nothing persisted", async ({ page }) => {
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function failForTheme(this: Storage, key: string, value: string) {
        if (key === "tango-donego.appearance.v1") {
          throw new DOMException("simulated quota failure", "QuotaExceededError");
        }
        original.call(this, key, value);
      };
    });
    const errors = watchErrors(page);
    await page.goto(FIXTURE_URL);
    await page.locator(inkRadio).check();
    expect(await inkApplied(page)).toBe(true);
    const status = page.locator("[data-appearance-status]");
    await expect(status).toContainText("保存失败");
    await expect(status).toContainText("刷新后");
    const persisted = await page.evaluate((k: string) => localStorage.getItem(k), THEME_KEY);
    expect(persisted).toBeNull();
    expect(errors).toEqual([]);
  });

  test("cross-tab storage event syncs both fixture pages", async ({ page }) => {
    const pageA = page;
    await pageA.goto(FIXTURE_URL);
    const pageB = await pageA.context().newPage();
    await pageB.goto(FIXTURE_URL);
    await pageB.locator(inkRadio).check();
    expect(await inkApplied(pageB)).toBe(true);
    expect(await inkApplied(pageA)).toBe(true);
    await expect(pageA.locator(inkRadio)).toBeChecked();
    await pageB.close();
  });
});

test.describe("appearance flow", () => {
  test("default -> ink -> reload -> navigate -> default persists and writes only the theme key", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/");
    await expect(page.locator("[data-page='s01']")).toBeVisible();
    const before = await snapshotStorage(page);
    expect(await inkApplied(page)).toBe(false);

    await page.goto(FIXTURE_URL);
    await page.locator(inkRadio).check();
    expect(await inkApplied(page)).toBe(true);

    await page.reload();
    expect(await inkApplied(page)).toBe(true);

    await page.goto("/ledger");
    await expect(page.locator("[data-page='s02']")).toBeVisible();
    expect(await inkApplied(page)).toBe(true);

    const inInk = await snapshotStorage(page);
    const newKeys = Object.keys(inInk).filter((k) => !(k in before));
    expect(newKeys).toEqual([THEME_KEY]);
    for (const [k, v] of Object.entries(before)) {
      expect(inInk[k]).toBe(v);
    }

    await page.goto(FIXTURE_URL);
    await page.locator(porcelainRadio).check();
    expect(await inkApplied(page)).toBe(false);
    await page.goto("/");
    expect(await inkApplied(page)).toBe(false);
    await page.reload();
    expect(await inkApplied(page)).toBe(false);
    expect(errors).toEqual([]);
  });
});

test.describe("routes smoke in both themes", () => {
  for (const theme of ["ink", "default"] as const) {
    test("all 18 routes render in " + theme, async ({ page }, testInfo) => {
      test.setTimeout(120_000);
      testInfo.skip(testInfo.project.name !== "desktop", "route smoke runs on desktop project");
      const errors = watchErrors(page);
      if (theme === "ink") {
        await storeTheme(page, "ink");
      }
      for (const [path, id] of ROUTES) {
        await page.goto(path);
        await expect(page.locator('[data-page="' + id + '"]')).toBeVisible();
        expect(await inkApplied(page)).toBe(theme === "ink");
      }
      expect(errors).toEqual([]);
    });
  }
});

test.describe("ink visual acceptance", () => {
  const representative: Array<[string, string]> = [
    ["/", "home"],
    ["/ledger", "ledger"],
    ["/workspace", "workspace"],
  ];

  test("contrast in ink meets AA on canvas and primary button", async ({ page }, testInfo) => {
    testInfo.skip(testInfo.project.name !== "desktop");
    await storeTheme(page, "ink");
    await page.goto(FIXTURE_URL);
    await page.goto("/");
    const ratio = await page.evaluate(() => {
      const lum = (c: string) => {
        const parts = c.replace("/[^0-9.,]/g", "").split(",").map(Number);
        if (parts.length < 3) return null;
        const f = (x: number) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
        return 0.2126 * f(parts[0] / 255) + 0.7152 * f(parts[1] / 255) + 0.0722 * f(parts[2] / 255);
      };
      const pick = (el: Element) => {
        const s = getComputedStyle(el);
        return [lum(s.color), lum(s.backgroundColor)] as const;
      };
      const pairRatio = (pair: readonly (number | null)[]) => {
        if (pair[0] === null || pair[1] === null) return null;
        const hi = Math.max(pair[0], pair[1]);
        const lo = Math.min(pair[0], pair[1]);
        return (hi + 0.05) / (lo + 0.05);
      };
      const body = pairRatio(pick(document.body));
      const btn = document.querySelector<HTMLElement>(".s01-primary");
      return { body: body, btn: btn ? pairRatio(pick(btn)) : null };
    });
    expect(ratio.body).not.toBeNull();
    expect(ratio.body as number).toBeGreaterThanOrEqual(4.5);
    expect(ratio.btn).not.toBeNull();
    expect(ratio.btn as number).toBeGreaterThanOrEqual(4.5);
  });

  test("no horizontal clipping on representative pages in ink", async ({ page }) => {
    await storeTheme(page, "ink");
    for (const [path] of representative) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => (document.scrollingElement?.scrollWidth ?? 0) - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    }
  });

  test("edge accent exists only on home/stillness, zero hitbox, hidden on mobile", async ({ page }, testInfo) => {
    testInfo.skip(testInfo.project.name !== "desktop");
    await storeTheme(page, "ink");
    await page.goto("/");
    const homeAccent = await page.evaluate(() => {
      const el = document.querySelector(".s01");
      const s = getComputedStyle(el as Element, "::before");
      return { content: s.content, position: s.position, pointerEvents: s.pointerEvents };
    });
    expect(homeAccent.content).not.toBe("none");
    expect(homeAccent.position).toBe("fixed");
    expect(homeAccent.pointerEvents).toBe("none");
    await page.goto("/ledger");
    const ledgerAccent = await page.evaluate(
      () => getComputedStyle(document.querySelector(".s02") as Element, "::before").content,
    );
    expect(ledgerAccent).toBe("none");
    const mobileContext = await page.context().browser()?.newContext({ viewport: { width: 375, height: 720 } });
    if (!mobileContext) throw new Error("could not open mobile context");
    const mobilePage = await mobileContext.newPage();
    await storeTheme(mobilePage, "ink");
    await mobilePage.goto("/");
    const mobileAccent = await mobilePage.evaluate(
      () => getComputedStyle(document.querySelector(".s01") as Element, "::before").display,
    );
    expect(mobileAccent).toBe("none");
    await mobileContext.close();
  });

  test("reduced motion: ink adds no transition on the control", async ({ page }, testInfo) => {
    testInfo.skip(testInfo.project.name !== "desktop");
    await page.goto(FIXTURE_URL);
    await page.locator(inkRadio).check();
    const duration = await page.evaluate(
      () => getComputedStyle(document.querySelector('[data-appearance-option="ink"] input') as Element).transitionDuration,
    );
    expect(duration).toBe("0s");
  });

  test("capture representative evidence screenshots in ink and default", async ({ page }, testInfo) => {
    await storeTheme(page, "ink");
    for (const [path, name] of representative) {
      await page.goto(path);
      await expect(page.locator("[data-page]").first()).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({
        path: EVIDENCE_DIR + "/" + name + "-ink-" + testInfo.project.name + ".png",
        fullPage: false,
      });
    }
    await page.goto(FIXTURE_URL);
    await expect(page.getByRole("radiogroup", { name: "外观" })).toBeVisible();
    await page.screenshot({
      path: EVIDENCE_DIR + "/settings-ink-" + testInfo.project.name + ".png",
      fullPage: false,
    });
    await page.evaluate((k: string) => localStorage.setItem(k, "porcelain"), THEME_KEY);
    await page.reload();
    await expect(page.getByRole("radiogroup", { name: "外观" })).toBeVisible();
    await page.screenshot({
      path: EVIDENCE_DIR + "/settings-default-" + testInfo.project.name + ".png",
      fullPage: false,
    });
    await page.goto("/");
    await expect(page.locator("[data-page='s01']")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({
      path: EVIDENCE_DIR + "/home-default-" + testInfo.project.name + ".png",
      fullPage: false,
    });
  });
});
