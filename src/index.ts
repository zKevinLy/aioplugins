
// Wrangler entry point (wrangler `main` still points here).
// Kept as a one-line re-export so deployment config does not change.
// To host elsewhere, add another entry that calls `handleRequest`
// from ./server.js with a different Platform adapter.

export { default } from "./adapters/cloudflare/worker.js";
