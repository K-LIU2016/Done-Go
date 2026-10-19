export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  role: "user" | "admin";
  emailVerified: boolean;
  isActive: boolean;
  settings: Record<string, unknown>;
}

export interface AuthStatus {
  enabled: boolean;
  emailDelivery: "unavailable" | "console" | "email";
  registrationEnabled: boolean;
  passwordMinLength: number;
}

export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export function authErrorMessage(error: unknown): string {
  return error instanceof AuthError ? error.message : "暂时无法连接账号服务，请稍后重试。";
}

export function createAuthClient(fetchImpl: typeof fetch = fetch) {
  async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`/api/auth/${path}`, {
        method,
        signal: AbortSignal.timeout(15000),
        credentials: "same-origin",
        headers: { "x-tango-client": "tango-settings/1", "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new AuthError("暂时无法连接账号服务，请稍后重试。");
    }
    let result: unknown;
    try { result = await response.json(); } catch { throw new AuthError("账号服务返回异常，请稍后重试。", response.status); }
    if (!response.ok) {
      const detail = result && typeof result === "object" && "detail" in result ? result.detail : null;
      const message = detail && typeof detail === "object" && "message" in detail && typeof detail.message === "string"
        ? detail.message : "账号操作未完成，请稍后重试。";
      throw new AuthError(message, response.status);
    }
    return result as T;
  }
  return {
    status: () => request<AuthStatus>("status"),
    me: () => request<{ user: AuthUser }>("me"),
    login: (email: string, password: string) => request<{ user: AuthUser }>("login", "POST", { email, password }),
    sendCode: (email: string, purpose: "register" | "reset") => request<{ status: "sent"; devCode?: string }>("send-code", "POST", { email, purpose }),
    register: (email: string, code: string, password: string, displayName: string) => request<{ user: AuthUser }>("register", "POST", { email, code, password, displayName }),
    resetPassword: (email: string, code: string, newPassword: string) => request<{ status: "ok" }>("reset-password", "POST", { email, code, newPassword }),
    logout: () => request<{ status: "ok" }>("logout", "POST", {}),
    updateProfile: (data: { displayName?: string; settings?: Record<string, unknown> }) => request<{ user: AuthUser }>("me", "PUT", data),
    updatePassword: (oldPassword: string, newPassword: string) => request<{ status: "ok" }>("me/password", "PUT", { oldPassword, newPassword }),
  };
}

export type AuthClient = ReturnType<typeof createAuthClient>;
