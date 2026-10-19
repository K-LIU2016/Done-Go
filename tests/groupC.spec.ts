import { test, expect, type Page } from "@playwright/test";

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

test.describe("[s11] 私人上下文 · 来源与推测", () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name === "mobile", "desktop-shell design surface");
  });

  test("renders intent, inference, and sources with honest boundaries", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/context");
    const root = page.locator('[data-page="s11"]');
    await expect(root).toBeVisible();
    await expect(
      root.getByRole("heading", { name: "了解你，不等于占有你。" }),
    ).toBeVisible();
    await expect(
      root.getByText("事实、意图与系统推测分开保存。你可以修正，也可以带走。"),
    ).toBeVisible();
    await expect(
      root.getByRole("tab", { name: "我的意图" }),
    ).toBeVisible();
    await expect(
      root.getByRole("tab", { name: "事实与来源" }),
    ).toBeVisible();
    await expect(
      root.getByRole("tab", { name: "系统推测" }),
    ).toBeVisible();
    await expect(
      root.getByText("最近想留给自己的时间"),
    ).toBeVisible();
    await expect(
      root.getByText("由你明确表达 · 可修改、暂停或删除"),
    ).toBeVisible();
    await expect(
      root.getByText("工作日晚上，保留一段不被工作填满的时间。"),
    ).toBeVisible();
    await expect(
      root.getByText("最近想重新做音乐，但不要变成新的考核。"),
    ).toBeVisible();
    await expect(root.getByText("来源：本人确认 · 09.11 20:10")).toBeVisible();
    await expect(root.getByText("01 一个尚未确认的推测")).toBeVisible();
    await expect(
      root.getByText("你可能更愿意从修改草稿开始。"),
    ).toBeVisible();
    await expect(
      root.getByText(
        "依据：最近两次写作中的选择。样本很少，不代表稳定偏好，更不代表人格判断。",
      ),
    ).toBeVisible();
    await expect(
      root.getByText("系统推测 · 7 天后重新检查"),
    ).toBeVisible();
    await expect(
      root.getByRole("button", { name: "这对我大致成立" }),
    ).toBeVisible();
    await expect(
      root.getByRole("button", { name: "并不准确" }),
    ).toBeVisible();
    await expect(
      root.getByRole("button", { name: "删除这条推测" }),
    ).toBeVisible();
    await expect(root.getByText("02 已选择的来源")).toBeVisible();
    await expect(root.getByText("只读 · 17:00 已同步")).toBeVisible();
    await expect(root.getByText("读取与内部规划 · 17:00 已同步")).toBeVisible();
    await expect(root.getByText("仅本次任务可用")).toBeVisible();
    await expect(
      root.getByText("未接入 · 不能推断没有安排"),
    ).toBeVisible();
    await expect(root.getByText("随时收回未来的访问。")).toBeVisible();
    await expect(
      root.getByText(
        "撤销权限会停止后续读取；已经传出的副本不能被假定全部收回。",
      ),
    ).toBeVisible();
    await expect(
      root.getByRole("button", { name: "管理来源权限" }),
    ).toBeVisible();
    await expect(
      root.getByRole("button", { name: "导出我的记录" }),
    ).toBeVisible();
    await expect(
      root.getByText("不把点击、接受率或使用时长当作你的生活目标。"),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("tabs switch panels and rejected inference is marked", async ({
    page,
  }) => {
    await page.goto("/context");
    const root = page.locator('[data-page="s11"]');
    await root.getByRole("tab", { name: "事实与来源" }).click();
    await expect(root.getByText("已接入的来源与范围")).toBeVisible();
    await root.getByRole("tab", { name: "系统推测" }).click();
    await expect(root.getByText("你可能更愿意从修改草稿开始。")).toBeVisible();
    await root.getByRole("button", { name: "并不准确" }).click();
    await expect(
      root.getByText("已标记为不准确。这条推测不会再被默默套用。"),
    ).toBeVisible();
    await root.getByRole("tab", { name: "我的意图" }).click();
    await expect(
      root.getByText("工作日晚上，保留一段不被工作填满的时间。"),
    ).toBeVisible();
  });
});

test.describe("[s12] 时间回顾 · 收益不做假账", () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name === "mobile", "desktop-shell design surface");
  });

  test("renders separated ledgers and no fabricated savings", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/review");
    const root = page.locator('[data-page="s12"]');
    await expect(root).toBeVisible();
    await expect(
      root.getByRole("heading", { name: "记下保留的生活，不夸大节省。" }),
    ).toBeVisible();
    await expect(
      root.getByText("本周回顾 · 9 月 7 日—11 日 · 以下均为合成演示数据。"),
    ).toBeVisible();
    await expect(root.getByText("由你回顾确认")).toBeVisible();
    await expect(
      root.getByText("段想保留的时间，得到了保留。"),
    ).toBeVisible();
    await expect(
      root.getByText("希望保留 300 分钟 · 实际保留 240 分钟"),
    ).toBeVisible();
    await expect(
      root.getByRole("img", { name: "周三 保留 0 分钟" }),
    ).toBeVisible();
    await expect(
      root.getByText("周三没有保住，不必把它藏起来。"),
    ).toBeVisible();
    await expect(
      root.getByText("这不是连胜记录，也不是对生活的评分。"),
    ).toBeVisible();
    await expect(root.getByText("01 三种时间，分别记账")).toBeVisible();
    await expect(
      root.getByText("是观察结果，不等于产品净节省。"),
    ).toBeVisible();
    await expect(
      root.getByText("责任仍在，不能冒充已完成。"),
    ).toBeVisible();
    await expect(
      root.getByText("作为成本记录，而不是忽略。"),
    ).toBeVisible();
    await expect(root.getByText("02 真正的净节省，尚未测量")).toBeVisible();
    await expect(
      root.getByText(
        "需要比较没有静驻时的同类任务，并把监督、纠错与未来负担计入。当前不显示一个看似精确的“省时总数”。",
      ),
    ).toBeVisible();
    await expect(
      root.getByText("这一周，你对自己的时间是否更有掌控?"),
    ).toBeVisible();
    await expect(
      root.getByRole("button", { name: "更有掌控" }),
    ).toBeVisible();
    await expect(
      root.getByRole("button", { name: "差不多" }),
    ).toBeVisible();
    await expect(
      root.getByRole("button", { name: "反而更难" }),
    ).toBeVisible();
    await expect(
      root.getByRole("button", { name: "跳过" }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("feedback answer is recorded once", async ({ page }) => {
    await page.goto("/review");
    const root = page.locator('[data-page="s12"]');
    await root.getByRole("button", { name: "反而更难" }).click();
    await expect(root.getByText("已记录你的感受，谢谢。")).toBeVisible();
    await expect(
      root.getByRole("button", { name: "更有掌控" }),
    ).toBeDisabled();
  });
});

test.describe("[s13] 同步异常 · 未知与接管", () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name === "mobile", "desktop-shell design surface");
  });

  test("keeps unknowns explicit instead of claiming full protection", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/sync");
    const root = page.locator('[data-page="s13"]');
    await expect(root).toBeVisible();
    await expect(
      root.getByRole("heading", { name: "不知道的时候，就说不知道。" }),
    ).toBeVisible();
    await expect(
      root.getByText("数据未同步不等于没有安排。外部保护未核验，就保持待确认。"),
    ).toBeVisible();
    await expect(root.getByText("部分来源未同步")).toBeVisible();
    await expect(
      root.getByRole("heading", { name: "今晚的保护，尚未完整核验。" }),
    ).toBeVisible();
    await expect(
      root.getByText(
        "静驻中的规则仍然保留。但因为个人日历暂时无法更新，不能确认外部预约是否看见这段不可用时间。",
      ),
    ).toBeVisible();
    await expect(root.getByText("本地规则仍然有效")).toBeVisible();
    await expect(
      root.getByText("19:00—20:00 不接受静驻内部的自动填充。"),
    ).toBeVisible();
    await expect(root.getByText("外部日历保护待确认")).toBeVisible();
    await expect(
      root.getByText("尚未核验闲忙投影与最新冲突。不会显示“已全面保护”。"),
    ).toBeVisible();
    await expect(root.getByText("工作日历")).toBeVisible();
    await expect(root.getByText("17:02 已同步")).toBeVisible();
    await expect(root.getByText("任务清单")).toBeVisible();
    await expect(root.getByText("17:00 已同步")).toBeVisible();
    await expect(root.getByText("个人日历", { exact: true })).toBeVisible();
    await expect(root.getByText("16:41 后未同步")).toBeVisible();
    await expect(root.getByText("家庭日历")).toBeVisible();
    await expect(root.getByText("尚未连接")).toBeVisible();
    await expect(
      root.getByText("可以继续，不必假装完整。"),
    ).toBeVisible();
    await expect(
      root.getByText(
        "暂时使用本地计划时，不会把未知时段分配给新的自动任务；你仍可以在原工具中接管。",
      ),
    ).toBeVisible();
    await expect(
      root.getByRole("button", { name: "重新同步与核验" }),
    ).toBeVisible();
    await expect(
      root.getByRole("button", { name: "打开原日历" }),
    ).toBeVisible();
    await expect(
      root.getByRole("button", { name: "暂用本地计划" }),
    ).toBeVisible();
    await expect(
      root.getByText("失败记录会保留；重试不会重复创建同一保护事件。"),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("retry shows current action and honest result, takeover works", async ({
    page,
  }) => {
    await page.goto("/sync");
    const root = page.locator('[data-page="s13"]');
    await root.getByRole("button", { name: "重新同步与核验" }).click();
    await expect(
      root.getByText("正在重新同步个人日历并核对冲突。"),
    ).toBeVisible();
    await expect(
      root.getByText("最新尝试仍未更新个人日历。保护状态保持待确认。"),
    ).toBeVisible({ timeout: 5000 });
    await root.getByRole("button", { name: "暂用本地计划" }).click();
    await expect(
      root.getByText("已暂用本地计划。未知时段不会分配给新的自动任务。"),
    ).toBeVisible();
  });
});

test.describe("[s14] 快捷输入 · 意图与约束", () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name === "mobile", "desktop-shell design surface");
  });

  test("parses one sentence into intent plus constraint, no hidden grants", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/capture");
    const root = page.locator('[data-page="s14"]');
    await expect(root).toBeVisible();
    await expect(
      root.getByRole("heading", { name: "一句话，保留你的原意。" }),
    ).toBeVisible();
    await expect(
      root.getByText("轻量输入不意味着草率执行。先理解，再检查可行性。"),
    ).toBeVisible();
    await expect(root.getByText("快捷入口")).toBeVisible();
    await expect(root.getByText("ESC 关闭")).toBeVisible();
    const input = root.getByRole("textbox", { name: "用一句话记录" });
    await expect(input).toHaveValue(
      "明晚七点到八点留给自己，客户会议别动。",
    );
    await expect(root.getByText("系统理解为")).toBeVisible();
    await expect(root.getByText("个人时间意图")).toBeVisible();
    await expect(
      root.getByText("9 月 13 日 · 19:00—20:00"),
    ).toBeVisible();
    await expect(
      root.getByText("当前时区 UTC+8 · 可修改 · 尚未创建日历事件"),
    ).toBeVisible();
    await expect(root.getByText("不可擅自改变")).toBeVisible();
    await expect(root.getByText("现有客户会议")).toBeVisible();
    await expect(
      root.getByText("没有自动授予改会或发消息权限。"),
    ).toBeVisible();
    await expect(
      root.getByText("下一步只检查冲突。需要改变安排时，再向你展示具体差异。"),
    ).toBeVisible();
    await expect(
      root.getByRole("button", { name: "检查这段时间" }),
    ).toBeVisible();
    await expect(
      root.getByRole("button", { name: "只保存为意图" }),
    ).toBeVisible();
    await expect(root.getByText("⌘ Enter")).toBeVisible();
    await expect(
      root.getByText("快速记录 / 自然语言 / 语音 / 分享到静驻 · 同一套语义与授权边界"),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("save-as-intent stays truthful and escape closes entry", async ({
    page,
  }) => {
    await page.goto("/capture");
    const root = page.locator('[data-page="s14"]');
    await root.getByRole("button", { name: "只保存为意图" }).click();
    await expect(
      root.getByText("已保存为意图。尚未创建日历事件，也不会通知任何人。"),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      root.getByText("快捷入口已关闭。可从菜单或分享重新进入。"),
    ).toBeVisible();
    await root.getByRole("button", { name: "重新打开快捷入口" }).click();
    await expect(
      root.getByRole("button", { name: "只保存为意图" }),
    ).toBeVisible();
  });
});

test.describe("[s15] 移动端 · 此刻", () => {
  test("shows one protected hour and one decision", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/m/now");
    const root = page.locator('[data-page="s15"]');
    await expect(root).toBeVisible();
    await expect(root.getByText("17:00")).toBeVisible();
    await expect(root.getByText("9 月 12 日 · 星期六")).toBeVisible();
    await expect(
      root.getByRole("heading", { name: "把今晚，留给自己。" }),
    ).toBeVisible();
    await expect(root.getByText("你的时间意图")).toBeVisible();
    await expect(root.getByText("19:00—20:00")).toBeVisible();
    await expect(root.getByText("不自动填满。没有用途，也成立。")).toBeVisible();
    await expect(
      root.getByText("当前计划超出容量 10 分钟"),
    ).toBeVisible();
    await expect(
      root.getByRole("heading", { name: "现在，只需一个决定。" }),
    ).toBeVisible();
    await expect(
      root.getByText("换一种做法，保住这一小时。"),
    ).toBeVisible();
    await expect(
      root.getByText(
        "AI 先准备报告，你从检查开始。预计减少投入，不悄悄降低交付标准。",
      ),
    ).toBeVisible();
    await expect(
      root.getByRole("button", { name: "查看两条路径" }),
    ).toBeVisible();
    await expect(
      root.getByText("会议不动 · 期限不变 · 没有执行任何变更"),
    ).toBeVisible();
    await expect(root.getByText("界面演示 · 非真实账户数据")).toBeVisible();
    const nav = root.getByRole("navigation", { name: "移动端导航" });
    await expect(nav.getByRole("link", { name: "此刻" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "时间" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "协同" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "我的" })).toBeVisible();
    await root.getByRole("button", { name: "查看两条路径" }).click();
    await expect(page).toHaveURL(/\/m\/plan$/);
    expect(errors).toEqual([]);
  });
});

test.describe("[s16] 移动端 · 自适应方案", () => {
  test("plan A shows estimate honestly, plan B never counts as savings", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/m/plan");
    const root = page.locator('[data-page="s16"]');
    await expect(root).toBeVisible();
    await expect(
      root.getByRole("heading", { name: "不挤掉自己，换一种做法。" }),
    ).toBeVisible();
    await expect(
      root.getByText("120 分钟可用 / 130 分钟预计投入"),
    ).toBeVisible();
    await expect(root.getByText("方案 A · 先准备，再判断")).toBeVisible();
    await expect(root.getByText("60 → 40 分钟")).toBeVisible();
    await expect(
      root.getByText("报告的预计人工投入，包含你检查和修改草稿的时间。"),
    ).toBeVisible();
    await expect(root.getByText("预计减少")).toBeVisible();
    await expect(root.getByText("20 分钟").first()).toBeVisible();
    await expect(root.getByText("外部承诺")).toBeVisible();
    await expect(root.getByText("不变")).toBeVisible();
    await expect(
      root.getByText("下一步仅准备草稿，仍需你检查。"),
    ).toBeVisible();
    const planB = root.getByRole("button", { name: /方案 B · 行政事项移到明天/ });
    await expect(planB).toBeVisible();
    await expect(
      root.getByText("延期 40 分钟，不算净节省。"),
    ).toBeVisible();
    await planB.click();
    await expect(
      root.getByText("未来仍欠 40 分钟，不能显示为节省。"),
    ).toBeVisible();
    await expect(
      root.getByRole("button", { name: "预览方案 A 的授权" }),
    ).toBeVisible();
    await expect(root.getByText("界面演示 · 非真实账户数据")).toBeVisible();
    await root.getByRole("button", { name: "预览方案 A 的授权" }).click();
    await expect(page).toHaveURL(/\/m\/auth$/);
    expect(errors).toEqual([]);
  });
});

test.describe("[s17] 移动端 · 一次性授权", () => {
  const s17ConsoleLogs = new WeakMap<Page, string[]>();

  function watchS17Errors(page: Page): string[] {
    const existing = s17ConsoleLogs.get(page);
    if (existing) {
      return existing;
    }
    const errors: string[] = [];
    s17ConsoleLogs.set(page, errors);
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    return errors;
  }

  function safeS17EvidenceName(value: string): string {
    return value.replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, "-").slice(0, 80);
  }

  test.afterEach(async ({ page }, testInfo) => {
    const errors = s17ConsoleLogs.get(page);
    if (!errors) {
      return;
    }
    await testInfo.attach(
      "gate-functional-console-groupC-" +
        testInfo.project.name +
        "-" +
        safeS17EvidenceName(testInfo.title) +
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

  test("allowed scope and exclusions stay on the same screen", async ({
    page,
  }) => {
    const errors = watchS17Errors(page);
    await page.goto("/m/auth");
    const root = page.locator('[data-page="s17"]');
    await expect(root).toBeVisible();
    await expect(
      root.getByRole("heading", { name: "只授权这一次。" }),
    ).toBeVisible();
    await expect(root.getByText("方案版本 03 · 尚未执行")).toBeVisible();
    await expect(root.getByText("允许的范围")).toBeVisible();
    await expect(
      root.getByRole("checkbox", { name: "读取两份指定材料" }),
    ).toBeChecked();
    await expect(
      root.getByText("不扩展到全部文件与邮件"),
    ).toBeVisible();
    await expect(
      root.getByRole("checkbox", { name: "创建待检查的草稿" }),
    ).toBeChecked();
    await expect(
      root.getByText("不代表已完成或已发送"),
    ).toBeVisible();
    await expect(
      root.getByRole("checkbox", { name: "更新内部投入估计" }),
    ).toBeChecked();
    await expect(root.getByText("暂估 40 分钟，允许修正")).toBeVisible();
    await expect(
      root.getByText("不包含：移动会议、发消息、付款或新增承诺。"),
    ).toBeVisible();
    await expect(
      root.getByRole("button", { name: "批准并准备草稿" }),
    ).toBeVisible();
    await expect(
      root.getByRole("link", { name: "返回修改方案" }),
    ).toBeVisible();
    await root.getByRole("link", { name: "返回修改方案" }).click();
    await expect(page).toHaveURL(/\/m\/plan$/);
    expect(errors).toEqual([]);
  });

  test("approve is one-time and the used receipt blocks re-execution", async ({
    page,
  }) => {
    const errors = watchS17Errors(page);
    await page.goto("/m/auth");
    const root = page.locator('[data-page="s17"]');
    const approve = root.getByRole("button", { name: "批准并准备草稿" });
    await approve.click();
    await expect(
      root.getByText("本次授权已使用。草稿待检查，不会自动发送。"),
    ).toBeVisible();
    await expect(approve).toBeDisabled();
    expect(errors).toEqual([]);
  });

  test("empty grant set keeps the action disabled with a reason", async ({
    page,
  }) => {
    const errors = watchS17Errors(page);
    await page.goto("/m/auth");
    const fresh = page.locator('[data-page="s17"]');
    const checkboxes = fresh.getByRole("checkbox");
    const count = await checkboxes.count();
    for (let i = 0; i < count; i += 1) {
      await checkboxes.nth(i).setChecked(false);
    }
    const disabled = fresh.getByRole("button", { name: "批准并准备草稿" });
    await expect(disabled).toBeDisabled();
    await expect(
      fresh.getByText("至少允许一项动作，或返回修改方案。"),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("[s18] 移动端 · 静驻时刻", () => {
  test("quiet blank time with clear exit and no pressure", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/m/stillness");
    const root = page.locator('[data-page="s18"]');
    await expect(root).toBeVisible();
    await expect(root.getByText("19:00", { exact: true })).toBeVisible();
    await expect(root.getByText("静驻", { exact: true })).toBeVisible();
    await expect(
      root.getByRole("button", { name: "退出静驻时刻" }),
    ).toBeVisible();
    await expect(root.getByText("A SPACE OF YOUR OWN")).toBeVisible();
    await expect(
      root.getByRole("heading", { name: "这段时间，不必证明什么。" }),
    ).toBeVisible();
    await expect(root.getByText("19:00—20:00")).toBeVisible();
    await expect(
      root.getByText("不自动填入工作，也不催促你选择。"),
    ).toBeVisible();
    await expect(
      root.getByRole("button", { name: "什么也不安排" }),
    ).toBeVisible();
    await expect(
      root.getByText("只保护已接入渠道 · 设计演示"),
    ).toBeVisible();
    await expect(root.getByText(/倒计时|打卡|已完成|连续/)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("choosing nothing is honored and exit returns to now", async ({
    page,
  }) => {
    await page.goto("/m/stillness");
    const root = page.locator('[data-page="s18"]');
    await root.getByRole("button", { name: "什么也不安排" }).click();
    await expect(
      root.getByText("已保留。不会再提醒你做选择。"),
    ).toBeVisible();
    await expect(
      root.getByRole("button", { name: "什么也不安排" }),
    ).toBeDisabled();
    await root.getByRole("button", { name: "退出静驻时刻" }).click();
    await expect(page).toHaveURL(/\/m\/now$/);
  });
});
