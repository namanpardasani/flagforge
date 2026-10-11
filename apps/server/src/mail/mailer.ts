import type { Logger } from "pino";

export interface Mail {
  to: string;
  subject: string;
  /** Plain text. Always provided: some clients show only this, and it is what the log sender prints. */
  text: string;
  html?: string;
}

/** Everything the app needs from email. Swapping providers means writing one small class. */
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/**
 * Development: no email leaves the machine. The message, including its link, is written to the
 * server log, which is how you click "verify" without an email account.
 * Never used in production (config refuses it): the links are secrets and logs are not private.
 */
export class LogMailer implements Mailer {
  constructor(private readonly logger: Logger) {}
  async send(mail: Mail): Promise<void> {
    // One line, ending with the link, so it can be copied straight from the terminal. (The full
    // text contains the same link, and in JSON logs its line breaks become unreadable "\n".)
    const link = /https?:\/\/\S+/.exec(mail.text)?.[0] ?? "(no link)";
    this.logger.info({ to: mail.to, subject: mail.subject }, `EMAIL (development, not sent) to ${mail.to}: ${mail.subject} -> ${link}`);
  }
}

/** Tests: keeps what was "sent" so assertions can read it. */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];
  /** Make the next send fail, to test that a broken mail provider does not break the app. */
  failNext = false;
  async send(mail: Mail): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("mail provider unavailable");
    }
    this.sent.push(mail);
  }
  /** The most recent message to this address, or undefined. */
  lastTo(address: string): Mail | undefined {
    return [...this.sent].reverse().find((mail) => mail.to === address);
  }
}

/** "Name <a@b.example>" or "a@b.example" -> { name?, email } */
export function parseFrom(from: string): { name?: string; email: string } {
  const match = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+)>\s*$/.exec(from);
  if (match) return { ...(match[1] ? { name: match[1].trim() } : {}), email: match[2]! };
  return { email: from.trim() };
}

type Fetch = typeof fetch;

async function post(fetchImpl: Fetch, url: string, headers: Record<string, string>, body: unknown, provider: string): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  } catch (cause) {
    // The message never includes the API key or the request body (which holds the secret link).
    throw new Error(`${provider}: could not reach the email service`, { cause });
  }
  if (!response.ok) throw new Error(`${provider}: the email service answered ${response.status}`);
  await response.arrayBuffer().catch(() => {});
}

/** Brevo (brevo.com): free plan sends 300 a day to anyone, after you verify one sender address. */
export class BrevoMailer implements Mailer {
  constructor(private readonly apiKey: string, private readonly from: string, private readonly fetchImpl: Fetch = fetch) {}
  send(mail: Mail): Promise<void> {
    const sender = parseFrom(this.from);
    return post(this.fetchImpl, "https://api.brevo.com/v3/smtp/email", { "api-key": this.apiKey }, { sender, to: [{ email: mail.to }], subject: mail.subject, textContent: mail.text, ...(mail.html ? { htmlContent: mail.html } : {}) }, "brevo");
  }
}

/** Resend (resend.com): free plan, but it only delivers to addresses on a domain you have verified. */
export class ResendMailer implements Mailer {
  constructor(private readonly apiKey: string, private readonly from: string, private readonly fetchImpl: Fetch = fetch) {}
  send(mail: Mail): Promise<void> {
    return post(this.fetchImpl, "https://api.resend.com/emails", { Authorization: `Bearer ${this.apiKey}` }, { from: this.from, to: [mail.to], subject: mail.subject, text: mail.text, ...(mail.html ? { html: mail.html } : {}) }, "resend");
  }
}
