import { isLoopbackHostname } from "../urlguard.mjs";

function integer(value, fallback, min, max, name) {
  const result = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`Invalid ${name}`);
  return result;
}

export function readAuthConfig(env = process.env) {
  const publicOrigin = env.TANGO_PUBLIC_ORIGIN || "";
  const production = env.ENV === "production" || env.NODE_ENV === "production";
  if (publicOrigin) {
    const parsed = new URL(publicOrigin);
    if (parsed.origin !== publicOrigin || parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("TANGO_PUBLIC_ORIGIN must be an exact HTTPS origin");
    }
  }
  const secret = env.TANGO_AUTH_SECRET || env.JWT_SECRET || "";
  if (Buffer.byteLength(secret) < 32) throw new Error("TANGO_AUTH_SECRET must contain at least 32 bytes");
  const transport = env.EMAIL_TRANSPORT || "disabled";
  if (!["disabled", "console", "resend", "smtp"].includes(transport)) throw new Error("Invalid EMAIL_TRANSPORT");
  if ((publicOrigin || production) && transport === "console") throw new Error("Console verification is prohibited in production or for a public origin");
  if (transport === "resend" && !env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is required");
  if (transport === "smtp" && (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS)) throw new Error("SMTP_HOST, SMTP_USER and SMTP_PASS are required");
  if (["smtp", "resend"].includes(transport) && (!env.MAIL_FROM || /[\r\n]/.test(env.MAIL_FROM))) throw new Error("MAIL_FROM is required");
  return {
    secret,
    publicOrigin,
    production,
    transport,
    secureCookie: Boolean(publicOrigin || production),
    trustProxy: env.TANGO_TRUST_CLOUDFLARE === "1",
    adminEmails: (env.ADMIN_EMAILS || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
    sessionTtlSeconds: integer(env.JWT_EXPIRY_HOURS, 72, 1, 720, "JWT_EXPIRY_HOURS") * 3600,
    codeTtlSeconds: integer(env.CODE_TTL_SECONDS, 600, 60, 1800, "CODE_TTL_SECONDS"),
    codeResendSeconds: integer(env.CODE_RESEND_SECONDS, 60, 1, 3600, "CODE_RESEND_SECONDS"),
    resendApiKey: env.RESEND_API_KEY || "",
    mailFrom: env.MAIL_FROM || "",
    smtpHost: env.SMTP_HOST || "",
    smtpPort: integer(env.SMTP_PORT, 587, 1, 65535, "SMTP_PORT"),
    smtpUser: env.SMTP_USER || "",
    smtpPassword: env.SMTP_PASS || "",
  };
}

export function authRequestAllowed(req, config) {
  if (req.headers["x-tango-client"] !== "tango-settings/1") return false;
  let host;
  try { host = new URL(`http://${req.headers.host}`).hostname; } catch { return false; }
  const loopback = isLoopbackHostname(host);
  if (!loopback && (!config.publicOrigin || host !== new URL(config.publicOrigin).hostname)) return false;
  const origin = req.headers.origin;
  if (!origin) return loopback || req.method === "GET" || req.method === "HEAD";
  if (origin === config.publicOrigin) return true;
  try {
    const parsed = new URL(origin);
    // 本机页面（http://localhost）只在非生产时放行：Mac 开发机同时挂着公网地址，本机也要能注册登录
    return (!config.publicOrigin || !config.production) && loopback && isLoopbackHostname(parsed.hostname) && parsed.protocol === "http:";
  } catch { return false; }
}
