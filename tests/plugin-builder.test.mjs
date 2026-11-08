import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { handleRequest } from "../dist/server.js";
import { renderAioStreamsFormat } from "../dist/providers/custom-formatter.js";
import { DEFAULT_STREAM_MIDDLEWARE, normalizeStreamMiddlewareSettings, wrapPluginStreams } from "../dist/providers/stream-middleware.js";

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
// files from the Astro build instead of any Cloudflare service.

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
let temporaryAtomFailures = 0;
let fixtureFileRequests = 0;
// What the deployed /version.json contains; undefined means the file is missing.
let versionJson = JSON.stringify({ version: "v1.2.3" });

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
      if (url.pathname.startsWith("/missing/")) {
        return new Response("Not Found", { status: 404 });
      }

      if (temporaryAtomFailures > 0) {
        temporaryAtomFailures--;
        return new Response("Temporarily unavailable", { status: 503 });
      }

      return new Response(
        `<feed><entry><id>tag:github.com,2008:Grit::Commit/${commit}</id></entry></feed>`
      );
    }
    if (url.hostname === "raw.githubusercontent.com" && url.pathname.endsWith("/manifest.json")) {
      return new Response(JSON.stringify(sourceManifest));
    }
    if (url.hostname === "raw.githubusercontent.com" && url.pathname.endsWith("/providers/fixture-plugin.js")) {
      fixtureFileRequests++;
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
        const pathname = decodeURIComponent(new URL(request.url).pathname);
        if (pathname === "/version.json") {
          return versionJson === undefined
            ? new Response("Not found", { status: 404 })
            : new Response(versionJson, { headers: { "content-type": "application/json" } });
        }
        const siteRoot = resolve(fileURLToPath(new URL("../dist/site/", import.meta.url)));
        const filePath = resolve(siteRoot, `.${pathname}`);

        // Resolve only files inside Astro's generated static output.
        if (filePath !== siteRoot && !filePath.startsWith(`${siteRoot}${sep}`)) {
          return new Response("Not found", { status: 404 });
        }

        try {
          const extension = filePath.split(".").pop()?.toLowerCase();
          const contentType = {
            html: "text/html; charset=utf-8",
            js: "application/javascript; charset=utf-8",
            css: "text/css; charset=utf-8",
            json: "application/json; charset=utf-8",
            svg: "image/svg+xml",
            png: "image/png",
            ico: "image/x-icon"
          }[extension] || "application/octet-stream";

          return new Response(readFileSync(filePath), {
            headers: { "content-type": contentType }
          });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      }
    },
    getClientIp: (request) => request.headers.get("cf-connecting-ip")
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  db.sqlite.close();
});

test("removes the provider file cache table", () => {
  assert.throws(
    () => db.sqlite.prepare("SELECT cache_key FROM provider_cache").get(),
    /no such table: provider_cache/
  );
});

test("builds a combined Nuvio manifest and serves selected files without executing them", async () => {
  const home = await testFetch("/").then((response) => response.text());
  assert.match(home, /AIOPlugins/);

  const appScriptPath = [...home.matchAll(/src="([^"]+\.js)"/g)]
    .map((match) => match[1])
    .find((src) => src?.startsWith("/_astro/"));
  assert.ok(appScriptPath, "Astro-generated app script should be present in the page");
  const appScript = await testFetch(appScriptPath);
  assert.equal(appScript.status, 200);
  assert.ok((await appScript.text()).length > 0);

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
  assert.equal(fixtureFileRequests, 0);

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
  assert.equal(fixtureFileRequests, 0);
  const config = await testFetch("/api/config").then((response) => response.json());
  assert.equal(config.middleware.format, middlewareFormat);
  assert.equal(config.middleware.descriptionFormat, middlewareFormat);
  assert.equal(config.middleware.nameFormat, DEFAULT_STREAM_MIDDLEWARE.nameFormat);
  assert.ok(config.fields.some((field) => field.key === "audioTags"));
  assert.ok(config.fields.some((field) => field.key === "service.shortName"));

  const previewResponse = await testFetch("/api/formatter/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      nameFormat: "{stream.resolution}",
      descriptionFormat: "{metadata.title} ({stream.year}) · {stream.resolution}",
      stream: { filename: "Movie.Title.2023.2160p.BluRay.HEVC.mkv" },
      metadata: { title: "Movie Title" }
    })
  });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.name, "2160p");
  assert.equal(preview.description, "Movie Title (2023) · 2160p");
  assert.equal(preview.title, preview.description);
  assert.equal(preview.parsed.quality, "BluRay");

  const legacyPreview = await testFetch("/api/formatter/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      format: "{stream.title}",
      stream: { title: "Legacy format" }
    })
  }).then((response) => response.json());
  assert.equal(legacyPreview.description, "Legacy format");
  assert.equal(legacyPreview.title, legacyPreview.description);

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

  // The deployed AIOPlugins version is surfaced where Nuvio can show it.
  assert.equal(manifest.version, "1.2.3");
  assert.match(manifest.name, /^AIOPlugins v1\.2\.3 · /);
  assert.equal(manifest.author, "AIOPlugins");
  assert.match(manifest.description, /AIOPlugins v1\.2\.3: 1 plugin from 1 source/);
  assert.equal(manifest.scrapers[0].version, "1.0.0+aio.1.2.3");
  assert.equal(manifest.scrapers[0].logo, "https://assets.example/logo.png");
  assert.equal(manifest.scrapers[0].enabled, true);
  assert.deepEqual(manifest.scrapers[0].supportedTypes, ["movie", "tv"]);
  assert.equal(manifest.logo, `${BASE_URL}/favicon-192.png`);

  // Without a version file (local development) the version is "dev".
  versionJson = undefined;
  const devManifest = await testFetch(manifestUrl).then((response) => response.json());
  assert.equal(devManifest.version, "0.0.0-dev");
  assert.match(devManifest.name, /^AIOPlugins dev · /);
  assert.equal(devManifest.scrapers[0].version, "1.0.0+aio.dev");
  versionJson = JSON.stringify({ version: "v1.2.3" });
  assert.match(manifest.scrapers[0].filename, /^providers\/example-plugins-fixture-plugin-[a-f0-9]{10}\.js$/);

  const fileUrl = new URL(manifest.scrapers[0].filename, manifestUrl);
  const pluginResponse = await testFetch(fileUrl);
  assert.equal(pluginResponse.status, 200);
  assert.equal(pluginResponse.headers.get("content-type"), "application/javascript; charset=utf-8");
  assert.equal(pluginResponse.headers.get("cache-control"), "no-store");
  assert.equal(fixtureFileRequests, 1);
  const servedPlugin = await pluginResponse.text();
  assert.ok(servedPlugin.startsWith(pluginSource));
  assert.match(servedPlugin, /originalGetStreams/);
  assert.ok(servedPlugin.includes(`"format":"${middlewareFormat}"`));
  assert.equal(globalThis.fixturePluginExecuted, undefined);

  const secondPluginResponse = await testFetch(fileUrl);
  assert.equal(secondPluginResponse.status, 200);
  assert.equal(fixtureFileRequests, 2);

  // Nuvio sends HEAD before downloading a plugin: it must succeed without
  // fetching the upstream file.
  const headResponse = await testFetch(fileUrl, { method: "HEAD" });
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get("content-type"), "application/javascript; charset=utf-8");
  assert.equal(await headResponse.text(), "");
  assert.equal(fixtureFileRequests, 2);
  const unknownHead = await testFetch(new URL("providers/nope.js", manifestUrl), { method: "HEAD" });
  assert.equal(unknownHead.status, 404);

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
  assert.deepEqual(health, { status: "ok", version: "1.2.3" });

  // The stream badge pack is public and importable by Nuvio.
  const badgeResponse = await testFetch("/badges.json");
  assert.equal(badgeResponse.status, 200);
  assert.equal(badgeResponse.headers.get("access-control-allow-origin"), "*");
  const pack = await badgeResponse.json();
  assert.ok(pack.filters.length >= 30);
  assert.ok(pack.filters.every((filter) => filter.imageURL.startsWith(`${BASE_URL}/badges/`)));
  const chip = await testFetch(new URL(pack.filters[0].imageURL).pathname);
  assert.equal(chip.status, 200);
  assert.equal(chip.headers.get("content-type"), "image/png");
});

test("retries transient GitHub failures during source discovery", async () => {
  temporaryAtomFailures = 1;

  const response = await testFetch("/api/discover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repository: "https://github.com/example/plugins",
      ref: "main"
    })
  });

  assert.equal(response.status, 200);
  const discovered = await response.json();
  assert.equal(discovered.commit, commit);
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

test("formats wrapped streams when the embedded formatter uses esbuild helpers", async () => {
  const formatter = renderAioStreamsFormat;
  const originalToString = Object.getOwnPropertyDescriptor(formatter, "toString");
  const originalStringAt = Object.getOwnPropertyDescriptor(String.prototype, "at");
  const formatterSource = formatter.toString();
  formatter.toString = () => formatterSource.replace(
    "const REMOVE_LINE =",
    "__name(() => {}, 'formatter');\n  const REMOVE_LINE ="
  );

  try {
    Object.defineProperty(String.prototype, "at", {
      configurable: true,
      value: undefined
    });
    const module = { exports: {} };
    const source = `module.exports = { getStreams: async () => [{ title: "Sample.1080p.WEB-DL.mkv", quality: "1080p" }] };`;
    new Function("module", "exports", wrapPluginStreams(source, {
      ...DEFAULT_STREAM_MIDDLEWARE,
      descriptionFormat: "{stream.resolution}"
    }))(module, module.exports);

    const [stream] = await module.exports.getStreams({});

    assert.match(stream.name, /FHD/);
    assert.doesNotMatch(stream.name, /\{stream\./);
    assert.equal(stream.description, "1080p");
  } finally {
    if (originalToString) Object.defineProperty(formatter, "toString", originalToString);
    else delete formatter.toString;
    if (originalStringAt) Object.defineProperty(String.prototype, "at", originalStringAt);
    else delete String.prototype.at;
  }
});

test("wraps frozen provider stream objects without mutating them", async () => {
  const module = { exports: {} };
  const source = `module.exports = { getStreams: async () => [Object.freeze({ title: "Sample.1080p.WEB-DL.mkv", url: "https://example.com/stream.m3u8" })] };`;
  new Function("module", "exports", wrapPluginStreams(source, DEFAULT_STREAM_MIDDLEWARE))(
    module,
    module.exports
  );

  const streams = await module.exports.getStreams({});

  assert.equal(streams.length, 1);
  assert.equal(streams[0].name, "🚀 FHD");
  assert.match(streams[0].description, /^🎬 Sample/);
  assert.match(streams[0].description, /WEB-DL/);
  assert.equal(streams[0].title, streams[0].description);
  assert.equal(streams[0].resolution, "1080p");
});

test("formats provider streams with circular metadata", async () => {
  const module = { exports: {} };
  const source = `const stream = { title: "Sample 1080p", url: "https://example.com/stream.m3u8" }; stream.extra = { parent: stream }; module.exports = { getStreams: async () => [stream] };`;
  new Function("module", "exports", wrapPluginStreams(source, DEFAULT_STREAM_MIDDLEWARE))(
    module,
    module.exports
  );

  const streams = await module.exports.getStreams({});

  assert.equal(streams.length, 1);
  assert.equal(streams[0].name, "🚀 FHD");
  assert.match(streams[0].description, /^🎬 Sample/);
  assert.equal(streams[0].title, streams[0].description);
});

test("falls back to legacy token formatting when metadata access throws", async () => {
  const module = { exports: {} };
  const source = `const service = new Proxy({}, { ownKeys() { throw new Error("unsupported metadata"); } }); module.exports = { getStreams: async () => [{ title: "Sample 1080p", service }] };`;
  new Function("module", "exports", wrapPluginStreams(source, {
    ...DEFAULT_STREAM_MIDDLEWARE,
    format: "{stream.resolution::replace('1080p', 'FHD')} · {stream.title}"
  }))(module, module.exports);

  const streams = await module.exports.getStreams({});

  assert.equal(streams.length, 1);
  assert.equal(streams[0].name, "🚀 FHD");
  assert.equal(streams[0].description, "FHD · Sample");
  assert.equal(streams[0].title, streams[0].description);
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
  assert.deepEqual(streams.map(stream => stream.description), [
    "1080p | Sample"
  ]);
  assert.equal(streams[0].title, "1080p | Sample");
  assert.equal(streams[0].name, "🚀 FHD");
  assert.equal(streams[0].filename, "Sample 1080p");
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
  assert.equal(streams[0].name, "🔥4K UHD");
  assert.match(streams[0].description, /🎬 Feature/);
  assert.match(streams[0].description, /📦 1.5 GB/);
  assert.match(streams[0].description, /🎧 AAC \| DTS/);
  assert.equal(streams[0].title, streams[0].description);
  assert.equal(streams[1].name, "💩 Unknown");
  assert.match(streams[1].description, /^🎬 Unlabeled Source/);
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
  assert.deepEqual(streams.map((stream) => stream.description), [
    "English | Beta | AAC",
    "English | Gamma | DTS"
  ]);
});

test("supports AIOStreams nested optional groups and conditional branches", () => {
  const stream = {
    title: "sample",
    resolution: "2160p",
    quality: "WEB-DL",
    cached: false,
    type: "p2p",
    seeders: 8
  };

  assert.equal(
    renderAioStreamsFormat(
      "{?{stream.resolution}{? · {stream.quality}?}?}",
      stream
    ),
    "2160p · WEB-DL"
  );
  assert.equal(
    renderAioStreamsFormat(
      "{stream.cached[\"Cached\"||\"Uncached\"||\"Unknown\"]} {stream.seeders::>0::and::stream.type::=p2p[\"Seeded\"||\"\"]}",
      stream
    ),
    "Uncached Seeded"
  );
  assert.equal(
    renderAioStreamsFormat(
      "{stream.resolution::exists[\"{stream.quality::exists[\\\"{stream.resolution} {stream.quality}\\\"||\\\"quality?\\\"]}\"||\"Unknown\"]}",
      stream
    ),
    "2160p WEB-DL"
  );
  assert.equal(
    renderAioStreamsFormat(
      "{stream.message::exists[\"Found\"||\"Missing\"||\"Unknown\"]}",
      { message: "   " }
    ),
    "Unknown"
  );
  assert.equal(
    renderAioStreamsFormat("{stream.seeders::upper}", stream),
    "{unknown_number_modifier(upper)}"
  );
  assert.equal(
    renderAioStreamsFormat("{stream.seeders::upper::lower}", stream),
    "{unknown_number_modifier(upper)}"
  );
  assert.equal(
    renderAioStreamsFormat("{stream.audioTracks::pluck('lang')::join(' ')}", { audioTracks: [] }),
    ""
  );

  const module = { exports: {} };
  const wrapperFormat = "{stream.cached[\"Cached\"||\"Uncached\"||\"Unknown\"]} · {?{stream.resolution}?}";
  // The fixture is passed in as a function argument instead of being
  // serialized into generated code.
  const source = "module.exports = { getStreams: async () => [fixtureStream] };";
  new Function("module", "exports", "fixtureStream", wrapPluginStreams(source, {
    ...DEFAULT_STREAM_MIDDLEWARE,
    format: wrapperFormat
  }))(module, module.exports, stream);
  return module.exports.getStreams({}).then(streams => {
    assert.equal(streams[0].description, "Uncached · 2160p");
    assert.equal(streams[0].title, streams[0].description);
  });
});

test("renders nested language conditional branches in wrapped providers", async () => {
  const module = { exports: {} };
  const source = `module.exports = { getStreams: async () => [{ title: "Example", languages: ["English", "Korean"] }] };`;
  const format = `{stream.languages::exists["🗣️ {stream.languages::~English["🇬🇧 "||""]}{stream.languages::~Chinese["🇨🇳 "||""]}{stream.languages::~Korean["🇰🇷 "||""]}{stream.languages::length::>1["🌐{stream.languages::length} "||""]}"||""]}`;
  new Function("module", "exports", wrapPluginStreams(source, {
    ...DEFAULT_STREAM_MIDDLEWARE,
    format
  }))(module, module.exports);

  const [stream] = await module.exports.getStreams({});

  assert.equal(stream.description, "🗣️ 🇬🇧 🇰🇷 🌐2 ");
});

test("formats the stream name and description separately", async () => {
  const module = { exports: {} };
  const source = `module.exports = { getStreams: async () => [{ name: "4KHDHub - HubCloud 1080p", title: "Doctor.X.Mafia.S01E01.1080p.WEB-DL.mkv", description: "Original WEB-DL", size: 1234 }] };`;
  new Function("module", "exports", wrapPluginStreams(source, {
    ...DEFAULT_STREAM_MIDDLEWARE,
    nameFormat: "{stream.resolution}",
    descriptionFormat: "{stream.title} · {stream.resolution}"
  }))(module, module.exports);

  const [stream] = await module.exports.getStreams({});

  assert.equal(stream.name, "1080p");
  assert.equal(stream.description, "Doctor X Mafia · 1080p");
  assert.equal(stream.title, stream.description);
  // Nuvio shows size and language before title, so neither may survive.
  assert.equal(stream.size, undefined);
  assert.equal(stream.language, undefined);
  assert.equal(stream.fileSize, 1234);
  assert.equal(stream.behaviorHints.videoSize, 1234);
  assert.equal(stream.quality, "1080p");
});

test("applies title filters to provider metadata rather than formatted output", async () => {
  const module = { exports: {} };
  const source = `module.exports = { getStreams: async () => [{ title: "Sample.CAM.1080p.mkv" }] };`;
  new Function("module", "exports", wrapPluginStreams(source, {
    ...DEFAULT_STREAM_MIDDLEWARE,
    filters: [{ field: "title", operator: "notContains", value: "CAM" }],
    format: "{stream.resolution}"
  }))(module, module.exports);

  assert.deepEqual(await module.exports.getStreams({}), []);
});

test("provides the selected plugin name as the addon formatter scope", async () => {
  const module = { exports: {} };
  const source = `module.exports = { getStreams: async () => [{ title: "Sample" }] };`;
  new Function("module", "exports", wrapPluginStreams(source, {
    ...DEFAULT_STREAM_MIDDLEWARE,
    format: "{addon.name} · {stream.title}"
  }, "ReAnime"))(module, module.exports);

  const [stream] = await module.exports.getStreams({});

  assert.equal(stream.description, "ReAnime · Sample");
  assert.equal(stream.title, stream.description);
});

test("supports AIOStreams array, track, language, date, and duration modifiers", () => {
  const stream = {
    audioTracks: [
      { lang: "English", channels: "5.1", commentary: false },
      { lang: "English", channels: "2.0", commentary: true }
    ],
    date: "2024-07-04",
    duration: 65_000
  };

  assert.equal(
    renderAioStreamsFormat(
      "{stream.audioTracks::where('lang=English', '!commentary')::pluck('lang')::languageCode::join(',')}|{stream.audioTracks::where('lang=English', '!commentary')::each(\"{track.lang::languageCode} {track.channels}\")::join(' | ')}|{stream.date::date('%B %o, %Y')}|{stream.duration::time('[%-Hh ]%-Mm[ %-Ss]')}",
      stream
    ),
    "EN|EN 5.1|July 4th, 2024|1m 5s"
  );
  assert.equal(
    renderAioStreamsFormat("{stream.languages::$EN[\"starts\"||\"no\"]}", { languages: ["EN", "DE"] }),
    "starts"
  );
  assert.equal(
    renderAioStreamsFormat("{stream.languages::^EN[\"ends\"||\"no\"]}", { languages: ["DE", "EN"] }),
    "ends"
  );
});

test("extracts filename metadata from Nuvio behavior hints before provider labels", () => {
  const withBehaviorFilename = {
    name: "4KHDHub - HubCloud 1080p",
    title: "WEB-DL",
    quality: "1080p",
    behaviorHints: {
      filename: "Doctor.X.Mafia.in.White.S01E06.1080p.NF.WEB-DL.English.AAC2.0.H.264-GRP.mkv"
    }
  };
  const extracted = renderAioStreamsFormat(
    "{stream.title}|{stream.formattedSeasons}|{stream.formattedEpisodes}|{stream.resolution}|{stream.quality}|{stream.network}|{stream.encode}|{stream.audioTags::join(', ')}",
    withBehaviorFilename
  );

  assert.equal(
    extracted,
    "Doctor X Mafia in White|S01|E06|1080p|WEB-DL|Netflix|AVC|AAC"
  );

  const withTitleOnly = {
    name: "4KHDHub - HubCloud 1080p",
    title: "Doctor X Mafia WEB-DL",
    quality: "1080p"
  };
  assert.equal(
    renderAioStreamsFormat("{stream.title}", withTitleOnly),
    "Doctor X Mafia"
  );
});

test("extracts a clean title from provider filename paths and URL-encoded basenames", () => {
  const stream = {
    behaviorHints: {
      filename: "/cache/series/The.Flash.S02E03.1080p.WEB-DL.H264.mkv?token=private"
    }
  };

  assert.equal(
    renderAioStreamsFormat("{stream.title}", stream),
    "The Flash"
  );

  const encoded = {
    filename: "https://cdn.example.test/files/The%20Flash%20S02E03%201080p%20WEB-DL.mkv?download=1"
  };
  assert.equal(renderAioStreamsFormat("{stream.title}", encoded), "The Flash");

  const providerLabel = {
    filename: "FHD",
    title: "The.Flash.2014.S02E03.1080p.WEB-DL.mkv"
  };
  assert.equal(renderAioStreamsFormat("{stream.title}", providerLabel), "The Flash");
});

test("extracts shared media fields from provider filenames before formatting", async () => {
  const stream = {
    name: "4KHDHub - PixelDrain 1080p",
    title: "Doctor.X.Mafia.in.White.S01E06.1080p.NF.WEB-DL.English.AAC2.0-Korean.AAC2.0.H.264-4kHdHub.Com.mkv",
    size: "2.24 GB"
  };

  const label = renderAioStreamsFormat(
    "{stream.title} · {stream.formattedSeasons} {stream.formattedEpisodes} · {stream.resolution} · {stream.quality} · {stream.network} · {stream.encode} · {stream.audioTags::join(', ')} · {stream.languages::join(', ')} · {stream.size::sbytes}",
    stream
  );

  assert.equal(stream.title, "Doctor X Mafia in White");
  assert.equal(stream.filename, "Doctor.X.Mafia.in.White.S01E06.1080p.NF.WEB-DL.English.AAC2.0-Korean.AAC2.0.H.264-4kHdHub.Com.mkv");
  assert.equal(stream.size, 2240000000);
  assert.match(label, /Doctor X Mafia in White · S01 E06 · 1080p · WEB-DL · Netflix · AVC/);
  assert.match(label, /AAC · English, Korean · 2.2 GB/);

  const module = { exports: {} };
  // The fixture is passed in as a function argument instead of being
  // serialized into generated code.
  const source = "module.exports = { getStreams: async () => [fixtureStream] };";
  new Function("module", "exports", "fixtureStream", wrapPluginStreams(source, {
    ...DEFAULT_STREAM_MIDDLEWARE,
    filters: [
      { field: "languages", operator: "contains", value: "Korean" },
      { field: "releaseGroup", operator: "equals", value: "4kHdHub.Com" }
    ],
    format: "{stream.title} · {stream.formattedSeasons} {stream.formattedEpisodes} · {stream.resolution} · {stream.quality} · {stream.network} · {stream.encode}"
  }))(module, module.exports, stream);
  const [wrapped] = await module.exports.getStreams({});
  assert.equal(wrapped.title, "Doctor X Mafia in White · S01 E06 · 1080p · WEB-DL · Netflix · AVC");
  assert.equal(wrapped.network, "Netflix");
  assert.equal(wrapped.fileSize, 2240000000);
  assert.equal(wrapped.behaviorHints.videoSize, 2240000000);
  assert.equal(wrapped.size, undefined);
  assert.equal(wrapped.description, wrapped.title);
  assert.equal(wrapped.name, "🚀 FHD");
});
test("strips provider emojis but preserves formatter template emojis", () => {
  const stream = {
    quality: "🔥4K UHD",
    title: "🎬 Doctor X 🇬🇧",
    languages: ["🇬🇧 English", "🇰🇷 한국어", "🇨🇳 中文"],
  };

  const result = renderAioStreamsFormat(
    "🚀 {stream.quality} · 🎥 {stream.title} · {stream.languages::join(', ')}",
    stream
  );

  assert.equal(
    result,
    "🚀 4K UHD · 🎥 Doctor X · English, 한국어, 中文"
  );
});
test("keeps the media title when a provider name contains only its source and resolution", async () => {
  const module = { exports: {} };
  const source = `module.exports = { getStreams: async () => [{
    name: "4KHDHub - PixelDrain 720p",
    title: "Doctor.X.Mafia.in.White.S01E01\\n2.59 GB",
    quality: "720p"
  }] };`;
  new Function("module", "exports", wrapPluginStreams(source, DEFAULT_STREAM_MIDDLEWARE))(
    module,
    module.exports
  );

  const [stream] = await module.exports.getStreams({});

  assert.equal(stream.name, "💿 HD");
  assert.match(stream.description, /Doctor X Mafia In White/);
  assert.doesNotMatch(stream.description, /4KHDHub - PixelDrain/);
});

test("uses the detailed formatter template by default", () => {
  const settings = normalizeStreamMiddlewareSettings({});
  assert.equal(settings.format, DEFAULT_STREAM_MIDDLEWARE.format);
  assert.ok(settings.format.length < 3000);
  assert.equal(
    renderAioStreamsFormat(DEFAULT_STREAM_MIDDLEWARE.nameFormat, { title: "Sample without resolution" }),
    "💩 Unknown"
  );

  const label = renderAioStreamsFormat(settings.format, {
    title: "the matrix",
    year: 1999,
    seadexBest: true,
    quality: "BluRay",
    visualTags: ["HDR10"],
    audioTags: ["Atmos"],
    size: 1500000000,
    seeders: 5,
    type: "p2p",
    cached: true,
    service: { cached: true, shortName: "RD" },
    message: "Verified"
  }, "AIOPlugins");

  assert.match(label, /The Matrix/);
  assert.match(label, /🎚️ Best/);
  assert.match(label, /🎥 BluRay/);
  assert.match(label, /⚡Ready/);
  assert.match(label, /🔍AIOPlugins/);
  assert.match(label, /ℹ️ Verified/);
});

test("keeps partial provider metadata useful without inventing fields", () => {
  const previousDefault = "{?{stream.resolution::replace('2160p', '🔥4K UHD')::replace('1440p', '✨ QHD')::replace('1080p', '🚀 FHD')::replace('720p', '💿 HD')::replace('576p', '💩 Low Quality')::replace('480p', '💩 Low Quality')::replace('360p', '💩 Low Quality')::replace('240p', '💩 Low Quality')::replace('144p', '💩 Low Quality')} · ?}{stream.title}{? · {stream.formattedSeasons}?}{? · {stream.formattedEpisodes}?}{? · 📦 {stream.size::sbytes}?}{? · 🎧 {stream.audioTags::join(' | ')}?}";
  const legacyFormat = previousDefault.replace(
    "{? · {stream.formattedSeasons}?}{? · {stream.formattedEpisodes}?}",
    ""
  );
  assert.equal(
    normalizeStreamMiddlewareSettings({ format: previousDefault }).format,
    DEFAULT_STREAM_MIDDLEWARE.format
  );
  assert.equal(
    normalizeStreamMiddlewareSettings({ format: legacyFormat }).format,
    DEFAULT_STREAM_MIDDLEWARE.format
  );

  const stream = {
    name: "ReAnime",
    title: "Doctor X: Mafia in White - Episode 6 (DUB)"
  };

  const label = renderAioStreamsFormat(DEFAULT_STREAM_MIDDLEWARE.format, stream);

  assert.equal(stream.title, "Doctor X: Mafia in White");
  assert.equal(stream.formattedEpisodes, "E06");
  assert.equal(stream.resolution, undefined);
  assert.match(label, /🎬 Doctor X: Mafia In White/);
  assert.match(label, /🎞️ E06/);
});

function runWrapped(source, settings) {
  const module = { exports: {} };
  new Function("module", "exports", wrapPluginStreams(source, settings))(module, module.exports);
  return module.exports;
}

test("reports source problems with specific messages and status codes", async () => {
  const post = (repository) => testFetch("/api/discover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repository, ref: "main" })
  });

  const invalid = await post("not a url");
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /valid GitHub repository URL/);

  const notGitHub = await post("https://example.com/owner/repo");
  assert.equal(notGitHub.status, 400);

  const missing = await post("https://github.com/missing/repo");
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /not found/i);
});

test("returns the saved workspace with the session so the UI can load in one request", async () => {
  const session = await testFetch("/api/session").then((response) => response.json());

  assert.ok(session.user);
  assert.ok(Array.isArray(session.workspace.sources));
  assert.ok(Array.isArray(session.workspace.profiles));
  assert.ok(session.workspace.middleware);
  assert.equal(
    session.workspace.fields.find((field) => field.key === "date").type,
    "date"
  );

  const resolution = session.workspace.fields.find((field) => field.key === "resolution");
  assert.deepEqual(resolution.options[0], { value: "2160", label: "2160p" });

  for (const profile of session.workspace.profiles) {
    for (const source of profile.sources) {
      assert.equal(source.providers, undefined, "cached provider entries stay on the server");
    }
  }
});

test("normalizes date and numeric filters picked in the UI", () => {
  const settings = normalizeStreamMiddlewareSettings({
    filters: [
      { field: "date", operator: "gte", value: "2023-06-01" },
      { field: "date", operator: "lt", value: "2023-02-31" },
      { field: "date", operator: "lt", value: "not a date" },
      { field: "date", operator: "contains", value: "2023" },
      { field: "resolution", operator: "gte", value: "1080p" },
      { field: "resolution", operator: "gte", value: "" },
      { field: "year", operator: "lte", value: "abc" }
    ]
  });

  assert.deepEqual(settings.filters, [
    { field: "date", operator: "gte", value: "2023-06-01" },
    { field: "date", operator: "contains", value: "2023" },
    { field: "resolution", operator: "gte", value: "1080" }
  ]);
});

test("filters and sorts streams by release date", async () => {
  const source = `module.exports = { getStreams: async () => [
    { title: "Old", date: "2021-03-04" },
    { title: "New", date: "2024-01-15" },
    { title: "Middle", date: "2023-06-01" },
    { title: "Undated" }
  ] };`;
  const titles = async (settings) => {
    const streams = await runWrapped(source, {
      ...DEFAULT_STREAM_MIDDLEWARE,
      format: "{stream.title}",
      ...settings
    }).getStreams({});
    return streams.map((stream) => stream.description);
  };

  assert.deepEqual(
    await titles({ filters: [{ field: "date", operator: "gte", value: "2023-06-01" }] }),
    ["New", "Middle"]
  );
  assert.deepEqual(
    await titles({ filters: [{ field: "date", operator: "lt", value: "2023-06-01" }] }),
    ["Old"]
  );
  assert.deepEqual(
    await titles({ filters: [{ field: "date", operator: "equals", value: "2024-01-15" }] }),
    ["New"]
  );
  assert.deepEqual(
    await titles({ sortField: "date", sortDirection: "desc" }),
    ["New", "Middle", "Old", "Undated"]
  );
  assert.deepEqual(
    await titles({ sortField: "date", sortDirection: "asc" }),
    ["Old", "Middle", "New", "Undated"]
  );
});

test("filters by resolution values chosen from the dropdown", async () => {
  const source = `module.exports = { getStreams: async () => [
    { title: "A 720p" }, { title: "B 1080p" }, { title: "C 2160p" }
  ] };`;
  const streams = await runWrapped(source, {
    ...DEFAULT_STREAM_MIDDLEWARE,
    filters: [{ field: "resolution", operator: "gte", value: "1080p" }],
    format: "{stream.title}"
  }).getStreams({});

  assert.deepEqual(streams.map((stream) => stream.description), ["B", "C"]);
});

test("sorts ranked fields by quality rather than alphabetically", async () => {
  const source = `module.exports = { getStreams: async () => [
    { title: "A", quality: "CAM" },
    { title: "B", quality: "BluRay REMUX" },
    { title: "C", quality: "WEB-DL" },
    { title: "D", quality: "HDTV" }
  ] };`;
  const sorted = async (sortDirection) => {
    const streams = await runWrapped(source, {
      ...DEFAULT_STREAM_MIDDLEWARE,
      sortField: "quality",
      sortDirection,
      format: "{stream.title}"
    }).getStreams({});
    return streams.map((stream) => stream.description);
  };

  assert.deepEqual(await sorted("desc"), ["B", "C", "D", "A"]);
  assert.deepEqual(await sorted("asc"), ["A", "D", "C", "B"]);
});

test("migrates a single saved sort and normalizes stacked sorts", () => {
  assert.deepEqual(
    normalizeStreamMiddlewareSettings({ sortField: "size", sortDirection: "asc" }).sorts,
    [{ field: "size", direction: "asc", unknown: "last" }]
  );
  assert.deepEqual(normalizeStreamMiddlewareSettings({}).sorts, []);
  assert.deepEqual(normalizeStreamMiddlewareSettings({ sortField: "nope" }).sorts, []);

  // Saved levels win over the old single-sort keys.
  const stacked = normalizeStreamMiddlewareSettings({
    sortField: "size",
    sorts: [
      { field: "resolution", direction: "desc", unknown: "first" },
      { field: "resolution", direction: "asc" },
      { field: "bogus", direction: "asc" },
      { field: "seeders", direction: "sideways" }
    ]
  });
  assert.deepEqual(stacked.sorts, [
    { field: "resolution", direction: "desc", unknown: "first" },
    { field: "seeders", direction: "desc", unknown: "last" }
  ]);

  const many = normalizeStreamMiddlewareSettings({
    sorts: ["resolution", "size", "seeders", "year", "quality", "encode", "title"]
      .map((field) => ({ field, direction: "asc" }))
  });
  assert.equal(many.sorts.length, 5);
});

test("breaks ties with stacked sorts and falls back to provider order", async () => {
  const source = `module.exports = { getStreams: async () => [
    { title: "A", resolution: "1080p", size: 3000 },
    { title: "B", resolution: "2160p", size: 9000 },
    { title: "C", resolution: "1080p", size: 1000 },
    { title: "D", resolution: "1080p", size: 1000 },
    { title: "E", resolution: "720p", size: 500 }
  ] };`;
  const titles = async (sorts) => {
    const streams = await runWrapped(source, {
      ...DEFAULT_STREAM_MIDDLEWARE,
      sorts,
      format: "{stream.title}"
    }).getStreams({});
    return streams.map((stream) => stream.description).join("");
  };

  assert.equal(await titles([]), "ABCDE");
  assert.equal(await titles([{ field: "resolution", direction: "desc" }]), "BACDE");
  // C and D tie on both levels, so they stay in the provider's order.
  assert.equal(
    await titles([
      { field: "resolution", direction: "desc" },
      { field: "size", direction: "asc" }
    ]),
    "BCDAE"
  );
  assert.equal(
    await titles([
      { field: "resolution", direction: "desc" },
      { field: "size", direction: "desc" }
    ]),
    "BACDE"
  );
});

test("places unknown sort values first or last at every level", async () => {
  const source = `module.exports = { getStreams: async () => [
    { title: "A", resolution: "720p", seeders: 1 },
    { title: "B", seeders: 5 },
    { title: "C", resolution: "Unknown", seeders: 9 },
    { title: "D", resolution: "1080p", seeders: 2 }
  ] };`;
  const titles = async (sorts) => {
    const streams = await runWrapped(source, {
      ...DEFAULT_STREAM_MIDDLEWARE,
      sorts,
      format: "{stream.title}"
    }).getStreams({});
    return streams.map((stream) => stream.description).join("");
  };

  // B and C are both unknown, so they tie on resolution and seeders decides.
  assert.equal(
    await titles([
      { field: "resolution", direction: "desc", unknown: "last" },
      { field: "seeders", direction: "desc" }
    ]),
    "DACB"
  );
  // Unknowns stay last even when the order is reversed.
  assert.equal(
    await titles([
      { field: "resolution", direction: "asc", unknown: "last" },
      { field: "seeders", direction: "desc" }
    ]),
    "ADCB"
  );
  assert.equal(
    await titles([
      { field: "resolution", direction: "desc", unknown: "first" },
      { field: "seeders", direction: "asc" }
    ]),
    "BCDA"
  );
});

test("treats placeholder text such as Unknown as a missing value", async () => {
  const source = `module.exports = { getStreams: async () => [
    { title: "Known", quality: "WEB-DL" },
    { title: "Placeholder", quality: "Unknown" },
    { title: "Blank", quality: "  " },
    { title: "Inferred 1080p", resolution: "N/A" }
  ] };`;
  const run = (settings) =>
    runWrapped(source, { ...DEFAULT_STREAM_MIDDLEWARE, format: "{stream.title}", ...settings })
      .getStreams({})
      .then((streams) => streams.map((stream) => stream.description));

  assert.deepEqual(
    await run({ filters: [{ field: "quality", operator: "missing", value: "" }] }),
    ["Placeholder", "Blank", "Inferred"]
  );
  assert.deepEqual(
    await run({ filters: [{ field: "quality", operator: "exists", value: "" }] }),
    ["Known"]
  );
  // A placeholder resolution falls back to the number found in the title.
  assert.deepEqual(
    await run({ filters: [{ field: "resolution", operator: "gte", value: "1080" }] }),
    ["Inferred"]
  );
  // Free-text fields keep what the provider wrote.
  const titled = await runWrapped(
    `module.exports = { getStreams: async () => [{ title: "None" }] };`,
    { ...DEFAULT_STREAM_MIDDLEWARE, filters: [{ field: "title", operator: "exists", value: "" }] }
  ).getStreams({});
  assert.equal(titled.length, 1);
});

test("lets each filter keep or drop streams with unknown values", async () => {
  const source = `module.exports = { getStreams: async () => [
    { title: "Hi", resolution: "1080p", quality: "WEB-DL" },
    { title: "Lo", resolution: "480p", quality: "CAM" },
    { title: "Unk" }
  ] };`;
  const run = async (filter) => {
    const streams = await runWrapped(source, {
      ...DEFAULT_STREAM_MIDDLEWARE,
      filters: [filter],
      format: "{stream.title}"
    }).getStreams({});
    return streams.map((stream) => stream.description).join(",");
  };

  // Without a choice, the operator keeps its previous behavior.
  assert.equal(await run({ field: "resolution", operator: "gte", value: "720" }), "Hi");
  assert.equal(await run({ field: "quality", operator: "notEquals", value: "CAM" }), "Hi,Unk");
  assert.equal(await run({ field: "quality", operator: "notContains", value: "cam" }), "Hi,Unk");
  assert.equal(await run({ field: "quality", operator: "equals", value: "CAM" }), "Lo");

  // An explicit choice overrides it.
  assert.equal(
    await run({ field: "resolution", operator: "gte", value: "720", unknown: "keep" }),
    "Hi,Unk"
  );
  assert.equal(
    await run({ field: "quality", operator: "notEquals", value: "CAM", unknown: "drop" }),
    "Hi"
  );
  assert.equal(
    await run({ field: "resolution", operator: "lt", value: "720", unknown: "keep" }),
    "Lo,Unk"
  );
});

test("keeps the unknown choice on filters it applies to", () => {
  const settings = normalizeStreamMiddlewareSettings({
    filters: [
      { field: "resolution", operator: "gte", value: "1080", unknown: "keep" },
      { field: "quality", operator: "exists", value: "", unknown: "keep" },
      { field: "quality", operator: "equals", value: "CAM", unknown: "maybe" }
    ]
  });

  assert.deepEqual(settings.filters, [
    { field: "resolution", operator: "gte", value: "1080", unknown: "keep" },
    { field: "quality", operator: "exists", value: "" },
    { field: "quality", operator: "equals", value: "CAM" }
  ]);
});

test("formats unknown values with a fallback, or skips them", async () => {
  const source = `module.exports = { getStreams: async () => [
    { title: "Known", quality: "WEB-DL" },
    { title: "Placeholder", quality: "Unknown" },
    { title: "Missing" }
  ] };`;
  const run = async (format) => {
    const streams = await runWrapped(source, {
      ...DEFAULT_STREAM_MIDDLEWARE,
      format
    }).getStreams({});
    return streams.map((stream) => stream.description);
  };

  assert.deepEqual(
    await run('{stream.title}: {stream.quality::exists["{stream.quality}"||"Unrated"]}'),
    ["Known: WEB-DL", "Placeholder: Unrated", "Missing: Unrated"]
  );
  assert.deepEqual(
    await run("{stream.title}{? · {stream.quality}?}"),
    ["Known · WEB-DL", "Placeholder", "Missing"]
  );

  const preview = await testFetch("/api/formatter/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      descriptionFormat: '{stream.quality::exists["{stream.quality}"||"Unrated"]}',
      stream: { quality: "Unknown" }
    })
  }).then((response) => response.json());
  assert.equal(preview.description, "Unrated");
});

test("issues 256-bit install tokens and lets the owner reroll them", async () => {
  const savedCookie = cookieJar;
  cookieJar = "";

  try {
    const headers = { "content-type": "application/json", "cf-connecting-ip": "198.51.100.77" };
    const post = (path, body) =>
      testFetch(path, { method: "POST", headers, body: JSON.stringify(body) });
    const tokenOf = (installPath) => installPath.split("/")[3];
    const password = "RerollPassword!1";

    const registered = await post("/api/register", { password }).then((response) => response.json());
    const first = registered.user;

    // 32 random bytes encode to 43 base64url characters.
    assert.match(tokenOf(first.installPath), /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await testFetch(first.installPath)).status, 200);

    // A wrong password changes nothing and does not end the session.
    const refused = await post("/api/account/token", { password: "wrong password" });
    assert.equal(refused.status, 401);
    assert.equal((await testFetch(first.installPath)).status, 200);
    assert.ok((await testFetch("/api/session").then((response) => response.json())).user);

    const rerolled = await post("/api/account/token", { password });
    assert.equal(rerolled.status, 200);
    const second = (await rerolled.json()).user;

    assert.equal(second.id, first.id);
    assert.match(tokenOf(second.installPath), /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(tokenOf(second.installPath), tokenOf(first.installPath));

    // The old link stops working at once; the new one works.
    assert.notEqual((await testFetch(first.installPath)).status, 200);
    assert.equal((await testFetch(second.installPath)).status, 200);

    // The session reports the new link too.
    const session = await testFetch("/api/session").then((response) => response.json());
    assert.equal(session.user.installPath, second.installPath);

    // Rerolling needs a signed-in session.
    cookieJar = "";
    assert.equal((await post("/api/account/token", { password })).status, 401);
  } finally {
    cookieJar = savedCookie;
  }
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
