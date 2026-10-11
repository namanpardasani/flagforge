import type { Logger } from "pino";
import type { Config } from "../config.js";
import { BrevoMailer, LogMailer, ResendMailer, type Mailer } from "./mailer.js";

export type { Mail, Mailer } from "./mailer.js";

/** Picks the sender named in the configuration. Config validation has already checked the key is there. */
export function createMailer(config: Pick<Config, "MAIL_PROVIDER" | "MAIL_API_KEY" | "MAIL_FROM">, logger: Logger): Mailer {
  switch (config.MAIL_PROVIDER) {
    case "brevo":
      return new BrevoMailer(config.MAIL_API_KEY!, config.MAIL_FROM);
    case "resend":
      return new ResendMailer(config.MAIL_API_KEY!, config.MAIL_FROM);
    default:
      return new LogMailer(logger);
  }
}
