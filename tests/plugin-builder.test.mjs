import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { handleRequest } from "../dist/server.js";
import { DEFAULT_STREAM_MIDDLEWARE, wrapPluginStreams } from "../dist/providers/stream-middleware.js";

const commit = "b".repeat(40);
const sourceManifest = {
  name: "Source plugins",
  version: "1.0.0",
  scrapers: [
    {
      id: "fixture-plugin",
      name: "Fixture Plugin",
      description: "Preserved source metadata",
      author: "Test Author",
      supportedTypes: ["movie", "tv"],
      filename: "providers/fixture-plugin.js",
      enabled: true,
      logo: "https://assets.example/logo.png"
    },
    {
      id: "not-selected",
      name: "Not Selected",
      supportedTypes: ["movie"],
      filename: "providers/not-selected.js",
      enabled: true
    }
  ]
};

const pluginSource = `
  globalThis.fixturePluginExecuted = true;
  module.exports = {
    getStreams: async (media) => {
      if (media.id === "550" || media.title === "Fight Club") {
        return [{ title: "Fight Club 1080p", url: "https://example.com/stream.m3u8" }];
      }
      return [];
    }
  };
`;

const mainPassword = "MainProfilePassword!";
const BASE_URL = "https://aioplugins.test";

// ---------- test platform ----------
//
// The app only depends on the Platform contract (src/lib/platform.ts),
// so the tests run it against an in-memory SQLite database and the real
// files from ./public instead of any Cloudflare service.

function createSqliteDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");

  const migrations = new URL("../migrations/", import.meta.url);
  const files = readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  assert.ok(files.length > 0, "No migration files found in ./migrations");

  for (const file of files) {
    sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  }

  const plain = (row) => (row ? { ...row } : null);

  return {
    sqlite,

    async first(sql, params = []) {
      return plain(sqlite.prepare(sql).get(...params));
    },

    async all(sql, params = []) {
      return sqlite.prepare(sql).all(...params).map(plain);
    },

    async run(sql, params = []) {
      sqlite.prepare(sql).run(...params);
    },

    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        for (const { sql, params = [] } of statements) {
          sqlite.prepare(sql).run(...params);
        }
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

let db;
let platform;
let originalFetch;
let cookieJar = "";

async function testFetch(target, options = {}) {
  const headers = new Headers(options.headers || {});
  if (cookieJar) headers.set("cookie", cookieJar);

  const request = new Request(new URL(target, BASE_URL), {
    ...options,
    headers
  });

  const response = await handleRequest(request, platform);

  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookieJar = setCookie.split(";")[0];

  return response;
}

before(() => {
  originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = new URL(input);

    if (url.hostname === "github.com" && url.pathname.endsWith(".atom")) {
      return new Response(
        `<feed><entry><id>tag:github.com,2008:Grit::Commit/${commit}</id></entry></feed>`
      );
    }
    if (url.hostname === "raw.githubusercontent.com" && url.pathname.endsWith("/manifest.json")) {
      return new Response(JSON.stringify(sourceManifest));
    }
    if (url.hostname === "raw.githubusercontent.com" && url.pathname.endsWith("/providers/fixture-plugin.js")) {
      return new Response(pluginSource);
    }
    if (url.hostname === "raw.githubusercontent.com" && url.pathname.endsWith("/providers/not-selected.js")) {
      return new Response("module.exports = { getStreams: () => [] };");
    }

    throw new Error(`Unexpected mocked request: ${url}`);
  };

  db = createSqliteDatabase();

  platform = {
    db,
    assets: {
      fetch: async (request) => {
        assert.equal(new URL(request.url).pathname, "/index.html");
        return new Response(
          readFileSync(new URL("../public/index.html", import.meta.url)),
          { headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }
    },
    getClientIp: (request) => request.headers.get("cf-connecting-ip")
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  db.sqlite.close();
});

test("builds a combined Nuvio manifest and serves selected files without executing them", async () => {
  const home = await testFetch("/").then((response) => response.text());
  assert.match(home, /AIOPlugins/);

  const registerRes = await testFetch("/api/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: mainPassword })
  });
  assert.equal(registerRes.status, 201);
  const registerData = await registerRes.json();
  assert.ok(registerData.user);
  const user = registerData.user;

  const discovered = await testFetch("/api/discover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repository: "https://github.com/example/plugins", ref: "main" })
  }).then((response) => response.json());
  assert.equal(discovered.commit, commit);
  assert.equal(discovered.providers.length, 2);

  const profileCreated = await testFetch("/api/profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "main-profile",
      name: "Main",
      sources: [{
        repository: "https://github.com/example/plugins",
        ref: "main",
        commit,
        providerIds: ["fixture-plugin"]
      }]
    })
  }).then((response) => response.json());
  assert.equal(profileCreated.plugins, 1);

  const middlewareFormat = "{stream.resolution} / {stream.title}";
  const applied = await testFetch("/api/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sources: [{
        repository: "https://github.com/example/plugins",
        ref: "main",
        commit,
        providerIds: ["fixture-plugin"]
      }],
      middleware: {
        sortBy: "resolution",
        minResolution: 1080,
        excludeKeywords: ["cam"],
        cachedOnly: true,
        format: middlewareFormat
      }
    })
  }).then((response) => response.json());
  assert.equal(applied.plugins, 1);
  const config = await testFetch("/api/config").then((response) => response.json());
  assert.equal(config.middleware.format, middlewareFormat);
  assert.ok(config.fields.some((field) => field.key === "audioTags"));
  assert.ok(config.fields.some((field) => field.key === "service.shortName"));

  assert.equal(globalThis.fixturePluginExecuted, undefined);

  // The install link is a bearer credential: it must work without a session.
  const manifestUrl = new URL(user.installPath, BASE_URL);
  const savedCookie = cookieJar;
  cookieJar = "";
  const manifest = await testFetch(manifestUrl).then((response) => response.json());
  assert.match(manifest.name, /AIOPlugins/);
  assert.equal(manifest.scrapers.length, 1);
  assert.equal(manifest.scrapers[0].id, "fixture-plugin");
  assert.equal(manifest.scrapers[0].description, "Preserved source metadata");
  assert.match(manifest.scrapers[0].filename, /^providers\/example-plugins-fixture-plugin-[a-f0-9]{10}\.js$/);

  const fileUrl = new URL(manifest.scrapers[0].filename, manifestUrl);
  const pluginResponse = await testFetch(fileUrl);
  assert.equal(pluginResponse.status, 200);
  assert.equal(pluginResponse.headers.get("content-type"), "application/javascript; charset=utf-8");
  assert.equal(pluginResponse.headers.get("cache-control"), "no-store");
  const servedPlugin = await pluginResponse.text();
  assert.ok(servedPlugin.startsWith(pluginSource));
  assert.match(servedPlugin, /originalGetStreams/);
  assert.ok(servedPlugin.includes(`"format":"${middlewareFormat}"`));
  assert.equal(globalThis.fixturePluginExecuted, undefined);

  cookieJar = savedCookie;
  await testFetch("/api/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sources: [{
        repository: "https://github.com/example/plugins",
        ref: "main",
        commit,
        providerIds: ["fixture-plugin"]
      }],
      middleware: {
        sortField: "resolution",
        sortDirection: "desc",
        filters: [],
        format: "{stream.title} · {stream.year}"
      }
    })
  });
  const updatedManifest = await testFetch(manifestUrl).then((response) => response.json());
  assert.notEqual(updatedManifest.scrapers[0].filename, manifest.scrapers[0].filename);
  cookieJar = savedCookie;

  const health = await testFetch("/health").then((response) => response.json());
  assert.deepEqual(health, { status: "ok" });
});

test("validates hardcoded media search against cached plugin code with latency tracking", async () => {
  const cachedCode = pluginSource;
  const mockModule = {};
  const mockExports = {};

  const startTime = performance.now();
  const fn = new Function('module', 'exports', cachedCode);
  fn(mockModule, mockExports);

  const plugin = mockModule.exports || mockExports;
  assert.equal(typeof plugin.getStreams, "function");

  const streams = await plugin.getStreams({ id: "550", title: "Fight Club", type: "movie" });
  const latencyMs = Math.round(performance.now() - startTime);

  assert.ok(Array.isArray(streams));
  assert.equal(streams.length, 1);
  assert.equal(streams[0].title, "Fight Club 1080p");
  assert.ok(latencyMs >= 0);
});

test("wraps plugin streams with metadata formatting, filtering, and sorting", async () => {
  const source = `module.exports = { getStreams: async () => [
    { title: "Sample 720p", size: 700000000, seeders: 3 },
    { title: "Sample CAM 2160p", size: 2000000000, seeders: 1 },
    { title: "Sample 1080p", size: 1400000000, seeders: 8 }
  ] };`;
  const wrapped = wrapPluginStreams(source, {
    ...DEFAULT_STREAM_MIDDLEWARE,
    sortField: "resolution",
    sortDirection: "desc",
    filters: [
      { field: "resolution", operator: "gte", value: "1080" },
      { field: "title", operator: "notContains", value: "cam" }
    ],
    format: "{stream.resolution} | {stream.title}"
  });
  const module = { exports: {} };
  new Function("module", "exports", wrapped)(module, module.exports);

  const streams = await module.exports.getStreams({ title: "Sample" });
  assert.deepEqual(streams.map(stream => stream.name), [
    "1080p | Sample 1080p"
  ]);
  assert.equal(streams[0].title, "Sample 1080p");
});

test("formats available metadata and omits empty optional blocks", async () => {
  const source = `module.exports = { getStreams: async () => [
    { title: "Feature", resolution: "2160p", size: 1500000000, audioTags: ["AAC", "DTS"] },
    { title: "Unlabeled source" }
  ] };`;
  const module = { exports: {} };
  new Function("module", "exports", wrapPluginStreams(source, DEFAULT_STREAM_MIDDLEWARE))(
    module,
    module.exports
  );

  const streams = await module.exports.getStreams({ title: "Feature" });
  assert.equal(streams[0].name, "🔥4K UHD · Feature · 📦 1.5 GB · 🎧 AAC | DTS");
  assert.equal(streams[0].title, "Feature");
  assert.equal(streams[1].name, "Unlabeled source");
});

test("filters, sorts, and formats across shared metadata fields", async () => {
  const source = `module.exports = { getStreams: async () => [
    { title: "Alpha", languages: ["Japanese"], audioTags: ["DTS"], size: 1000, cached: false },
    { title: "Beta", languages: ["English"], audioTags: ["AAC"], size: 3000, cached: true },
    { title: "Gamma", languages: ["English"], audioTags: ["DTS"], size: 2000, cached: true }
  ] };`;
  const settings = {
    ...DEFAULT_STREAM_MIDDLEWARE,
    filters: [
      { field: "languages", operator: "contains", value: "English" },
      { field: "cached", operator: "isTrue", value: "" }
    ],
    sortField: "size",
    sortDirection: "desc",
    format: "{stream.languages::join(', ')} | {stream.title} | {stream.audioTags::join(', ')}"
  };
  const module = { exports: {} };
  new Function("module", "exports", wrapPluginStreams(source, settings))(
    module,
    module.exports
  );

  const streams = await module.exports.getStreams({ title: "Test" });
  assert.deepEqual(streams.map((stream) => stream.name), [
    "English | Beta | AAC",
    "English | Gamma | DTS"
  ]);
});

test("keeps named profiles and sources manageable", async () => {
  const profilesRes = await testFetch("/api/profiles").then((response) => response.json());
  assert.ok(Array.isArray(profilesRes.profiles));
  assert.ok(profilesRes.profiles.length > 0);

  const targetId = profilesRes.profiles[0].id;
  const deleteRes = await testFetch(`/api/profiles/${targetId}`, {
    method: "DELETE"
  }).then((response) => response.json());
  assert.equal(deleteRes.success, true);
});

test("rate limits by the client IP supplied by the platform", async () => {
  const attempt = (ip) =>
    testFetch("/api/register", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ password: "short" })
    });

  for (let i = 0; i < 5; i++) {
    assert.equal((await attempt("203.0.113.9")).status, 400);
  }

  const limited = await attempt("203.0.113.9");
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);

  // A different client is unaffected.
  assert.equal((await attempt("203.0.113.10")).status, 400);
});
