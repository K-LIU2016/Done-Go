// Frontend client for the loopback Tango Done&Go settings API. Secrets are only ever
// sent to the local server, never echoed back and never persisted client-side.

const CLIENT_HEADER = "x-tango-client";
const CLIENT_VALUE = "tango-settings/1";

export type LlmProtocol = "anthropic" | "openai";

export interface LlmCandidate {
  protocol: LlmProtocol;
  baseUrl: string;
  messagesUrl: string;
  modelsUrl: string;
  model: string;
}

export interface LlmSettingsMeta {
  protocol: string;
  baseUrl: string;
  messagesUrl: string;
  modelsUrl: string;
  model: string;
  hasApiKey: boolean;
  enabled: boolean;
  verified: boolean;
  verifiedAt: string | null;
}

export interface ModelsStage {
  ok: boolean;
  models?: string[];
  error?: string;
  status?: number;
}

export interface InferenceStage {
  ok: boolean;
  model?: string;
  responseModel?: string;
  error?: string;
  status?: number;
}

export interface LlmTestResult {
  ok: boolean;
  models: ModelsStage;
  inference: InferenceStage;
  proofToken?: string;
}

export interface GenerateResult {
  text: string;
  model: string;
  requestId: string;
  responseModel?: string;
}

export class LlmApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "LlmApiError";
    this.code = code;
    this.status = status;
  }
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      [CLIENT_HEADER]: CLIENT_VALUE,
      ...(init?.headers ?? {}),
    },
  });
}

async function throwApiError(res: Response): Promise<never> {
  let code = "request_failed";
  const body: unknown = await res.json().catch(() => null);
  if (body && typeof body === "object" && "error" in body) {
    const errCode = (body as { error?: unknown }).error;
    if (typeof errCode === "string") code = errCode;
  }
  throw new LlmApiError(code, res.status);
}

export async function getLlmSettings(): Promise<LlmSettingsMeta> {
  const res = await apiFetch("/api/settings/llm");
  if (!res.ok) await throwApiError(res);
  return res.json() as Promise<LlmSettingsMeta>;
}

export async function testLlmCandidate(candidate: LlmCandidate, apiKey: string): Promise<LlmTestResult> {
  const res = await apiFetch("/api/settings/llm/test", {
    method: "POST",
    body: JSON.stringify({ candidate, apiKey }),
  });
  if (!res.ok) await throwApiError(res);
  return res.json() as Promise<LlmTestResult>;
}

export async function saveLlmSettings(
  candidate: LlmCandidate,
  apiKey: string,
  proofToken: string,
): Promise<{ ok: boolean }> {
  const res = await apiFetch("/api/settings/llm", {
    method: "POST",
    body: JSON.stringify({ candidate, apiKey, proofToken }),
  });
  if (!res.ok) await throwApiError(res);
  return res.json() as Promise<{ ok: boolean }>;
}

export async function disconnectLlm(): Promise<void> {
  const res = await apiFetch("/api/settings/llm", { method: "DELETE" });
  if (!res.ok) await throwApiError(res);
}

export async function generateWithLlm({
  purpose,
  input,
  signal,
}: {
  purpose: "draft";
  input: string;
  signal?: AbortSignal;
}): Promise<GenerateResult> {
  const res = await fetch("/api/llm/generate", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      [CLIENT_HEADER]: CLIENT_VALUE,
    },
    body: JSON.stringify({ purpose, input }),
  });
  if (!res.ok) await throwApiError(res);
  return res.json() as Promise<GenerateResult>;
}

const ERROR_TEXT: Record<string, string> = {
  network_error: "无法连接上游端点",
  timeout: "请求超时，已中止",
  cancelled: "请求已取消",
  auth_error: "鉴权失败：密钥无效或无权限",
  redirect_blocked: "上游重定向被阻止",
  not_found: "地址或模型不存在",
  rate_limited: "上游限流，请稍后再试",
  upstream_error: "上游返回错误",
  model_not_listed: "模型不在上游模型列表中",
  bad_response: "上游响应格式无效",
  response_too_large: "上游响应超过大小限制",
  text_too_large: "生成文本超过长度上限",
  invalid_candidate: "端点配置无效，请检查各字段",
  missing_key: "缺少 API Key",
  proof_required: "缺少有效测试凭证，请重新测试",
  not_configured: "尚未保存已验证的模型连接",
  invalid_purpose: "不支持的用途",
  empty_input: "输入为空",
  input_too_long: "输入超过长度限制",
  persist_failed: "保存失败：本地存储目录或文件权限异常，原有数据未改动",
  settings_corrupt: "本地设置文件损坏，已保留原文件；请手动处理 .tango-donego 后重试",
  settings_unreadable: "本地设置文件不可读，已保留原文件；请检查 .tango-donego 权限",
  body_too_large: "请求体过大",
  invalid_json: "请求格式错误",
  request_failed: "本地服务请求失败",
  AUTH_REQUIRED: "请先登录后再管理模型连接",
};

export function describeLlmError(code: string): string {
  return ERROR_TEXT[code] ?? "发生未知错误（" + code + "）";
}
