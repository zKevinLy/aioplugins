
// Cloudflare Worker bindings. These names must match wrangler config.
// This type is private to the Cloudflare adapter; nothing outside
// src/adapters/cloudflare should import it.

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GITHUB_TOKEN?: string;
}
