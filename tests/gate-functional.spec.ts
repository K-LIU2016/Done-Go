import { test, expect, type Page } from "@playwright/test";

const consoleLogs = new WeakMap<Page, string[]>();

function watchErrors(page: Page): string[] {
  const existing = consoleLogs.get(page);
  if (existing) {
    return existing;
  }
  const errors: string[] = [];
  consoleLogs.set(page, errors);
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

function safeEvidenceName(value: string): string {
  return value.replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, "-").slice(0, 80);
}

test.afterEach(async ({ page }, testInfo) => {
  const errors = consoleLogs.get(page);
  if (!errors) {
    return;
  }
  await testInfo.attach(
    "gate-functional-console-" +
      testInfo.project.name +
      "-" +
      safeEvidenceName(testInfo.title) +
      ".json",
    {
      body: JSON.stringify(
        { project: testInfo.project.name, title: testInfo.title, errors },
        null,
        2,
      ),
      contentType: "application/json",
    },
  );
});

function shot(page: Page, name: string) {
  return page.screenshot({
    path: `.omo/evidence/gate-functional-${test.info().project.name}-${name}.png`,
    fullPage: true,
  });
}

function seedLocalStorage(page: Page, seed: Record<string, string>): void {
  page.addInitScript((entries) => {
    for (const [key, value] of Object.entries(entries)) {
      window.localStorage.setItem(key, value);
    }
  }, seed);
}

function breakStorageOn(page: Page, failingKey: string): void {
  page.addInitScript((key) => {
    const original = Storage.prototype.setItem;
    let failing = true;
    (window as unknown as { __allowStorage: () => void }).__allowStorage =
      () => {
        failing = false;
      };
    Storage.prototype.setItem = function (name: string, value: string) {
      if (failing && name === key) {
        throw new DOMException("storage blocked", "QuotaExceededError");
      }
      return original.call(this, name, value);
    };
  }, failingKey);
}

function breakStorageReadOn(page: Page, failingKey: string): void {
  page.addInitScript((key) => {
    const original = Storage.prototype.getItem;
    let failing = true;
    const runtime = window as unknown as {
      __allowStorageRead: () => void;
      __readStorageRaw: (name: string) => string | null;
    };
    runtime.__allowStorageRead = () => {
      failing = false;
    };
    runtime.__readStorageRaw = (name: string) =>
      original.call(window.localStorage, name);
    Storage.prototype.getItem = function (name: string) {
      if (failing && name === key) {
        throw new DOMException("storage read blocked", "QuotaExceededError");
      }
      return original.call(this, name);
    };
  }, failingKey);
}

async function readJsonStorage(page: Page, key: string): Promise<unknown> {
  return page.evaluate((storageKey) => {
    const raw = window.localStorage.getItem(storageKey);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  }, key);
}

async function readJsonStorageDirect(
  page: Page,
  key: string,
): Promise<unknown> {
  return page.evaluate((storageKey) => {
    const rawRead = (
      window as unknown as {
        __readStorageRaw?: (name: string) => string | null;
      }
    ).__readStorageRaw;
    const raw = rawRead
      ? rawRead(storageKey)
      : window.localStorage.getItem(storageKey);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  }, key);
}

test.describe("[gate][s14] capture intent parsing", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("edited input re-parses; empty input shows an honest empty state", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/capture");
    const root = page.locator('[data-page="s14"]');
    const input = root.getByRole("textbox", { name: "用一句话记录" });
    await input.fill("明晚八点半到九点半读书");
    await expect(root.getByText("9 月 13 日 · 20:30—21:30")).toBeVisible();
    await shot(page, "s14-reparse");
    await input.fill("");
    await expect(
      root.getByText("输入为空。可以填入示例，或直接修改下方字段。"),
    ).toBeVisible();
    await expect(root.getByText("19:00—20:00")).toHaveCount(0);
    await shot(page, "s14-empty");
    expect(errors).toEqual([]);
  });

  test("manual field edits drive interpretation and check outcomes", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/capture");
    const root = page.locator('[data-page="s14"]');
    await root.getByRole("button", { name: "修改字段" }).click();
    await root.getByRole("textbox", { name: "修改开始时间" }).fill("18:00");
    await root.getByRole("textbox", { name: "修改结束时间" }).fill("18:45");
    await expect(root.getByText("9 月 13 日 · 18:00—18:45")).toBeVisible();
    await root.getByRole("button", { name: "检查这段时间" }).click();
    await expect(root.getByText("无冲突 · 对照本地演示日程")).toBeVisible();
    await shot(page, "s14-fields-check");
    await root.getByRole("textbox", { name: "修改日期" }).fill("9 月 14 日");
    await root.getByRole("button", { name: "检查这段时间" }).click();
    await expect(
      root.getByText("无法判断 · 本地演示日程未覆盖该日期"),
    ).toBeVisible();
    await shot(page, "s14-unknown-check");
    expect(errors).toEqual([]);
  });

  test("default check reports conflict against the local demo schedule only", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/capture");
    const root = page.locator('[data-page="s14"]');
    await root.getByRole("button", { name: "检查这段时间" }).click();
    await expect(root.getByText("有冲突 · 对照本地演示日程")).toBeVisible();
    await expect(
      root.getByText(/客户会议（19:00—20:30）重叠/),
    ).toBeVisible();
    await expect(root.getByText(/未检查任何外部日历/)).toBeVisible();
    await shot(page, "s14-conflict-check");
    expect(errors).toEqual([]);
  });

  test("invalid interval is rejected instead of judged", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/capture");
    const root = page.locator('[data-page="s14"]');
    await root.getByRole("button", { name: "修改字段" }).click();
    await root.getByRole("textbox", { name: "修改开始时间" }).fill("20:00");
    await root.getByRole("textbox", { name: "修改结束时间" }).fill("19:00");
    await root.getByRole("button", { name: "检查这段时间" }).click();
    await expect(
      root.getByText("无法检查：结束时间需要晚于开始时间。"),
    ).toBeVisible();
    await expect(root.getByText("无冲突 · 对照本地演示日程")).toHaveCount(0);
    await shot(page, "s14-invalid-interval");
    expect(errors).toEqual([]);
  });

  test("draft survives escape, reopen, navigation and reload", async ({
    page,
  }) => {
    test.slow();
    const errors = watchErrors(page);
    await page.goto("/capture");
    const root = page.locator('[data-page="s14"]');
    const input = root.getByRole("textbox", { name: "用一句话记录" });
    await input.fill("明晚七点半到八点半散步");
    await root.getByRole("button", { name: "修改字段" }).click();
    await root.getByRole("textbox", { name: "修改结束时间" }).fill("21:00");
    await expect(root.getByText("9 月 13 日 · 19:30—21:00")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      root.getByText("快捷入口已关闭。可从菜单或分享重新进入。"),
    ).toBeVisible();
    await page.getByRole("button", { name: "重新打开快捷入口" }).click();
    await expect(input).toHaveValue("明晚七点半到八点半散步");
    await page.goto("/");
    await page.goto("/capture");
    await expect(input).toHaveValue("明晚七点半到八点半散步");
    await page.reload();
    await expect(input).toHaveValue("明晚七点半到八点半散步");
    await expect(root.getByText("9 月 13 日 · 19:30—21:00")).toBeVisible();
    await shot(page, "s14-persist");
    expect(errors).toEqual([]);
  });

  test("Cmd+Enter runs the conflict check", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/capture");
    const root = page.locator('[data-page="s14"]');
    await root.getByRole("textbox", { name: "用一句话记录" }).click();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(root.getByText("有冲突 · 对照本地演示日程")).toBeVisible();
    await shot(page, "s14-cmd-enter");
    expect(errors).toEqual([]);
  });

  test("storage failure keeps the draft in memory with an honest error", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException("storage blocked", "QuotaExceededError");
      };
    });
    await page.goto("/capture");
    const root = page.locator('[data-page="s14"]');
    await expect(
      root.getByText("本地存储不可用：草稿只保留在当前页面内存中。"),
    ).toBeVisible();
    const input = root.getByRole("textbox", { name: "用一句话记录" });
    await input.fill("明天下午两点到三点处理邮件");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "重新打开快捷入口" }).click();
    await expect(input).toHaveValue("明天下午两点到三点处理邮件");
    await shot(page, "s14-storage-error");
    expect(errors).toEqual([]);
  });
});

test.describe("[gate][s05] preview approval to local draft", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("approval creates an editable local draft that can be withdrawn", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/preview");
    const root = page.locator('[data-page="s05"]');
    await root.getByRole("button", { name: /批准并准备草稿/ }).click();
    const draftBox = root.getByRole("textbox", { name: "草稿正文" });
    await expect(draftBox).toBeVisible();
    await expect(root.getByText("本地草稿 · 待检查")).toBeVisible();
    await expect(root.getByText(/来源：产品说明（示例）/)).toBeVisible();
    await expect(root.getByText(/访谈节选（示例）/)).toBeVisible();
    await expect(root.getByText(/未发送/)).toBeVisible();
    await draftBox.fill("手动补充：先核对成本材料，再比较两种路径。");
    await expect(draftBox).toHaveValue("手动补充：先核对成本材料，再比较两种路径。");
    await shot(page, "s05-draft");
    await root.getByRole("button", { name: "撤回本地草稿" }).click();
    await expect(root.getByText(/本地草稿已撤回/)).toBeVisible();
    await expect(root.getByRole("textbox", { name: "草稿正文" })).toHaveCount(0);
    await shot(page, "s05-withdrawn");
    expect(errors).toEqual([]);
  });

  test("delay approval reports the delay result and never prepares a report draft", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/plan");
    await page
      .locator('[data-page="s04"]')
      .getByRole("button", { name: /预览延期的影响/ })
      .click();
    await expect(page).toHaveURL(/\/preview$/);
    const preview = page.locator('[data-page="s05"]');
    await preview.getByRole("button", { name: "确认延期安排" }).click();
    await expect(preview.getByText("已确认延期 · 仅本地记录")).toBeVisible();
    await expect(preview.getByText(/没有创建报告草稿/)).toBeVisible();
    await expect(preview.getByRole("textbox", { name: "草稿正文" })).toHaveCount(0);
    await expect(preview.getByText("已批准 · 本次准备任务")).toHaveCount(0);
    await shot(page, "s05-delay");
    expect(errors).toEqual([]);
  });

  test("approval is single-use and survives reentry bound to plan version 03", async ({
    page,
  }) => {
    test.slow();
    const errors = watchErrors(page);
    await page.goto("/preview");
    const root = page.locator('[data-page="s05"]');
    await root.getByRole("button", { name: /批准并准备草稿/ }).click();
    await expect(root.getByText("已批准 · 本次准备任务")).toBeVisible();
    await root.getByRole("button", { name: "返回修改方案" }).click();
    await expect(page).toHaveURL(/\/plan$/);
    await page
      .locator('[data-page="s04"]')
      .getByRole("button", { name: /选择这条路径/ })
      .click();
    await expect(page).toHaveURL(/\/preview$/);
    const reentry = page.locator('[data-page="s05"]');
    await expect(reentry.getByText("已批准 · 本次准备任务")).toBeVisible();
    await expect(
      reentry.getByRole("button", { name: /批准并准备草稿/ }),
    ).toHaveCount(0);
    await expect(reentry.getByRole("textbox", { name: "草稿正文" })).toBeVisible();
    await expect(reentry.getByText("批准绑定：方案版本 03")).toBeVisible();
    await shot(page, "s05-reentry");
    expect(errors).toEqual([]);
  });
});

test.describe("[gate][s17] mobile one-time authorization", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("all scopes approve produces read, estimate, and draft results", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/m/auth");
    const root = page.locator('[data-page="s17"]');
    const approve = root.getByRole("button", { name: "批准并准备草稿" });
    await approve.click();
    await expect(root.getByText(/已读取 2 份指定材料/)).toBeVisible();
    await expect(root.getByText(/投入估计已更新/)).toBeVisible();
    await expect(
      root.getByText("本次授权已使用。草稿待检查，不会自动发送。"),
    ).toBeVisible();
    await expect(root.getByRole("textbox", { name: "草稿正文" })).toBeVisible();
    await expect(root.getByText("本地草稿 · 待检查")).toBeVisible();
    await expect(root.getByText(/来源：产品说明（示例）/)).toBeVisible();
    await expect(approve).toBeDisabled();
    await expect(root.getByRole("checkbox").first()).toBeDisabled();
    await shot(page, "s17-all-grants");
    expect(errors).toEqual([]);
  });

  test("without the draft grant only allowed actions run and no draft is announced", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/m/auth");
    const root = page.locator('[data-page="s17"]');
    await root.getByRole("checkbox", { name: "创建待检查的草稿" }).uncheck();
    await root.getByRole("button", { name: "批准并准备草稿" }).click();
    await expect(root.getByText(/已读取 2 份指定材料/)).toBeVisible();
    await expect(root.getByText(/投入估计已更新/)).toBeVisible();
    await expect(root.getByText("草稿待检查")).toHaveCount(0);
    await expect(root.getByRole("textbox", { name: "草稿正文" })).toHaveCount(0);
    await shot(page, "s17-no-draft");
    expect(errors).toEqual([]);
  });

  test("draft grant without read is explained and no material is read", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/m/auth");
    const root = page.locator('[data-page="s17"]');
    await root.getByRole("checkbox", { name: "读取两份指定材料" }).uncheck();
    await root.getByRole("button", { name: "批准并准备草稿" }).click();
    await expect(
      root.getByText(/草稿未创建：需要先允许读取材料/),
    ).toBeVisible();
    await expect(root.getByText(/已读取/)).toHaveCount(0);
    await expect(root.getByRole("textbox", { name: "草稿正文" })).toHaveCount(0);
    await shot(page, "s17-draft-no-read");
    expect(errors).toEqual([]);
  });

  test("empty grant set keeps the action disabled with a reason", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/m/auth");
    const root = page.locator('[data-page="s17"]');
    const boxes = root.getByRole("checkbox");
    const count = await boxes.count();
    for (let i = 0; i < count; i += 1) {
      await boxes.nth(i).uncheck();
    }
    const approve = root.getByRole("button", { name: "批准并准备草稿" });
    await expect(approve).toBeDisabled();
    await expect(
      root.getByText("至少允许一项动作，或返回修改方案。"),
    ).toBeVisible();
    await shot(page, "s17-empty-grants");
    expect(errors).toEqual([]);
  });

  test("demo disclosure stays visible", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/m/auth");
    const root = page.locator('[data-page="s17"]');
    await expect(root.getByText("界面演示 · 非真实账户数据")).toBeVisible();
    await shot(page, "s17-demo-disclosure");
    expect(errors).toEqual([]);
  });
});

test.describe("[gate][s14][delta] manual fields, clock validation, persistence", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("manual field entry from empty input drives a real check and Cmd+Enter", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/capture");
    const root = page.locator('[data-page="s14"]');
    const input = root.getByRole("textbox", { name: "用一句话记录" });
    await input.fill("");
    await root.getByRole("button", { name: "检查这段时间" }).click();
    await expect(root.getByText("无法判断 · 信息不完整")).toBeVisible();
    await root.getByRole("button", { name: "修改字段" }).click();
    await root.getByRole("textbox", { name: "修改日期" }).fill("9 月 13 日");
    await root.getByRole("textbox", { name: "修改开始时间" }).fill("18:00");
    await root.getByRole("textbox", { name: "修改结束时间" }).fill("18:45");
    await root
      .getByRole("textbox", { name: "修改约束对象" })
      .fill("客户会议");
    await root.getByRole("button", { name: "检查这段时间" }).click();
    await expect(root.getByText("无冲突 · 对照本地演示日程")).toBeVisible();
    await shot(page, "delta-s14-manual-check");
    await root.getByRole("textbox", { name: "修改开始时间" }).fill("");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(root.getByText("无法判断 · 信息不完整")).toBeVisible();
    await root.getByRole("textbox", { name: "修改开始时间" }).fill("18:00");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(root.getByText("无冲突 · 对照本地演示日程")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("invalid clock formats are rejected explicitly", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/capture");
    const root = page.locator('[data-page="s14"]');
    await root.getByRole("button", { name: "修改字段" }).click();
    const startBox = root.getByRole("textbox", { name: "修改开始时间" });
    for (const bad of ["18:30:99", "18:", ":30", "abc", "24:00"]) {
      await startBox.fill(bad);
      await root.getByRole("button", { name: "检查这段时间" }).click();
      await expect(
        root.getByText("无法检查：时间格式无法识别。"),
      ).toBeVisible();
      await expect(root.getByText("无冲突 · 对照本地演示日程")).toHaveCount(0);
      await expect(root.getByText("有冲突 · 对照本地演示日程")).toHaveCount(0);
    }
    await startBox.fill("18:00");
    await root.getByRole("textbox", { name: "修改结束时间" }).fill("18:30");
    await root.getByRole("button", { name: "检查这段时间" }).click();
    await expect(root.getByText("无冲突 · 对照本地演示日程")).toBeVisible();
    await shot(page, "delta-s14-invalid-clock");
    expect(errors).toEqual([]);
  });

  test("impossible dates are not normalized to demo dates", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/capture");
    const root = page.locator('[data-page="s14"]');
    await root.getByRole("button", { name: "修改字段" }).click();
    await root.getByRole("textbox", { name: "修改日期" }).fill("13 月 1 日");
    await root.getByRole("textbox", { name: "修改开始时间" }).fill("18:00");
    await root.getByRole("textbox", { name: "修改结束时间" }).fill("18:45");
    await root.getByRole("button", { name: "检查这段时间" }).click();
    await expect(
      root.getByText("无法判断 · 本地演示日程未覆盖该日期"),
    ).toBeVisible();
    await expect(root.getByText("9 月 13 日 · 18:00—18:45")).toHaveCount(0);
    await root.getByRole("textbox", { name: "修改日期" }).fill("2 月 30 日");
    await root.getByRole("button", { name: "检查这段时间" }).click();
    await expect(
      root.getByText("无法判断 · 本地演示日程未覆盖该日期"),
    ).toBeVisible();
    await shot(page, "delta-s14-impossible-date");
    expect(errors).toEqual([]);
  });

  test("manually saved intent preserves fields across reload without inventing words", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/capture");
    const root = page.locator('[data-page="s14"]');
    const input = root.getByRole("textbox", { name: "用一句话记录" });
    await input.fill("");
    await root.getByRole("button", { name: "修改字段" }).click();
    await root.getByRole("textbox", { name: "修改日期" }).fill("9 月 13 日");
    await root.getByRole("textbox", { name: "修改开始时间" }).fill("18:00");
    await root.getByRole("textbox", { name: "修改结束时间" }).fill("18:45");
    await root
      .getByRole("textbox", { name: "修改约束对象" })
      .fill("客户会议");
    await root.getByRole("button", { name: "只保存为意图" }).click();
    await expect(
      root.getByText("已保存为意图。尚未创建日历事件，也不会通知任何人。"),
    ).toBeVisible();
    await page.reload();
    await expect(input).toHaveValue("");
    await expect(root.getByText("9 月 13 日 · 18:00—18:45")).toBeVisible();
    await expect(root.getByText("现有客户会议")).toBeVisible();
    await expect(
      root.getByText("已保存为意图。尚未创建日历事件，也不会通知任何人。"),
    ).toBeVisible();
    await shot(page, "delta-s14-manual-save-reload");
    expect(errors).toEqual([]);
  });
});

test.describe("[gate][s05][delta] delay detour, malformed state, storage faults", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("normal approval survives the delay detour; edited draft survives reload", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/preview");
    const root = page.locator('[data-page="s05"]');
    await root.getByRole("button", { name: /批准并准备草稿/ }).click();
    const draftBox = root.getByRole("textbox", { name: "草稿正文" });
    await expect(draftBox).toBeVisible();
    await draftBox.fill("增量验证：保留这段修改。");
    await root.getByRole("button", { name: "返回修改方案" }).click();
    await expect(page).toHaveURL(/\/plan$/);
    await page
      .locator('[data-page="s04"]')
      .getByRole("button", { name: /预览延期的影响/ })
      .click();
    await expect(page).toHaveURL(/\/preview$/);
    const delay = page.locator('[data-page="s05"]');
    await expect(delay.getByRole("textbox", { name: "草稿正文" })).toHaveCount(0);
    await expect(delay.getByText("已批准 · 本次准备任务")).toHaveCount(0);
    await delay.getByRole("button", { name: "确认延期安排" }).click();
    await expect(delay.getByText("已确认延期 · 仅本地记录")).toBeVisible();
    await expect(delay.getByRole("textbox", { name: "草稿正文" })).toHaveCount(0);
    await expect(delay.getByText("已批准 · 本次准备任务")).toHaveCount(0);
    await shot(page, "delta-s05-delay-detour");
    await delay.getByRole("button", { name: "返回修改方案" }).click();
    await expect(page).toHaveURL(/\/plan$/);
    await page
      .locator('[data-page="s04"]')
      .getByRole("button", { name: /选择这条路径/ })
      .click();
    await expect(page).toHaveURL(/\/preview$/);
    const normal = page.locator('[data-page="s05"]');
    await expect(normal.getByRole("textbox", { name: "草稿正文" })).toHaveValue(
      "增量验证：保留这段修改。",
    );
    await expect(normal.getByText("已批准 · 本次准备任务")).toBeVisible();
    await page.reload();
    await expect(normal.getByRole("textbox", { name: "草稿正文" })).toHaveValue(
      "增量验证：保留这段修改。",
    );
    await expect(normal.getByText("已批准 · 本次准备任务")).toBeVisible();
    await shot(page, "delta-s05-normal-reload");
    expect(errors).toEqual([]);
  });

  test("malformed stored plan cannot grant authority and reports recovery", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    seedLocalStorage(page, {
      "tango-donego.s05.plan.v1": JSON.stringify({ approved: true, draft: {} }),
    });
    await page.goto("/preview");
    const root = page.locator('[data-page="s05"]');
    await expect(root.getByText("待批准 · 方案版本 03")).toBeVisible();
    await expect(
      root.getByText("本地保存的数据无法识别，已重置为未批准状态；旧批准未恢复。"),
    ).toBeVisible();
    await expect(root.getByRole("textbox", { name: "草稿正文" })).toHaveCount(0);
    await expect(root.getByText("已批准 · 本次准备任务")).toHaveCount(0);
    await expect(
      root.getByRole("button", { name: /批准并准备草稿/ }),
    ).toBeVisible();
    await shot(page, "delta-s05-malformed");
    expect(errors).toEqual([]);
  });

  test("foreign plan version stored data is not treated as an approval", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    seedLocalStorage(page, {
      "tango-donego.s05.plan.v1": JSON.stringify({
        approved: true,
        draft: {
          scope: "本次准备任务",
          planVersion: "方案版本 99",
          title: "报告工作草稿",
          status: "待检查",
          sources: ["未知来源"],
          content: "外来版本内容。",
        },
      }),
    });
    await page.goto("/preview");
    const root = page.locator('[data-page="s05"]');
    await expect(root.getByText("待批准 · 方案版本 03")).toBeVisible();
    await expect(
      root.getByText("本地保存的数据无法识别，已重置为未批准状态；旧批准未恢复。"),
    ).toBeVisible();
    await expect(root.getByText("已批准 · 本次准备任务")).toHaveCount(0);
    await expect(root.getByText("外来版本内容。")).toHaveCount(0);
    await shot(page, "delta-s05-foreign-version");
    expect(errors).toEqual([]);
  });

  test("failed storage keeps approval pending with retry reading back the same draft", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    breakStorageOn(page, "tango-donego.s05.plan.v1");
    await page.goto("/preview");
    const root = page.locator('[data-page="s05"]');
    await root.getByRole("button", { name: /批准并准备草稿/ }).click();
    await expect(
      root.getByText("本地保存失败：最新改动未写入本地存储，内容保留在当前页面。"),
    ).toBeVisible();
    const retry = root.getByRole("button", { name: "重试保存" });
    await expect(retry).toBeVisible();
    await expect(root.getByText("已批准 · 本次准备任务")).toHaveCount(0);
    const draftBox = root.getByRole("textbox", { name: "草稿正文" });
    await expect(draftBox).toBeVisible();
    await draftBox.fill("失败重试：新内容保留。");
    await shot(page, "delta-s05-pending");
    await page.evaluate(() =>
      (window as unknown as { __allowStorage: () => void }).__allowStorage(),
    );
    await retry.click();
    await expect(root.getByText("已批准 · 本次准备任务")).toBeVisible();
    await expect(draftBox).toHaveValue("失败重试：新内容保留。");
    const stored = (await readJsonStorage(
      page,
      "tango-donego.s05.plan.v1",
    )) as { approved?: boolean; draft?: { content?: string } | null };
    expect(stored?.approved).toBe(true);
    expect(stored?.draft?.content).toBe("失败重试：新内容保留。");
    await expect(root.getByRole("button", { name: /批准并准备草稿/ })).toHaveCount(0);
    await shot(page, "delta-s05-retry-recovered");
    expect(errors).toEqual([]);
  });

  test("pre-existing storage snapshot does not override newer pending edits", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    seedLocalStorage(page, {
      "tango-donego.s05.plan.v1": JSON.stringify({
        approved: true,
        draft: {
          scope: "本次准备任务",
          planVersion: "方案版本 03",
          title: "报告工作草稿",
          status: "待检查",
          sources: ["产品说明（示例）", "访谈节选（示例）"],
          content: "旧快照内容：不应覆盖新编辑。",
        },
      }),
    });
    breakStorageOn(page, "tango-donego.s05.plan.v1");
    await page.goto("/preview");
    const root = page.locator('[data-page="s05"]');
    const draftBox = root.getByRole("textbox", { name: "草稿正文" });
    await expect(draftBox).toHaveValue("旧快照内容：不应覆盖新编辑。");
    await draftBox.fill("快照之上的新编辑。");
    await expect(draftBox).toHaveValue("快照之上的新编辑。");
    await expect(
      root.getByText("本地保存失败：最新改动未写入本地存储，内容保留在当前页面。"),
    ).toBeVisible();
    await expect(root.getByText("草稿改动尚未写入本地存储。")).toBeVisible();
    await shot(page, "delta-s05-snapshot-pending");
    expect(errors).toEqual([]);
  });
});

test.describe("[gate][s17][delta] reload persistence, malformed state, storage faults", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("used authorization and edited draft survive reload", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/m/auth");
    const root = page.locator('[data-page="s17"]');
    await root.getByRole("button", { name: "批准并准备草稿" }).click();
    await expect(
      root.getByText("本次授权已使用。草稿待检查，不会自动发送。"),
    ).toBeVisible();
    const draftBox = root.getByRole("textbox", { name: "草稿正文" });
    await draftBox.fill("手机端修订：这不是默认句子。");
    await shot(page, "delta-s17-before-reload");
    await page.reload();
    await expect(
      root.getByText("本次授权已使用。草稿待检查，不会自动发送。"),
    ).toBeVisible();
    await expect(root.getByText(/已读取 2 份指定材料/)).toHaveCount(1);
    await expect(root.getByText(/投入估计已更新/)).toHaveCount(1);
    await expect(root.getByText("方案版本 03 · 本次授权已使用")).toBeVisible();
    await expect(draftBox).toHaveValue("手机端修订：这不是默认句子。");
    await expect(root.getByText(/来源：产品说明（示例）/)).toBeVisible();
    const approve = root.getByRole("button", { name: "批准并准备草稿" });
    await expect(approve).toBeDisabled();
    const draftGrant = root.getByRole("checkbox", {
      name: "创建待检查的草稿",
    });
    await expect(draftGrant).toBeChecked();
    await expect(draftGrant).toBeDisabled();
    await shot(page, "delta-s17-reload-persist");
    expect(errors).toEqual([]);
  });

  test("denied draft grant persists the actually chosen scopes after reload", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/m/auth");
    const root = page.locator('[data-page="s17"]');
    await root.getByRole("checkbox", { name: "创建待检查的草稿" }).uncheck();
    await root.getByRole("button", { name: "批准并准备草稿" }).click();
    await expect(root.getByText("本次授权已使用。未创建草稿。")).toBeVisible();
    await page.reload();
    await expect(root.getByText("本次授权已使用。未创建草稿。")).toBeVisible();
    const readBox = root.getByRole("checkbox", { name: "读取两份指定材料" });
    const draftGrant = root.getByRole("checkbox", {
      name: "创建待检查的草稿",
    });
    const estimateBox = root.getByRole("checkbox", {
      name: "更新内部投入估计",
    });
    await expect(readBox).toBeChecked();
    await expect(draftGrant).not.toBeChecked();
    await expect(estimateBox).toBeChecked();
    for (const box of [readBox, draftGrant, estimateBox]) {
      await expect(box).toBeDisabled();
    }
    await expect(root.getByRole("textbox", { name: "草稿正文" })).toHaveCount(0);
    await expect(
      root.getByRole("button", { name: "批准并准备草稿" }),
    ).toBeDisabled();
    await shot(page, "delta-s17-denied-reload");
    expect(errors).toEqual([]);
  });

  test("malformed stored authorization resets honestly without crashing", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    seedLocalStorage(page, {
      "tango-donego.s17.auth.v1": JSON.stringify({
        used: true,
        grants: "all",
        draft: { content: 42 },
      }),
    });
    await page.goto("/m/auth");
    const root = page.locator('[data-page="s17"]');
    await expect(
      root.getByText("本地授权数据无法识别，已重置为未执行状态；旧授权未恢复。"),
    ).toBeVisible();
    const approve = root.getByRole("button", { name: "批准并准备草稿" });
    await expect(approve).toBeEnabled();
    await expect(root.getByText("本次授权已使用")).toHaveCount(0);
    await page.evaluate(() => {
      window.localStorage.setItem("tango-donego.s17.auth.v1", "{oops");
    });
    await page.reload();
    await expect(
      root.getByText("本地授权数据无法识别，已重置为未执行状态；旧授权未恢复。"),
    ).toBeVisible();
    await expect(approve).toBeEnabled();
    await shot(page, "delta-s17-malformed");
    expect(errors).toEqual([]);
  });

  test("failed storage keeps authorization pending with retry reading back the same draft", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    breakStorageOn(page, "tango-donego.s17.auth.v1");
    await page.goto("/m/auth");
    const root = page.locator('[data-page="s17"]');
    await root.getByRole("button", { name: "批准并准备草稿" }).click();
    await expect(
      root.getByText("本地保存失败：最新改动未写入本地存储，内容保留在当前页面。"),
    ).toBeVisible();
    const retry = root.getByRole("button", { name: "重试保存" });
    await expect(retry).toBeVisible();
    await expect(
      root.getByText("本次授权已使用。草稿待检查，不会自动发送。"),
    ).toHaveCount(0);
    await expect(root.getByText(/已读取 2 份指定材料/)).toHaveCount(0);
    const draftBox = root.getByRole("textbox", { name: "草稿正文" });
    await expect(draftBox).toBeVisible();
    await draftBox.fill("授权写入失败后的句子。");
    await shot(page, "delta-s17-pending");
    await page.evaluate(() =>
      (window as unknown as { __allowStorage: () => void }).__allowStorage(),
    );
    await retry.click();
    await expect(
      root.getByText("本次授权已使用。草稿待检查，不会自动发送。"),
    ).toBeVisible();
    await expect(draftBox).toHaveValue("授权写入失败后的句子。");
    const stored = (await readJsonStorage(
      page,
      "tango-donego.s17.auth.v1",
    )) as { used?: boolean; draft?: { content?: string } | null };
    expect(stored?.used).toBe(true);
    expect(stored?.draft?.content).toBe("授权写入失败后的句子。");
    await expect(root.getByText(/已读取 2 份指定材料/)).toHaveCount(1);
    await expect(
      root.getByRole("button", { name: "批准并准备草稿" }),
    ).toBeDisabled();
    await shot(page, "delta-s17-retry-recovered");
    expect(errors).toEqual([]);
  });
});

test.describe("[gate][s05][boundary] committed versus pending storage", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("failed approval keeps a pending attempt and never publishes a committed receipt on reentry or reload", async ({
    page,
  }) => {
    test.slow();
    const errors = watchErrors(page);
    breakStorageOn(page, "tango-donego.s05.plan.v1");
    await page.goto("/preview");
    const root = page.locator('[data-page="s05"]');
    await root.getByRole("button", { name: /批准并准备草稿/ }).click();
    await expect(
      root.getByText("本地保存失败：最新改动未写入本地存储，内容保留在当前页面。"),
    ).toBeVisible();
    const alert = root.locator('[role="alert"]');
    const attemptId = await alert.getAttribute("data-attempt-id");
    expect(attemptId).toBeTruthy();
    await expect(root.getByText("已批准 · 本次准备任务")).toHaveCount(0);
    const draftBox = root.getByRole("textbox", { name: "草稿正文" });
    await draftBox.fill("边界验证：待定内容不能冒充已提交。");
    await expect(alert).toHaveAttribute("data-attempt-id", attemptId as string);
    expect(await readJsonStorage(page, "tango-donego.s05.plan.v1")).toBeNull();

    await root.getByRole("button", { name: "返回修改方案" }).click();
    await expect(page).toHaveURL(/\/plan$/);
    await page
      .locator('[data-page="s04"]')
      .getByRole("button", { name: /选择这条路径/ })
      .click();
    await expect(page).toHaveURL(/\/preview$/);
    const reentry = page.locator('[data-page="s05"]');
    await expect(reentry.getByText("已批准 · 本次准备任务")).toHaveCount(0);
    await expect(
      reentry.getByText("本地保存失败：最新改动未写入本地存储，内容保留在当前页面。"),
    ).toBeVisible();
    await expect(
      reentry.getByRole("textbox", { name: "草稿正文" }),
    ).toHaveValue("边界验证：待定内容不能冒充已提交。");
    await expect(reentry.locator('[role="alert"]')).toHaveAttribute(
      "data-attempt-id",
      attemptId as string,
    );
    expect(await readJsonStorage(page, "tango-donego.s05.plan.v1")).toBeNull();

    await page.reload();
    const fresh = page.locator('[data-page="s05"]');
    await expect(fresh.getByText("已批准 · 本次准备任务")).toHaveCount(0);
    await expect(
      fresh.getByText("本地保存失败：最新改动未写入本地存储，内容保留在当前页面。"),
    ).toHaveCount(0);
    await expect(fresh.locator('[role="alert"]')).toHaveCount(0);
    await expect(fresh.getByRole("textbox", { name: "草稿正文" })).toHaveCount(0);
    await expect(
      fresh.getByRole("button", { name: /批准并准备草稿/ }),
    ).toBeVisible();
    expect(await readJsonStorage(page, "tango-donego.s05.plan.v1")).toBeNull();
    await shot(page, "boundary-s05-pending-reentry");
    expect(errors).toEqual([]);
  });

  test("retry keeps the edited text and the exact attemptId in the durable receipt", async ({
    page,
  }) => {
    test.slow();
    const errors = watchErrors(page);
    breakStorageOn(page, "tango-donego.s05.plan.v1");
    await page.goto("/preview");
    const root = page.locator('[data-page="s05"]');
    await root.getByRole("button", { name: /批准并准备草稿/ }).click();
    await expect(
      root.getByText("本地保存失败：最新改动未写入本地存储，内容保留在当前页面。"),
    ).toBeVisible();
    const alert = root.locator('[role="alert"]');
    const attemptId = await alert.getAttribute("data-attempt-id");
    expect(attemptId).toBeTruthy();
    await root
      .getByRole("textbox", { name: "草稿正文" })
      .fill("重试边界：同一尝试编号。");
    await expect(alert).toHaveAttribute("data-attempt-id", attemptId as string);
    await page.evaluate(() =>
      (window as unknown as { __allowStorage: () => void }).__allowStorage(),
    );
    await root.getByRole("button", { name: "重试保存" }).click();
    await expect(root.getByText("已批准 · 本次准备任务")).toBeVisible();
    await expect(
      root.getByRole("textbox", { name: "草稿正文" }),
    ).toHaveValue("重试边界：同一尝试编号。");
    const stored = (await readJsonStorage(
      page,
      "tango-donego.s05.plan.v1",
    )) as {
      approved?: boolean;
      attemptId?: string;
      draft?: { content?: string } | null;
    };
    expect(stored?.approved).toBe(true);
    expect(stored?.attemptId).toBe(attemptId);
    expect(stored?.draft?.content).toBe("重试边界：同一尝试编号。");
    await page.reload();
    const reloaded = page.locator('[data-page="s05"]');
    await expect(reloaded.getByText("已批准 · 本次准备任务")).toBeVisible();
    await expect(
      reloaded.getByRole("textbox", { name: "草稿正文" }),
    ).toHaveValue("重试边界：同一尝试编号。");
    await shot(page, "boundary-s05-retry-receipt");
    expect(errors).toEqual([]);
  });

  test("setItem success with failing getItem is unverified, never a verified durable success", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    breakStorageReadOn(page, "tango-donego.s05.plan.v1");
    await page.goto("/preview");
    const root = page.locator('[data-page="s05"]');
    await root.getByRole("button", { name: /批准并准备草稿/ }).click();
    await expect(
      root.getByText("写入结果未知：本地写入后无法确认保存是否成功，请重试验证。"),
    ).toBeVisible();
    await expect(root.getByText("已批准 · 本次准备任务")).toHaveCount(0);
    await expect(
      root.getByText("本地保存失败：最新改动未写入本地存储，内容保留在当前页面。"),
    ).toHaveCount(0);
    const stored = (await readJsonStorageDirect(
      page,
      "tango-donego.s05.plan.v1",
    )) as { approved?: boolean; attemptId?: string } | null;
    expect(stored?.approved).toBe(true);
    const alert = root.locator('[role="alert"]');
    const attemptId = await alert.getAttribute("data-attempt-id");
    expect(attemptId).toBeTruthy();
    expect(stored?.attemptId).toBe(attemptId);
    await page.evaluate(() =>
      (window as unknown as { __allowStorageRead: () => void })
        .__allowStorageRead(),
    );
    await root.getByRole("button", { name: "重试保存" }).click();
    await expect(root.getByText("已批准 · 本次准备任务")).toBeVisible();
    await expect(root.locator('[role="alert"]')).toHaveCount(0);
    await shot(page, "boundary-s05-readback-unverified");
    expect(errors).toEqual([]);
  });

  test("approved snapshot claiming changed sources recovers as invalid", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    seedLocalStorage(page, {
      "tango-donego.s05.plan.v1": JSON.stringify({
        approved: true,
        draft: {
          scope: "本次准备任务",
          planVersion: "方案版本 03",
          title: "报告工作草稿",
          status: "待检查",
          sources: ["产品说明（示例）", "外部补充材料（未授权）"],
          content: "来源被改动的快照不应作为批准恢复。",
        },
      }),
    });
    await page.goto("/preview");
    const root = page.locator('[data-page="s05"]');
    await expect(root.getByText("待批准 · 方案版本 03")).toBeVisible();
    await expect(
      root.getByText("本地保存的数据无法识别，已重置为未批准状态；旧批准未恢复。"),
    ).toBeVisible();
    await expect(root.getByText("已批准 · 本次准备任务")).toHaveCount(0);
    await expect(root.getByRole("textbox", { name: "草稿正文" })).toHaveCount(0);
    await shot(page, "boundary-s05-changed-sources");
    expect(errors).toEqual([]);
  });
});

test.describe("[gate][s17][boundary] committed versus pending storage", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("failed authorization keeps a pending attempt and never publishes a used receipt on reentry or reload", async ({
    page,
  }) => {
    test.slow();
    const errors = watchErrors(page);
    breakStorageOn(page, "tango-donego.s17.auth.v1");
    await page.goto("/m/auth");
    const root = page.locator('[data-page="s17"]');
    await root.getByRole("button", { name: "批准并准备草稿" }).click();
    await expect(
      root.getByText("本地保存失败：最新改动未写入本地存储，内容保留在当前页面。"),
    ).toBeVisible();
    const alert = root.locator('[role="alert"]');
    const attemptId = await alert.getAttribute("data-attempt-id");
    expect(attemptId).toBeTruthy();
    await expect(
      root.getByText("本次授权已使用。草稿待检查，不会自动发送。"),
    ).toHaveCount(0);
    await expect(root.getByText(/已读取 2 份指定材料/)).toHaveCount(0);
    await root
      .getByRole("textbox", { name: "草稿正文" })
      .fill("移动端边界：未提交的授权草稿。");
    await expect(alert).toHaveAttribute("data-attempt-id", attemptId as string);
    expect(await readJsonStorage(page, "tango-donego.s17.auth.v1")).toBeNull();

    await root.getByRole("link", { name: "返回修改方案" }).click();
    await expect(page).toHaveURL(/\/m\/plan$/);
    await page
      .locator('[data-page="s16"]')
      .getByRole("button", { name: /预览方案 A 的授权/ })
      .click();
    await expect(page).toHaveURL(/\/m\/auth$/);
    const reentry = page.locator('[data-page="s17"]');
    await expect(
      reentry.getByText("本次授权已使用。草稿待检查，不会自动发送。"),
    ).toHaveCount(0);
    await expect(
      reentry.getByText("本地保存失败：最新改动未写入本地存储，内容保留在当前页面。"),
    ).toBeVisible();
    await expect(
      reentry.getByRole("textbox", { name: "草稿正文" }),
    ).toHaveValue("移动端边界：未提交的授权草稿。");
    await expect(reentry.locator('[role="alert"]')).toHaveAttribute(
      "data-attempt-id",
      attemptId as string,
    );
    expect(await readJsonStorage(page, "tango-donego.s17.auth.v1")).toBeNull();

    await page.reload();
    const fresh = page.locator('[data-page="s17"]');
    await expect(
      fresh.getByText("本次授权已使用。草稿待检查，不会自动发送。"),
    ).toHaveCount(0);
    await expect(
      fresh.getByText("本地保存失败：最新改动未写入本地存储，内容保留在当前页面。"),
    ).toHaveCount(0);
    await expect(fresh.locator('[role="alert"]')).toHaveCount(0);
    await expect(fresh.getByRole("textbox", { name: "草稿正文" })).toHaveCount(0);
    await expect(
      fresh.getByRole("button", { name: "批准并准备草稿" }),
    ).toBeEnabled();
    expect(await readJsonStorage(page, "tango-donego.s17.auth.v1")).toBeNull();
    await shot(page, "boundary-s17-pending-reentry");
    expect(errors).toEqual([]);
  });

  test("retry keeps the edited draft and the exact attemptId in the durable receipt", async ({
    page,
  }) => {
    test.slow();
    const errors = watchErrors(page);
    breakStorageOn(page, "tango-donego.s17.auth.v1");
    await page.goto("/m/auth");
    const root = page.locator('[data-page="s17"]');
    await root.getByRole("button", { name: "批准并准备草稿" }).click();
    await expect(
      root.getByText("本地保存失败：最新改动未写入本地存储，内容保留在当前页面。"),
    ).toBeVisible();
    const alert = root.locator('[role="alert"]');
    const attemptId = await alert.getAttribute("data-attempt-id");
    expect(attemptId).toBeTruthy();
    await expect(
      root.getByText("本次授权已使用。草稿待检查，不会自动发送。"),
    ).toHaveCount(0);
    await root
      .getByRole("textbox", { name: "草稿正文" })
      .fill("移动端重试：同一尝试编号。");
    await expect(alert).toHaveAttribute("data-attempt-id", attemptId as string);
    await page.evaluate(() =>
      (window as unknown as { __allowStorage: () => void }).__allowStorage(),
    );
    await root.getByRole("button", { name: "重试保存" }).click();
    await expect(
      root.getByText("本次授权已使用。草稿待检查，不会自动发送。"),
    ).toBeVisible();
    await expect(
      root.getByRole("textbox", { name: "草稿正文" }),
    ).toHaveValue("移动端重试：同一尝试编号。");
    const stored = (await readJsonStorage(
      page,
      "tango-donego.s17.auth.v1",
    )) as {
      used?: boolean;
      attemptId?: string;
      draft?: { content?: string } | null;
    };
    expect(stored?.used).toBe(true);
    expect(stored?.attemptId).toBe(attemptId);
    expect(stored?.draft?.content).toBe("移动端重试：同一尝试编号。");
    await page.reload();
    const reloaded = page.locator('[data-page="s17"]');
    await expect(
      reloaded.getByText("本次授权已使用。草稿待检查，不会自动发送。"),
    ).toBeVisible();
    await expect(
      reloaded.getByRole("textbox", { name: "草稿正文" }),
    ).toHaveValue("移动端重试：同一尝试编号。");
    await shot(page, "boundary-s17-retry-receipt");
    expect(errors).toEqual([]);
  });

  test("setItem success with failing getItem is unverified, never a verified used receipt", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    breakStorageReadOn(page, "tango-donego.s17.auth.v1");
    await page.goto("/m/auth");
    const root = page.locator('[data-page="s17"]');
    await root.getByRole("button", { name: "批准并准备草稿" }).click();
    await expect(
      root.getByText("写入结果未知：本地写入后无法确认保存是否成功，请重试验证。"),
    ).toBeVisible();
    await expect(
      root.getByText("本次授权已使用。草稿待检查，不会自动发送。"),
    ).toHaveCount(0);
    await expect(root.getByText(/已读取 2 份指定材料/)).toHaveCount(0);
    const stored = (await readJsonStorageDirect(
      page,
      "tango-donego.s17.auth.v1",
    )) as { used?: boolean; attemptId?: string } | null;
    expect(stored?.used).toBe(true);
    const alert = root.locator('[role="alert"]');
    const attemptId = await alert.getAttribute("data-attempt-id");
    expect(attemptId).toBeTruthy();
    expect(stored?.attemptId).toBe(attemptId);
    await page.evaluate(() =>
      (window as unknown as { __allowStorageRead: () => void })
        .__allowStorageRead(),
    );
    await root.getByRole("button", { name: "重试保存" }).click();
    await expect(
      root.getByText("本次授权已使用。草稿待检查，不会自动发送。"),
    ).toBeVisible();
    await expect(root.locator('[role="alert"]')).toHaveCount(0);
    await shot(page, "boundary-s17-readback-unverified");
    expect(errors).toEqual([]);
  });

  test("rehydrated draft paired with denied grants recovers as invalid", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    seedLocalStorage(page, {
      "tango-donego.s17.auth.v1": JSON.stringify({
        used: true,
        grants: { read: false, draft: false, estimate: true },
        readDone: false,
        estimateDone: true,
        draftBlocked: true,
        draft: {
          scope: "本次准备任务",
          planVersion: "方案版本 03",
          title: "报告工作草稿",
          status: "待检查",
          sources: ["产品说明（示例）", "访谈节选（示例）"],
          content: "与拒绝授权配对的草稿不应显示。",
        },
      }),
    });
    await page.goto("/m/auth");
    const root = page.locator('[data-page="s17"]');
    await expect(
      root.getByText("本地授权数据无法识别，已重置为未执行状态；旧授权未恢复。"),
    ).toBeVisible();
    await expect(root.getByText("本次授权已使用")).toHaveCount(0);
    await expect(root.getByText(/已读取/)).toHaveCount(0);
    await expect(root.getByRole("textbox", { name: "草稿正文" })).toHaveCount(0);
    await expect(
      root.getByRole("button", { name: "批准并准备草稿" }),
    ).toBeEnabled();
    await shot(page, "boundary-s17-grant-mismatch");
    expect(errors).toEqual([]);
  });
});

test.describe("[runtime-s05] shared runtime authority flow", () => {
  type RuntimeSnapshot = {
    ready: boolean;
    reason?: string;
    plans: Array<{ id: string; kind: string; intentId: string | null; status: string }>;
    approvals: Array<{
      id: string;
      planId: string;
      status: string;
      consumedByOperationId: string | null;
    }>;
    operations: Array<{ id: string; approvalId: string; status: string; resultRefs: string[] }>;
    drafts: Array<{ id: string; operationId: string; status: string; sectionCount: number }>;
  };

  async function inspectRuntime(page: Page): Promise<RuntimeSnapshot> {
    return page.evaluate(async () => {
      const runtimeModuleUrl = "/src/runtime/index.ts";
      const mod = (await import(runtimeModuleUrl)) as {
        getDomainRuntime: () => Promise<unknown>;
      };
      const handle = (await mod.getDomainRuntime()) as {
        status: string;
        reason?: string;
        store?: {
          getState: () => {
            plans: Record<string, { id: string; kind: string; intentId: string | null; status: string }>;
            approvals: Record<
              string,
              { id: string; planId: string; status: string; consumedByOperationId: string | null }
            >;
            operations: Record<
              string,
              { id: string; approvalId: string; status: string; resultRefs: string[] }
            >;
            drafts: Record<
              string,
              { id: string; operationId: string; status: string; sections: unknown[] }
            >;
          };
        };
      };
      if (handle.status !== "ready" || !handle.store) {
        return {
          ready: false,
          reason: handle.reason ?? handle.status,
          plans: [],
          approvals: [],
          operations: [],
          drafts: [],
        };
      }
      const state = handle.store.getState();
      return {
        ready: true,
        plans: Object.values(state.plans).map((p) => ({
          id: p.id,
          kind: p.kind,
          intentId: p.intentId,
          status: p.status,
        })),
        approvals: Object.values(state.approvals).map((a) => ({
          id: a.id,
          planId: a.planId,
          status: a.status,
          consumedByOperationId: a.consumedByOperationId,
        })),
        operations: Object.values(state.operations).map((o) => ({
          id: o.id,
          approvalId: o.approvalId,
          status: o.status,
          resultRefs: o.resultRefs,
        })),
        drafts: Object.values(state.drafts).map((d) => ({
          id: d.id,
          operationId: d.operationId,
          status: d.status,
          sectionCount: d.sections.length,
        })),
      };
    });
  }

  function validRefsFor(snap: RuntimeSnapshot, opId: string, resultRefs: string[]): string[] {
    return resultRefs.filter((ref) =>
      snap.drafts.some((d) => d.id === ref && d.operationId === opId),
    );
  }

  async function watchConsole(page: Page): Promise<string[]> {
    const lines: string[] = [];
    page.on("console", (message) => {
      lines.push(JSON.stringify({ type: message.type(), text: message.text() }));
    });
    return lines;
  }

  async function attachConsole(lines: string[], name: string): Promise<void> {
    await test.info().attach(name + "-console.json", {
      body: JSON.stringify(lines, null, 2),
      contentType: "application/json",
    });
  }

  async function shotOnFailure(page: Page, name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      await shot(page, name + "-RED").catch(() => undefined);
      throw error;
    }
    await shot(page, name);
  }

  async function approveViaUi(page: Page): Promise<RuntimeSnapshot> {
    const root = page.locator('[data-page="s05"]');
    await root.getByRole("button", { name: "批准并准备草稿" }).click();
    let snap: RuntimeSnapshot | null = null;
    await expect
      .poll(
        async () => {
          snap = await inspectRuntime(page);
          return snap.ready
            ? snap.operations.filter((o) => o.status === "verified").length
            : 0;
        },
        { timeout: 10000 },
      )
      .toBeGreaterThanOrEqual(1);
    return snap ?? (await inspectRuntime(page));
  }

  test("approval uses only the shared runtime: no private plan key, one shared draft, stays on preview", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    const consoleLines = await watchConsole(page);
    await page.goto("/preview");
    const root = page.locator('[data-page="s05"]');
    await shotOnFailure(page, "runtime-s05-authority-single-source", async () => {
      const snap = await approveViaUi(page);
      expect(page.url()).toMatch(/\/preview$/);
      const privateKey = await page.evaluate(() =>
        window.localStorage.getItem("tango-donego.s05.plan.v1"),
      );
      expect(privateKey).toBeNull();
      const op = snap.operations.find((o) => o.status === "verified");
      expect(op).toBeDefined();
      const refs = validRefsFor(snap, op!.id, op!.resultRefs);
      expect(refs).toHaveLength(1);
      const handoff = root.locator('[data-runtime-handoff]');
      await expect(handoff).toHaveCount(1);
      await expect(handoff).toHaveAttribute("data-draft-id", refs[0]);
      await expect(handoff).toHaveAttribute("data-operation-id", op!.id);
      await expect(root.locator('article[aria-label="本地草稿"]')).toHaveCount(0);
      await expect(page.getByRole("textbox")).toHaveCount(0);
      await expect(
        root.locator('[data-edit-unavailable="editDraftSection"]'),
      ).toBeVisible();
      await expect(root.locator('[data-approved-verified]')).toHaveCount(1);
      await expect(root.getByText("已批准 · 方案版本 03")).toBeVisible();
    });
    await attachConsole(consoleLines, "runtime-s05-authority-single-source");
    expect(errors).toEqual([]);
  });

  test("shared storage write failure during approval shows failure without 已批准 and keeps retry", async ({
    page,
  }) => {
    test.setTimeout(30000);
    const errors = watchErrors(page);
    const consoleLines = await watchConsole(page);
    await page.addInitScript(() => {
      const marker = window as typeof window & { __s05FailStorage?: boolean };
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (
        this: Storage,
        key: string,
        value: string,
      ) {
        if (marker.__s05FailStorage === true && key.startsWith("tango-donego:domain:v1:")) {
          throw new Error("quota exceeded");
        }
        return originalSetItem.call(this, key, value);
      };
    });
    await page.goto("/preview");
    const root = page.locator('[data-page="s05"]');
    await shotOnFailure(page, "runtime-s05-authority-storage-failure", async () => {
      await expect(root.getByRole("button", { name: "批准并准备草稿" })).toBeVisible();
      await page.evaluate(() => {
        (window as typeof window & { __s05FailStorage?: boolean }).__s05FailStorage = true;
      });
      await root.getByRole("button", { name: "批准并准备草稿" }).click();
      await expect(root.locator('[data-runtime-phase="failed"]')).toBeVisible({
        timeout: 10000,
      });
      await expect(page.getByText("已批准")).toHaveCount(0);
      await expect(root.locator('[data-runtime-handoff]')).toHaveCount(0);
      expect(page.url()).toMatch(/\/preview$/);
      const retry = root.locator('[data-runtime-retry]');
      await expect(retry).toBeVisible();
      await page.evaluate(() => {
        (window as typeof window & { __s05FailStorage?: boolean }).__s05FailStorage = false;
      });
      await retry.click();
      let snap: RuntimeSnapshot | null = null;
      await expect
        .poll(
          async () => {
            snap = await inspectRuntime(page);
            return snap.ready
              ? snap.operations.filter((o) => o.status === "verified").length
              : 0;
          },
          { timeout: 12000 },
        )
        .toBeGreaterThanOrEqual(1);
      const recovered = snap ?? (await inspectRuntime(page));
      expect(recovered.operations).toHaveLength(1);
      expect(recovered.approvals).toHaveLength(1);
      expect(recovered.drafts).toHaveLength(1);
      await expect(root.locator('[data-runtime-handoff]')).toHaveCount(1);
      await expect(root.locator('[data-approved-verified]')).toHaveCount(1);
      expect(page.url()).toMatch(/\/preview$/);
    });
    await attachConsole(consoleLines, "runtime-s05-authority-storage-failure");
    expect(errors).toEqual([]);
  });

  test("open workspace is an explicit click carrying matching draftId and operationId", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    const consoleLines = await watchConsole(page);
    await page.goto("/preview");
    const root = page.locator('[data-page="s05"]');
    await shotOnFailure(page, "runtime-s05-authority-open-workspace", async () => {
      const snap = await approveViaUi(page);
      const op = snap.operations.find((o) => o.status === "verified");
      expect(op).toBeDefined();
      const refs = validRefsFor(snap, op!.id, op!.resultRefs);
      expect(refs).toHaveLength(1);
      await expect(page).toHaveURL(/\/preview$/);
      const handoff = root.locator('[data-runtime-handoff]');
      await expect(handoff).toBeVisible();
      await expect(handoff).toHaveAttribute("data-operation-id", op!.id);
      await expect(handoff).toHaveAttribute("data-draft-id", refs[0]);
      await handoff.getByRole("button", { name: "打开工作台" }).click();
      await expect(page).toHaveURL(
        new RegExp(
          "/workspace\\?draftId=" + encodeURIComponent(refs[0]) + "&operationId=" + encodeURIComponent(op!.id),
        ),
      );
      await expect(page.locator('[data-page="s06"]')).toBeVisible();
    });
    await attachConsole(consoleLines, "runtime-s05-authority-open-workspace");
    expect(errors).toEqual([]);
  });

  test("reload restores the same verified operation and draft without duplicates", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    const consoleLines = await watchConsole(page);
    await page.goto("/preview");
    const root = page.locator('[data-page="s05"]');
    await shotOnFailure(page, "runtime-s05-authority-reload", async () => {
      const before = await approveViaUi(page);
      const op = before.operations.find((o) => o.status === "verified");
      expect(op).toBeDefined();
      const plan = before.plans.find((p) => p.kind === "A");
      expect(plan).toBeDefined();
      const approvalsBefore = before.approvals.filter((a) => a.planId === plan!.id).length;
      await expect(page).toHaveURL(/\/preview$/);
      await page.reload();
      await expect(root).toBeVisible();
      const handoff = root.locator('[data-runtime-handoff]');
      await expect(handoff).toBeVisible();
      await expect(handoff).toHaveAttribute("data-operation-id", op!.id);
      await expect(root.getByText("已批准 · 方案版本 03")).toBeVisible();
      expect(page.url()).toMatch(/\/preview$/);
      let after: RuntimeSnapshot | null = null;
      await expect
        .poll(
          async () => {
            after = await inspectRuntime(page);
            return after.ready ? after.operations.length : 0;
          },
          { timeout: 10000 },
        )
        .toBe(before.operations.length);
      const finalSnap = after ?? (await inspectRuntime(page));
      expect(finalSnap.operations.some((o) => o.id === op!.id)).toBe(true);
      expect(finalSnap.approvals.filter((a) => a.planId === plan!.id)).toHaveLength(approvalsBefore);
      expect(finalSnap.drafts.filter((d) => d.operationId === op!.id)).toHaveLength(1);
    });
    await attachConsole(consoleLines, "runtime-s05-authority-reload");
    expect(errors).toEqual([]);
  });
});
