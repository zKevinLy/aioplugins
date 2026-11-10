import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import {
  listPasskeys,
  loginWithPasskey,
  passkeyLoginOptions,
  passkeyRegistrationOptions,
  registerPasskey
} from "../dist/passkeys.js";

const rp = { rpId: "example.com", origin: "https://example.com" };
const user = { id: "11111111-1111-4111-8111-111111111111", installToken: "tok" };
const sha = (v) => createHash("sha256").update(v).digest();
const b64 = (b) => Buffer.from(b).toString("base64url");

// Minimal in-memory Database covering the statements passkeys.ts issues.
function memoryDb() {
  const challenges = new Map();
  const passkeys = new Map();
  const exec = (sql, p = []) => {
    if (sql.startsWith("DELETE FROM passkey_challenges WHERE expires_at")) {
      for (const [k, v] of challenges) if (v.expires_at <= p[0]) challenges.delete(k);
    } else if (sql.startsWith("INSERT INTO passkey_challenges")) {
      challenges.set(p[0], { purpose: p[1], user_id: p[2], expires_at: p[3] });
    } else if (sql.startsWith("DELETE FROM passkey_challenges WHERE challenge")) {
      challenges.delete(p[0]);
    } else if (sql.startsWith("INSERT INTO passkeys")) {
      if (passkeys.has(p[0])) throw new Error("dup");
      passkeys.set(p[0], { credential_id: p[0], user_id: p[1], public_key: p[2], counter: p[3], name: p[4], created_at: p[5], last_used_at: null });
    } else if (sql.startsWith("UPDATE passkeys")) {
      Object.assign(passkeys.get(p[2]), { counter: p[0], last_used_at: p[1] });
    }
  };
  return {
    async first(sql, p = []) {
      if (sql.includes("FROM passkey_challenges")) return challenges.get(p[0]) ?? null;
      if (sql.includes("COUNT(*)")) return { n: passkeys.size };
      if (sql.includes("JOIN users")) {
        const row = passkeys.get(p[0]);
        return row ? { ...row, install_token: user.installToken } : null;
      }
      return null;
    },
    async all(sql) {
      if (sql.includes("FROM passkeys")) return [...passkeys.values()];
      return [];
    },
    async run(sql, p) { exec(sql, p); },
    async batch(list) { for (const s of list) exec(s.sql, s.params); }
  };
}

function authData({ credId, counter, flags }) {
  const head = Buffer.concat([sha(rp.rpId), Buffer.from([flags]), Buffer.alloc(4)]);
  head.writeUInt32BE(counter, 33);
  if (!credId) return head;
  const len = Buffer.alloc(2);
  len.writeUInt16BE(credId.length);
  return Buffer.concat([head, Buffer.alloc(16), len, credId, Buffer.from([0xa0])]);
}

const clientData = (type, challenge, origin = rp.origin) =>
  Buffer.from(JSON.stringify({ type, challenge, origin }));

async function enroll(db, keys, credId) {
  const options = await passkeyRegistrationOptions(user, rp, db);
  await registerPasskey(user, rp, {
    id: b64(credId),
    name: "Test",
    clientDataJSON: b64(clientData("webauthn.create", options.challenge)),
    authenticatorData: b64(authData({ credId, counter: 0, flags: 0x45 | 0x40 })),
    publicKey: b64(keys.publicKey.export({ type: "spki", format: "der" })),
    publicKeyAlgorithm: -7
  }, db);
}

async function assertion(db, keys, credId, { counter, origin, flags = 0x05, tamper } = {}) {
  const options = await passkeyLoginOptions(rp, db);
  const cd = clientData("webauthn.get", options.challenge, origin);
  const ad = authData({ counter: counter ?? 1, flags });
  const signature = sign("sha256", Buffer.concat([ad, sha(cd)]), keys.privateKey);
  if (tamper) signature[signature.length - 1] ^= 1;
  return {
    id: b64(credId),
    clientDataJSON: b64(cd),
    authenticatorData: b64(ad),
    signature: b64(signature)
  };
}

test("registers a passkey and signs in with it", async () => {
  const db = memoryDb();
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credId = Buffer.from("credential-one");

  await enroll(db, keys, credId);
  assert.equal((await listPasskeys(user.id, db)).length, 1);

  const signedIn = await loginWithPasskey(rp, await assertion(db, keys, credId), db);
  assert.equal(signedIn.id, user.id);
});

test("rejects bad signatures, wrong origins, missing verification, and replays", async () => {
  const db = memoryDb();
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credId = Buffer.from("credential-two");
  await enroll(db, keys, credId);

  await assert.rejects(loginWithPasskey(rp, await assertion(db, keys, credId, { tamper: true }), db));
  await assert.rejects(loginWithPasskey(rp, await assertion(db, keys, credId, { origin: "https://evil.test" }), db));
  await assert.rejects(loginWithPasskey(rp, await assertion(db, keys, credId, { flags: 0x01 }), db));

  const good = await assertion(db, keys, credId, { counter: 5 });
  await loginWithPasskey(rp, good, db);
  await assert.rejects(loginWithPasskey(rp, good, db)); // challenge already used
  await assert.rejects(loginWithPasskey(rp, await assertion(db, keys, credId, { counter: 5 }), db)); // counter not increasing
});
