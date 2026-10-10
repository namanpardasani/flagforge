import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";

const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Logs one line per request and gives each request an ID.
 * We reuse the caller's x-request-id if it looks safe (so traces can span services),
 * otherwise we generate one. The ID is echoed back in the response header.
 */
export function requestLogger(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId: (req, res) => {
      const incoming = req.headers["x-request-id"];
      const id = typeof incoming === "string" && SAFE_ID.test(incoming) ? incoming : randomUUID();
      res.setHeader("x-request-id", id);
      return id;
    },
  });
}
