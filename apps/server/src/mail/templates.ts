import type { Mail } from "./mailer.js";

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** One plain layout for every message. User-supplied values are escaped; links are built by the server. */
function layout(heading: string, paragraphs: string[], action?: { label: string; url: string }, footer?: string) {
  const text = [heading, "", ...paragraphs, ...(action ? ["", `${action.label}: ${action.url}`] : []), ...(footer ? ["", footer] : []), "", "FlagForge"].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a18">
<h1 style="font-size:20px;margin:0 0 16px">${escape(heading)}</h1>
${paragraphs.map((p) => `<p style="line-height:1.5;margin:0 0 12px">${escape(p)}</p>`).join("\n")}
${action ? `<p style="margin:24px 0"><a href="${escape(action.url)}" style="background:#1a1a18;color:#fff;padding:10px 16px;border-radius:3px;text-decoration:none">${escape(action.label)}</a></p><p style="font-size:12px;color:#666;word-break:break-all">${escape(action.url)}</p>` : ""}
${footer ? `<p style="font-size:12px;color:#666;margin-top:24px">${escape(footer)}</p>` : ""}
</div>`;
  return { text, html };
}

export function verifyEmailMail(to: string, name: string, url: string, hours: number): Mail {
  return {
    to,
    subject: "Confirm your email for FlagForge",
    ...layout(`Welcome, ${name}`, ["Confirm that this is your email address so teammates can add you to workspaces and so you can recover your account."], { label: "Confirm email", url }, `The link works once and expires in ${hours} hours. If you did not create a FlagForge account, ignore this message.`),
  };
}

export function resetPasswordMail(to: string, url: string, minutes: number): Mail {
  return {
    to,
    subject: "Reset your FlagForge password",
    ...layout("Reset your password", ["Someone asked to reset the password for this account. If it was you, choose a new one with the button below."], { label: "Choose a new password", url }, `The link works once and expires in ${minutes} minutes. If you did not ask for this, ignore this message: your password has not changed.`),
  };
}

export function passwordChangedMail(to: string): Mail {
  return {
    to,
    subject: "Your FlagForge password was changed",
    ...layout("Your password was changed", ["The password for this account was just changed, and you were signed out everywhere.", "If this was you, there is nothing to do. If it was not, reset your password straight away and check who has access to your email."]),
  };
}
