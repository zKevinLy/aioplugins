import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import {
  DEFAULT_STREAM_MIDDLEWARE,
  normalizeStreamMiddlewareSettings,
  toJsLiteral,
  wrapPluginStreams
} from "../dist/providers/stream-middleware.js";

// A throwaway media server. Each path behaves like one kind of real-world link.
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f]);
const requests = [];
let server;
let base;

function ranged(request, response, body, type = "video/x-matroska") {
  const match = /^bytes=(\d+)-(\d+)?$/.exec(request.headers.range ?? "");
  if (!match) {
    response.writeHead(200, { "content-type": type, "content-length": body.length });
    response.end(body);
    return;
  }

  const start = Number(match[1]);
  const end = Math.min(Number(match[2] ?? body.length - 1), body.length - 1);
  response.writeHead(206, {
    "content-type": type,
    "content-range": `bytes ${start}-${end}/${body.length}`,
    "accept-ranges": "bytes",
    "content-length": end - start + 1
  });
  response.end(body.subarray(start, end + 1));
}

before(async () => {
  server = createServer((request, response) => {
    requests.push({ path: request.url, headers: request.headers });
    const big = Buffer.concat([EBML, Buffer.alloc(200_000)]);

    switch (request.url) {
      case "/ok":
        return ranged(request, response, big);
      case "/no-range":
        // Ignores Range and says nothing about ranges: not seekable.
        response.writeHead(200, { "content-type": "video/mp4", "content-length": big.length });
        return void response.end(big);
      case "/advertises-range":
        // Answers 200 to a range that starts at 0 but advertises support.
        response.writeHead(200, { "content-type": "video/mp4", "accept-ranges": "bytes" });
        return void response.end(big);
      case "/html":
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return void response.end("<html>Link expired</html>");
      case "/json":
        response.writeHead(200, { "content-type": "application/json" });
        return void response.end('{"error":"nope"}');
      case "/disguised":
        // An error page that claims to be video.
        return ranged(request, response, Buffer.from("<html><body>blocked</body></html>"), "video/mp4");
      case "/404":
        response.writeHead(404);
        return void response.end();
      case "/403":
        response.writeHead(403);
        return void response.end();
      case "/503":
        response.writeHead(503);
        return void response.end();
      case "/429":
        response.writeHead(429);
        return void response.end();
      case "/empty":
        response.writeHead(200, { "content-type": "video/mp4", "content-length": 0 });
        return void response.end();
      case "/hls.m3u8":
        response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
        return void response.end("#EXTM3U\n#EXT-X-ENDLIST\n");
      case "/hang":
        return; // never answers
      default:
        response.writeHead(404);
        return void response.end();
    }
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

async function run(urls, probe, { headers } = {}) {
  const module = { exports: {} };
  const source = `module.exports = { getStreams: async () => ${toJsLiteral(
    urls.map((url, index) => ({
      title: `Stream ${index}`,
      url: url.startsWith("/") ? base + url : url,
      ...(headers ? { headers } : {})
    }))
  )} };`;

  new Function("module", "exports", wrapPluginStreams(source, {
    ...DEFAULT_STREAM_MIDDLEWARE,
    probe,
    // These tests are about the playback check alone.
    ranking: { preferFastest: false, perQuality: 0 }
  }))(module, module.exports);

  const streams = await module.exports.getStreams({});
  return streams.map(stream => stream.url.replace(base, ""));
}

const on = { enabled: true, requireSeekable: true, timeoutMs: 1500 };

test("probe is off by default and does not touch the network", async () => {
  requests.length = 0;
  const kept = await run(["/404", "/html", "/no-range"], DEFAULT_STREAM_MIDDLEWARE.probe);

  assert.deepEqual(kept, ["/404", "/html", "/no-range"]);
  assert.equal(requests.length, 0);
});

test("keeps seekable media and removes streams that clearly cannot play", async () => {
  const kept = await run(
    ["/ok", "/404", "/403", "/html", "/json", "/disguised", "/empty", "/hls.m3u8"],
    on
  );

  assert.deepEqual(kept, ["/ok", "/hls.m3u8"]);
});

test("removes streams that ignore byte ranges only when seeking is required", async () => {
  assert.deepEqual(await run(["/ok", "/no-range"], on), ["/ok"]);
  assert.deepEqual(
    await run(["/ok", "/no-range"], { ...on, requireSeekable: false }),
    ["/ok", "/no-range"]
  );
});

test("a 200 that advertises byte-range support counts as seekable", async () => {
  assert.deepEqual(await run(["/advertises-range"], on), ["/advertises-range"]);
});

test("keeps streams the probe cannot judge", async () => {
  const kept = await run(
    ["/503", "/429", "/hang", "magnet:?xt=urn:btih:abc", "http://127.0.0.1:1/refused", "/ok"],
    { ...on, timeoutMs: 1000 }
  );

  assert.deepEqual(kept, ["/503", "/429", "/hang", "magnet:?xt=urn:btih:abc", "http://127.0.0.1:1/refused", "/ok"]);
});

test("sends the provider headers but only asks for the first bytes", async () => {
  requests.length = 0;
  await run(["/ok"], on, { headers: { Referer: "https://host.example/", Range: "bytes=500-" } });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.referer, "https://host.example/");
  assert.equal(requests[0].headers.range, "bytes=0-31");
});

test("probes each distinct URL once", async () => {
  requests.length = 0;
  const kept = await run(["/ok", "/ok", "/404", "/404"], on);

  assert.deepEqual(kept, ["/ok", "/ok"]);
  assert.equal(requests.length, 2);
});

test("keeps everything when fetch is not available in the plugin runtime", async () => {
  const original = globalThis.fetch;

  try {
    globalThis.fetch = undefined;
    assert.deepEqual(await run(["/404", "/html"], on), ["/404", "/html"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("normalizes probe settings", () => {
  assert.deepEqual(normalizeStreamMiddlewareSettings({}).probe, {
    enabled: false,
    requireSeekable: true,
    timeoutMs: 5000
  });

  assert.deepEqual(
    normalizeStreamMiddlewareSettings({
      probe: { enabled: true, requireSeekable: false, timeoutMs: 999999 }
    }).probe,
    { enabled: true, requireSeekable: false, timeoutMs: 15000 }
  );

  assert.equal(normalizeStreamMiddlewareSettings({ probe: { timeoutMs: 10 } }).probe.timeoutMs, 1000);
  assert.equal(normalizeStreamMiddlewareSettings({ probe: { timeoutMs: "soon" } }).probe.timeoutMs, 5000);
  assert.equal(normalizeStreamMiddlewareSettings({ probe: { enabled: "yes" } }).probe.enabled, false);
  assert.equal(normalizeStreamMiddlewareSettings({ probe: [] }).probe.enabled, false);
});

test("toJsLiteral escapes characters that can break out of generated code", () => {
  const literal = toJsLiteral({ value: "</script><!-- \u2028\u2029 /" });

  assert.ok(!/[<>/\u2028\u2029]/.test(literal));
  assert.deepEqual(JSON.parse(literal), { value: "</script><!-- \u2028\u2029 /" });
  assert.equal(toJsLiteral(undefined), "undefined");
});
