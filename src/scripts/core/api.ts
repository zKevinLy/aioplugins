// The single place the browser talks to the server.

import { isRecord } from "./guards.js";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

// A 401 on these paths is an expected answer ("wrong password"), not an
// expired session.
const AUTH_PATHS = new Set([
  "/api/session",
  "/api/login",
  "/api/register",
  "/api/account",
  "/api/account/token"
]);

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** Called when a request fails because the session is gone or expired. */
export function onUnauthorized(listener: UnauthorizedListener): void {
  unauthorizedListeners.add(listener);
}

export async function api<T>(
  path: string,
  body?: unknown,
  method?: string
): Promise<T> {
  const request: RequestInit = {
    method: method ?? (body === undefined ? "GET" : "POST")
  };

  if (body !== undefined) {
    request.headers = { "content-type": "application/json" };
    request.body = JSON.stringify(body);
  }

  const response = await fetch(path, request);
  const result: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    if (response.status === 401 && !AUTH_PATHS.has(path)) {
      unauthorizedListeners.forEach((listener) => listener());
    }

    const message = isRecord(result) && typeof result.error === "string"
      ? result.error
      : `Request failed (${response.status})`;

    throw new ApiError(response.status, message);
  }

  return result as T;
}

function isTransient(error: unknown): boolean {
  if (error instanceof TypeError) return true; // network failure
  return error instanceof ApiError && [500, 502, 503, 504].includes(error.status);
}

/**
 * Retries network failures and transient server errors. Rate limits (429)
 * and client errors are not retried: repeating them only makes things worse.
 */
export async function withTransientRetry<T>(operation: () => Promise<T>): Promise<T> {
  const delays = [500, 1000, 2000];

  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const delay = delays[attempt];
      if (!isTransient(error) || delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
