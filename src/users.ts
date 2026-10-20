import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { getDb } from "./db.js";
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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------- passwords ----------

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, (error, key) => (error ? reject(error) : resolve(key)))
  );
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${(await derive(password, salt)).toString("hex")}`;
}

async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await derive(password, Buffer.from(saltHex, "hex"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function assertPassword(password: unknown): asserts password is string {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) throw new HttpError(400, "Password is too long");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

// ---------- login throttling (in memory, per UUID) ----------

const failures = new Map<string, { count: number; resetAt: number }>();

function assertNotLocked(key: string): void {
  const entry = failures.get(key);
  if (!entry) return;
  if (entry.resetAt < Date.now()) failures.delete(key);
  else if (entry.count >= MAX_FAILED_LOGINS) throw new HttpError(429, "Too many failed attempts. Try again in a few minutes.");
}

function recordFailure(key: string): void {
  const entry = failures.get(key);
  if (!entry || entry.resetAt < Date.now()) failures.set(key, { count: 1, resetAt: Date.now() + LOCKOUT_MS });
  else entry.count += 1;
}

// ---------- accounts ----------

interface UserRow {
  id: string;
  password_hash: string;
  install_token: string;
}

function findUser(root: string, id: string): UserRow | undefined {
  return getDb(root).prepare("SELECT id, password_hash, install_token FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

function toUser(row: UserRow): User {
  return { id: row.id, installToken: row.install_token };
}

export async function registerUser(password: unknown, root: string): Promise<User> {
  assertPassword(password);
  const id = randomUUID();
  const installToken = randomBytes(24).toString("base64url");
  const passwordHash = await hashPassword(password);
  const db = getDb(root);
  const now = Date.now();
  db.prepare("INSERT INTO users (id, password_hash, install_token, created_at) VALUES (?, ?, ?, ?)").run(id, passwordHash, installToken, now);
  db.prepare("INSERT INTO user_config (user_id, updated_at) VALUES (?, ?)").run(id, now);
  return { id, installToken };
}

async function verifyCredentials(rawId: unknown, password: unknown, root: string): Promise<UserRow> {
  const id = typeof rawId === "string" ? rawId.trim().toLowerCase() : "";
  const key = UUID_PATTERN.test(id) ? id : "invalid";
  assertNotLocked(key);
  const row = UUID_PATTERN.test(id) ? findUser(root, id) : undefined;
  const given = typeof password === "string" ? password.slice(0, MAX_PASSWORD_LENGTH) : "";
  // Hash even when the user doesn't exist so response time doesn't reveal valid UUIDs.
  const ok = row ? await checkPassword(given, row.password_hash) : (await derive(given, randomBytes(16)), false);
  if (!ok || !row) {
    recordFailure(key);
    throw new HttpError(401, "Invalid UUID or password");
  }
  failures.delete(key);
  return row;
}

export async function loginUser(rawId: unknown, password: unknown, root: string): Promise<User> {
  return toUser(await verifyCredentials(rawId, password, root));
}

export async function deleteUser(userId: string, password: unknown, root: string): Promise<void> {
  try {
    await verifyCredentials(userId, password, root);
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) throw new HttpError(401, "Incorrect password");
    throw error;
  }
  getDb(root).prepare("DELETE FROM users WHERE id = ?").run(userId); // sessions + config cascade
}

// ---------- profiles ----------

export interface Profile {
  id: string;
  name: string;
  sources: SavedSourceSelection[];
  updatedAt: number;
}

export function getProfiles(userId: string, root: string): Profile[] {
  const rows = getDb(root).prepare("SELECT id, name, sources, updated_at FROM profiles WHERE user_id = ?").all(userId) as { id: string; name: string; sources: string; updated_at: number }[];
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    sources: JSON.parse(row.sources || "[]"),
    updatedAt: row.updated_at
  }));
}

export function saveProfile(userId: string, profileId: string, name: string, sources: SavedSourceSelection[], root: string): void {
  getDb(root).prepare(
    `INSERT INTO profiles (id, user_id, name, sources, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET name = excluded.name, sources = excluded.sources, updated_at = excluded.updated_at`
  ).run(profileId, userId, name, JSON.stringify(sources), Date.now());
}

export function deleteProfile(userId: string, profileId: string, root: string): void {
  getDb(root).prepare("DELETE FROM profiles WHERE user_id = ? AND id = ?").run(userId, profileId);
}

// ---------- sessions ----------

export function createSession(userId: string, root: string): { token: string; maxAgeSeconds: number } {
  const db = getDb(root);
  const token = randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
  return { token, maxAgeSeconds: SESSION_TTL_MS / 1000 };
}

export function userFromSession(token: string | undefined, root: string): User | null {
  if (!token) return null;
  const row = getDb(root).prepare(
    `SELECT u.id, u.password_hash, u.install_token FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).get(sha256(token), Date.now()) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function destroySession(token: string | undefined, root: string): void {
  if (token) getDb(root).prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

// ---------- install link (what Nuvio uses, no login) ----------

export function userFromInstallLink(id: string, token: string, root: string): User | null {
  const row = findUser(root, id);
  return row && safeEqual(row.install_token, token) ? toUser(row) : null;
}

// ---------- per-user config ----------

export function getSources(userId: string, root: string): SavedSourceSelection[] {
  const row = getDb(root).prepare("SELECT sources FROM user_config WHERE user_id = ?").get(userId) as { sources: string } | undefined;
  try {
    const value: unknown = JSON.parse(row?.sources ?? "[]");
    return Array.isArray(value) ? (value as SavedSourceSelection[]) : [];
  } catch {
    return [];
  }
}

export function saveSources(userId: string, sources: SavedSourceSelection[], root: string): void {
  getDb(root).prepare(
    `INSERT INTO user_config (user_id, sources, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET sources = excluded.sources, updated_at = excluded.updated_at`
  ).run(userId, JSON.stringify(sources), Date.now());
}
