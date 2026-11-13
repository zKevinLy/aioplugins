// Checks AIOPlugins output against Nuvio's own consumers. The helpers below are
// ports of the Kotlin that reads plugin output.
//   Nuvio TV:      PluginRuntime.parseJsonResults, StreamRepositoryImpl.toPluginStream /
//                  buildDescription, Stream.getDisplayDescription.
//   Nuvio Desktop: PluginRuntime.parseJsonResults, PluginRuntimeResult.toStreamItem,
//                  StreamItem.streamLabel / streamSubtitle.
// If either client changes them, update the ports and these tests.

import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeVersion } from "../dist/lib/app-info.js";
import {
  buildNuvioManifest,
  pluginVersion,
  resolveLogo,
  sanitizeScraper
} from "../dist/providers/nuvio-manifest.js";
import { DEFAULT_STREAM_MIDDLEWARE as PRODUCTION_DEFAULTS, wrapPluginStreams } from "../dist/providers/stream-middleware.js";

// The playback check is on by default and would call the network for these
// fixtures' fake URLs; these tests are about formatting, filtering and sorting.
const DEFAULT_STREAM_MIDDLEWARE = {
  ...PRODUCTION_DEFAULTS,
  probe: { ...PRODUCTION_DEFAULTS.probe, enabled: false }
};

// ---------- ports of Nuvio's consumers ----------

const clean = (value) => {
  const text = value == null ? undefined : String(value);
  return text !== undefined && !text.includes("[object") ? text : undefined;
};

/** PluginRuntime.parseJsonResults (the fields Nuvio keeps). */
function nuvioParse(item) {
  const hints = item.behaviorHints && typeof item.behaviorHints === "object" ? item.behaviorHints : {};
  return {
    title: clean(item.title) ?? clean(item.name) ?? "Unknown",
    name: clean(item.name),
    url: item.url,
    quality: clean(item.quality),
    size: clean(item.size),
    language: clean(item.language),
    provider: clean(item.provider),
    type: clean(item.type),
    audioDelayMs: typeof hints.audioDelayMs === "number" ? hints.audioDelayMs : undefined
  };
}

/** Kotlin data class toString: every field, as name=value. */
const dataClassToString = (result) =>
  `LocalScraperResult(${Object.entries(result).map(([key, value]) => `${key}=${value ?? "null"}`).join(", ")})`;

/** StreamRepositoryImpl.toPluginStream + Stream.getDisplayDescription. */
function nuvioCard(result, scraperName = "Scraper") {
  const quality = result.quality?.trim() || undefined;
  const qualityLabel = quality ?? "Unknown";
  const baseTitle = result.title.trim() || undefined;
  const baseName = result.name?.trim() || undefined;

  let name = baseName ?? baseTitle ?? scraperName;
  if (!dataClassToString(result).includes(qualityLabel)) name += ` - ${qualityLabel}`;

  const title = baseTitle ?? baseName ?? scraperName;
  const parts = [result.size, result.language].filter((part) => part !== undefined);
  const description = parts.length > 0 ? parts.join(" • ") : undefined;

  return { name, title, description, shownDescription: description ?? title };
}

/**
 * Nuvio Desktop: PluginRuntimeResult.toStreamItem + StreamItem.streamLabel/streamSubtitle.
 * The title is never shown; the line under the name is quality • size • language.
 */
function desktopCard(result) {
  const parts = [result.quality, result.size, result.language]
    .filter((part) => part !== undefined && part.trim() !== "");

  return {
    name: result.name?.trim() ? result.name : result.title,
    subtitle: parts.length > 0 ? parts.join(" • ") : undefined
  };
}

async function run(source, settings = {}) {
  const module = { exports: {} };
  new Function("module", "exports", wrapPluginStreams(source, { ...DEFAULT_STREAM_MIDDLEWARE, ...settings }))(
    module,
    module.exports
  );
  return module.exports.getStreams({});
}

const provider = `module.exports = { getStreams: async () => [
  { name: "HubCloud", title: "Movie.2023.2160p.BluRay.HEVC.DV.HDR10+.TrueHD.Atmos.7.1-GRP.mkv",
    url: "https://example.com/a.mkv", quality: "2160p", size: "2.24 GB", language: "English",
    headers: { Referer: "https://example.com" } },
  { title: "Unlabelled stream", url: "https://example.com/b.mp4", size: 1500000000 }
] };`;

// ---------- stream output ----------

test("the formatted description is what Nuvio TV shows under the name", async () => {
  const [first] = await run(provider);
  const parsed = nuvioParse(first);
  const card = nuvioCard(parsed);

  assert.equal(parsed.language, undefined);
  assert.equal(card.shownDescription, first.description);
  assert.match(card.shownDescription, /Movie/);
  assert.match(card.shownDescription, /📦 2\.2 GB/);
  assert.equal(card.name, first.name);
});

test("the formatted description is what Nuvio Desktop shows under the name", async () => {
  for (const stream of await run(provider)) {
    const card = desktopCard(nuvioParse(stream));

    assert.equal(card.name, stream.name);
    assert.equal(card.subtitle, stream.description, "only the user's text, nothing added");
  }
  const [first] = await run(provider);
  assert.match(desktopCard(nuvioParse(first)).subtitle, /📦 2\.2 GB/);
});

test("the settings that used to move the description are ignored", async () => {
  const [byDefault] = await run(provider);
  const [legacy] = await run(provider, { detailField: "title" });

  assert.equal(legacy.size, byDefault.size);
  assert.equal(byDefault.size, byDefault.description);
});

test("names never get Nuvio's \" - Unknown\" suffix", async () => {
  for (const settings of [{}, { detailField: "size" }]) {
    for (const stream of await run(provider, settings)) {
      const card = nuvioCard(nuvioParse(stream));
      assert.equal(stream.quality, undefined, "quality would be printed by Desktop");
      assert.doesNotMatch(card.name, / - Unknown$/);
      assert.equal(card.name, stream.name);
    }
  }
});

test("no quality is sent, and the TV unknown label is parked in the hidden provider field", async () => {
  const streams = await run(`module.exports = { getStreams: async () => [
    { title: "A 2160p", url: "https://x/a" },
    { title: "B", quality: "HD", provider: "Prov", url: "https://x/b" }
  ] };`);

  for (const stream of streams) {
    assert.equal(stream.quality, undefined);
    assert.match(stream.provider, /Unknown/);
    assert.match(stream.provider, /未知/);
  }
  assert.match(streams[1].provider, /^Prov /);
});

test("the description rides in size and the provider's language is dropped", async () => {
  const [first] = await run(provider);
  const card = nuvioCard(nuvioParse(first));

  assert.equal(first.size, first.description);
  assert.equal(first.language, undefined);
  assert.equal(card.description, first.description);
});

test("real file size and filename are carried in Stremio's standard hints", async () => {
  const [first, second] = await run(provider);

  assert.equal(first.behaviorHints.videoSize, 2240000000);
  assert.equal(first.fileSize, 2240000000);
  assert.equal(second.behaviorHints.videoSize, 1500000000);
  assert.match(first.behaviorHints.filename, /^Movie\.2023\.2160p/);
});

test("provider headers, url and unrelated behavior hints survive", async () => {
  const [stream] = await run(`module.exports = { getStreams: async () => [
    { title: "S 1080p", url: "https://x/s", headers: { "User-Agent": "UA" },
      behaviorHints: { audioDelayMs: 120, audioDelayLanguage: "eng" } }
  ] };`);
  const parsed = nuvioParse(stream);

  assert.equal(parsed.url, "https://x/s");
  assert.equal(stream.headers["User-Agent"], "UA");
  assert.equal(parsed.audioDelayMs, 120);
  assert.equal(stream.behaviorHints.audioDelayLanguage, "eng");
});

// ---------- manifest ----------

const source = { owner: "o", repo: "r", commit: "c".repeat(40) };

/** The types Nuvio's Moshi adapters require for PluginManifest / ScraperManifestInfo. */
function assertMoshiValid(manifest) {
  const isStrings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");

  for (const key of ["name", "version"]) assert.equal(typeof manifest[key], "string", `manifest.${key}`);
  assert.ok(Array.isArray(manifest.scrapers));

  for (const scraper of manifest.scrapers) {
    for (const key of ["id", "name", "version", "filename"]) {
      assert.equal(typeof scraper[key], "string", `scraper.${key}`);
    }
    assert.ok(isStrings(scraper.supportedTypes) && scraper.supportedTypes.length > 0);
    assert.equal(typeof scraper.enabled, "boolean");
    for (const key of ["contentLanguage", "supportedPlatforms", "disabledPlatforms", "formats", "supportedFormats"]) {
      assert.ok(scraper[key] === undefined || isStrings(scraper[key]), key);
    }
    for (const key of ["supportsExternalPlayer", "limited", "description", "logo"]) {
      assert.ok(scraper[key] === undefined || ["boolean", "string"].includes(typeof scraper[key]), key);
    }
  }
}

test("hostile upstream entries still produce a manifest Nuvio can parse", () => {
  const plugins = [
    { entry: { id: "numeric", version: 3, supportedTypes: null, name: 42, logo: 5, limited: "yes", formats: "mp4" } },
    { entry: { id: "nulls", name: null, description: null, contentLanguage: [1, null, "en"], enabled: false } },
    { entry: { id: "plain" } }
  ].map(({ entry }) => ({ entry, filename: `providers/${entry.id}.js`, ...source }));

  const manifest = buildNuvioManifest({
    userId: "12345678-aaaa-bbbb-cccc-1234567890ab",
    appVersion: "0.4.0",
    origin: "https://aio.test",
    middlewareVersion: "18",
    plugins
  });

  assertMoshiValid(manifest);
  assert.equal(manifest.scrapers[0].version, "3+aio.0.4.0");
  assert.equal(manifest.scrapers[0].name, "42");
  assert.deepEqual(manifest.scrapers[0].supportedTypes, ["movie", "tv"]);
  assert.equal(manifest.scrapers[0].limited, undefined);
  assert.equal(manifest.scrapers[0].formats, undefined);
  assert.deepEqual(manifest.scrapers[1].contentLanguage, ["en"]);
  assert.equal(manifest.scrapers[1].name, "nulls");
  assert.equal(manifest.scrapers[2].version, "1.0.0+aio.0.4.0");
  assert.equal(manifest.scrapers.every((scraper) => scraper.enabled), true);
});

test("unknown upstream keys are kept and provenance is recorded", () => {
  const scraper = sanitizeScraper(
    { entry: { id: "x", name: "X", hasSettings: true, settings: { a: 1 } }, filename: "providers/x.js", ...source },
    "0.4.0",
    "https://aio.test",
    "18"
  );

  assert.equal(scraper.hasSettings, true);
  assert.deepEqual(scraper.settings, { a: 1 });
  assert.deepEqual(scraper.aioplugins, {
    version: "0.4.0",
    middleware: "18",
    source: "o/r",
    commit: source.commit,
    upstreamVersion: null
  });
});

test("scraper versions carry AIOPlugins build metadata", () => {
  assert.equal(pluginVersion("1.2.0", "0.4.0"), "1.2.0+aio.0.4.0");
  assert.equal(pluginVersion("1.2.0+build5", "0.4.0"), "1.2.0+build5.aio.0.4.0");
  assert.equal(pluginVersion(undefined, "dev"), "1.0.0+aio.dev");
  assert.equal(pluginVersion(" 2 ", "0.4.0"), "2+aio.0.4.0");
});

test("logos are absolute, resolved against the pinned commit, or fall back to the AIOPlugins icon", () => {
  const origin = "https://aio.test";
  const fallback = "https://aio.test/favicon-192.png";

  assert.equal(resolveLogo("https://cdn.example/l.png", source, origin), "https://cdn.example/l.png");
  assert.equal(
    resolveLogo("assets/logo one.png", source, origin),
    `https://raw.githubusercontent.com/o/r/${source.commit}/assets/logo%20one.png`
  );
  assert.equal(resolveLogo(undefined, source, origin), fallback);
  assert.equal(resolveLogo("", source, origin), fallback);
  assert.equal(resolveLogo("../escape.png", source, origin), fallback);
  assert.equal(resolveLogo("/abs.png", source, origin), fallback);
  assert.equal(resolveLogo("javascript:alert(1)", source, origin), fallback);
  assert.equal(resolveLogo("data:image/png;base64,AAAA", source, origin), fallback);
  assert.equal(resolveLogo("//cdn.example/l.png", source, origin), fallback);
});

test("version strings are validated", () => {
  assert.equal(normalizeVersion("v0.4.0"), "0.4.0");
  assert.equal(normalizeVersion(" 1.2.3-rc.1 "), "1.2.3-rc.1");
  assert.equal(normalizeVersion("1.2"), null);
  assert.equal(normalizeVersion("latest"), null);
  assert.equal(normalizeVersion(4), null);
});
