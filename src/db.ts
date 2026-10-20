import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,           -- the UUID the user logs in with
    password_hash TEXT NOT NULL,              -- "<salt hex>:<scrypt hex>"
    install_token TEXT NOT NULL,              -- secret part of the Nuvio install link
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,              -- sha256 of the cookie value
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS user_config (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    sources    TEXT NOT NULL DEFAULT '[]',    -- selected repos/providers (JSON)
    settings   TEXT NOT NULL DEFAULT '{}',    -- reserved: formatting, sorting, filters (JSON)
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS profiles (
    id         TEXT NOT NULL,                 -- profile identifier/slug
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,                 -- friendly name
    sources    TEXT NOT NULL DEFAULT '[]',    -- selected repos/providers (JSON)
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );
`;

const handles = new Map<string, DatabaseSync>();

export function dataDir(storageRoot: string): string {
  return resolve(storageRoot, "data");
}

export function getDb(storageRoot: string): DatabaseSync {
  const root = resolve(storageRoot);
  const existing = handles.get(root);
  if (existing) return existing;
  mkdirSync(dataDir(root), { recursive: true });
  const db = new DatabaseSync(resolve(dataDir(root), "aioplugins.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  handles.set(root, db);
  return db;
}