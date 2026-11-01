import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
        const pathname = new URL(request.url).pathname;
        const filePath = pathname === "/index.html"
          ? "../dist/site/index.html"
          : `../dist/site${pathname}`;

        try {
          return new Response(readFileSync(new URL(filePath, import.meta.url)), {
            headers: {
              "content-type": pathname.endsWith(".html")
                ? "text/html; charset=utf-8"
                : "application/octet-stream"
            }
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

test("builds a combined Nuvio manifest and serves selected files without executing them", async () => {
  const home = await testFetch("/").then((response) => response.text());
  assert.match(home, /AIOPlugins/);

  const appScriptPath = home.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(appScriptPath, "Astro app script should be present in the page");
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
  const source = `module.exports = { getStreams: async () => [${JSON.stringify(stream)}] };`;
  new Function("module", "exports", wrapPluginStreams(source, {
    ...DEFAULT_STREAM_MIDDLEWARE,
    format: wrapperFormat
  }))(module, module.exports);
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
  assert.equal(stream.size, 1234);
  assert.equal(stream.fileSize, 1234);
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
  const source = `module.exports = { getStreams: async () => [${JSON.stringify(stream)}] };`;
  new Function("module", "exports", wrapPluginStreams(source, {
    ...DEFAULT_STREAM_MIDDLEWARE,
    filters: [
      { field: "languages", operator: "contains", value: "Korean" },
      { field: "releaseGroup", operator: "equals", value: "4kHdHub.Com" }
    ],
    format: "{stream.title} · {stream.formattedSeasons} {stream.formattedEpisodes} · {stream.resolution} · {stream.quality} · {stream.network} · {stream.encode}"
  }))(module, module.exports);
  const [wrapped] = await module.exports.getStreams({});
  assert.equal(wrapped.title, "Doctor X Mafia in White · S01 E06 · 1080p · WEB-DL · Netflix · AVC");
  assert.equal(wrapped.network, "Netflix");
  assert.equal(wrapped.fileSize, 2240000000);
  assert.equal(wrapped.size, wrapped.description);
  assert.equal(wrapped.description, wrapped.title);
  assert.equal(wrapped.name, "🚀 FHD");
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
