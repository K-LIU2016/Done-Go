export function createEmailSender(config, { fetchImpl = fetch, consoleLog = console.log } = {}) {
  return async ({ email, code, purpose }) => {
    const label = purpose === "register" ? "注册账号" : "重置密码";
    const text = `Tango Done&Go 静驻\n\n你正在${label}。验证码：${code}\n${Math.floor(config.codeTtlSeconds / 60)} 分钟内有效。如果不是你本人操作，请忽略此邮件。`;
    const message = {
      from: config.mailFrom,
      to: [email],
      subject: `Tango Done&Go ${label}验证码`,
      text,
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
