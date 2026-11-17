import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { parseAdminUserIds } from "../dist/adapters/cloudflare/platform.js";
import {
  countCuratedFollowers,
  getCuratedConfig,
  getCuratedStatus,
  getProfiles,
  getUserConfig,
  isServedCurated,
  registerUser,
  saveCuratedConfig,
  saveUserConfig,
  setFollowCurated
} from "../dist/users.js";

// The real migrations, run in order on a real SQLite database.
function migrate(db, { from = 0, upTo = Infinity } = {}) {
  const files = readdirSync(new URL("../migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const name of files) {
    const n = Number.parseInt(name, 10);
    if (n <= from) continue;
    if (n > upTo) break;
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
}

function adapter(db) {
  const bind = (params = []) => params;
  return {
    async first(sql, p) { return db.prepare(sql).get(...bind(p)) ?? null; },
    async all(sql, p) { return db.prepare(sql).all(...bind(p)); },
    async run(sql, p) { db.prepare(sql).run(...bind(p)); },
    async batch(list) {
      db.exec("BEGIN");
      try {
        for (const s of list) db.prepare(s.sql).run(...bind(s.params));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

const src = (repository, ids) => ({ repository, ref: "main", commit: "a".repeat(40), providerIds: ids });
const OWN = [src("https://github.com/me/own", ["mine"])];
const CURATED = [src("https://github.com/admin/picks", ["one", "two"])];

function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  migrate(sqlite);
  return { sqlite, db: adapter(sqlite) };
}

test("migration: existing accounts follow the curated list and keep their old setup as a profile", async () => {
  const sqlite = new DatabaseSync(":memory:");
  migrate(sqlite, { upTo: 5 });

  const add = (id, sources) => {
    sqlite.prepare("INSERT INTO users VALUES (?, 'h', 't', 1)").run(id);
    sqlite.prepare("INSERT INTO user_config (user_id, sources, updated_at) VALUES (?, ?, 1)").run(id, JSON.stringify(sources));
  };
  add("with-setup", OWN);
  add("empty", []);

  migrate(sqlite, { from: 5 });
  const db = adapter(sqlite);

  assert.deepEqual(await countCuratedFollowers(db), { following: 2, total: 2 });

  const kept = await getProfiles("with-setup", db);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, "pre-curated");
  assert.deepEqual(kept[0].sources, OWN);
  assert.equal((await getProfiles("empty", db)).length, 0);
});

test("followers keep their own setup until an admin publishes one", async () => {
  const { db } = fresh();
  const user = await registerUser("password123", db);
  await saveUserConfig(user.id, OWN, {}, db);

  const status = await getCuratedStatus(user.id, db);
  assert.deepEqual([status.following, status.available], [true, false]);
  assert.equal(await isServedCurated(user.id, db), false);
  assert.deepEqual((await getUserConfig(user.id, db)).sources, OWN);
});

test("new accounts follow by default and are served the curated list", async () => {
  const { db } = fresh();
  await saveCuratedConfig("admin", CURATED, { filters: [{ field: "resolution", operator: "gt", value: "720", unknown: "keep" }] }, db);

  const user = await registerUser("password123", db);
  const config = await getUserConfig(user.id, db);

  assert.equal(config.following, true);
  assert.deepEqual(config.sources, CURATED);
  assert.equal(config.middleware.filters.length, 1);
  assert.equal(await isServedCurated(user.id, db), true);
});

test("an admin update reaches followers at once, and not people who opted out", async () => {
  const { db } = fresh();
  const follower = await registerUser("password123", db);
  const solo = await registerUser("password123", db);
  await saveUserConfig(solo.id, OWN, {}, db);
  await setFollowCurated(solo.id, false, db);

  await saveCuratedConfig("admin", CURATED, {}, db);
  assert.deepEqual((await getUserConfig(follower.id, db)).sources, CURATED);
  assert.deepEqual((await getUserConfig(solo.id, db)).sources, OWN);

  const next = [src("https://github.com/admin/picks", ["three"])];
  await saveCuratedConfig("admin", next, {}, db);
  assert.deepEqual((await getUserConfig(follower.id, db)).sources, next);
  assert.deepEqual((await getUserConfig(solo.id, db)).sources, OWN);
  assert.equal((await getCuratedConfig(db)).updatedAt !== null, true);
});

test("unsubscribing keeps serving the same plugins; resubscribing saves the account's own setup first", async () => {
  const { db } = fresh();
  await saveCuratedConfig("admin", CURATED, {}, db);
  const user = await registerUser("password123", db);

  await setFollowCurated(user.id, false, db);
  let config = await getUserConfig(user.id, db);
  assert.equal(config.following, false);
  assert.deepEqual(config.sources, CURATED, "nothing changes for Nuvio at the moment of unsubscribing");
  assert.equal(await isServedCurated(user.id, db), false);

  await saveUserConfig(user.id, OWN, {}, db);
  await setFollowCurated(user.id, true, db);

  config = await getUserConfig(user.id, db);
  assert.deepEqual(config.sources, CURATED);

  const profiles = await getProfiles(user.id, db);
  assert.deepEqual(profiles.find((p) => p.id === "pre-curated")?.sources, OWN);

  // Following twice must not overwrite that profile with the curated list.
  await setFollowCurated(user.id, true, db);
  assert.deepEqual((await getProfiles(user.id, db)).find((p) => p.id === "pre-curated")?.sources, OWN);
});

test("ADMIN_USER_IDS accepts only well-formed UUIDs", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(parseAdminUserIds(` ${id.toUpperCase()} , nope,, `), [id]);
  assert.deepEqual(parseAdminUserIds(undefined), []);
});
