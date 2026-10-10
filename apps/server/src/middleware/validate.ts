import type { RequestHandler } from "express";
import type { ZodType } from "zod";
import { AppError } from "../errors.js";

type Source = "body" | "query" | "params";

/**
 * Validates one part of the request with a Zod schema.
 * On success the parsed (typed, cleaned) value replaces the original.
 * On failure it throws a 400 AppError listing what was wrong.
 */
export function validate(schema: ZodType, source: Source = "body"): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      throw new AppError(400, "VALIDATION_ERROR", "Invalid request", issues);
    }
    // Express 5 makes req.query a read-only getter, so redefine the property instead of assigning.
    Object.defineProperty(req, source, {
      value: result.data,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    next();
  };
}
