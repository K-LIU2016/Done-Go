export interface AgreementTerms {
  purpose: string;
  dateRange: { start: string; end: string };
  timezone: string;
  effortRange: { min: number | null; max: number | null };
  deadline: string | null;
  materials: Array<{ id: string; label: string; permission: "reference" | "read" }>;
}

export interface AgreementVersion {
  version: number;
  terms: AgreementTerms;
  termsHash: string;
  createdBy: string;
  createdAt: string;
}

export type AgreementResponseStatus = "pending" | "accepted" | "rejected";

export interface AgreementResponse {
  actorId: string;
  status: AgreementResponseStatus;
  termsVersion: number | null;
  termsHash: string | null;
  respondedAt: string | null;
  reasonCode: string | null;
}

export type AgreementRequestStatus = "draft" | "sent" | "received" | "withdrawn" | "expired" | "rejected" | "agreed";

export interface Agreement {
  requestId: string;
  termsVersion: number;
  termsHash: string;
  parties: [string, string];
  formedAt: string;
  expiresAt: string;
  executionRefs: string[];
}

export interface AgreementRequest {
  id: string;
  proposerId: string;
  recipientId: string;
  status: AgreementRequestStatus;
  currentVersion: number;
  versions: AgreementVersion[];
  responses: Record<string, AgreementResponse>;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  agreement: Agreement | null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value as Record<string, unknown>).sort().map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

export function hashAgreementTerms(terms: AgreementTerms): string {
  const normalized: AgreementTerms = {
    ...terms,
    purpose: terms.purpose.trim(),
    timezone: terms.timezone.trim(),
    materials: [...terms.materials]
      .map((material) => ({ ...material, id: material.id.trim(), label: material.label.trim() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  let hash = 2166136261;
  for (const char of canonical(normalized)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function partiesOf(request: AgreementRequest): [string, string] {
  return [request.proposerId, request.recipientId];
}

function assertParty(request: AgreementRequest, actorId: string): void {
  if (!partiesOf(request).includes(actorId as string)) throw new Error("actor is not a party to this request");
}

function assertNotTerminal(request: AgreementRequest): void {
  if (["withdrawn", "expired", "rejected", "agreed"].includes(request.status)) throw new Error("request is terminal");
}

function isExpired(request: AgreementRequest, now: string): boolean {
  return Date.parse(now) >= Date.parse(request.expiresAt);
}

function withStatus(request: AgreementRequest, status: AgreementRequestStatus, now: string): AgreementRequest {
  return { ...request, status, updatedAt: now, revision: request.revision + 1 };
}

export function createAgreementRequest(input: {
  id: string;
  proposerId: string;
  recipientId: string;
  terms: AgreementTerms;
  expiresAt: string;
  now: string;
}): AgreementRequest {
  if (!input.id || !input.proposerId || !input.recipientId || input.proposerId === input.recipientId) throw new Error("request parties are invalid");
  if (Date.parse(input.expiresAt) <= Date.parse(input.now)) throw new Error("request expiry must be in the future");
  const version: AgreementVersion = { version: 1, terms: structuredClone(input.terms), termsHash: hashAgreementTerms(input.terms), createdBy: input.proposerId, createdAt: input.now };
  return {
    id: input.id,
    proposerId: input.proposerId,
    recipientId: input.recipientId,
    status: "sent",
    currentVersion: 1,
    versions: [version],
    responses: {
      [input.proposerId]: { actorId: input.proposerId, status: "pending", termsVersion: null, termsHash: null, respondedAt: null, reasonCode: null },
      [input.recipientId]: { actorId: input.recipientId, status: "pending", termsVersion: null, termsHash: null, respondedAt: null, reasonCode: null },
    },
    expiresAt: input.expiresAt,
    createdAt: input.now,
    updatedAt: input.now,
    revision: 1,
    agreement: null,
  };
}

export function counterProposeAgreement(request: AgreementRequest, input: { actorId: string; terms: AgreementTerms; now: string }): AgreementRequest {
  assertParty(request, input.actorId);
  assertNotTerminal(request);
  if (isExpired(request, input.now)) return withStatus(request, "expired", input.now);
  const nextVersion = request.currentVersion + 1;
  const version: AgreementVersion = { version: nextVersion, terms: structuredClone(input.terms), termsHash: hashAgreementTerms(input.terms), createdBy: input.actorId, createdAt: input.now };
  return {
    ...request,
    status: "received",
    currentVersion: nextVersion,
    versions: [...request.versions, version],
    responses: Object.fromEntries(partiesOf(request).map((actorId) => [actorId, { actorId, status: "pending", termsVersion: null, termsHash: null, respondedAt: null, reasonCode: null }])),
    updatedAt: input.now,
    revision: request.revision + 1,
    agreement: null,
  };
}

export function respondToAgreementRequest(request: AgreementRequest, input: {
  actorId: string;
  termsVersion: number;
  termsHash: string;
  response: "accepted" | "rejected";
  now: string;
  reasonCode?: string | null;
}): AgreementRequest {
  assertParty(request, input.actorId);
  assertNotTerminal(request);
  if (isExpired(request, input.now)) return withStatus(request, "expired", input.now);
  const version = request.versions.find((candidate) => candidate.version === input.termsVersion);
  if (!version || input.termsVersion !== request.currentVersion || version.termsHash !== input.termsHash) throw new Error("terms version or hash is stale");
  const response: AgreementResponse = { actorId: input.actorId, status: input.response, termsVersion: input.termsVersion, termsHash: input.termsHash, respondedAt: input.now, reasonCode: input.reasonCode ?? null };
  const next = { ...request, responses: { ...request.responses, [input.actorId]: response }, updatedAt: input.now, revision: request.revision + 1 };
  if (input.response === "rejected") return { ...next, status: "rejected" };
  const allAccepted = partiesOf(request).every((actorId) => {
    const partyResponse = next.responses[actorId];
    return partyResponse?.status === "accepted" && partyResponse.termsVersion === input.termsVersion && partyResponse.termsHash === input.termsHash;
  });
  if (!allAccepted) return { ...next, status: "received" };
  return {
    ...next,
    status: "agreed",
    agreement: { requestId: request.id, termsVersion: input.termsVersion, termsHash: input.termsHash, parties: partiesOf(request), formedAt: input.now, expiresAt: request.expiresAt, executionRefs: [] },
  };
}

export function withdrawAgreementRequest(request: AgreementRequest, input: { actorId: string; now: string }): AgreementRequest {
  assertParty(request, input.actorId);
  if (request.status === "agreed") throw new Error("an agreed request requires cancellation, not withdrawal");
  if (request.status === "withdrawn") return request;
  return withStatus(request, "withdrawn", input.now);
}

export function refreshAgreementExpiry(request: AgreementRequest, now: string): AgreementRequest {
  if (request.status === "agreed" || request.status === "withdrawn" || request.status === "rejected" || request.status === "expired") return request;
  return isExpired(request, now) ? withStatus(request, "expired", now) : request;
}
