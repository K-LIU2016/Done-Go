import { test, expect } from "@playwright/test";

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

function watchErrors(page: import("@playwright/test").Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

test("desktop shell renders with navigation", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await expect(page.locator("[data-shell]")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const [path, id] of ROUTES) {
  test(`route ${path} renders ${id}`, async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto(path);
    await expect(page.locator(`[data-page="${id}"]`)).toBeVisible();
    expect(errors).toEqual([]);
  });
}
