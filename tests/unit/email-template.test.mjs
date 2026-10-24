import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmailSender } from "../../server/auth/email.mjs";
import { readAuthConfig } from "../../server/auth/config.mjs";

// Template-level contract for the mail2profile verification email.
// The transport contract (sendEmail({email, code, purpose})) and every
// endpoint of the auth service stay untouched; these tests only pin what
// the rendered message must contain and must never leak.
const config = (extra = {}) => readAuthConfig({
  TANGO_AUTH_SECRET: "template-test-secret-with-at-least-32-bytes",
  EMAIL_TRANSPORT: "resend",
  RESEND_API_KEY: "test-only",
  MAIL_FROM: "Done-Go <noreply@example.test>",
  ...extra,
});

function captureSender(extraConfig = {}) {
  let captured;
  const sender = createEmailSender(config(extraConfig), {
    fetchImpl: async (url, options) => { captured = { url, options }; return new Response("OK"); },
  });
  return { sender, message: () => JSON.parse(captured.options.body) };
}

test("verification email renders brand, code, purpose, expiry and safety copy in responsive HTML with a plain-text fallback", async () => {
  const { sender, message } = captureSender({ CODE_TTL_SECONDS: "600" });
  await sender({ email: "alice@example.test", code: "482913", purpose: "register" });
  const mail = message();
  // Display-name sender passes through verbatim (Resend supports "Name <addr>").
  assert.equal(mail.from, "Done-Go <noreply@example.test>");
  // Subject carries the product name and the purpose label.
  assert.match(mail.subject, /探戈 Done&Go 注册账号验证码/);
  assert.ok(mail.html, "html part must exist");
  assert.ok(mail.text, "plain-text fallback must exist");
  // Brand identity in the same voice as the web header (web/index.html:478).
  assert.match(mail.html, /探戈/);
  assert.match(mail.html, /Done&amp;Go/);
  // The code is the visual anchor of the message.
  assert.match(mail.html, />482913</);
  // Purpose, expiry and safety copy.
  assert.match(mail.html, /你正在注册账号/);
  assert.match(mail.html, /10 分钟内有效/);
  assert.match(mail.html, /仅可使用一次/);
  assert.match(mail.html, /如果不是你本人操作/);
  // Responsive: viewport media query plus a capped content width.
  assert.match(mail.html, /@media/);
  assert.match(mail.html, /max-width/);
  // Plain-text fallback carries the same facts.
  assert.match(mail.text, /482913/);
  assert.match(mail.text, /你正在注册账号/);
  assert.match(mail.text, /10 分钟内有效/);
  assert.match(mail.text, /仅可使用一次/);
  assert.match(mail.text, /如果不是你本人操作/);
});

test("expiry minutes follow CODE_TTL_SECONDS instead of a hardcoded number", async () => {
  const { sender, message } = captureSender({ CODE_TTL_SECONDS: "300" });
  await sender({ email: "alice@example.test", code: "778899", purpose: "register" });
  const mail = message();
  assert.match(mail.html, /5 分钟内有效/);
  assert.equal(mail.html.includes("10 分钟"), false);
  assert.match(mail.text, /5 分钟内有效/);
});

test("reset purpose renders the reset label in subject, HTML and text", async () => {
  const { sender, message } = captureSender();
  await sender({ email: "alice@example.test", code: "998877", purpose: "reset" });
  const mail = message();
  assert.match(mail.subject, /重置密码/);
  assert.match(mail.html, /你正在重置密码/);
  assert.match(mail.text, /你正在重置密码/);
});

test("HTML escapes every interpolated value and never leaks keys, paths or debug detail", async () => {
  const { sender, message } = captureSender();
  await sender({ email: "alice@example.test", code: '<img src=x onerror="alert(1)">', purpose: "register" });
  const mail = message();
  assert.equal(mail.html.includes("<img"), false);
  assert.equal(mail.html.includes("<script"), false);
  assert.match(mail.html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  for (const part of [mail.subject, mail.text, mail.html]) {
    assert.equal(part.includes("test-only"), false, "provider key must not appear in the message");
    assert.equal(part.includes("RESEND_API_KEY"), false);
    assert.equal(part.includes("Bearer"), false);
    assert.equal(part.includes("/home/"), false, "no internal paths");
    assert.equal(part.includes("/Users/"), false, "no internal paths");
  }
});

test("rendered HTML is a complete, balanced document", async () => {
  const { sender, message } = captureSender();
  await sender({ email: "alice@example.test", code: "123456", purpose: "register" });
  const mail = message();
  assert.match(mail.html, /^<!doctype html>/i);
  assert.match(mail.html, /<\/html>\s*$/i);
  for (const tag of ["div", "table", "tr", "td", "p", "body", "html"]) {
    const opened = (mail.html.match(new RegExp(`<${tag}\\b`, "g")) || []).length;
    const closed = (mail.html.match(new RegExp(`</${tag}>`, "g")) || []).length;
    assert.equal(opened, closed, `<${tag}> tags must balance (${opened} vs ${closed})`);
  }
});

test("console transport keeps the pinned local terminal line", async () => {
  const logged = [];
  const sender = createEmailSender(readAuthConfig({
    TANGO_AUTH_SECRET: "template-test-secret-with-at-least-32-bytes",
    EMAIL_TRANSPORT: "console",
  }), { consoleLog: (line) => logged.push(line) });
  await sender({ email: "smoke@example.test", code: "123456", purpose: "register" });
  assert.match(logged[0], /\[Tango Done&Go local verification\] smoke@example\.test register 123456/);
});
