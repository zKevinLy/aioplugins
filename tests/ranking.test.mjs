import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import {
  DEFAULT_STREAM_MIDDLEWARE,
  normalizeStreamMiddlewareSettings,
  toJsLiteral,
  wrapPluginStreams
} from "../dist/providers/stream-middleware.js";
import { getPluginRepositoryManifest, getRemotePluginFile, resolveSelectedSources } from "../dist/providers/remote.js";

const MEDIA = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(300_000)]);
const requests = [];
let server;
let base;

before(async () => {
  server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url.startsWith("/missing")) {
      response.writeHead(404);
      return void response.end();
    }
    const delay = request.url.startsWith("/slow") ? 400 : request.url.startsWith("/mid") ? 120 : 0;
    setTimeout(() => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
      if (request.url.startsWith("/noseek") || !match) {
        response.writeHead(200, { "content-type": "video/mp4" });
        return void response.end(MEDIA);
      }
      const end = Math.min(Number(match[2]), MEDIA.length - 1);
      response.writeHead(206, {
        "content-type": "video/mp4",
        "content-range": `bytes 0-${end}/${MEDIA.length}`,
        "accept-ranges": "bytes"
      });
      response.end(MEDIA.subarray(0, end + 1));
    }, delay);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

async function run(streams, ranking, sorts = []) {
  const module = { exports: {} };
  const source = `module.exports = { getStreams: async () => ${toJsLiteral(
    streams.map(item => ({ ...item, url: item.url.startsWith("/") ? base + item.url : item.url }))
  )} };`;
  new Function("module", "exports", wrapPluginStreams(source, {
    // The playback check is on by default; these tests are about ranking alone.
    ...DEFAULT_STREAM_MIDDLEWARE, sorts, ranking,
    probe: { ...DEFAULT_STREAM_MIDDLEWARE.probe, enabled: false }
  }))(module, module.exports);
  return (await module.exports.getStreams({})).map(stream => stream.url.replace(base, ""));
}

const on = { preferFastest: true, perQuality: 0 };

test("ranking is on by default and normalized", () => {
  assert.deepEqual(normalizeStreamMiddlewareSettings({}).ranking, { preferFastest: true, perQuality: 0 });
  assert.equal(normalizeStreamMiddlewareSettings({ ranking: { preferFastest: false } }).ranking.preferFastest, false);
  assert.equal(normalizeStreamMiddlewareSettings({ ranking: { perQuality: 999 } }).ranking.perQuality, 20);
  assert.equal(normalizeStreamMiddlewareSettings({ ranking: { perQuality: -4 } }).ranking.perQuality, 0);
  assert.equal(normalizeStreamMiddlewareSettings({ ranking: { perQuality: "x" } }).ranking.perQuality, 0);
});

test("tied streams are ordered fastest first", async () => {
  const order = await run(
    [{ title: "A 1080p", url: "/slow1" }, { title: "B 1080p", url: "/mid1" }, { title: "C 1080p", url: "/fast1" }],
    on
  );
  assert.deepEqual(order, ["/fast1", "/mid1", "/slow1"]);
});

test("turning it off keeps the provider's order and makes no requests", async () => {
  requests.length = 0;
  const order = await run(
    [{ title: "A 1080p", url: "/slow2" }, { title: "B 1080p", url: "/fast2" }],
    { preferFastest: false, perQuality: 0 }
  );
  assert.deepEqual(order, ["/slow2", "/fast2"]);
  assert.equal(requests.length, 0);
});

test("the configured sort always wins over speed", async () => {
  const order = await run(
    [{ title: "Low 720p", url: "/fast3" }, { title: "High 1080p", url: "/slow3" }],
    on,
    [{ field: "resolution", direction: "desc", unknown: "last" }]
  );
  assert.deepEqual(order, ["/slow3", "/fast3"]);
});

test("streams only move within their resolution when there are no sort levels", async () => {
  const order = await run(
    [
      { title: "A 720p", url: "/slow4" },
      { title: "B 1080p", url: "/slow5" },
      { title: "C 720p", url: "/fast4" },
      { title: "D 1080p", url: "/fast5" }
    ],
    on
  );
  assert.deepEqual(order, ["/fast4", "/fast5", "/slow4", "/slow5"]);
});

test("unplayable and non-seekable streams sink; unmeasurable ones stay average", async () => {
  const order = await run(
    [
      { title: "A 1080p", url: "/missing" },
      { title: "B 1080p", url: "/noseek1" },
      { title: "C 1080p", url: "magnet:?xt=urn:btih:abc" },
      { title: "D 1080p", url: "/fast6" }
    ],
    on
  );
  assert.equal(order[0], "/fast6");
  assert.equal(order.at(-1), "/missing");
  assert.ok(order.indexOf("/noseek1") > order.indexOf("magnet:?xt=urn:btih:abc"));
});

test("the per-resolution cap keeps the best streams and counts each resolution", async () => {
  const order = await run(
    [
      { title: "A 1080p", url: "/slow7" },
      { title: "B 1080p", url: "/mid7" },
      { title: "C 1080p", url: "/fast7" },
      { title: "D 720p", url: "/slow8" }
    ],
    { preferFastest: true, perQuality: 2 }
  );
  assert.deepEqual(order, ["/fast7", "/mid7", "/slow8"]);
});

test("the cap works without speed ranking and measures each URL once", async () => {
  requests.length = 0;
  const order = await run(
    [{ title: "A 1080p", url: "/a9" }, { title: "B 1080p", url: "/b9" }, { title: "C 1080p", url: "/c9" }],
    { preferFastest: false, perQuality: 1 }
  );
  assert.deepEqual(order, ["/a9"]);
  assert.equal(requests.length, 0);
});

// ---------- same plugin ID from several sources ----------

const sha = ch => ch.repeat(40);
const entry = { id: "kurage", name: "Kurage", filename: "providers/kurage.js", supportedTypes: ["movie", "tv"] };
const other = { id: "other", name: "Other", filename: "providers/other.js", supportedTypes: ["movie"] };
const atom = (commit, updated) =>
  `<feed><updated>2030-01-01T00:00:00Z</updated><entry><id>tag:github.com,2008:Grit::Commit/${commit}</id><updated>${updated}</updated></entry></feed>`;

// repos: { name: { commit, repoUpdated, manifest, files: { path: updated | null } } }
// A null file time means GitHub has no commit feed for that file.
function mockGitHub(repos) {
  const original = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async input => {
    const url = new URL(input);
    calls.push(url.href);
    const [, owner, name, kind, ...rest] = url.pathname.split("/");
    const repo = repos[name];
    if (!repo || owner !== "owner") return new Response("", { status: 404 });

    if (url.hostname === "raw.githubusercontent.com") {
      return new Response(JSON.stringify(repo.manifest), { status: 200 });
    }
    if (kind === "commits" && rest.length === 1) {
      return new Response(atom(repo.commit, repo.repoUpdated), { status: 200 });
    }
    if (kind === "commits") {
      const updated = repo.files[rest.slice(1).join("/").replace(/\.atom$/, "")];
      return updated ? new Response(atom(repo.commit, updated), { status: 200 }) : new Response("", { status: 404 });
    }
    return new Response("", { status: 404 });
  };

  return { calls, restore: () => { globalThis.fetch = original; } };
}

const pick = (name, providerIds = ["kurage"]) => ({
  repository: `https://github.com/owner/${name}`, ref: "main", providerIds
});

const repo = (letter, repoUpdated, fileUpdated, entries = [entry]) => ({
  commit: sha(letter),
  repoUpdated,
  manifest: entries,
  files: Object.fromEntries(entries.map(e => [e.filename, fileUpdated]))
});

test("a plugin selected from several sources is saved once, from the newest file", async () => {
  const github = mockGitHub({
    stale: repo("a", "2026-11-01T00:00:00Z", "2024-02-01T00:00:00Z"),
    fresh: repo("b", "2025-01-01T00:00:00Z", "2026-06-01T00:00:00Z"),
    middle: repo("c", "2026-11-01T00:00:00Z", "2025-05-01T00:00:00Z")
  });

  try {
    const result = await resolveSelectedSources([pick("stale"), pick("fresh"), pick("middle")]);

    assert.equal(result.plugins, 1);
    assert.equal(result.deduped, 1);
    assert.deepEqual(result.sources.map(s => s.repository), ["https://github.com/owner/fresh"]);
    assert.deepEqual(result.sources[0].providerIds, ["kurage"]);
    assert.deepEqual(result.sources[0].providers.map(p => p.id), ["kurage"]);
  } finally {
    github.restore();
  }
});

test("only the duplicated plugin moves; a source keeps its other selections", async () => {
  const github = mockGitHub({
    old: repo("a", "2026-01-01T00:00:00Z", "2024-01-01T00:00:00Z", [entry, other]),
    new: repo("b", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", [entry])
  });

  try {
    const result = await resolveSelectedSources([pick("old", ["kurage", "other"]), pick("new")]);

    assert.equal(result.plugins, 2);
    assert.equal(result.deduped, 1);
    const old = result.sources.find(s => s.repository.endsWith("/old"));
    assert.deepEqual(old.providerIds, ["other"]);
    assert.deepEqual(old.providers.map(p => p.id), ["other"]);
    assert.deepEqual(result.sources.find(s => s.repository.endsWith("/new")).providerIds, ["kurage"]);
  } finally {
    github.restore();
  }
});

test("without a file history the repository's latest commit decides, and ties keep the first source", async () => {
  const fallback = mockGitHub({
    a: repo("a", "2024-01-01T00:00:00Z", null),
    b: repo("b", "2026-01-01T00:00:00Z", null)
  });
  try {
    const result = await resolveSelectedSources([pick("a"), pick("b")]);
    assert.deepEqual(result.sources.map(s => s.repository), ["https://github.com/owner/b"]);
  } finally {
    fallback.restore();
  }

  const tie = mockGitHub({
    a: repo("a", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
    b: repo("b", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
  });
  try {
    const result = await resolveSelectedSources([pick("a"), pick("b")]);
    assert.deepEqual(result.sources.map(s => s.repository), ["https://github.com/owner/a"]);
  } finally {
    tie.restore();
  }
});

test("no dates are looked up when nothing is duplicated", async () => {
  const github = mockGitHub({
    a: repo("a", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", [entry]),
    b: repo("b", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", [other])
  });

  try {
    const result = await resolveSelectedSources([pick("a"), pick("b", ["other"])]);
    assert.equal(result.deduped, 0);
    assert.equal(result.plugins, 2);
    assert.equal(github.calls.filter(url => url.endsWith(".js.atom")).length, 0);
  } finally {
    github.restore();
  }
});

// ---------- serving ----------

const saved = (name, letter) => ({
  repository: `https://github.com/owner/${name}`, ref: "main", commit: sha(letter),
  providerIds: ["kurage"], providers: [{ ...entry }]
});

test("a setup saved with duplicates serves the first source's file and fetches only that", async () => {
  const original = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async input => {
    fetched.push(new URL(input).pathname);
    return new Response("module.exports = { getStreams: async () => [] };", { status: 200 });
  };

  try {
    const sources = [saved("yoru", "a"), saved("allinone", "b")];
    const manifest = await getPluginRepositoryManifest(
      "u", sources, {}, { appVersion: "1.0.0", origin: "https://x.test" }
    );

    assert.equal(manifest.scrapers.length, 1);
    assert.equal(manifest.scrapers[0].aioplugins.source, "owner/yoru");
    assert.match(manifest.description, /1 plugin from 1 source\./);

    const code = await getRemotePluginFile(sources, manifest.scrapers[0].filename, {});
    assert.ok(code.startsWith("module.exports"));
    assert.deepEqual(fetched, [`/owner/yoru/${sha("a")}/providers/kurage.js`]);
  } finally {
    globalThis.fetch = original;
  }
});
