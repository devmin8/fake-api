// One error envelope for the whole API: { error: { code, message, details? } }.
// Throw an ApiError anywhere; the Elysia onError handler (in index.ts) maps the
// code to its HTTP status and serializes the envelope.

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL";

export const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

// Convenience constructors for the common cases.
export const errors = {
  validation: (message = "Validation failed", details?: unknown) =>
    new ApiError("VALIDATION_ERROR", message, details),
  unauthenticated: (message = "Authentication required") =>
    new ApiError("UNAUTHENTICATED", message),
  forbidden: (message = "Forbidden") => new ApiError("FORBIDDEN", message),
  notFound: (message = "Not found") => new ApiError("NOT_FOUND", message),
  conflict: (message = "Conflict") => new ApiError("CONFLICT", message),
  rateLimited: (message = "Too many requests") =>
    new ApiError("RATE_LIMITED", message),
};
