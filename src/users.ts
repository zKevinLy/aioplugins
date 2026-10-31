
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual
} from "node:crypto";
import type { Database } from "./lib/db.js";
import type { SavedSourceSelection } from "./providers/remote.js";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface User {
  id: string;
  installToken: string;
}

export const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_LOGIN_ENTRIES = 10_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const HASH_PATTERN = /^[0-9a-f]{32}$/;
const KEY_PATTERN = /^[0-9a-f]{128}$/;

// ---------- passwords ----------

function derive(password: string, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

async function checkPassword(
  password: string,
  stored: string
): Promise<boolean> {
  try {
    if (typeof stored !== "string") return false;

    const parts = stored.split(":");
    if (parts.length !== 2) return false;

    const saltHex = parts[0];
    const hashHex = parts[1];

    if (
      typeof saltHex !== "string" ||
      typeof hashHex !== "string" ||
      !HASH_PATTERN.test(saltHex) ||
      !KEY_PATTERN.test(hashHex)
    ) {
      return false;
    }

    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = await derive(password, salt);

    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function assertPassword(password: unknown): asserts password is string {
  if (
    typeof password !== "string" ||
    password.length < MIN_PASSWORD_LENGTH
  ) {
    throw new HttpError(
      400,
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
    );
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(400, "Password is too long");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

// ---------- login throttling ----------

const failures = new Map<
  string,
  { count: number; resetAt: number }
>();

function pruneFailures(): void {
  const now = Date.now();

  for (const [key, entry] of failures) {
    if (entry.resetAt <= now) failures.delete(key);
  }

  while (failures.size > MAX_LOGIN_ENTRIES) {
    const oldest = failures.keys().next().value;
    if (oldest === undefined) break;
    failures.delete(oldest);
  }
}

function loginKey(id: string, clientKey?: string): string {
  const normalizedClient =
    typeof clientKey === "string" && clientKey.length > 0
      ? sha256(clientKey.slice(0, 256))
      : "unknown";

  return `${id}:${normalizedClient}`;
}

function assertNotLocked(key: string): void {
  const entry = failures.get(key);
  if (!entry) return;

  if (entry.resetAt <= Date.now()) {
    failures.delete(key);
    return;
  }

  if (entry.count >= MAX_FAILED_LOGINS) {
    throw new HttpError(
      429,
      "Too many failed attempts. Try again in a few minutes."
    );
  }
}

function recordFailure(key: string): void {
  pruneFailures();

  const now = Date.now();
  const entry = failures.get(key);

  if (!entry || entry.resetAt <= now) {
    failures.set(key, {
      count: 1,
      resetAt: now + LOCKOUT_MS
    });
  } else {
    entry.count += 1;
  }
}

// ---------- accounts ----------

interface UserRow {
  id: string;
  password_hash: string;
  install_token: string;
}

async function findUser(
  db: Database,
  id: string
): Promise<UserRow | null> {
  return db.first<UserRow>(
    "SELECT id, password_hash, install_token FROM users WHERE id = ?",
    [id]
  );
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    installToken: row.install_token
  };
}

export async function registerUser(
  password: unknown,
  db: Database
): Promise<User> {
  assertPassword(password);

  const id = randomUUID();
  const installToken = randomBytes(24).toString("base64url");
  const passwordHash = await hashPassword(password);

  const now = Date.now();

  await db.batch([
    {
      sql: `INSERT INTO users
       (id, password_hash, install_token, created_at)
       VALUES (?, ?, ?, ?)`,
      params: [id, passwordHash, installToken, now]
    },

    {
      sql: `INSERT INTO user_config (user_id, updated_at)
       VALUES (?, ?)`,
      params: [id, now]
    }
  ]);

  return { id, installToken };
}

async function verifyCredentials(
  rawId: unknown,
  password: unknown,
  db: Database,
  clientKey?: string
): Promise<UserRow> {
  const id =
    typeof rawId === "string"
      ? rawId.trim().toLowerCase()
      : "";

  const validId = UUID_PATTERN.test(id);
  const key = loginKey(validId ? id : "invalid", clientKey);

  assertNotLocked(key);

  const row = validId ? await findUser(db, id) : null;

  const given =
    typeof password === "string"
      ? password.slice(0, MAX_PASSWORD_LENGTH)
      : "";

  const ok = row
    ? await checkPassword(given, row.password_hash)
    : (await derive(given, randomBytes(16)), false);

  if (!ok || !row) {
    recordFailure(key);
    throw new HttpError(401, "Invalid UUID or password");
  }

  failures.delete(key);
  return row;
}

export async function loginUser(
  rawId: unknown,
  password: unknown,
  db: Database,
  clientKey?: string
): Promise<User> {
  return toUser(
    await verifyCredentials(rawId, password, db, clientKey)
  );
}

export async function deleteUser(
  userId: string,
  password: unknown,
  db: Database
): Promise<void> {
  try {
    await verifyCredentials(userId, password, db);
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      throw new HttpError(401, "Incorrect password");
    }

    throw error;
  }

  await db.run("DELETE FROM users WHERE id = ?", [userId]);
}

// ---------- profiles ----------

export interface Profile {
  id: string;
  name: string;
  sources: SavedSourceSelection[];
  updatedAt: number;
}

export async function getProfiles(
  userId: string,
  db: Database
): Promise<Profile[]> {
  const rows = await db.all<{
    id: string;
    name: string;
    sources: string;
    updated_at: number;
  }>(
    `SELECT id, name, sources, updated_at
       FROM profiles
       WHERE user_id = ?`,
    [userId]
  );

  return rows.map(row => {
    let sources: SavedSourceSelection[] = [];

    try {
      const parsed: unknown = JSON.parse(row.sources || "[]");
      if (Array.isArray(parsed)) {
        sources = parsed as SavedSourceSelection[];
      }
    } catch {
      sources = [];
    }

    return {
      id: row.id,
      name: row.name,
      sources,
      updatedAt: row.updated_at
    };
  });
}

export async function saveProfile(
  userId: string,
  profileId: string,
  name: string,
  sources: SavedSourceSelection[],
  db: Database
): Promise<void> {
  await db.run(
    `INSERT INTO profiles
       (id, user_id, name, sources, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, id)
       DO UPDATE SET
         name = excluded.name,
         sources = excluded.sources,
         updated_at = excluded.updated_at`,
    [
      profileId,
      userId,
      name,
      JSON.stringify(sources),
      Date.now()
    ]
  );
}

export async function deleteProfile(
  userId: string,
  profileId: string,
  db: Database
): Promise<void> {
  await db.run(
    "DELETE FROM profiles WHERE user_id = ? AND id = ?",
    [userId, profileId]
  );
}

// ---------- sessions ----------

export async function createSession(
  userId: string,
  db: Database
): Promise<{ token: string; maxAgeSeconds: number }> {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();

  await db.batch([
    {
      sql: "DELETE FROM sessions WHERE expires_at <= ?",
      params: [now]
    },

    {
      sql: `INSERT INTO sessions (token_hash, user_id, expires_at)
       VALUES (?, ?, ?)`,
      params: [
        sha256(token),
        userId,
        now + SESSION_TTL_MS
      ]
    }
  ]);

  return {
    token,
    maxAgeSeconds: SESSION_TTL_MS / 1000
  };
}

export async function userFromSession(
  token: string | undefined,
  db: Database
): Promise<User | null> {
  if (
    !token ||
    token.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  ) {
    return null;
  }

  const row = await db.first<UserRow>(
    `SELECT u.id, u.password_hash, u.install_token
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    [sha256(token), Date.now()]
  );

  return row ? toUser(row) : null;
}

export async function destroySession(
  token: string | undefined,
  db: Database
): Promise<void> {
  if (!token || token.length > 256) return;

  await db.run(
    "DELETE FROM sessions WHERE token_hash = ?",
    [sha256(token)]
  );
}

// ---------- install link ----------

export async function userFromInstallLink(
  id: string,
  token: string,
  db: Database
): Promise<User | null> {
  if (
    !UUID_PATTERN.test(id) ||
    typeof token !== "string" ||
    token.length > 128
  ) {
    return null;
  }

  const row = await findUser(db, id);

  return row && safeEqual(row.install_token, token)
    ? toUser(row)
    : null;
}

// ---------- per-user config ----------

export async function getSources(
  userId: string,
  db: Database
): Promise<SavedSourceSelection[]> {
  const row = await db.first<{ sources: string }>(
    "SELECT sources FROM user_config WHERE user_id = ?",
    [userId]
  );

  try {
    const value: unknown = JSON.parse(row?.sources ?? "[]");

    return Array.isArray(value)
      ? (value as SavedSourceSelection[])
      : [];
  } catch {
    return [];
  }
}

export async function saveSources(
  userId: string,
  sources: SavedSourceSelection[],
  db: Database
): Promise<void> {
  await db.run(
    `INSERT INTO user_config
       (user_id, sources, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id)
       DO UPDATE SET
         sources = excluded.sources,
         updated_at = excluded.updated_at`,
    [
      userId,
      JSON.stringify(sources),
      Date.now()
    ]
  );
}
