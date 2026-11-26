export type AuthErrorCode = "store" | "oauth" | "login";

/** Failure while reading, refreshing or storing credentials. The original error is the `cause`. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuthError";
    this.code = code;
  }
}
