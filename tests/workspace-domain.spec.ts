/// <reference types="node" />
import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page, type Locator } from "@playwright/test";

const EVIDENCE_DIR = path.join(process.cwd(), ".omo", "evidence");
const STORAGE_KEY_PREFIX = "tango-donego:domain:v1:";

interface PageWatch {
  errors: string[];
  flush(): void;
  shot(page: Page, name: string): Promise<void>;
}

function watchPage(page: Page, slug: string): PageWatch {
  const errors: string[] = [];
  const consoleLines: string[] = [];
  page.on("pageerror", (e) => {
    errors.push("pageerror: " + String(e));
    consoleLines.push("pageerror: " + String(e));
  });
  page.on("console", (m) => {
    consoleLines.push("[" + m.type() + "] " + m.text());
    if (m.type() === "error") errors.push(m.text());
  });
  return {
    errors,
    flush() {
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(EVIDENCE_DIR, "workspace-domain-closure-console-" + slug + ".txt"),
        consoleLines.join("\n") || "(no console output)",
      );
    },
    async shot(p: Page, name: string) {
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
      await p.screenshot({ path: path.join(EVIDENCE_DIR, "workspace-domain-closure-" + name + ".png"), fullPage: true });
    },
  };
}

async function withFailureEvidence(
  watch: PageWatch,
  page: Page,
  slug: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (err) {
    await watch.shot(page, slug + "-red").catch(() => undefined);
    watch.flush();
    throw err;
  }
}

interface SeededSection {
  id: string;
  title: string;
  content: string;
  contentVersion: number;
  reviewStatus: string;
}

interface SeededDraft {
  draftId: string;
  operationId: string;
  sections: SeededSection[];
}

// Evidence contract: the draft MUST come from real domain commands executed in
// the browser (selectPlan -> grantApproval -> startOperation). Direct state
// writes or fake postconditions would invalidate this spec as evidence.
async function seedRealDraft(page: Page): Promise<SeededDraft> {
  return page.evaluate(async () => {
    const importModule = new Function("u", "return import(u)") as (u: string) => Promise<unknown>;
    const data = (await importModule("/src/data/index.ts")) as {
      createPersistedDomainStore: (o: { dataMode: string }) => Promise<{
        status: string;
        store: {
          execute: (c: Record<string, unknown>) => Promise<{
            ok: boolean;
            code?: string;
            reason?: string;
            data?: Record<string, unknown>;
          }>;
          getState: () => {
            drafts: Record<
              string,
              {
                id: string;
                operationId: string;
                sections: Array<{
                  id: string;
                  title: string;
                  content: string;
                  contentVersion: number;
                  reviewStatus: string;
                }>;
              }
            >;
          };
        };
      }>;
    };
    const handle = await data.createPersistedDomainStore({ dataMode: "fixture" });
    if (handle.status !== "ready") throw new Error("domain runtime not ready: " + handle.status);
    const user = () => ({ commandId: crypto.randomUUID(), actor: "user", issuedAt: new Date().toISOString() });
    const run = async (command: Record<string, unknown>) => {
      const res = await handle.store.execute(command);
      if (!res.ok) throw new Error("command failed: " + JSON.stringify(res));
      return res;
    };
    const plan = await run({ type: "selectPlan", kind: "A", entityId: null, expectedRevision: null, ...user() });
    const changeSetId = (plan.data as { changeSet: { id: string } }).changeSet.id;
    const approval = await run({
      type: "grantApproval",
      changeSetId,
      grants: ["readMaterial", "createLocalDraft", "updateEstimate"],
      entityId: null,
      expectedRevision: null,
      ...user(),
    });
    const approvalId = (approval.data as { approval: { id: string } }).approval.id;
    const op = await run({ type: "startOperation", approvalId, entityId: null, expectedRevision: null, ...user() });
    const operationId = (op.data as { operation: { id: string } }).operation.id;
    const draft = Object.values(handle.store.getState().drafts).find((d) => d.operationId === operationId);
    if (!draft || draft.sections.length === 0) throw new Error("operation produced no draft with sections");
    return {
      draftId: draft.id,
      operationId,
      sections: draft.sections.map((s) => ({
        id: s.id,
        title: s.title,
        content: s.content,
        contentVersion: s.contentVersion,
        reviewStatus: s.reviewStatus,
      })),
    };
  });
}

async function gotoDraft(page: Page, draft: { draftId: string; operationId: string }): Promise<void> {
  await page.goto("/workspace?draftId=" + draft.draftId + "&operationId=" + draft.operationId);
}

async function workspaceRoot(page: Page): Promise<Locator> {
  return page.locator('[data-page="s06"]');
}

test.describe("[s06] 工作台 draftId+operationId 选择与归属", () => {
  test("query pair selects exactly the owned draft and refresh shows the same content", async ({ page }) => {
    const watch = watchPage(page, "selection");
    await page.goto("/workspace");
    const draftA = await seedRealDraft(page);
    const draftB = await seedRealDraft(page);

    await gotoDraft(page, draftA);
    const root = await workspaceRoot(page);
    await expect(root.locator('[data-runtime-state="ready"]')).toBeVisible();
    const cardA = root.locator('[data-section-id="' + draftA.sections[0].id + '"]');
    await expect(cardA).toContainText(draftA.sections[0].title);
    await expect(cardA).toContainText(draftA.sections[0].content);
    await expect(root.locator('[data-section-id="' + draftB.sections[0].id + '"]')).toHaveCount(0);
    await expect(root.locator('[data-draft-status="pendingReview"]')).toBeVisible();
    await expect(root.locator('[data-sent-state="not-sent"]')).toBeVisible();
    await watch.shot(page, "selection-owned");

    await gotoDraft(page, draftB);
    await expect(root.locator('[data-section-id="' + draftB.sections[0].id + '"]')).toContainText(
      draftB.sections[0].content,
    );
    await expect(root.locator('[data-section-id="' + draftA.sections[0].id + '"]')).toHaveCount(0);

    await gotoDraft(page, draftA);
    await expect(root.locator('[data-section-id="' + draftA.sections[0].id + '"]')).toContainText(
      draftA.sections[0].content,
    );
    watch.flush();
    expect(watch.errors).toEqual([]);
  });

  test("wrong or partial operationId refuses honestly and never falls back to the draft", async ({ page }) => {
    const watch = watchPage(page, "ownership");
    await page.goto("/workspace");
    const draftA = await seedRealDraft(page);
    const draftB = await seedRealDraft(page);
    const root = await workspaceRoot(page);

    await page.goto("/workspace?draftId=" + draftA.draftId + "&operationId=" + crypto.randomUUID());
    await expect(root.locator('[data-draft-missing="operation-mismatch"]')).toBeVisible();

    await page.goto("/workspace?draftId=" + draftA.draftId + "&operationId=" + draftB.operationId);
    await expect(root.locator('[data-draft-missing="operation-mismatch"]')).toBeVisible();
    await expect(root.locator('[data-draft-missing="operation-mismatch"]')).toContainText("拒绝显示");

    await page.goto("/workspace?draftId=" + draftA.draftId);
    await expect(root.locator('[data-draft-missing="incomplete-ids"]')).toBeVisible();

    await page.goto("/workspace?operationId=" + draftA.operationId);
    await expect(root.locator('[data-draft-missing="incomplete-ids"]')).toBeVisible();

    await page.goto("/workspace?draftId=&operationId=" + draftB.operationId);
    await expect(root.locator('[data-draft-missing="incomplete-ids"]')).toBeVisible();

    await page.goto("/workspace?draftId=" + draftA.draftId + "&operationId=");
    await expect(root.locator('[data-draft-missing="incomplete-ids"]')).toBeVisible();

    await page.goto("/workspace?draftId=&operationId=");
    await expect(root.locator('[data-draft-missing="incomplete-ids"]')).toBeVisible();

    await page.goto("/workspace?draftId=");
    await expect(root.locator('[data-draft-missing="incomplete-ids"]')).toBeVisible();

    await page.goto("/workspace?operationId=");
    await expect(root.locator('[data-draft-missing="incomplete-ids"]')).toBeVisible();

    await expect(root.locator('[data-draft-missing="incomplete-ids"]')).not.toContainText("draftId");
    await expect(root.locator('[data-draft-missing="incomplete-ids"]')).not.toContainText("operationId");

    await expect(root.locator("[data-section-id]")).toHaveCount(0);
    await expect(root.locator("[data-draft-status]")).toHaveCount(0);
    await expect(root.locator("[data-confirm-section]")).toHaveCount(0);
    await watch.shot(page, "ownership-refusals");
    watch.flush();
    expect(watch.errors).toEqual([]);
  });

  test("unknown draftId shows not-found, never sample content", async ({ page }) => {
    const watch = watchPage(page, "not-found");
    await page.goto("/workspace");
    const seeded = await seedRealDraft(page);
    const root = await workspaceRoot(page);
    await page.goto("/workspace?draftId=does-not-exist&operationId=" + seeded.operationId);
    await expect(root.locator('[data-draft-missing="not-found"]')).toBeVisible();
    await expect(root.locator('[data-draft-missing="not-found"]')).not.toContainText("does-not-exist");
    await expect(root.locator('[data-section-id="' + seeded.sections[0].id + '"]')).toHaveCount(0);
    await expect(root.getByText("方案比较 · 工作草稿")).toHaveCount(0);
    watch.flush();
    expect(watch.errors).toEqual([]);
  });

  test("no ids and no drafts shows an empty state with a usable return-to-plan link", async ({ page }) => {
    const watch = watchPage(page, "empty");
    await page.goto("/workspace");
    const root = await workspaceRoot(page);
    await expect(root.locator('[data-runtime-state="ready"]')).toBeVisible();
    await expect(root.locator('[data-draft-missing="no-draft"]')).toBeVisible();
    await expect(root.locator("[data-section-id]")).toHaveCount(0);
    await watch.shot(page, "empty-state");

    await root.locator("[data-return-plan]").click();
    await expect(page).toHaveURL(/\/plan$/);
    await expect(page.locator('[data-page="s04"]')).toBeVisible();
    watch.flush();
    expect(watch.errors).toEqual([]);
  });

  test("no ids auto-selects the latest draft with a verified owning operation", async ({ page }) => {
    const watch = watchPage(page, "auto-select");
    await page.goto("/workspace");
    const draftA = await seedRealDraft(page);
    const draftB = await seedRealDraft(page);
    await page.goto("/workspace");
    const root = await workspaceRoot(page);
    await expect(root.locator('[data-runtime-state="ready"]')).toBeVisible();
    await expect(root.locator('[data-section-id="' + draftB.sections[0].id + '"]')).toBeVisible();
    await expect(root.locator('[data-section-id="' + draftA.sections[0].id + '"]')).toHaveCount(0);
    await watch.shot(page, "auto-select-latest");
    watch.flush();
    expect(watch.errors).toEqual([]);
  });
});

test.describe("[s06] 工作台真实领域操作", () => {
  test("confirm, flag invalidation, and checkpoint persist across reload with truthful status", async ({ page }) => {
    const watch = watchPage(page, "main-flow");
    await page.goto("/workspace");
    const draft = await seedRealDraft(page);
    await gotoDraft(page, draft);
    const root = await workspaceRoot(page);
    await expect(root.locator('[data-runtime-state="ready"]')).toBeVisible();

    const card = root.locator('[data-section-id="' + draft.sections[0].id + '"]');
    await expect(card).toHaveAttribute("data-section-review-status", "pendingReview");
    await root.locator('[data-confirm-section="' + draft.sections[0].id + '"]').click();
    await expect(card).toHaveAttribute("data-section-review-status", "confirmed");
    await expect(root.locator('[data-draft-status="partiallyConfirmed"]')).toBeVisible();
    await expect(root.locator('[data-sent-state="not-sent"]')).toBeVisible();
    await watch.shot(page, "confirmed");

    await root.locator("[data-checkpoint-input]").fill("把成本材料补齐后再检查");
    await root.locator("[data-checkpoint-save]").click();
    await expect(root.locator("[data-checkpoint-saved]")).toContainText("把成本材料补齐后再检查");

    const flagInput = root.locator('[data-flag-input="' + draft.sections[0].id + '"]');
    await flagInput.fill("确认后又发现了新的成本问题");
    await root.locator('[data-flag-section="' + draft.sections[0].id + '"]').click();
    await expect(card).toHaveAttribute("data-section-review-status", "pendingReview");
    await expect(card.locator("[data-section-invalid-reason]")).toContainText("issue flagged after confirmation");
    await expect(card.locator("[data-section-issues]")).toContainText("新的成本问题");

    await gotoDraft(page, draft);
    const reloaded = page.locator('[data-section-id="' + draft.sections[0].id + '"]');
    await expect(reloaded).toBeVisible();
    await expect(reloaded).toContainText(draft.sections[0].content);
    await expect(reloaded).toHaveAttribute("data-section-review-status", "pendingReview");
    await expect(reloaded.locator("[data-section-invalid-reason]")).toContainText("issue flagged after confirmation");
    await expect(page.locator("[data-checkpoint-saved]")).toContainText("把成本材料补齐后再检查");
    await expect(page.locator('[data-sent-state="not-sent"]')).toBeVisible();
    await watch.shot(page, "reload-readback");
    watch.flush();
    expect(watch.errors).toEqual([]);
  });

  test("storage write failure keeps inputs, clears busy, and never fakes success", async ({ page }) => {
    const watch = watchPage(page, "storage-failure");
    await page.goto("/workspace");
    const draft = await seedRealDraft(page);
    await gotoDraft(page, draft);
    const root = await workspaceRoot(page);
    await expect(root.locator('[data-runtime-state="ready"]')).toBeVisible();

    await page.evaluate((prefix) => {
      const w = window as unknown as { __s06OriginalSetItem?: Storage["setItem"] };
      w.__s06OriginalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
        if (typeof k === "string" && k.startsWith(prefix)) {
          throw new DOMException("simulated quota exceeded", "QuotaExceededError");
        }
        return w.__s06OriginalSetItem!.call(this, k, v);
      };
    }, STORAGE_KEY_PREFIX);

    const flagInput = root.locator('[data-flag-input="' + draft.sections[0].id + '"]');
    await flagInput.fill("存储失败时这段判断必须保留");
    await root.locator('[data-flag-section="' + draft.sections[0].id + '"]').click();
    await expect(root.locator('[data-command-error="flag"]')).toContainText("STORAGE_WRITE_FAILED");
    await expect(flagInput).toHaveValue("存储失败时这段判断必须保留");
    await expect(root.locator('[data-draft-status="partiallyConfirmed"]')).toHaveCount(0);

    await root.locator('[data-confirm-section="' + draft.sections[0].id + '"]').click();
    await expect(root.locator('[data-command-error="confirm"]')).toContainText("STORAGE_WRITE_FAILED");
    await expect(root.locator('[data-section-id="' + draft.sections[0].id + '"]')).toHaveAttribute(
      "data-section-review-status",
      "pendingReview",
    );
    await watch.shot(page, "storage-failure");

    await page.evaluate(() => {
      const w = window as unknown as { __s06OriginalSetItem?: Storage["setItem"] };
      if (w.__s06OriginalSetItem) Storage.prototype.setItem = w.__s06OriginalSetItem;
    });
    await root.locator('[data-confirm-section="' + draft.sections[0].id + '"]').click();
    await expect(root.locator('[data-draft-status="partiallyConfirmed"]')).toBeVisible();
    await expect(flagInput).toHaveValue("存储失败时这段判断必须保留");
    watch.flush();
    expect(watch.errors).toEqual([]);
  });

  test("corrupt runtime recovers only through explicit retry, with no silent storage reset", async ({ page }) => {
    const watch = watchPage(page, "recovery");
    await page.goto("/workspace");
    await page.evaluate((prefix) => {
      localStorage.setItem(prefix + "fixture", "{broken json");
    }, STORAGE_KEY_PREFIX);
    await page.goto("/workspace?draftId=whatever&operationId=whatever");
    const root = await workspaceRoot(page);
    await expect(root.locator('[data-runtime-state="unavailable"]')).toBeVisible();
    await expect(root.locator("[data-runtime-reason]")).toContainText("corrupt");
    await expect(root.locator("[data-section-id]")).toHaveCount(0);

    const corruptBefore = await page.evaluate((prefix) => localStorage.getItem(prefix + "fixture"), STORAGE_KEY_PREFIX);
    await root.locator("[data-runtime-retry]").click();
    await expect(root.locator('[data-runtime-state="unavailable"]')).toBeVisible();
    await expect(root.locator("[data-runtime-retry]")).toBeEnabled();
    const corruptAfter = await page.evaluate((prefix) => localStorage.getItem(prefix + "fixture"), STORAGE_KEY_PREFIX);
    expect(corruptAfter).toBe(corruptBefore);
    await watch.shot(page, "recovery-still-corrupt");

    await page.evaluate(async (prefix) => {
      localStorage.removeItem(prefix + "fixture");
      const importModule = new Function("u", "return import(u)") as (u: string) => Promise<unknown>;
      const data = (await importModule("/src/data/index.ts")) as {
        resetFixtureDomain: () => Promise<{ ok: boolean }>;
      };
      const reset = await data.resetFixtureDomain();
      if (!reset.ok) throw new Error("fixture repair failed");
    }, STORAGE_KEY_PREFIX);
    await root.locator("[data-runtime-retry]").click();
    await expect(root.locator('[data-runtime-state="ready"]')).toBeVisible();
    await expect(root.locator('[data-draft-missing="not-found"]')).not.toContainText("whatever");
    await watch.shot(page, "recovery-ready");

    const draft = await seedRealDraft(page);
    await gotoDraft(page, draft);
    await expect(page.locator('[data-section-id="' + draft.sections[0].id + '"]')).toContainText(
      draft.sections[0].content,
    );
    watch.flush();
    expect(watch.errors).toEqual([]);
  });
});

test.describe("[s06] 工作台编辑、材料与撤回的真实界面契约", () => {
  test("same-draft partial confirmation keeps the unresolved-cost section pending", async ({ page }) => {
    const watch = watchPage(page, "partial-sections");
    await page.goto("/workspace");
    const draft = await seedRealDraft(page);
    expect(draft.sections.length).toBeGreaterThanOrEqual(2);
    await gotoDraft(page, draft);
    const root = await workspaceRoot(page);
    const first = draft.sections[0];
    const rest = draft.sections.slice(1);
    await root.locator('[data-confirm-section="' + first.id + '"]').click();
    await expect(root.locator('[data-section-id="' + first.id + '"]')).toHaveAttribute(
      "data-section-review-status",
      "confirmed",
    );
    for (const section of rest) {
      await expect(root.locator('[data-section-id="' + section.id + '"]')).toHaveAttribute(
        "data-section-review-status",
        "pendingReview",
      );
    }
    await expect(root.locator('[data-draft-status="partiallyConfirmed"]')).toBeVisible();
    await expect(root.locator('[data-sent-state="not-sent"]')).toBeVisible();
    await watch.shot(page, "partial-sections");
    watch.flush();
    expect(watch.errors).toEqual([]);
  });

  test("section editor persists content and invalidates only the edited section confirmation", async ({ page }) => {
    const watch = watchPage(page, "section-edit");
    await withFailureEvidence(watch, page, "section-edit", async () => {
      await page.goto("/workspace");
      const draft = await seedRealDraft(page);
      await gotoDraft(page, draft);
      const root = await workspaceRoot(page);
      const first = draft.sections[0];
      const editor = root.locator('[data-section-editor="' + first.id + '"]');
      await expect(root.locator('[data-runtime-state="ready"]')).toBeVisible();
      await expect(editor).toBeVisible();
      await editor.fill(first.content + "（补充：需要核对成本来源）");
      await root.locator('[data-section-save="' + first.id + '"]').click();
      await expect(root.locator('[data-section-id="' + first.id + '"]')).toContainText("需要核对成本来源");
      await gotoDraft(page, draft);
      await expect(root.locator('[data-section-id="' + first.id + '"]')).toContainText("需要核对成本来源");
    });
    watch.flush();
    expect(watch.errors).toEqual([]);
  });

  test("material record with content, permission, and section association survives refresh unverified", async ({
    page,
  }) => {
    const watch = watchPage(page, "material-v2");
    await withFailureEvidence(watch, page, "material-v2", async () => {
      await page.goto("/workspace");
      const draft = await seedRealDraft(page);
      await gotoDraft(page, draft);
      const root = await workspaceRoot(page);
      await expect(root.locator('[data-runtime-state="ready"]')).toBeVisible();
      const contentInput = root.locator("[data-material-content]");
      const permissionInput = root.locator('[data-material-read-permission="granted"]');
      const sectionInput = root.locator('[data-material-section="' + draft.sections[0].id + '"]');
      await expect(contentInput).toBeVisible();
      await expect(permissionInput).toBeVisible();
      await expect(sectionInput).toBeVisible();

      await root.locator("[data-material-name]").fill("成本核算表");
      await root.locator("[data-material-access-ref]").fill("file://costs/q3-review.xlsx");
      await root.locator("[data-material-version]").fill("2");
      await contentInput.fill("Q3 各渠道成本明细，待人工核对");
      await permissionInput.check();
      await sectionInput.check();
      await root.locator("[data-material-add]").click();
      await expect(root.locator("[data-material-item]").first()).toContainText("成本核算表");
      await expect(root.locator("[data-material-item]").first()).toContainText("仍需人工核对");
      await expect(root.locator('[data-material-verified="false"]').first()).toBeVisible();
      await gotoDraft(page, draft);
      await expect(root.locator("[data-material-item]").first()).toContainText("成本核算表");
      await expect(root.locator("[data-material-item]").first()).toContainText("file://costs/q3-review.xlsx");
      await expect(root.locator('[data-material-verified="false"]').first()).toBeVisible();
    });
    await watch.shot(page, "material-v2");
    watch.flush();
    expect(watch.errors).toEqual([]);
  });

});

test.describe("[s06] 运行时初始化与重试", () => {
  test("retry under persistent storage read failure stays handled and reusable", async ({ page }) => {
    const watch = watchPage(page, "retry-unhandled");
    await page.addInitScript((prefix) => {
      const original = Storage.prototype.getItem;
      Storage.prototype.getItem = function (this: Storage, key: string) {
        if (typeof key === "string" && key.startsWith(prefix)) {
          throw new DOMException("simulated storage read failure", "InvalidStateError");
        }
        return original.call(this, key);
      };
    }, STORAGE_KEY_PREFIX);
    await page.goto("/workspace");
    const root = await workspaceRoot(page);
    await expect(root.locator('[data-runtime-state="unavailable"]')).toBeVisible();
    await expect(root.locator("[data-runtime-reason]")).toContainText("simulated storage read failure");
    await expect(root.locator("[data-section-id]")).toHaveCount(0);

    await root.locator("[data-runtime-retry]").click();
    await expect(root.locator('[data-runtime-state="unavailable"]')).toBeVisible();
    await expect(root.locator("[data-runtime-retry]")).toBeEnabled();

    await root.locator("[data-runtime-retry]").click();
    await expect(root.locator('[data-runtime-state="unavailable"]')).toBeVisible();
    await expect(root.locator("[data-runtime-retry]")).toBeEnabled();

    await watch.shot(page, "retry-unhandled");
    watch.flush();
    expect(watch.errors).toEqual([]);
  });

  test("concurrent retries and later reads converge on one ready runtime identity", async ({ page }) => {
    const watch = watchPage(page, "retry-identity");
    await page.goto("/workspace");
    await page.evaluate((prefix) => {
      localStorage.setItem(prefix + "fixture", "{broken json");
    }, STORAGE_KEY_PREFIX);
    await page.reload();
    const root = await workspaceRoot(page);
    await expect(root.locator('[data-runtime-state="unavailable"]')).toBeVisible();

    const result = await page.evaluate(async (prefix) => {
      const importModule = new Function("u", "return import(u)") as (u: string) => Promise<unknown>;
      const runtime = (await importModule("/src/runtime/index.ts")) as {
        getDomainRuntime: (mode?: string) => Promise<unknown>;
        retryDomainRuntime: (mode?: string) => Promise<unknown>;
      };
      interface RuntimeHandle {
        status: string;
        store?: unknown;
      }
      const broken = (await runtime.getDomainRuntime("fixture")) as RuntimeHandle;
      if (broken.status === "ready") throw new Error("expected corrupt cached runtime, got ready");
      localStorage.removeItem(prefix + "fixture");
      const [first, second] = (await Promise.all([
        runtime.retryDomainRuntime("fixture"),
        runtime.retryDomainRuntime("fixture"),
      ])) as [RuntimeHandle, RuntimeHandle];
      const third = (await runtime.getDomainRuntime("fixture")) as RuntimeHandle;
      if (first.status !== "ready" || second.status !== "ready" || third.status !== "ready") {
        throw new Error("expected ready handles, got " + first.status + "/" + second.status + "/" + third.status);
      }
      const storeA = first.store;
      const storeB = second.store;
      const storeC = third.store;
      return { singleIdentity: storeA !== undefined && storeA === storeB && storeB === storeC };
    }, STORAGE_KEY_PREFIX);
    expect(result.singleIdentity).toBe(true);
    await watch.shot(page, "retry-identity");
    watch.flush();
    expect(watch.errors).toEqual([]);
  });
});

test.describe("[s06] mobile layout evidence", () => {
  test("mobile keeps document and rail stacked with truthful content", async ({ page }) => {
    test.skip(test.info().project.name !== "mobile", "mobile layout evidence only");
    const watch = watchPage(page, "mobile-layout");
    await page.goto("/workspace");
    const draft = await seedRealDraft(page);
    await gotoDraft(page, draft);
    const root = await workspaceRoot(page);
    await expect(root.locator('[data-runtime-state="ready"]')).toBeVisible();
    const doc = root.locator(".s06-doc");
    const rail = root.locator(".s06-rail");
    await expect(doc).toBeVisible();
    await expect(rail).toBeVisible();
    const docBox = await doc.boundingBox();
    const railBox = await rail.boundingBox();
    expect(docBox).not.toBeNull();
    expect(railBox).not.toBeNull();
    expect(railBox!.y).toBeGreaterThanOrEqual(docBox!.y + docBox!.height - 2);
    const viewportWidth = page.viewportSize()?.width ?? 0;
    await expect(viewportWidth).toBeLessThan(900);
    await watch.shot(page, "mobile-layout");
    watch.flush();
    expect(watch.errors).toEqual([]);
  });
});
