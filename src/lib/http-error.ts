// An error that carries the HTTP status it should be reported with.
//
// It lives in lib/ (rather than users.ts) so that every layer of the
// server can raise user-facing errors without importing the account code.

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}
