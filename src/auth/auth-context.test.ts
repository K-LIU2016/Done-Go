import assert from "node:assert/strict";
import test from "node:test";
import { AuthError, createAuthClient } from "./auth-client.ts";
import type { AuthStatus, AuthUser } from "./auth-client.ts";
import { createAuthController } from "./auth-controller.ts";
import { authFlowReducer, initialAuthFlow } from "./auth-flow.ts";

const status: AuthStatus = { enabled: true, emailDelivery: "email", registrationEnabled: true, passwordMinLength: 12 };
const user: AuthUser = { id: "user-1", email: "person@example.com", displayName: "Done&Go 用户", role: "user", createdAt: "2026-09-13", emailVerified: true, isActive: true, settings: {} };
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { "Content-Type": "application/json" } });

test("session restore treats /me 401 as signed out, without a visible service error", async () => {
  const requests: string[] = [];
  const controller = createAuthController(createAuthClient(async (input, init) => {
    requests.push(String(input));
    assert.equal(init?.credentials, "same-origin");
    assert.equal(new Headers(init?.headers).get("x-tango-client"), "tango-settings/1");
    return String(input).endsWith("status") ? json(status) : json({ error: "unauthorized", detail: { message: "请先登录。" } }, 401);
  }));
  await controller.refresh();
  assert.deepEqual(requests, ["/api/auth/status", "/api/auth/me"]);
  assert.deepEqual(controller.getSnapshot(), { user: null, status, loading: false, busy: false, error: null });
});

test("session restore publishes the server user and does not persist a token", async () => {
  const controller = createAuthController(createAuthClient(async (input) => String(input).endsWith("status") ? json(status) : json({ user })));
  await controller.refresh();
  assert.deepEqual(controller.getSnapshot().user, user);
});

test("registration requires sending a code before entering verification, and changing email discards the challenge", () => {
  const register = authFlowReducer(initialAuthFlow, { type: "mode", mode: "register", registrationEnabled: true });
  assert.equal(register.step, "email");
  const sent = authFlowReducer(register, { type: "sent", email: " person@example.com ", devCode: "123456", showDevCode: true });
  assert.deepEqual(sent, { mode: "register", step: "verify", email: "person@example.com", devCode: "123456" });
  assert.deepEqual(authFlowReducer(sent, { type: "edit-email" }), { ...sent, step: "email", devCode: null });
  assert.equal(authFlowReducer(register, { type: "sent", email: user.email, devCode: "123456", showDevCode: false }).devCode, null);
});

test("disabled registration cannot select register or call the registration endpoints", async () => {
  assert.equal(authFlowReducer(initialAuthFlow, { type: "mode", mode: "register", registrationEnabled: false }).mode, "login");
  const requests: string[] = [];
  const controller = createAuthController(createAuthClient(async (input) => {
    requests.push(String(input));
    return String(input).endsWith("status") ? json({ ...status, registrationEnabled: false }) : json({ user });
  }));
  await controller.refresh();
  await assert.rejects(controller.sendCode(user.email, "register"), /注册暂未开放/);
  await assert.rejects(controller.register(user.email, "123456", "test-password-only", "Test"), /注册暂未开放/);
  assert.deepEqual(requests, ["/api/auth/status", "/api/auth/me"]);
});

test("successful register uses the verified email and publishes the cookie-authenticated user", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const controller = createAuthController(createAuthClient(async (input, init) => {
    calls.push({ path: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (String(input).endsWith("status")) return json(status);
    if (String(input).endsWith("send-code")) return json({ status: "sent" });
    if (String(input).endsWith("register")) return json({ user });
    return json({ detail: { message: "未登录" } }, 401);
  }));
  await controller.refresh();
  await controller.sendCode(user.email, "register");
  await controller.register(user.email, "654321", "a-long-password", "Name");
  assert.deepEqual(calls.slice(-2), [
    { path: "/api/auth/send-code", body: { email: user.email, purpose: "register" } },
    { path: "/api/auth/register", body: { email: user.email, code: "654321", password: "a-long-password", displayName: "Name" } },
  ]);
  assert.deepEqual(controller.getSnapshot().user, user);
});

test("login errors show detail.message and network errors use the quiet generic message", async () => {
  const client = createAuthClient(async () => json({ detail: { code: "LOGIN_FAILED", message: "邮箱或密码不正确。" } }, 401));
  await assert.rejects(client.login(user.email, "wrong"), (error: unknown) => error instanceof AuthError && error.message === "邮箱或密码不正确。" && error.status === 401);
  await assert.rejects(createAuthClient(async () => { throw new TypeError("network"); }).me(), /暂时无法连接账号服务/);
});

test("an older session restore cannot replace a completed login", async () => {
  let resolveMe: ((response: Response) => void) | undefined;
  const pendingMe = new Promise<Response>((resolve) => { resolveMe = resolve; });
  const controller = createAuthController(createAuthClient(async (input) => {
    if (String(input).endsWith("status")) return json(status);
    if (String(input).endsWith("login")) return json({ user });
    return pendingMe;
  }));
  const restoring = controller.refresh();
  await controller.login(user.email, "correct-password");
  resolveMe?.(json({ detail: { message: "未登录" } }, 401));
  await restoring;
  assert.deepEqual(controller.getSnapshot().user, user);
});

test("failed logout preserves identity; confirmed logout clears it", async () => {
  let failLogout = true;
  const controller = createAuthController(createAuthClient(async (input) => {
    if (String(input).endsWith("status")) return json(status);
    if (String(input).endsWith("logout")) return failLogout ? json({ detail: { message: "退出未完成。" } }, 503) : json({ status: "ok" });
    return json({ user });
  }));
  await controller.refresh();
  await assert.rejects(controller.logout(), /退出未完成/);
  assert.deepEqual(controller.getSnapshot().user, user);
  failLogout = false;
  await controller.logout();
  assert.equal(controller.getSnapshot().user, null);
});

test("password reset returns to login, keeping email and removing code", () => {
  const resetting = authFlowReducer(initialAuthFlow, { type: "mode", mode: "reset", registrationEnabled: false });
  const sent = authFlowReducer(resetting, { type: "sent", email: user.email, showDevCode: false });
  assert.deepEqual(authFlowReducer(sent, { type: "reset-complete" }), { ...initialAuthFlow, email: user.email });
});
