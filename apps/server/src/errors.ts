/**
 * An error we expect and can safely show to the client.
 * Anything that is NOT an AppError is treated as a bug and returns a generic 500.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}
