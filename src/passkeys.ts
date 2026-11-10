// WebAuthn passkey support (attestation "none", ES256 / RS256 keys).
// Verification uses node:crypto only, so there are no extra dependencies.

import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify
} from "node:crypto";
import type { Database } from "./lib/db.js";
import { HttpError } from "./lib/http-error.js";
import type { User } from "./users.js";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PASSKEYS = 20;
const MAX_FIELD = 8192;

const ALG_ES256 = -7;
const ALG_RS256 = -257;

export interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface RelyingParty {
  rpId: string;
  origin: string;
}

type Purpose = "register" | "login";

const B64URL = /^[A-Za-z0-9_-]+$/;

function b64url(value: unknown, label: string, max = MAX_FIELD): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !B64URL.test(value)) {
    throw new HttpError(400, `Invalid ${label}`);
  }
  return Buffer.from(value, "base64url");
}

function sha256(data: Uint8Array | string): Buffer {
  return createHash("sha256").update(data).digest();
}

// ---------- challenges ----------

async function issueChallenge(
  db: Database,
  purpose: Purpose,
  userId: string | null
): Promise<string> {
  const challenge = randomBytes(32).toString("base64url");
  const now = Date.now();

  await db.batch([
    { sql: "DELETE FROM passkey_challenges WHERE expires_at <= ?", params: [now] },
    {
      sql: `INSERT INTO passkey_challenges (challenge, purpose, user_id, expires_at)
            VALUES (?, ?, ?, ?)`,
      params: [challenge, purpose, userId, now + CHALLENGE_TTL_MS]
    }
  ]);

  return challenge;
}

// Challenges are single use: the row is read and deleted before anything else
// is checked, so a replayed response always fails.
async function consumeChallenge(
  db: Database,
  challenge: string,
  purpose: Purpose
): Promise<{ userId: string | null }> {
  const row = await db.first<{ purpose: string; user_id: string | null; expires_at: number }>(
    "SELECT purpose, user_id, expires_at FROM passkey_challenges WHERE challenge = ?",
    [challenge]
  );

  await db.run("DELETE FROM passkey_challenges WHERE challenge = ?", [challenge]);

  if (!row || row.purpose !== purpose || row.expires_at <= Date.now()) {
    throw new HttpError(400, "Passkey request expired. Please try again.");
  }

  return { userId: row.user_id };
}

// ---------- shared checks ----------

interface ClientData {
  challenge: string;
}

function checkClientData(
  raw: Buffer,
  type: "webauthn.create" | "webauthn.get",
  rp: RelyingParty
): ClientData {
  let data: unknown;

  try {
    data = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid passkey response");
  }

  const record = data as Record<string, unknown> | null;

  if (
    !record ||
    typeof record !== "object" ||
    record.type !== type ||
    typeof record.challenge !== "string" ||
    record.origin !== rp.origin ||
    record.crossOrigin === true
  ) {
    throw new HttpError(400, "Passkey response was rejected");
  }

  return { challenge: record.challenge };
}

interface AuthData {
  flags: number;
  counter: number;
  credentialId: Buffer | null;
}

function checkAuthData(authData: Buffer, rp: RelyingParty, expectCredential: boolean): AuthData {
  if (authData.length < 37) throw new HttpError(400, "Invalid passkey response");

  const rpIdHash = authData.subarray(0, 32);
  if (!timingSafeEqual(rpIdHash, sha256(rp.rpId))) {
    throw new HttpError(400, "Passkey response was rejected");
  }

  const flags = authData[32] ?? 0;
  const userPresent = (flags & 0x01) !== 0;
  const userVerified = (flags & 0x04) !== 0;

  // Passkeys replace password + UUID, so require user verification.
  if (!userPresent || !userVerified) {
    throw new HttpError(400, "Passkey verification was not completed");
  }

  const counter = authData.readUInt32BE(33);
  let credentialId: Buffer | null = null;

  if (expectCredential) {
    // flags bit 6: attested credential data present.
    if ((flags & 0x40) === 0 || authData.length < 55) {
      throw new HttpError(400, "Invalid passkey response");
    }

    const length = authData.readUInt16BE(53);
    if (length === 0 || length > 1024 || authData.length < 55 + length) {
      throw new HttpError(400, "Invalid passkey response");
    }

    credentialId = authData.subarray(55, 55 + length);
  }

  return { flags, counter, credentialId };
}

// ---------- registration ----------

export async function passkeyRegistrationOptions(user: User, rp: RelyingParty, db: Database) {
  const existing = await db.all<{ credential_id: string }>(
    "SELECT credential_id FROM passkeys WHERE user_id = ?",
    [user.id]
  );

  if (existing.length >= MAX_PASSKEYS) {
    throw new HttpError(400, `You can register up to ${MAX_PASSKEYS} passkeys`);
  }

  const challenge = await issueChallenge(db, "register", user.id);

  return {
    challenge,
    rp: { id: rp.rpId, name: "AIOPlugins" },
    user: {
      id: Buffer.from(user.id, "utf8").toString("base64url"),
      name: user.id,
      displayName: "AIOPlugins account"
    },
    pubKeyCredParams: [
      { type: "public-key", alg: ALG_ES256 },
      { type: "public-key", alg: ALG_RS256 }
    ],
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required"
    },
    attestation: "none",
    timeout: 60_000,
    excludeCredentials: existing.map(({ credential_id }) => ({
      type: "public-key",
      id: credential_id
    }))
  };
}

export async function registerPasskey(
  user: User,
  rp: RelyingParty,
  body: Record<string, unknown>,
  db: Database
): Promise<PasskeyInfo> {
  const clientData = b64url(body.clientDataJSON, "clientDataJSON");
  const authData = b64url(body.authenticatorData, "authenticatorData");
  const publicKey = b64url(body.publicKey, "publicKey");
  const credentialId = b64url(body.id, "credential id", 1400);
  const alg = body.publicKeyAlgorithm;

  const parsed = checkClientData(clientData, "webauthn.create", rp);
  const { userId } = await consumeChallenge(db, parsed.challenge, "register");

  if (userId !== user.id) throw new HttpError(400, "Passkey request expired. Please try again.");

  const attested = checkAuthData(authData, rp, true);

  if (!attested.credentialId || !attested.credentialId.equals(credentialId)) {
    throw new HttpError(400, "Passkey response was rejected");
  }

  if (alg !== ALG_ES256 && alg !== ALG_RS256) {
    throw new HttpError(400, "Unsupported passkey algorithm");
  }

  let key;
  try {
    key = createPublicKey({ key: publicKey, format: "der", type: "spki" });
  } catch {
    throw new HttpError(400, "Invalid passkey public key");
  }

  const expectedType = alg === ALG_ES256 ? "ec" : "rsa";
  if (key.asymmetricKeyType !== expectedType) {
    throw new HttpError(400, "Invalid passkey public key");
  }

  const count = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?",
    [user.id]
  );
  if ((count?.n ?? 0) >= MAX_PASSKEYS) {
    throw new HttpError(400, `You can register up to ${MAX_PASSKEYS} passkeys`);
  }

  const name = cleanName(body.name);
  const id = credentialId.toString("base64url");
  const now = Date.now();

  try {
    await db.run(
      `INSERT INTO passkeys (credential_id, user_id, public_key, counter, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, user.id, publicKey.toString("base64url"), attested.counter, name, now]
    );
  } catch {
    throw new HttpError(409, "This passkey is already registered");
  }

  return { id, name, createdAt: now, lastUsedAt: null };
}

function cleanName(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  return text || "Passkey";
}

// ---------- login ----------

export async function passkeyLoginOptions(rp: RelyingParty, db: Database) {
  const challenge = await issueChallenge(db, "login", null);

  return {
    challenge,
    rpId: rp.rpId,
    userVerification: "required",
    timeout: 60_000
  };
}

export async function loginWithPasskey(
  rp: RelyingParty,
  body: Record<string, unknown>,
  db: Database
): Promise<User> {
  const fail = () => new HttpError(401, "Passkey sign-in failed");

  const clientData = b64url(body.clientDataJSON, "clientDataJSON");
  const authData = b64url(body.authenticatorData, "authenticatorData");
  const signature = b64url(body.signature, "signature");
  const credentialId = b64url(body.id, "credential id", 1400).toString("base64url");

  const parsed = checkClientData(clientData, "webauthn.get", rp);
  await consumeChallenge(db, parsed.challenge, "login");

  const row = await db.first<{
    user_id: string;
    public_key: string;
    counter: number;
    install_token: string;
  }>(
    `SELECT p.user_id, p.public_key, p.counter, u.install_token
       FROM passkeys p JOIN users u ON u.id = p.user_id
       WHERE p.credential_id = ?`,
    [credentialId]
  );

  if (!row) throw fail();

  const assertion = checkAuthData(authData, rp, false);

  const signed = Buffer.concat([authData, sha256(clientData)]);
  let valid = false;

  try {
    const key = createPublicKey({
      key: Buffer.from(row.public_key, "base64url"),
      format: "der",
      type: "spki"
    });
    valid = verify("sha256", signed, key, signature);
  } catch {
    valid = false;
  }

  if (!valid) throw fail();

  // A counter that fails to increase signals a cloned authenticator. Many
  // synced passkeys always report 0, which is allowed.
  if ((assertion.counter !== 0 || row.counter !== 0) && assertion.counter <= row.counter) {
    throw fail();
  }

  await db.run(
    "UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?",
    [assertion.counter, Date.now(), credentialId]
  );

  return { id: row.user_id, installToken: row.install_token };
}

// ---------- management ----------

export async function listPasskeys(userId: string, db: Database): Promise<PasskeyInfo[]> {
  const rows = await db.all<{
    credential_id: string;
    name: string;
    created_at: number;
    last_used_at: number | null;
  }>(
    `SELECT credential_id, name, created_at, last_used_at
       FROM passkeys WHERE user_id = ? ORDER BY created_at`,
    [userId]
  );

  return rows.map(row => ({
    id: row.credential_id,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at
  }));
}

export async function deletePasskey(userId: string, id: unknown, db: Database): Promise<void> {
  if (typeof id !== "string" || id.length > 1400 || !B64URL.test(id)) {
    throw new HttpError(400, "Invalid passkey id");
  }

  await db.run("DELETE FROM passkeys WHERE user_id = ? AND credential_id = ?", [userId, id]);
}

