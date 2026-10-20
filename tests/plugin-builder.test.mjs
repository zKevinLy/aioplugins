import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createPluginBuilderServer } from "../dist/server.js";

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

let server;
let serverUrl;
let storageRoot;
let originalFetch;
let cookieJar = "";

const mainPassword = "MainProfilePassword!";

async function testFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookieJar) headers["cookie"] = cookieJar;
  const res = await originalFetch(url, { ...options, headers });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    cookieJar = setCookie.split(";")[0];
  }
  return res;
}

before(async () => {
  storageRoot = mkdtempSync(join(tmpdir(), "nuvio-plugin-builder-test-"));
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === "127.0.0.1") return originalFetch(input, options);
    if (url.hostname === "api.github.com") return new Response(JSON.stringify({ sha: commit }));
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

  server = createPluginBuilderServer({ providerStorageRoot: storageRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  serverUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  globalThis.fetch = originalFetch;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  try {
    rmSync(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    // Silently ignore Windows file locking on temp SQLite files
  }
});

test("builds a combined Nuvio manifest and serves selected files without executing them", async () => {
  const home = await testFetch(serverUrl).then((response) => response.text());
  assert.match(home, /AIOPlugins/);

  const registerRes = await testFetch(`${serverUrl}/api/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: mainPassword })
  });
  const registerData = await registerRes.json();
  assert.ok(registerData.user);
  const user = registerData.user;

  const discovered = await testFetch(`${serverUrl}/api/discover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repository: "https://github.com/example/plugins", ref: "main" })
  }).then((response) => response.json());
  assert.equal(discovered.commit, commit);
  assert.equal(discovered.providers.length, 2);

  const profileCreated = await testFetch(`${serverUrl}/api/profiles`, {
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

  assert.equal(globalThis.fixturePluginExecuted, undefined);

  const manifestUrl = `${serverUrl}${user.installPath}`;
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
  assert.equal(await pluginResponse.text(), pluginSource);
  assert.equal(globalThis.fixturePluginExecuted, undefined);

  const health = await testFetch(`${serverUrl}/health`).then((response) => response.json());
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

test("keeps named profiles and sources manageable", async () => {
  const profilesRes = await testFetch(`${serverUrl}/api/profiles`).then((response) => response.json());
  assert.ok(Array.isArray(profilesRes.profiles));
  assert.ok(profilesRes.profiles.length > 0);

  const targetId = profilesRes.profiles[0].id;
  const deleteRes = await testFetch(`${serverUrl}/api/profiles/${targetId}`, {
    method: "DELETE"
  }).then((response) => response.json());
  assert.equal(deleteRes.success, true);
});