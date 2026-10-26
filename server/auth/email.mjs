// Verification email for the mail2profile auth chain. The transport contract
// (a sender invoked with {email, code, purpose}) and the auth endpoints are
// untouched; this module only decides what the rendered message looks like.
// Visual language mirrors web/index.html: sage palette, Noto Serif SC
// headings, Noto Sans SC body, pill/28px radii, tabular serif numerals.

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

const BRAND = { name: "探戈", latin: "Done&Go", slogan: "从一件件的小事里拥抱我们的大时代" };
const SERIF = "'Noto Serif SC','Songti SC','STSong',serif";
const SANS = "'Noto Sans SC','PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,sans-serif";

function renderVerificationEmail({ code, purpose, minutes }) {
  const label = { register: "注册账号", reset: "重置密码", login: "登录" }[purpose] || "账号验证";
  const subject = `${BRAND.name} ${BRAND.latin} ${label}验证码`;
  const text = [
    `${BRAND.name} ${BRAND.latin} —— ${label}验证码`,
    "",
    `你正在${label}。请在页面的验证码输入框中填写以下验证码：`,
    "",
    code,
    "",
    `· ${minutes} 分钟内有效`,
    "· 验证码仅可使用一次，过期后需重新获取",
    "· 如果不是你本人操作，请忽略此邮件，无需任何进一步操作",
    "",
    BRAND.slogan,
    "此邮件由系统自动发送，请勿直接回复。",
  ].join("\n");
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
<style>
  @media (max-width: 480px) {
    .card { border-radius: 20px !important; padding: 28px 20px !important; }
    .code { font-size: 32px !important; letter-spacing: .22em !important; }
  }
</style>
</head>
<body style="margin:0;padding:24px 12px;background:#EEF3EC;color:#22302A;font-family:${SANS};font-size:15px;line-height:1.55;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
<table role="presentation" width="440" cellpadding="0" cellspacing="0" border="0" style="max-width:440px;width:100%;background:#FFFFFF;border:1px solid rgba(34,48,42,.14);border-radius:28px;"><tr><td class="card" style="padding:36px 32px;">
<p style="margin:0;font-family:${SERIF};font-size:22px;letter-spacing:.12em;color:#22302A;">${escapeHtml(BRAND.name)}<span style="font-family:${SANS};font-size:13px;letter-spacing:.04em;color:#5C6B61;">&nbsp;${escapeHtml(BRAND.latin)}</span></p>
<p style="margin:2px 0 28px;font-size:13px;letter-spacing:.06em;color:#5C6B61;">${escapeHtml(BRAND.slogan)}</p>
<h1 style="margin:0 0 14px;font-family:${SERIF};font-weight:400;font-size:28px;line-height:1.3;color:#22302A;">${escapeHtml(label)}验证码</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.55;">你正在${escapeHtml(label)}。请在页面的验证码输入框中填写以下验证码：</p>
<div class="code" style="margin:0 0 24px;padding:18px 20px;background:#FCFBF6;border:1px solid rgba(34,48,42,.14);border-radius:20px;font-family:${SERIF};font-size:40px;letter-spacing:.35em;text-align:center;color:#2E4636;font-variant-numeric:tabular-nums;">${escapeHtml(code)}</div>
<p style="margin:0 0 6px;font-size:13px;line-height:1.6;color:#5C6B61;">· ${minutes} 分钟内有效</p>
<p style="margin:0 0 18px;font-size:13px;line-height:1.6;color:#5C6B61;">· 验证码仅可使用一次，过期后需重新获取</p>
<p style="margin:0;padding-top:18px;border-top:1px solid rgba(34,48,42,.14);font-size:13px;line-height:1.6;color:#5C6B61;">如果不是你本人操作，请忽略此邮件，无需任何进一步操作。</p>
</td></tr></table>
<p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:#5C6B61;">此邮件由系统自动发送，请勿直接回复。</p>
</td></tr></table>
</body>
</html>`;
  return { subject, text, html };
}

export function createEmailSender(config, { fetchImpl = fetch, consoleLog = console.log } = {}) {
  return async ({ email, code, purpose }) => {
    const { subject, text, html } = renderVerificationEmail({ code, purpose, minutes: Math.floor(config.codeTtlSeconds / 60) });
    const message = {
      from: config.mailFrom,
      to: [email],
      subject,
      text,
      html,
    };
    if (config.transport === "console") {
      if (config.publicOrigin || config.production) throw new Error("console_prohibited");
      consoleLog(`[Tango Done&Go local verification] ${email} ${purpose} ${code}`);
      return;
    }
    if (config.transport === "resend") {
      const response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.resendApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(message),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error("email_delivery_failed"); }
      await response.body?.cancel();
      return;
    }
    if (config.transport === "smtp") {
      const { default: nodemailer } = await import("nodemailer");
      const transport = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpPort === 465,
        requireTLS: config.smtpPort !== 465,
        auth: { user: config.smtpUser, pass: config.smtpPassword },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 15000,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      try { await transport.sendMail(message); } finally { transport.close(); }
      return;
    }
    throw new Error("email_unavailable");
  };
}

export function createSmsSender(config, { consoleLog = console.log } = {}) {
  return async ({ phone, code, purpose }) => {
    if (config.transport === "console") {
      if (config.publicOrigin || config.production) throw new Error("console_prohibited");
      consoleLog(`[Tango Done&Go local SMS verification] ${phone} ${purpose} ${code}`);
      return;
    }
    throw new Error("sms_unavailable");
  };
}
