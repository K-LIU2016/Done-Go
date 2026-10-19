import { test, expect, type Page } from "@playwright/test";

test.beforeEach(() => {
  test.skip(test.info().project.name === "mobile", "desktop-shell design surface");
});

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

test.describe("[s01] 此刻 · 时间主权", () => {
  test("shows protected time, capacity gap, and navigates to plan", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/");
    const root = page.locator('[data-page="s01"]');
    await expect(root).toBeVisible();
    await expect(
      root.getByRole("heading", { name: "把今晚，留给自己。" }),
    ).toBeVisible();
    await expect(root.getByText("19:00 — 20:00")).toBeVisible();
    await expect(
      root.getByText("不自动填入工作。暂时没有用途，也成立。"),
    ).toBeVisible();
    await expect(
      root.getByText("当前计划超出容量 10 分钟"),
    ).toBeVisible();
    await expect(root.getByText("可用时间 / 分钟")).toBeVisible();
    await expect(root.getByText("130", { exact: true })).toBeVisible();
    await expect(
      root.getByText("预计减少 20 分钟，仍需你检查确认。"),
    ).toBeVisible();
    await expect(root.getByText("已确认会议")).toBeVisible();
    await expect(root.getByText("报告交付")).toBeVisible();
    await expect(root.getByText("行政事项")).toBeVisible();
    await expect(
      root.getByText(
        "覆盖范围：工作日历、任务清单、指定文件。其他生活安排仍需你确认。",
      ),
    ).toBeVisible();
    await expect(root.getByText(/倒计时|连续打卡|已完成/)).toHaveCount(0);
    await root.getByRole("button", { name: /看看可行的做法/ }).click();
    await expect(page).toHaveURL(/\/plan$/);
    await expect(page.locator('[data-page="s04"]')).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("[s02] 时间账本 · 责任与边界", () => {
  test("ledger stays internally consistent and protects blank time", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/ledger");
    const root = page.locator('[data-page="s02"]');
    await expect(root).toBeVisible();
    await expect(
      root.getByRole("heading", { name: "时间有去向，也有边界。" }),
    ).toBeVisible();
    await expect(root.getByText("19:00 前可用")).toBeVisible();
    await expect(root.getByText("120 分钟").first()).toBeVisible();
    await expect(root.getByText("当前预计投入").first()).toBeVisible();
    await expect(root.getByText("130 分钟").first()).toBeVisible();
    await expect(root.getByText("容量缺口")).toBeVisible();
    await expect(root.getByText("10 分钟").first()).toBeVisible();
    await expect(root.getByText("30 分钟 · 固定约定")).toBeVisible();
    await expect(root.getByText("预计投入 60 分钟")).toBeVisible();
    await expect(root.getByText("40 分钟 · 暂定计划")).toBeVisible();
    await expect(root.getByText("受保护的静驻")).toBeVisible();
    await expect(
      root.getByText("没有用途，也不接受自动填充。"),
    ).toBeVisible();
    await expect(root.getByText("超出边界 10 分钟")).toBeVisible();
    await expect(root.getByText("工作日历")).toBeVisible();
    await expect(root.getByText("任务清单")).toBeVisible();
    await expect(root.getByText("未覆盖")).toBeVisible();
    await expect(root.getByText("移动，不等于节省。")).toBeVisible();
    await expect(root.getByText(/倒计时|连续打卡|已完成/)).toHaveCount(0);
    await root.getByRole("button", { name: /查看可行方案/ }).click();
    await expect(page).toHaveURL(/\/plan$/);
    expect(errors).toEqual([]);
  });

  test("week view is an honest empty state with sources", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/ledger");
    const root = page.locator('[data-page="s02"]');
    await root.getByRole("button", { name: "本周" }).click();
    await expect(root.getByText("本周还没有可核验的汇总。")).toBeVisible();
    await expect(root.getByText("数据来源：工作日历、任务清单。")).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("[s03] 收件箱 · 请求不等于承诺", () => {
  test("a request stays a request until you accept it", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/inbox");
    const root = page.locator('[data-page="s03"]');
    await expect(root).toBeVisible();
    await expect(
      root.getByRole("heading", { name: "先理解，再成为责任。" }),
    ).toBeVisible();
    await expect(root.getByText("竞品分析 · 会议提及")).toBeVisible();
    await expect(root.getByText("下周碰一次方案")).toBeVisible();
    await expect(root.getByText("找个晚上练琴")).toBeVisible();
    await expect(
      root.getByText("“下周可以看看三种方案的差异。”"),
    ).toBeVisible();
    await expect(root.getByText("陈同事（演示人物）")).toBeVisible();
    await expect(root.getByText("尚未确认").first()).toBeVisible();
    await expect(root.getByText("尚未约定")).toBeVisible();
    await expect(root.getByText("请求 · 未确认")).toBeVisible();
    await expect(
      root.getByText("只有你的确认，才会把它变成你的责任。"),
    ).toBeVisible();
    await root.getByRole("button", { name: "下周碰一次方案" }).click();
    await expect(
      root.getByRole("heading", { name: "下周碰一次方案" }),
    ).toBeVisible();
    await root.getByRole("button", { name: /保留为想法/ }).click();
    await expect(root.getByText("已保留为想法")).toBeVisible();
    await expect(root.getByText("未成为责任")).toBeVisible();
    await root.getByRole("button", { name: "找个晚上练琴" }).click();
    await root.getByRole("button", { name: /我接受这件事/ }).click();
    await expect(root.getByText("已接受 · 本地责任")).toBeVisible();
    await expect(root.getByText("未对外发送")).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("[s04] 自适应方案 · 改变方法与分工", () => {
  test("plan A selection navigates to preview", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/plan");
    const root = page.locator('[data-page="s04"]');
    await expect(root).toBeVisible();
    await expect(
      root.getByRole("heading", { name: "换一种做法，不挤掉自己。" }),
    ).toBeVisible();
    await expect(
      root.getByText("19:00 前可用 120 分钟；当前预计投入 130 分钟。"),
    ).toBeVisible();
    await expect(root.getByText("会议不动")).toBeVisible();
    await expect(root.getByText("交付标准不变")).toBeVisible();
    await expect(root.getByText("方案未执行")).toBeVisible();
    await expect(
      root.getByRole("heading", { name: "先准备，再由你判断。" }),
    ).toBeVisible();
    await expect(root.getByText("预计减少人工投入")).toBeVisible();
    await expect(root.getByText("20 分钟").first()).toBeVisible();
    await expect(root.getByText("110 / 120 分钟")).toBeVisible();
    await expect(
      root.getByRole("heading", { name: "今天放下，明天仍在。" }),
    ).toBeVisible();
    await expect(root.getByText("没有发生")).toBeVisible();
    await expect(root.getByText("90 / 120 分钟")).toBeVisible();
    await expect(root.getByText("明天新增负担")).toBeVisible();
    await expect(root.getByText("估计不是事实。执行期间会更新人工投入，必要时重新检查可行性。")).toBeVisible();
    await root.getByRole("button", { name: /选择这条路径/ }).click();
    await expect(page).toHaveURL(/\/preview$/);
    await expect(page.locator('[data-page="s05"]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("plan B delay preview does not claim savings", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/plan");
    const root = page.locator('[data-page="s04"]');
    await expect(root.getByText("不会算作节省时间")).toBeVisible();
    await root.getByRole("button", { name: /预览延期的影响/ }).click();
    await expect(page).toHaveURL(/\/preview$/);
    const preview = page.locator('[data-page="s05"]');
    await expect(preview).toBeVisible();
    await expect(preview.getByText("明天 · 待重新安排")).toBeVisible();
    await expect(preview.getByText("未来仍欠 40 分钟")).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("[s05] 变更预览 · 有限授权", () => {
  test("approval is scoped to this task and nothing executes", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await page.goto("/preview");
    const root = page.locator('[data-page="s05"]');
    await expect(root).toBeVisible();
    await expect(
      root.getByRole("heading", { name: "授权这一次，不是以后每一次。" }),
    ).toBeVisible();
    await expect(root.getByText("待批准 · 方案版本 03")).toBeVisible();
    await expect(
      root.getByRole("heading", { name: "准备报告草稿" }),
    ).toBeVisible();
    await expect(root.getByText("报告工作草稿")).toBeVisible();
    await expect(root.getByText("尚未创建")).toBeVisible();
    await expect(root.getByText("生成 · 待检查")).toBeVisible();
    await expect(root.getByText("暂估 40 分钟")).toBeVisible();
    await expect(root.getByText("仍然没有变更")).toBeVisible();
    await expect(root.getByText("本次均不包含")).toBeVisible();
    await expect(root.getByText("外部约会")).toBeVisible();
    await expect(root.getByText("邮件发送")).toBeVisible();
    await expect(root.getByText("付款与购买")).toBeVisible();
    await expect(root.getByText("不包含发送、提交或移动会议。")).toBeVisible();
    await expect(root.getByText("读取指定材料")).toBeVisible();
    await expect(root.getByText("创建一份本地草稿")).toBeVisible();
    await expect(root.getByText("更新内部投入估计")).toBeVisible();
    await expect(root.getByText("有效范围：本次准备任务")).toBeVisible();
    await expect(root.getByText("任何参数改变，都重新检查")).toBeVisible();
    await root.getByRole("button", { name: /批准并准备草稿/ }).click();
    await expect(root.getByText("已批准 · 本次准备任务")).toBeVisible();
    const draftBox = root.getByRole("textbox", { name: "草稿正文" });
    await expect(draftBox).toBeVisible();
    await expect(root.getByText("本地草稿 · 待检查")).toBeVisible();
    await expect(root.getByText(/来源：产品说明（示例）/)).toBeVisible();
    await expect(root.getByText(/访谈节选（示例）/)).toBeVisible();
    await expect(root.getByText("尚未执行")).toHaveCount(0);
    await root.getByRole("button", { name: "返回修改方案" }).click();
    await expect(page).toHaveURL(/\/plan$/);
    expect(errors).toEqual([]);
  });
});
