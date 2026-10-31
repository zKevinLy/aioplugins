
// Platform contract.
//
// Everything the application needs from the hosting environment,
// expressed without reference to any specific provider. A hosting
// adapter (Cloudflare today; Node, AWS, Vercel, ...) builds one of
// these and hands it to `handleRequest`.

import type { Database } from "./db.js";

/** Serves the built front-end files (the app's static assets). */
export interface StaticAssets {
  /** Resolves the asset addressed by the request URL's path. */
  fetch(request: Request): Promise<Response>;
}

export interface Platform {
  db: Database;
  assets: StaticAssets;

  /**
   * Returns the connecting client's IP as reported by the hosting
   * platform, or null when it is not available. The value is untrusted:
   * the application validates it before use.
   */
  getClientIp(request: Request): string | null;
}
