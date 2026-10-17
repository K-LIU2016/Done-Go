import type { EntityId } from "./types.ts";

export const FIXTURE_IDS = {
  sourceCalendar: "fx-source-calendar-01",
  intent: "fx-intent-01",
  protectedBlock: "fx-protected-01",
  request: "fx-request-01",
  agreementRequest: "fx-agreement-01",
  commitmentReport: "fx-commitment-01",
  commitmentMeeting: "fx-commitment-02",
  commitmentAdmin: "fx-commitment-03",
  ruleset: "fx-ruleset",
  attentionBudget: "fx-attention-budget",
  ledgerProtected: "fx-ledger-protected-01",
} as const satisfies Record<string, EntityId>;

export type UuidFactory = () => string;

export function defaultUuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}
