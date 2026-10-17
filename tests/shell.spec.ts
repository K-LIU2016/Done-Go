import { test, expect, type Page, type TestInfo } from "@playwright/test";

type EvidenceFs = {
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  writeFileSync(path: string, data: string): void;
};
type EvidencePath = { join(...parts: string[]): string };

const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
const evidenceFs = (typeof proc?.getBuiltinModule === "function"
  ? proc.getBuiltinModule("node:fs")
  : null) as EvidenceFs | null;
const evidencePath = (typeof proc?.getBuiltinModule === "function"
  ? proc.getBuiltinModule("node:path")
  : null) as EvidencePath | null;
if (!evidenceFs || !evidencePath) {
  throw new Error("node builtins unavailable via process.getBuiltinModule; cannot persist shell evidence");
}
const mkdirSync = evidenceFs.mkdirSync.bind(evidenceFs);
const writeFileSync = evidenceFs.writeFileSync.bind(evidenceFs);
const join = evidencePath.join.bind(evidencePath);

const shellEnv =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const EVIDENCE = shellEnv.SHELL_EVIDENCE_DIR ?? ".omo/evidence/shell-glm/artifacts";
const PHASE = shellEnv.SHELL_PHASE ?? "run";
const COVERAGE_CLAIM = "覆盖范围：工作日历、任务清单、指定文件。其他生活安排仍需你确认。";
const FIXTURE_URL = "/.omo/evidence/shell-glm/fixtures/unmount-harness.html";

mkdirSync(EVIDENCE, { recursive: true });

type RailControl = { key: string; name: string; selector: string };

const RAIL_CONTROLS: RailControl[] = [
  { key: "nav-now", name: "此刻", selector: "[data-shell-rail] .shell-nav a >> nth=0" },
  { key: "nav-ledger", name: "时间", selector: "[data-shell-rail] .shell-nav a >> nth=1" },
  { key: "nav-inbox", name: "收件", selector: "[data-shell-rail] .shell-nav a >> nth=2" },
  { key: "nav-workspace", name: "协同", selector: "[data-shell-rail] .shell-nav a >> nth=3" },
  { key: "nav-review", name: "回顾", selector: "[data-shell-rail] .shell-nav a >> nth=4" },
  { key: "nav-boundaries", name: "边界", selector: "[data-shell-rail] .shell-nav a >> nth=5" },
  { key: "search", name: "搜索 · 快捷输入 ⌘K", selector: "[data-shell-search]" },
  { key: "avatar", name: "JC · 个人上下文", selector: "[data-shell-avatar]" },
];

type Obs = Record<string, unknown>;

function saveObs(slug: string, data: Obs): void {
  writeFileSync(join(EVIDENCE, PHASE + "-obs-" + slug + ".json"), JSON.stringify({ phase: PHASE, slug, ...data }, null, 2));
}

function watch(page: Page, testInfo: TestInfo, title: string, slug: string): void {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("close", () => {
    const body = JSON.stringify({ test: title, phase: PHASE, errors }, null, 2);
    writeFileSync(join(EVIDENCE, PHASE + "-console-" + slug + ".json"), body);
    void testInfo.attach("console-log", { body });
  });
}

type ControlProbe = {
  control: string;
  box: { x: number; y: number; width: number; height: number };
  centerInViewport: boolean;
  centerHitInsideRailLink: boolean;
  minTargetPx: number;
};

async function probeControl(page: Page, control: RailControl): Promise<ControlProbe> {
  const loc = page.locator(control.selector);
  await loc.scrollIntoViewIfNeeded();
  const box = (await loc.boundingBox())!;
  const vp = page.viewportSize()!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const hitInside = await page.evaluate(
    ({ cx, cy }: { cx: number; cy: number }) => {
      const el = document.elementFromPoint(cx, cy);
      return el ? el.closest("[data-shell-rail] a") !== null : false;
    },
    { cx, cy },
  );
  return {
    control: control.key,
    box,
    centerInViewport: cx >= 0 && cx <= vp.width && cy >= 0 && cy <= vp.height,
    centerHitInsideRailLink: hitInside,
    minTargetPx: Math.min(box.width, box.height),
  };
}

async function focusedRailSequence(page: Page): Promise<string[]> {
  const names: string[] = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      return {
        inRail: el.closest("[data-shell-rail]") !== null,
        name: el.getAttribute("aria-label") ?? (el.textContent ?? "").trim(),
      };
    });
    if (!info || !info.inRail) break;
    names.push(info.name);
    if (names.length === RAIL_CONTROLS.length) break;
  }
  return names;
}

test.describe("shell design contract", () => {
  test("rail floats at design geometry and content column starts x151", async ({ page }, testInfo) => {
    watch(page, testInfo, "rail geometry", "geometry");
    await page.goto("/");
    await page.screenshot({ path: join(EVIDENCE, PHASE + "-desktop-home.png"), fullPage: false });
    const rail = page.locator("[data-shell-rail]");
    await expect(rail).toBeVisible();
    const box = await rail.boundingBox();
    expect(box, "rail bounding box present").toBeTruthy();
    expect(Math.abs(box!.x - 18), "rail x 18").toBeLessThanOrEqual(2);
    expect(Math.abs(box!.y - 18), "rail y 18").toBeLessThanOrEqual(2);
    expect(Math.abs(box!.width - 88), "rail width 88").toBeLessThanOrEqual(2);
    expect(Math.abs(box!.y + box!.height - 1182), "rail bottom 1182").toBeLessThanOrEqual(2);
    await page.evaluate(() => window.scrollTo(0, 500));
    const scrolled = await rail.boundingBox();
    expect(Math.abs(scrolled!.y - 18), "rail stays fixed while content scrolls").toBeLessThanOrEqual(2);
    const content = page.locator("[data-shell-content]");
    const contentBox = await content.boundingBox();
    expect(Math.abs(contentBox!.x - 151), "content starts x151").toBeLessThanOrEqual(2);
    const topbar = page.locator("[data-shell-topbar]");
    const topBox = await topbar.boundingBox();
    expect(Math.abs(topBox!.y + topBox!.height - 92), "header divider y92").toBeLessThanOrEqual(2);
  });

  test("footer keeps screen-local coverage claim off the shell and divider at source baseline", async ({ page }, testInfo) => {
    watch(page, testInfo, "footer coverage uniqueness", "footer-coverage");
    await page.goto("/");
    const footer = page.locator("[data-shell-footer]");
    const shellFooterHasCoverage = await footer.evaluate((el) => (el.textContent ?? "").includes("覆盖范围"));
    const homeCoverageCount = await page.getByText(COVERAGE_CLAIM).count();
    const row = page.locator("[data-shell-footer] .shell-footer-row");
    const dividerY = await row.evaluate((el) => el.getBoundingClientRect().top);
    saveObs("footer-coverage", {
      shellFooterContainsCoverage: shellFooterHasCoverage,
      homeCoverageOccurrences: homeCoverageCount,
      footerDividerY: dividerY,
    });
    await page.goto("/ledger");
    const ledgerCoverageCount = await page.getByText(COVERAGE_CLAIM).count();
    expect(ledgerCoverageCount, "no universal coverage claim on non-home screens").toBe(0);
    await page.goto("/");
    expect(shellFooterHasCoverage, "shell footer must not invent the universal coverage claim").toBe(false);
    expect(homeCoverageCount, "coverage claim appears exactly once on home (s01-local)").toBe(1);
    expect(Math.abs(dividerY - 1131.5), "footer row divider at source baseline 1131.5").toBeLessThanOrEqual(2.5);
    await expect(footer).toContainText("探戈 Done&Go");
    await expect(footer).toContainText("界面为独立演示状态；不代表已连接、已执行或真实收益。");
  });

  for (const [label, route] of [
    ["此刻", "/"],
    ["时间", "/ledger"],
    ["收件", "/inbox"],
    ["协同", "/workspace"],
    ["回顾", "/review"],
    ["边界", "/boundaries"],
  ] as Array<[string, string]>) {
    test("nav " + label + " -> " + route + " with single active state", async ({ page }, testInfo) => {
      watch(page, testInfo, "nav " + label, "nav-click");
      await page.goto("/");
      await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: label }).click();
      await expect(page).toHaveURL(new RegExp(route.replace(/\//g, "\\/") + "$"));
      const active = page.locator("[data-shell-rail] a[aria-current='page']");
      await expect(active).toHaveCount(1);
      await expect(active).toHaveAccessibleName(label);
    });
  }

  test("search control navigates to /capture", async ({ page }, testInfo) => {
    watch(page, testInfo, "search click", "search-click");
    await page.goto("/");
    const search = page.locator("[data-shell-search]");
    await expect(search).toBeVisible();
    await expect(search).toContainText("⌘ K");
    await search.click();
    await expect(page).toHaveURL(/\/capture$/);
  });

  test("Meta+K and Ctrl+K navigate to /capture", async ({ page }, testInfo) => {
    watch(page, testInfo, "keyboard shortcut", "shortcut-basic");
    await page.goto("/");
    await expect(page.locator("[data-shell-rail]")).toBeVisible();
    await page.keyboard.press("Meta+KeyK");
    await expect(page).toHaveURL(/\/capture$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("[data-shell-rail]")).toBeVisible();
    await page.keyboard.press("Control+KeyK");
    await expect(page).toHaveURL(/\/capture$/);
  });

  test("Alt/Shift-modified Cmd+K stays on the current route", async ({ page }, testInfo) => {
    watch(page, testInfo, "ignored modifier shortcuts", "ignored-modifiers");
    await page.goto("/");
    await expect(page.locator("[data-shell-rail]")).toBeVisible();
    const before = await page.evaluate(() => history.length);
    await page.keyboard.press("Alt+Meta+KeyK");
    await expect(page).toHaveURL(/\/$/);
    await page.keyboard.press("Shift+Meta+KeyK");
    await expect(page).toHaveURL(/\/$/);
    const after = await page.evaluate(() => history.length);
    saveObs("ignored-modifiers", { historyLengthBefore: before, historyLengthAfter: after });
    expect(after, "ignored shortcuts do not push history").toBe(before);
  });

  test("repeated Cmd+K on /capture does not stack history entries", async ({ page }, testInfo) => {
    watch(page, testInfo, "repeated shortcut history", "repeat-shortcut");
    await page.goto("/");
    await expect(page.locator("[data-shell-rail]")).toBeVisible();
    await page.keyboard.press("Meta+KeyK");
    await expect(page).toHaveURL(/\/capture$/);
    const before = await page.evaluate(() => history.length);
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Meta+KeyK");
    }
    await expect(page).toHaveURL(/\/capture$/);
    const after = await page.evaluate(() => history.length);
    saveObs("repeat-shortcut", { historyLengthBefore: before, historyLengthAfter: after });
    expect(after, "repeated shortcut must not push repeated history entries").toBe(before);
    await page.goBack();
    await expect(page, "exactly one step back returns home").toHaveURL(/\/$/);
  });

  test("Cmd+K listener is removed on in-app shell unmount (isolated evidence fixture)", async ({ page }, testInfo) => {
    watch(page, testInfo, "listener cleanup on unmount", "unmount-cleanup");
    await page.goto(FIXTURE_URL);
    await expect(page.locator("[data-shell-rail]")).toBeVisible();
    await page.evaluate(() => {
      (window as { __shellEpoch?: number }).__shellEpoch = 1;
    });
    await page.keyboard.press("Meta+KeyK");
    await expect(page).toHaveURL(/\/capture$/);
    await expect(page.locator("[data-shell-rail]")).toBeVisible();
    await page.locator("[data-harness-unmount-link]").click();
    await expect(page.locator("[data-harness-bare]")).toBeVisible();
    await expect(page.locator("[data-shell-rail]")).toHaveCount(0);
    const epochAfterNav = await page.evaluate(() => (window as { __shellEpoch?: number }).__shellEpoch);
    await page.keyboard.press("Meta+KeyK");
    await expect(page).toHaveURL(/\/harness\/bare$/);
    await expect(page.locator("[data-harness-bare]")).toBeVisible();
    await expect(page.locator("[data-shell-rail]")).toHaveCount(0);
    const epochFinal = await page.evaluate(() => (window as { __shellEpoch?: number }).__shellEpoch);
    saveObs("unmount-cleanup", { epochAfterNav, epochFinal, urlAfterUnmountKeypress: page.url() });
    expect(epochAfterNav, "in-app navigation only: no document replacement").toBe(1);
    expect(epochFinal, "listener removed with the shell unmount").toBe(1);
  });

  test("normal app URLs expose no internal test control", async ({ page }, testInfo) => {
    watch(page, testInfo, "no internal probe control", "no-probe-control");
    await page.goto("/?shell-unmount-probe=1");
    await expect(page.locator("[data-shell-rail]")).toBeVisible();
    const probeButtonCount = await page.locator("[data-shell-unmount-probe]").count();
    const probeTextCount = await page.getByText("卸载探针").count();
    const probeCssPresent = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSStyleRule && (rule.selectorText ?? "").includes("shell-unmount-probe")) {
            return true;
          }
        }
      }
      return false;
    });
    await page.screenshot({ path: join(EVIDENCE, PHASE + "-no-probe-control.png"), fullPage: false });
    saveObs("no-probe-control", {
      url: page.url(),
      probeButtonCount,
      probeTextCount,
      probeCssPresent,
    });
    expect(probeButtonCount, "no [data-shell-unmount-probe] control on product URL").toBe(0);
    expect(probeTextCount, "no internal probe label rendered").toBe(0);
    expect(probeCssPresent, "no .shell-unmount-probe CSS rule shipped").toBe(false);
    await page.goto("/");
    expect(await page.locator("[data-shell-unmount-probe]").count(), "no probe control on clean URL").toBe(0);
  });

  test("avatar links to /context with accessible name", async ({ page }, testInfo) => {
    watch(page, testInfo, "avatar", "avatar-click");
    await page.goto("/");
    const avatar = page.locator("[data-shell-avatar]");
    await expect(avatar).toBeVisible();
    await expect(avatar).toHaveAccessibleName(/JC/);
    await avatar.click();
    await expect(page).toHaveURL(/\/context$/);
  });

  test("header and footer match the design contract", async ({ page }, testInfo) => {
    watch(page, testInfo, "header footer", "header-footer");
    await page.goto("/");
    await expect(page.locator("[data-shell-brand]")).toContainText("探戈");
    await expect(page.locator("[data-shell-brand]")).toContainText("DONE&GO");
    await expect(page.locator("[data-shell-badge]")).toHaveText("概念设计 · 演示状态");
    await expect(page.locator("[data-shell-date]")).toContainText("· 星期");
    const footer = page.locator("[data-shell-footer]");
    await expect(footer).toContainText("探戈 Done&Go");
    await expect(page.locator("[data-shell-footer-page]")).toHaveText("01 / 14");
    await page.goto("/capture");
    await expect(page.locator("[data-shell-footer-page]")).toHaveText("14 / 14");
  });

  for (const vp of [
    { label: "1024x800", width: 1024, height: 800, shot: "narrow-home" },
    { label: "1024x560 short", width: 1024, height: 560, shot: "short-home" },
    { label: "375x667 narrow shell surface", width: 375, height: 667, shot: "narrow375-shell" },
  ]) {
    test("all eight rail controls visible, hit-testable, keyboard-reachable at " + vp.label, async ({ page }, testInfo) => {
      watch(page, testInfo, "controls " + vp.label, vp.shot);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/");
      await page.screenshot({ path: join(EVIDENCE, PHASE + "-" + vp.shot + ".png"), fullPage: false });
      const rail = page.locator("[data-shell-rail]");
      const railBox = await rail.boundingBox();
      expect(railBox, "rail bounding box present").toBeTruthy();
      const railInViewport =
        railBox!.x >= 0 &&
        railBox!.x + railBox!.width <= vp.width &&
        railBox!.y >= 0 &&
        railBox!.y + railBox!.height <= vp.height;
      const probes: ControlProbe[] = [];
      for (const control of RAIL_CONTROLS) {
        const probe = await probeControl(page, control);
        probes.push(probe);
        await expect(page.locator(control.selector)).toBeVisible();
      }
      const focusOrder = await focusedRailSequence(page);
      saveObs(vp.shot, {
        viewport: { width: vp.width, height: vp.height },
        rail: railBox,
        railInViewport,
        controls: probes,
        keyboardFocusOrder: focusOrder,
      });
      expect(railInViewport, "rail fully inside viewport at " + vp.label).toBe(true);
      for (const probe of probes) {
        expect(probe.centerInViewport, probe.control + " center in viewport at " + vp.label).toBe(true);
        expect(probe.centerHitInsideRailLink, probe.control + " hit-testable at " + vp.label).toBe(true);
        expect(probe.minTargetPx, probe.control + " hit target >= 44 CSS px at " + vp.label).toBeGreaterThanOrEqual(44);
      }
      expect(focusOrder, "tab reaches all rail controls in order at " + vp.label).toEqual(
        RAIL_CONTROLS.map((c) => c.name),
      );
    });
  }

  test("keyboard focus is visible on rail controls", async ({ page }, testInfo) => {
    watch(page, testInfo, "focus visible", "focus-visible");
    await page.goto("/");
    let focusedInRail = false;
    let outline = "none 0px";
    for (let i = 0; i < 12; i++) {
      const state = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          inRail: el.closest("[data-shell-rail]") !== null,
          outline: cs.outlineStyle + " " + cs.outlineWidth,
        };
      });
      if (state?.inRail) {
        focusedInRail = true;
        outline = state.outline;
        break;
      }
      await page.keyboard.press("Tab");
    }
    expect(focusedInRail, "tab reaches rail controls").toBe(true);
    expect(outline.startsWith("solid"), "focus outline visible: " + outline).toBe(true);
    expect(outline).not.toBe("solid 0px");
  });
});
