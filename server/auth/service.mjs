import { createHmac, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { authRequestAllowed } from "./config.mjs";
import { createEmailSender, createSmsSender } from "./email.mjs";

const derive = promisify(scrypt);
const COOKIE = "tango_session";
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 15;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const JWT_HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

export class AuthError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function fail(status, code, message) { throw new AuthError(status, code, message); }
function emailInput(input) {
  if (typeof input !== "string" || input.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.trim())) fail(400, "INVALID_EMAIL", "请输入有效的邮箱地址。");
  return input.trim().toLowerCase();
}
function phoneInput(input) {
  if (typeof input !== "string" || input.length > 24) fail(400, "INVALID_PHONE", "请输入有效的手机号。");
  const compact = input.replace(/[\s()-]/g, "");
  const match = /^(?:\+?86)?(1[3-9]\d{9})$/.exec(compact);
  if (!match) fail(400, "INVALID_PHONE", "请输入有效的手机号。");
  return "+86" + match[1];
}
function identifierInput(body) {
  if (body.email !== undefined && body.phone !== undefined) fail(400, "INVALID_IDENTIFIER", "请只提供邮箱或手机号其中一项。");
  if (body.email !== undefined) return { channel: "email", identifier: emailInput(body.email) };
  if (body.phone !== undefined) return { channel: "phone", identifier: phoneInput(body.phone) };
  if (body.identifier === undefined || String(body.identifier).trim() === "") fail(400, "INVALID_IDENTIFIER", "请输入邮箱或手机号。");
  const value = String(body.identifier);
  return value.includes("@") ? { channel: "email", identifier: emailInput(value) } : { channel: "phone", identifier: phoneInput(value) };
}
function phoneEmail(phone) {
  return phone.slice(1) + "@phone.tango.invalid";
}
function passwordInput(input) {
  if (typeof input !== "string" || input.length < PASSWORD_MIN || input.length > PASSWORD_MAX) fail(400, "INVALID_PASSWORD", "密码长度需为 8–15 个字符。");
  return input;
}
function nameInput(input, fallback) {
  if (input === undefined) return fallback;
  if (typeof input !== "string" || !input.trim() || input.trim().length > 80) fail(400, "INVALID_NAME", "称呼需为 1–80 个字符。");
  return input.trim();
}
function publicUser(row) {
  const local = row.account_kind === "local";
  const phone = row.account_kind === "phone";
  return { id: row.id, email: local || phone ? null : row.email, phone: phone ? row.phone : null, username: local ? row.email.split("@")[0] : null, displayName: row.display_name, createdAt: row.created_at, role: row.role, emailVerified: !local && !phone, phoneVerified: phone, isActive: Boolean(row.is_active), settings: JSON.parse(row.settings_json) };
}
async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = await derive(password, salt, 64, SCRYPT);
  return `scrypt$${salt}$${derived.toString("hex")}`;
}
async function verifyPassword(password, stored) {
  const parts = typeof stored === "string" ? stored.split("$") : [];
  const valid = parts.length === 3 && parts[0] === "scrypt" && /^[a-f0-9]{32}$/.test(parts[1]) && /^[a-f0-9]{128}$/.test(parts[2]);
  const derived = await derive(password, valid ? parts[1] : "00000000000000000000000000000000", 64, SCRYPT);
  return valid && timingSafeEqual(derived, Buffer.from(parts[2], "hex"));
}
function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/** mail2profile contracts adapted to the existing Node host; no browser-held bearer token. */
export function createAuthService({ databaseFile, config, sendEmail = createEmailSender(config), sendSms = createSmsSender(config), now = Date.now, resourceHooks = {}, localAccounts = false, cookieName = COOKIE, requireLoginAfterRegistration = false }) {
  if (!/^[a-zA-Z0-9_]{1,80}$/.test(cookieName)) throw new Error('Invalid session cookie name');
  if (!databaseFile || !config || Buffer.byteLength(config.secret || "") < 32) throw new Error("Auth database and strong secret are required");
  if ((config.publicOrigin || config.production) && config.transport === "console") throw new Error("Public authentication cannot use console email");
  if (databaseFile !== ":memory:") mkdirSync(dirname(databaseFile), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databaseFile);
  if (databaseFile !== ":memory:") chmodSync(databaseFile, 0o600);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL, role TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1, settings_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS email_verifications (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, delivery TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS verifications_lookup ON email_verifications(email, purpose, created_at);
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_rates (
      key TEXT PRIMARY KEY, started_at INTEGER NOT NULL, count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_events (
      id TEXT PRIMARY KEY, event_type TEXT NOT NULL, channel TEXT, identifier TEXT,
      user_id TEXT, outcome TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_events_time ON auth_events(created_at);
    CREATE INDEX IF NOT EXISTS auth_events_type ON auth_events(event_type, created_at);
  `);
  const userColumns = db.prepare("PRAGMA table_info(users)").all();
  if (!userColumns.some((column) => column.name === "account_kind")) db.exec("ALTER TABLE users ADD COLUMN account_kind TEXT NOT NULL DEFAULT 'email'");
  if (!userColumns.some((column) => column.name === "phone")) db.exec("ALTER TABLE users ADD COLUMN phone TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(phone) WHERE phone IS NOT NULL");
  if (!db.prepare("PRAGMA table_info(email_verifications)").all().some((column) => column.name === "channel")) db.exec("ALTER TABLE email_verifications ADD COLUMN channel TEXT NOT NULL DEFAULT 'email'");

  const getUser = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  const userByEmail = (email) => db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  const userByPhone = (phone) => db.prepare("SELECT * FROM users WHERE phone = ?").get(phone);
  const userByIdentifier = (target) => (target.channel === "phone" ? userByPhone(target.identifier) : userByEmail(target.identifier));
  const digest = (text) => createHmac("sha256", config.secret).update(text).digest("hex");
  function maskIdentifier(channel, identifier) {
    if (channel === "phone") return identifier.slice(0, 3) + "****" + identifier.slice(-4);
    const [name, domain] = identifier.split("@");
    return (name[0] || "*") + "***@" + (domain || "");
  }
  function recordEvent(eventType, { channel = null, identifier = null, userId = null, outcome = "success" } = {}) {
    try {
      db.prepare("INSERT INTO auth_events(id,event_type,channel,identifier,user_id,outcome,created_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), eventType, channel, identifier ? maskIdentifier(channel, identifier) : null, userId, outcome, new Date(now()).toISOString());
      db.prepare("DELETE FROM auth_events WHERE created_at < ?").run(new Date(now() - 180 * 86400000).toISOString());
    } catch {
      // Analytics must never break an authentication flow.
    }
  }
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function rate(key, limit, windowMs = 60000) {
    const timestamp = now();
    const hashed = digest(key);
    transaction(() => {
      db.prepare("DELETE FROM auth_rates WHERE started_at < ?").run(timestamp - 86400000);
      const entry = db.prepare("SELECT * FROM auth_rates WHERE key = ?").get(hashed);
      if (entry && entry.started_at > timestamp - windowMs) {
        if (entry.count >= limit) fail(429, "RATE_LIMITED", "尝试过于频繁，请稍后再试。");
        db.prepare("UPDATE auth_rates SET count = count + 1 WHERE key = ?").run(hashed);
      } else db.prepare("INSERT OR REPLACE INTO auth_rates(key, started_at, count) VALUES (?, ?, 1)").run(hashed, timestamp);
    });
  }
  function address(req) {
    const socketAddress = req.socket?.remoteAddress || "unknown";
    const cfAddress = req.headers["cf-connecting-ip"];
    if (config.trustProxy && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(socketAddress) && typeof cfAddress === "string" && /^[a-fA-F0-9:.]{3,45}$/.test(cfAddress)) return cfAddress;
    return socketAddress;
  }
  function signature(value) { return createHmac("sha256", config.secret).update(value).digest("base64url"); }
  function cookie(res, token, maxAge = config.sessionTtlSeconds) {
    res.setHeader("set-cookie", `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secureCookie ? "; Secure" : ""}`);
  }
  function createSession(user, res) {
    const timestamp = Math.floor(now() / 1000);
    const id = randomBytes(24).toString("hex");
    const expiresAt = timestamp + config.sessionTtlSeconds;
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(timestamp);
    db.prepare("INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES (?,?,?,?)").run(id, user.id, expiresAt, timestamp);
    const payload = Buffer.from(JSON.stringify({ iss: "tango-donego", aud: "tango-donego-web", sub: user.id, jti: id, iat: timestamp, exp: expiresAt })).toString("base64url");
    const unsigned = `${JWT_HEADER}.${payload}`;
    cookie(res, `${unsigned}.${signature(unsigned)}`);
  }
  function session(req) {
    const cookies = String(req.headers.cookie || "").split(";").map((part) => part.trim());
    const entry = cookies.find((part) => part.startsWith(`${cookieName}=`));
    if (!entry) fail(401, "AUTH_REQUIRED", "请先登录。");
    const token = entry.slice(cookieName.length + 1);
    if (token.length > 2048) fail(401, "AUTH_INVALID", "登录已失效，请重新登录。");
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== JWT_HEADER || !/^[\w-]{43}$/.test(parts[2])) fail(401, "AUTH_INVALID", "登录已失效，请重新登录。");
    const expected = signature(`${parts[0]}.${parts[1]}`);
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) fail(401, "AUTH_INVALID", "登录已失效，请重新登录。");
    let claims;
    try { claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { fail(401, "AUTH_INVALID", "登录已失效，请重新登录。"); }
    const timestamp = Math.floor(now() / 1000);
    if (!claims || typeof claims !== "object" || claims.iss !== "tango-donego" || claims.aud !== "tango-donego-web" || typeof claims.sub !== "string" || typeof claims.jti !== "string" || !Number.isInteger(claims.exp) || claims.exp <= timestamp) fail(401, "AUTH_INVALID", "登录已失效，请重新登录。");
    const record = db.prepare("SELECT * FROM sessions WHERE id = ? AND user_id = ? AND expires_at > ?").get(claims.jti, claims.sub, timestamp);
    const user = getUser(claims.sub);
    if (!record || !user) fail(401, "AUTH_INVALID", "登录已失效，请重新登录。");
    if (!user.is_active) fail(401, "ACCOUNT_INACTIVE", "账号已停用，请联系管理员。");
    return { user, sessionId: record.id };
  }
  function authenticate(req) { return publicUser(session(req).user); }
  function requireAdmin(req) {
    const user = authenticate(req);
    if (user.role !== "admin") fail(403, "ADMIN_REQUIRED", "此操作需要管理员权限。");
    return user;
  }

  async function sendCode(body, req) {
    const target = identifierInput(body);
    const purpose = body.purpose === undefined ? "register" : body.purpose;
    if (!["register", "reset", "login"].includes(purpose)) fail(400, "INVALID_PURPOSE", "验证码用途无效。");
    rate(`send-ip:${address(req)}`, 5);
    rate(`send-${target.channel}:${target.identifier}`, 5, 3600000);
    if (target.channel === "email" && config.transport === "disabled") fail(503, "EMAIL_UNAVAILABLE", "邮箱验证服务尚未配置，请联系管理员。");
    if (target.channel === "phone" && config.transport !== "console") fail(503, "PHONE_UNAVAILABLE", "短信验证服务尚未配置，请联系管理员。");
    const timestamp = now();
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    const id = randomUUID();
    transaction(() => {
      db.prepare("DELETE FROM email_verifications WHERE expires_at < ?").run(timestamp - 86400000);
      const previous = db.prepare("SELECT created_at FROM email_verifications WHERE email = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1").get(target.identifier, purpose);
      if (previous && timestamp - previous.created_at < config.codeResendSeconds * 1000) fail(429, "CODE_COOLDOWN", "验证码已发送，请稍后再试。");
      db.prepare("UPDATE email_verifications SET consumed = 1 WHERE email = ? AND purpose = ?").run(target.identifier, purpose);
      db.prepare("INSERT INTO email_verifications(id,email,channel,purpose,code_hash,created_at,expires_at) VALUES (?,?,?,?,?,?,?)").run(id, target.identifier, target.channel, purpose, digest(`${target.identifier}:${purpose}:${code}`), timestamp, timestamp + config.codeTtlSeconds * 1000);
    });
    const exists = Boolean(userByIdentifier(target));
    if ((purpose === "register" && exists) || (purpose !== "register" && !exists)) {
      db.prepare("UPDATE email_verifications SET consumed = 1, delivery = 'suppressed' WHERE id = ?").run(id);
      return { status: "sent" };
    }
    try {
      if (target.channel === "phone") await sendSms({ phone: target.identifier, code, purpose });
      else await sendEmail({ email: target.identifier, code, purpose });
    } catch {
      db.prepare("UPDATE email_verifications SET consumed = 1, delivery = 'failed' WHERE id = ?").run(id);
      recordEvent("code_send_failed", { channel: target.channel, identifier: target.identifier, outcome: "failure" });
      if (target.channel === "phone") fail(503, "PHONE_DELIVERY_FAILED", "验证码未能发送，请稍后重试。");
      fail(503, "EMAIL_DELIVERY_FAILED", "验证码未能发送，请稍后重试。");
    }
    db.prepare("UPDATE email_verifications SET delivery = 'sent' WHERE id = ?").run(id);
    recordEvent("code_sent", { channel: target.channel, identifier: target.identifier });
    return config.transport === "console" && !config.publicOrigin && !config.production ? { status: "sent", devCode: code } : { status: "sent" };
  }

  function verifyCode(identifier, code, purpose) {
    const row = db.prepare("SELECT * FROM email_verifications WHERE email = ? AND purpose = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(identifier, purpose);
    const valid = typeof code === "string" && /^\d{6}$/.test(code);
    if (!row || row.consumed || row.delivery !== "sent" || row.expires_at <= now() || row.attempts >= 5) fail(400, "INVALID_CODE", "验证码无效或已过期，请重新获取。");
    // The attempt increment must survive an invalid-code response.
    db.prepare("UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?").run(row.id);
    const expected = Buffer.from(row.code_hash);
    const actual = Buffer.from(digest(`${identifier}:${purpose}:${code}`));
    if (!valid || expected.length !== actual.length || !timingSafeEqual(expected, actual)) fail(400, "INVALID_CODE", "验证码无效或已过期，请重新获取。");
    return row.id;
  }
  async function register(body, req, res) {
    rate(`register-ip:${address(req)}`, 5);
    const target = identifierInput(body);
    if (body.confirmPassword !== body.password) fail(400, "PASSWORD_MISMATCH", "两次输入的密码不一致。");
    const password = passwordInput(body.password);
    const fallbackName = target.channel === "phone" ? `用户${target.identifier.slice(-4)}` : target.identifier.split("@")[0];
    const displayName = nameInput(body.displayName, fallbackName);
    // Hash outside the transaction so account creation remains atomic.
    const passwordHash = await hashPassword(password);
    const id = randomUUID();
    transaction(() => {
      if (userByIdentifier(target)) fail(400, "REGISTRATION_FAILED", "该账号无法注册，请尝试登录。");
      const storedEmail = target.channel === "phone" ? phoneEmail(target.identifier) : target.identifier;
      if (userByEmail(storedEmail)) fail(400, "REGISTRATION_FAILED", "该账号无法注册，请尝试登录。");
      db.prepare("INSERT INTO users(id,email,phone,display_name,password_hash,created_at,role,account_kind) VALUES (?,?,?,?,?,?,?,?)").run(id, storedEmail, target.channel === "phone" ? target.identifier : null, displayName, passwordHash, new Date(now()).toISOString(), target.channel === "email" && config.adminEmails.includes(target.identifier) ? "admin" : "user", target.channel);
    });
    const user = getUser(id);
    recordEvent("register_success", { channel: target.channel, identifier: target.identifier, userId: id });
    if (!requireLoginAfterRegistration) createSession(user, res);
    return { user: publicUser(user) };
  }
  async function login(body, req, res) {
    rate(`login-ip:${address(req)}`, 10);
    const target = localAccounts && body.username !== undefined ? { channel: "email", identifier: localEmail(body.username) } : identifierInput(body);
    rate(`login-${target.channel}:${target.identifier}`, 10);
    if (typeof body.password !== "string" || Buffer.byteLength(body.password) > 256) fail(401, "LOGIN_FAILED", "账号或密码不正确。");
    const user = userByIdentifier(target);
    const valid = await verifyPassword(body.password, user?.password_hash);
    if (!valid || !user) {
      recordEvent("login_password_failure", { channel: target.channel, identifier: target.identifier, outcome: "failure" });
      fail(401, "LOGIN_FAILED", "账号或密码不正确。");
    }
    const fresh = getUser(user.id);
    if (!fresh || fresh.password_hash !== user.password_hash) {
      recordEvent("login_password_failure", { channel: target.channel, identifier: target.identifier, outcome: "failure" });
      fail(401, "LOGIN_FAILED", "账号或密码不正确。");
    }
    if (!fresh.is_active) fail(401, "ACCOUNT_INACTIVE", "账号已停用，请联系管理员。");
    createSession(fresh, res);
    recordEvent("login_password_success", { channel: target.channel, identifier: target.identifier, userId: fresh.id });
    return { user: publicUser(fresh) };
  }
  async function loginCode(body, req, res) {
    rate(`login-code-ip:${address(req)}`, 10);
    const target = identifierInput(body);
    rate(`login-code-${target.channel}:${target.identifier}`, 10);
    try {
      const codeId = verifyCode(target.identifier, body.code, "login");
      let userId;
      transaction(() => {
        const user = userByIdentifier(target);
        if (!user || !user.is_active) fail(401, "LOGIN_FAILED", "账号或验证码不正确。");
        const consumed = db.prepare("UPDATE email_verifications SET consumed = 1 WHERE id = ? AND consumed = 0 AND expires_at > ?").run(codeId, now());
        if (consumed.changes !== 1) fail(400, "INVALID_CODE", "验证码无效或已过期，请重新获取。");
        userId = user.id;
      });
      const user = getUser(userId);
      createSession(user, res);
      recordEvent("login_code_success", { channel: target.channel, identifier: target.identifier, userId: user.id });
      return { user: publicUser(user) };
    } catch (error) {
      if (error instanceof AuthError) recordEvent("login_code_failure", { channel: target.channel, identifier: target.identifier, outcome: "failure" });
      throw error;
    }
  }
  function localEmail(username) {
    if (typeof username !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,39}$/.test(username)) fail(400, "INVALID_USERNAME", "用户名需为3–40位字母、数字、点、横线或下划线。");
    return username.toLowerCase() + "@accounts.tango.invalid";
  }
  async function registerLocal(body, req, res) {
    if (!localAccounts || config.production || config.publicOrigin) fail(403, "LOCAL_REGISTRATION_DISABLED", "当前服务不开放本地账号注册。");
    rate(`local-register:${address(req)}`, 10, 3600000);
    const email = localEmail(body.username), password = passwordInput(body.password), name = nameInput(body.displayName, body.username);
    const hash = await hashPassword(password), id = randomUUID();
    transaction(() => {
      if (userByEmail(email)) fail(409, "USERNAME_TAKEN", "这个用户名已被使用。");
      db.prepare("INSERT INTO users(id,email,display_name,password_hash,created_at,role,account_kind) VALUES (?,?,?,?,?,?,?)").run(id, email, name, hash, new Date(now()).toISOString(), "user", "local");
    });
    const user = getUser(id); createSession(user, res); return { user: publicUser(user) };
  }
  async function resetPassword(body, req) {
    rate(`reset-ip:${address(req)}`, 5);
    const target = identifierInput(body);
    const hash = await hashPassword(passwordInput(body.newPassword));
    const codeId = verifyCode(target.identifier, body.code, "reset");
    transaction(() => {
      const user = userByIdentifier(target);
      if (!user) fail(400, "INVALID_CODE", "验证码无效或已过期，请重新获取。");
      db.prepare("UPDATE email_verifications SET consumed = 1 WHERE id = ?").run(codeId);
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    });
    return { status: "ok" };
  }

  async function handle(req, res, body = {}) {
    const url = (req.url || "/").split("?")[0];
    if (!url.startsWith("/api/auth/") && !url.startsWith("/api/admin/")) return false;
    try {
      if (!authRequestAllowed(req, config)) fail(403, "FORBIDDEN", "请求来源不被允许。");
      if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "INVALID_BODY", "请求内容无效。");
      const method = req.method || "GET";
      let payload;
      if (method === "GET" && url === "/api/auth/status") payload = { enabled: true, localAccounts, requireLoginAfterRegistration, emailDelivery: config.transport === "disabled" ? "unavailable" : config.transport === "console" ? "console" : "email", phoneDelivery: config.transport === "console" ? "console" : "unavailable", codeLogin: false, registrationEnabled: true, passwordMinLength: PASSWORD_MIN, passwordMaxLength: PASSWORD_MAX, codeResendSeconds: config.codeResendSeconds };
      else if (method === "POST" && url === "/api/auth/local-register") payload = await registerLocal(body, req, res);
      else if (method === "POST" && url === "/api/auth/send-code") payload = await sendCode(body, req);
      else if (method === "POST" && url === "/api/auth/register") payload = await register(body, req, res);
      else if (method === "POST" && url === "/api/auth/login") payload = await login(body, req, res);
      else if (method === "POST" && url === "/api/auth/login-code") payload = await loginCode(body, req, res);
      else if (method === "POST" && url === "/api/auth/reset-password") payload = await resetPassword(body, req);
      else if (method === "POST" && url === "/api/auth/logout") {
        try {
          const current = session(req);
          db.prepare("DELETE FROM sessions WHERE id = ?").run(current.sessionId);
          recordEvent("logout", { channel: current.user.account_kind === "phone" ? "phone" : current.user.account_kind === "email" ? "email" : null, identifier: current.user.account_kind === "phone" ? current.user.phone : current.user.email, userId: current.user.id });
        } catch (error) { if (!(error instanceof AuthError)) throw error; }
        cookie(res, "", 0); payload = { status: "ok" };
      } else if (method === "GET" && url === "/api/auth/me") payload = { user: authenticate(req) };
      else if (method === "PUT" && url === "/api/auth/me") {
        const user = authenticate(req);
        const displayName = nameInput(body.displayName, user.displayName);
        if (body.settings !== undefined && (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings) || JSON.stringify(body.settings).length > 8000)) fail(400, "INVALID_SETTINGS", "个人设置无效或过长。");
        db.prepare("UPDATE users SET display_name = ?, settings_json = ? WHERE id = ?").run(displayName, JSON.stringify(body.settings ?? user.settings), user.id);
        payload = { user: publicUser(getUser(user.id)) };
      } else if (method === "PUT" && url === "/api/auth/me/password") {
        const current = session(req);
        rate(`password:${current.user.id}`, 5);
        if (typeof body.oldPassword !== "string" || Buffer.byteLength(body.oldPassword) > 256 || !await verifyPassword(body.oldPassword, current.user.password_hash)) fail(400, "PASSWORD_MISMATCH", "原密码不正确。");
        const hash = await hashPassword(passwordInput(body.newPassword));
        const fresh = getUser(current.user.id);
        if (!fresh?.is_active || fresh.password_hash !== current.user.password_hash) fail(401, "AUTH_INVALID", "登录状态已变化，请重新登录。");
        transaction(() => {
          db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, fresh.id);
          db.prepare("DELETE FROM sessions WHERE user_id = ?").run(fresh.id);
        });
        createSession(getUser(fresh.id), res); payload = { status: "ok" };
      } else if (url.startsWith("/api/admin/")) {
        const admin = requireAdmin(req);
        const match = /^\/api\/admin\/users\/([a-f0-9-]{36})$/.exec(url);
        if (method === "GET" && url === "/api/admin/analytics") {
          const totalsRow = db.prepare("SELECT COUNT(*) AS users, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS activeUsers, SUM(CASE WHEN account_kind = 'email' THEN 1 ELSE 0 END) AS emailAccounts, SUM(CASE WHEN account_kind = 'phone' THEN 1 ELSE 0 END) AS phoneAccounts, SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins FROM users").get();
          const activeSessions = db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ?").get(Math.floor(now() / 1000)).count;
          const registrationsByDay = db.prepare("SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS count FROM users GROUP BY date ORDER BY date DESC LIMIT 30").all();
          const eventsByType = db.prepare("SELECT event_type AS type, COUNT(*) AS count FROM auth_events GROUP BY event_type ORDER BY count DESC").all();
          const eventsByDay = db.prepare("SELECT substr(created_at, 1, 10) AS date, event_type AS type, COUNT(*) AS count FROM auth_events GROUP BY date, event_type ORDER BY date DESC LIMIT 180").all();
          const recentEvents = db.prepare("SELECT id, event_type AS type, channel, identifier, user_id AS userId, outcome, created_at AS createdAt FROM auth_events ORDER BY created_at DESC, rowid DESC LIMIT 50").all();
          payload = { totals: { users: totalsRow.users || 0, activeUsers: totalsRow.activeUsers || 0, emailAccounts: totalsRow.emailAccounts || 0, phoneAccounts: totalsRow.phoneAccounts || 0, admins: totalsRow.admins || 0, activeSessions }, registrationsByDay, eventsByType, eventsByDay, recentEvents };
        } else if (method === "GET" && url === "/api/admin/users") {
          const limit = Number(new URL(req.url, "http://localhost").searchParams.get("limit") || 100);
          if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail(400, "INVALID_LIMIT", "用户数量上限无效。");
          const rows = db.prepare("SELECT * FROM users ORDER BY created_at DESC, id LIMIT ?").all(limit);
          payload = { users: await Promise.all(rows.map(async (row) => ({ ...publicUser(row), resourceCount: await resourceHooks.countUserResources?.(row.id) ?? 0 }))) };
        } else if (match && ["PATCH", "DELETE"].includes(method)) {
          const target = getUser(match[1]);
          if (!target) fail(404, "USER_NOT_FOUND", "账号不存在。");
          if (target.id === admin.id) fail(400, "SELF_MODIFICATION", "不能在此停用或删除自己的管理员账号。");
          if (method === "PATCH") {
            if (typeof body.isActive !== "boolean") fail(400, "INVALID_STATUS", "账号状态无效。");
            transaction(() => {
              db.prepare("UPDATE users SET is_active = ? WHERE id = ?").run(body.isActive ? 1 : 0, target.id);
              if (!body.isActive) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(target.id);
            });
            payload = { user: publicUser(getUser(target.id)) };
          } else {
            await resourceHooks.onUserDeleted?.(target.id,{actor:publicUser(getUser(admin.id))});
            transaction(() => {
              db.prepare("DELETE FROM email_verifications WHERE email = ? OR email = ?").run(target.email, target.phone);
              db.prepare("DELETE FROM users WHERE id = ?").run(target.id);
            });
            payload = { status: "deleted" };
          }
        } else fail(404, "NOT_FOUND", "接口不存在。");
      } else fail(404, "NOT_FOUND", "接口不存在。");
      send(res, 200, payload);
    } catch (error) {
      if (error instanceof AuthError) send(res, error.status, { error: error.code, detail: { code: error.code, message: error.message } });
      else send(res, 500, { error: "AUTH_INTERNAL", detail: { code: "AUTH_INTERNAL", message: "账号服务暂时不可用，请稍后再试。" } });
    }
    return true;
  }
  return { handle, authenticate, requireAdmin, throttle: rate, userById: id => { const user = getUser(id); return user && user.is_active ? publicUser(user) : null; }, close: () => db.close() };
}
