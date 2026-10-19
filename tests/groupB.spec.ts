import { test, expect } from "@playwright/test";

test.beforeEach(() => {
  test.skip(test.info().project.name === "mobile", "desktop-shell design surface");
});

function watchErrors(page: import("@playwright/test").Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  return errors;
}

test.describe("s06 workspace", () => {
  test("s06 renders draft workspace copy", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/workspace");
    const root = page.locator('[data-page="s06"]');
    await expect(root).toBeVisible();
    const copy = [
      "让 AI 准备，让判断回到你。",
      "草稿不是完成，确认不是发送；每一步有自己的状态。",
      "自动保存于 17:21",
      "方案比较 · 工作草稿",
      "目标：为下一轮产品方向讨论，保留可核查的取舍依据。",
      "产品说明（示例）",
      "访谈节选（示例）",
      "两种路径，不同的负担",
      "用户首先需要做什么",
      "迁入事项，维护新的系统",
      "选择来源，提出一个意图",
      "首版需要验证什么",
      "替代既有工具的理由",
      "减少协调与监督负担",
      "仍然不能下结论的地方",
      "成本数据尚未核对。不能仅凭功能描述，推断任何路径的留存、盈利或长期效果。",
      "本文内容为设计演示，不是实际研究结果",
      "接下来，只需两个判断",
      "先确认产品切入点",
      "是否以“一个真实场景的协调减负”作为首版，而非替换全部任务工具？",
      "成本核对还没有完成",
      "缺少可靠成本材料。可以补充文件，或把它保留为待核对事项。",
      "预计人工检查 12—20 分钟",
      "确认后仍不会自动发送或提交",
    ];
    for (const line of copy) {
      await expect(root.getByText(line)).toBeVisible();
    }
    await expect(root.getByRole("button", { name: "同意这个取舍" })).toBeVisible();
    await expect(root.getByRole("button", { name: "我有不同判断" })).toBeVisible();
    await expect(root.getByRole("button", { name: "补充材料" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("s06 confirm flow respects draft state machine", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/workspace");
    const root = page.locator('[data-page="s06"]');
    const status = root.locator("[data-draft-status]");
    const confirm = root.getByRole("button", { name: "确认已检查的内容" });
    await expect(status).toContainText("待检查");
    await expect(confirm).toBeDisabled();
    await expect(root.getByText("先完成切入点判断，才能确认已检查的内容。")).toBeVisible();
    await root.getByRole("button", { name: "同意这个取舍" }).click();
    await expect(status).toContainText("部分确认");
    await root.getByRole("button", { name: "补充材料" }).click();
    await expect(root.getByText("成本估算草表（演示）")).toBeVisible();
    await expect(root.getByText("材料已登记，仍需人工核对。")).toBeVisible();
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(status).toContainText("已确认");
    await expect(root.getByText("确认后仍不会自动发送或提交")).toBeVisible();
    await expect(root.getByText(/待核对事项/)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("s06 disagree judgment also unlocks partial confirmation", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/workspace");
    const root = page.locator('[data-page="s06"]');
    await root.getByRole("button", { name: "我有不同判断" }).click();
    await expect(root.locator("[data-draft-status]")).toContainText("部分确认");
    await expect(root.getByText("已记录：你对切入点有不同判断。")).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("s07 session", () => {
  test("s07 renders checkpoint restore copy", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/session");
    const root = page.locator('[data-page="s07"]');
    await expect(root).toBeVisible();
    const copy = [
      "从刚才那个判断继续。",
      "恢复的不只是任务名字，而是你上次离开的工作现场。",
      "工作检查点 · 17:26",
      "你不必再讲一遍。",
      "上次确认的取舍、正在看的材料、还没有决定的问题，都在这里。",
      "先完成一个判断。",
      "不必一次重启整个项目。",
      "上次停在这里",
      "个人协调层 · 首版范围",
      "不要求迁移整套任务，只接一个真实来源。",
      "现在需要你决定",
      "草稿可以先准备，还是每次都询问?",
      "当前边界允许整理指定材料，但不允许对外发送。你可以调整准备阶段的主动程度。",
      "只在已选来源内，自动准备可撤回草稿",
      "这是一个候选规则，还没有生效。",
      "相关材料",
      "方案比较草稿",
      "上次的两项确认",
      "查看完整记录",
    ];
    for (const line of copy) {
      await expect(root.getByText(line)).toBeVisible();
    }
    await expect(root.getByText("已确认", { exact: true })).toBeVisible();
    await expect(root.getByRole("button", { name: "查看规则差异" })).toBeVisible();
    await expect(root.getByRole("button", { name: "先口述我的想法" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("s07 diff, dictation and defer paths work", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/session");
    const root = page.locator('[data-page="s07"]');
    await root.getByRole("button", { name: "查看规则差异" }).click();
    await expect(root.getByText("现在：每次准备前都需要你确认。")).toBeVisible();
    await expect(root.getByText("候选：只在已选来源内自动准备，随时可撤回。")).toBeVisible();
    await expect(root.getByText("边界不变：仍不允许对外发送。")).toBeVisible();
    await root.getByRole("button", { name: "先口述我的想法" }).click();
    const dictation = root.getByLabel("口述记录（演示）");
    await expect(dictation).toBeVisible();
    await dictation.fill("先做个人协调层，接入一个真实来源。");
    await root.getByRole("button", { name: "保存为附注" }).click();
    await expect(root.getByText("已保存为本次附注（演示，仅保留在本页）。")).toBeVisible();
    await root.getByRole("button", { name: "暂不处理" }).click();
    await expect(root.getByText("已保留。稍后回到这里也可以。")).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("s08 blank", () => {
  test("s08 renders protected blank time without pressure", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/stillness");
    const root = page.locator('[data-page="s08"]');
    await expect(root).toBeVisible();
    const copy = [
      "今晚 · 留给自己",
      "这段时间，不必证明什么。",
      "19:00 — 20:00",
      "按你的边界保留。不自动补入下一件事。",
      "你可以继续重要的事，也可以什么都不安排。",
      "更多可能性",
      "不会因为没有选择，而再次提醒你。",
      "已接入渠道内受保护",
    ];
    for (const line of copy) {
      await expect(root.getByText(line)).toBeVisible();
    }
    await expect(root.getByText(/倒计时|打卡|连续|完成次数|绩效/)).toHaveCount(0);
    await expect(root.getByRole("button", { name: "什么也不安排" })).toBeVisible();
    await expect(root.getByRole("button", { name: "继续上次的音乐" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("s08 choices stay quiet and honest", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/stillness");
    const root = page.locator('[data-page="s08"]');
    await root.getByRole("button", { name: "什么也不安排" }).click();
    await expect(root.getByText("好的，这段时间由你决定。")).toBeVisible();
    await expect(root.getByText("不会因为没有选择，而再次提醒你。")).toBeVisible();
    await root.getByRole("button", { name: "继续上次的音乐" }).click();
    await expect(root.getByText("音乐会在这里继续（演示环境不会真正播放）。")).toBeVisible();
    await root.getByRole("button", { name: "更多可能性" }).click();
    await expect(root.getByText("记下一个想法（只保存在本页演示中）")).toBeVisible();
    await expect(root.getByText("看看最近保存的一段话")).toBeVisible();
    await expect(root.getByText("继续什么都不做")).toBeVisible();
    await expect(root.getByText("这些只是可能性，不会替你安排。")).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("s09 attention", () => {
  test("s09 renders shared attention budget", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/attention");
    const root = page.locator('[data-page="s09"]');
    await expect(root).toBeVisible();
    const copy = [
      "少一些声音，重要的仍然可达。",
      "外部请求与 AI 建议，共用你设定的注意力预算。",
      "按后果与期限，不按发送者的“紧急”",
      "此刻需要你判断",
      "交付材料有更新，可能影响正在确认的报告",
      "有依据的期限：19:00 · 来源：你指定的工作材料",
      "不查看的可能后果：沿用旧材料中的成本说明。",
      "合并到下一次查看",
      "三个非紧急请求",
      "两条会议候选时间 · 一条材料补充",
      "18:30 合并呈现",
      "一份明日准备摘要",
      "AI 已默默准备，没有触发提醒",
      "留在协同工作台",
      "可选的周末活动建议",
      "与你最近的方向有关；没有真实期限",
      "不主动打断",
      "你决定主动性的尺度",
      "今天剩余的主动提醒预算",
      "你设定：每天最多 2 次非紧急提醒。",
      "真实责任风险单独呈现，不伪装成普通通知。",
      "预算不构成遗漏重要承诺的理由。",
      "AI 没有例外通道。",
      "付费推荐也不能购买更高的打扰权限。",
      "覆盖：已接入请求；不是全系统通知接管。",
    ];
    for (const line of copy) {
      await expect(root.getByText(line)).toBeVisible();
    }
    await expect(root.locator("[data-remaining]")).toHaveText("1");
    await expect(root.getByRole("button", { name: "查看差异" })).toBeVisible();
    await expect(root.getByRole("button", { name: "修改提醒规则" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("s09 budget arithmetic stays consistent", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/attention");
    const root = page.locator('[data-page="s09"]');
    await root.getByRole("button", { name: "查看差异" }).click();
    await expect(root.getByText("旧：沿用成本说明（未核对）")).toBeVisible();
    await expect(root.getByText("新：材料已更新，成本说明需要重新核对")).toBeVisible();
    await expect(root.getByText("查看差异不占用提醒预算。")).toBeVisible();
    await root.getByRole("button", { name: "修改提醒规则" }).click();
    await expect(root.getByText(/今日已用 1 次/)).toBeVisible();
    await root.getByRole("button", { name: "增加提醒上限" }).click();
    await expect(root.locator("[data-remaining]")).toHaveText("2");
    await expect(root.getByText("你设定：每天最多 3 次非紧急提醒。")).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("s10 boundaries", () => {
  test("s10 renders permission boundary copy", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/boundaries");
    const root = page.locator('[data-page="s10"]');
    await expect(root).toBeVisible();
    const copy = [
      "智能可以学习，边界由你决定。",
      "规则不是提示词。每次读取、写入与打扰，都受它约束。",
      "我的规则",
      "规则版本 08",
      "由你在 09.12 09:10 确认",
      "AI 可以提出修改建议，但不能自行让它生效。",
      "本人的规则优先",
      "只读工作日历、任务清单与手动选择的文件",
      "限定材料范围；不代表内容已核验或交付已完成",
      "只在已授权时段内；不得移动外部约定",
      "涉及他人的时间，必须按共同约定确认",
      "批准对象与内容；发送不视为可完全撤回",
      "当前未开放；不得从其他许可推导授权",
      "原始事项与未完成责任仍然可见。",
    ];
    for (const line of copy) {
      await expect(root.getByText(line)).toBeVisible();
    }
    const rows = [
      ["读取指定来源", "已授权"],
      ["准备可撤回的草稿", "可自动准备"],
      ["改写内部计划", "先预览"],
      ["移动外部会议", "每次确认"],
      ["发送消息或提交交付", "每次确认"],
      ["付款、购买与新增承诺", "未授权"],
    ];
    for (const [title, status] of rows) {
      const row = root.locator("[data-rule-row]", { hasText: title });
      await expect(row).toBeVisible();
      await expect(row).toContainText(status);
    }
    await expect(root.getByRole("button", { name: "立即暂停" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("s10 category panels and pause state work", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/boundaries");
    const root = page.locator('[data-page="s10"]');
    const nav = root.locator("[data-rule-nav]");
    await nav.getByRole("button", { name: "时间边界" }).click();
    await expect(root.getByText("今晚 19:00—20:00 已保护。")).toBeVisible();
    await expect(root.getByText("与静驻时刻共用同一边界。")).toBeVisible();
    await nav.getByRole("button", { name: "打扰规则" }).click();
    await expect(root.getByText("每天最多 2 次非紧急提醒。")).toBeVisible();
    await expect(root.getByText("与注意力队列共用同一份预算。")).toBeVisible();
    await nav.getByRole("button", { name: "暂停与退出" }).click();
    await expect(root.getByText("暂停随时可以恢复。")).toBeVisible();
    await nav.getByRole("button", { name: "行动权限" }).click();
    await root.getByRole("button", { name: "查看规则变更记录" }).click();
    await expect(root.getByText("08 · 09.12 09:10 · 由你确认：付款、购买与新增承诺保持未授权")).toBeVisible();
    await root.getByRole("button", { name: "立即暂停" }).click();
    await expect(root.getByText("自动化已暂停：不再读取来源、不再准备草稿。")).toBeVisible();
    await expect(root.getByRole("button", { name: "恢复自动化" })).toBeVisible();
    await root.getByRole("button", { name: "恢复自动化" }).click();
    await expect(root.getByRole("button", { name: "立即暂停" })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
