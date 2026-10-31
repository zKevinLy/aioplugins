
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GITHUB_TOKEN?: string;
}

export function getDb(env: Env): D1Database {
  return env.DB;
}
