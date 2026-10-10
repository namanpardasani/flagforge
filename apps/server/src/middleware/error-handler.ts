import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError } from "../errors.js";

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, "NOT_FOUND", `Route not found: ${req.method} ${req.path}`));
};

/**
 * The single place every error ends up. Express recognises it by its 4 arguments.
 * Known errors (AppError) are shown to the client; unknown errors are logged
 * with full detail but the client only gets a generic message (no stack traces).
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = String(req.id ?? "");

  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, requestId },
    });
    return;
  }

  // express.json() throws this when the body is not valid JSON.
  if (err && typeof err === "object" && (err as { type?: string }).type === "entity.parse.failed") {
    res.status(400).json({
      error: { code: "INVALID_JSON", message: "Request body is not valid JSON", requestId },
    });
    return;
  }

  req.log?.error({ err }, "unhandled error");
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Internal server error", requestId },
  });
};
