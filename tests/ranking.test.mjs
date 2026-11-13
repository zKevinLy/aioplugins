import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import {
  DEFAULT_STREAM_MIDDLEWARE,
  combineVariantSources,
  normalizeStreamMiddlewareSettings,
  toJsLiteral,
  usesModuleSyntax,
  wrapPluginStreams
} from "../dist/providers/stream-middleware.js";
import { getPluginRepositoryManifest, getRemotePluginFile } from "../dist/providers/remote.js";

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
    ...DEFAULT_STREAM_MIDDLEWARE, sorts, ranking
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

async function combined(sources) {
  const module = { exports: {} };
  new Function("module", "exports", wrapPluginStreams(
    combineVariantSources(sources),
    { ...DEFAULT_STREAM_MIDDLEWARE, ranking: { preferFastest: false, perQuality: 0 } }
  ))(module, module.exports);
  return module.exports.getStreams({});
}

const variant = streams => `module.exports = { getStreams: async () => ${toJsLiteral(streams)} };`;

test("combined copies drop streams another copy already returned", async () => {
  const result = await combined([
    variant([{ title: "One 1080p", url: "https://h.example/a.mp4" }, { title: "Hash", infoHash: "ABC123" }]),
    variant([
      { title: "One again 1080p", url: "https://h.example/a.mp4#frag" },
      { title: "Hash again", infoHash: "abc123" },
      { title: "Only here 720p", url: "https://h.example/b.mp4" }
    ])
  ]);
  assert.deepEqual(result.map(s => s.url ?? s.infoHash), ["https://h.example/a.mp4", "abc123".toUpperCase(), "https://h.example/b.mp4"]);
});

test("combined copies keep duplicates inside one copy and survive a failing copy", async () => {
  const result = await combined([
    variant([{ title: "A", url: "https://h.example/x.mp4" }, { title: "A", url: "https://h.example/x.mp4" }]),
    "throw new Error('broken on load');",
    "module.exports = { getStreams: async () => { throw new Error('boom'); } };",
    variant([{ title: "B", url: "https://h.example/y.mp4" }])
  ]);
  assert.equal(result.length, 3);
});

test("copies cannot overwrite each other's getStreams, even via the global", async () => {
  const result = await combined([
    "globalThis.getStreams = async () => [{ title: 'G1', url: 'https://h.example/g1.mp4' }];",
    "globalThis.getStreams = async () => [{ title: 'G2', url: 'https://h.example/g2.mp4' }];"
  ]);
  assert.deepEqual(result.map(s => s.url), ["https://h.example/g1.mp4", "https://h.example/g2.mp4"]);
  assert.equal(typeof globalThis.getStreams, "undefined");
});

test("module syntax is detected", () => {
  assert.equal(usesModuleSyntax("import x from 'y';\nmodule.exports={}"), true);
  assert.equal(usesModuleSyntax("export const a = 1;"), true);
  assert.equal(usesModuleSyntax("const important = 1;\nmodule.exports = {};"), false);
});

const hash = "c".repeat(40);
const entry = { id: "kurage", name: "Kurage", filename: "providers/kurage.js", supportedTypes: ["movie", "tv"] };
const select = repo => ({
  repository: `https://github.com/owner/${repo}`, ref: "main", commit: hash,
  providerIds: ["kurage"], providers: [{ ...entry }]
});

test("one plugin per ID is listed, with every source recorded", async () => {
  const manifest = await getPluginRepositoryManifest(
    "u", [select("yoru"), select("allinone")], {}, { appVersion: "1.0.0", origin: "https://x.test" }
  );
  assert.equal(manifest.scrapers.length, 1);
  assert.equal(manifest.scrapers[0].id, "kurage");
  assert.deepEqual(manifest.scrapers[0].aioplugins.alsoFrom, [`owner/allinone@${hash}`]);
  assert.match(manifest.description, /1 plugin from 2 sources/);

  const single = await getPluginRepositoryManifest(
    "u", [select("yoru")], {}, { appVersion: "1.0.0", origin: "https://x.test" }
  );
  assert.equal(single.scrapers[0].aioplugins.alsoFrom, undefined);
  assert.notEqual(single.scrapers[0].filename, manifest.scrapers[0].filename);
});

test("the served file runs both copies; identical code is served once", async () => {
  const original = globalThis.fetch;
  const files = {
    yoru: variant([{ title: "Y 1080p", url: "https://h.example/y.mp4" }]),
    allinone: variant([{ title: "A 1080p", url: "https://h.example/a.mp4" }]),
    twin: variant([{ title: "Y 1080p", url: "https://h.example/y.mp4" }])
  };
  globalThis.fetch = async input => {
    const repo = new URL(input).pathname.split("/")[2];
    return new Response(files[repo] ?? "", { status: files[repo] ? 200 : 404 });
  };

  try {
    const sources = [select("yoru"), select("allinone")];
    const manifest = await getPluginRepositoryManifest("u", sources, {}, { appVersion: "1", origin: "https://x.test" });
    const code = await getRemotePluginFile(sources, manifest.scrapers[0].filename, {});
    assert.match(code, /function \(module, exports\)/);

    const twins = [select("yoru"), select("twin")];
    const twinManifest = await getPluginRepositoryManifest("u", twins, {}, { appVersion: "1", origin: "https://x.test" });
    const single = await getRemotePluginFile(twins, twinManifest.scrapers[0].filename, {});
    assert.doesNotMatch(single, /function \(module, exports\)/);
  } finally {
    globalThis.fetch = original;
  }
});
