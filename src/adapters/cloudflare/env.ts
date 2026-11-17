
// Cloudflare Worker bindings. These names must match wrangler config.
// This type is private to the Cloudflare adapter; nothing outside
// src/adapters/cloudflare should import it.

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GITHUB_TOKEN?: string;
  /** Comma-separated account UUIDs that may manage the curated plugin list. */
  ADMIN_USER_IDS?: string;
}
