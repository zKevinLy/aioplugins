import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
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
const pluginSource = "globalThis.fixturePluginExecuted = true; module.exports = { getStreams: () => [] };";

let server;
let serverUrl;
let storageRoot;
let originalFetch;
let mainProfile;
const mainPassword = "MainProfilePassword!";

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
  rmSync(storageRoot, { recursive: true, force: true });
});

test("builds a combined Nuvio manifest and serves selected files without executing them", async () => {
  const home = await originalFetch(serverUrl).then((response) => response.text());
  assert.match(home, /AIOPlugins/);

  const created = await originalFetch(`${serverUrl}/api/profiles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Main", password: mainPassword })
  }).then((response) => response.json());
  mainProfile = created.profiles.find(({ name }) => name === "Main");
  assert.ok(mainProfile);

  const discovered = await originalFetch(`${serverUrl}/api/discover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repository: "https://github.com/example/plugins", ref: "main" })
  }).then((response) => response.json());
  assert.equal(discovered.commit, commit);
  assert.equal(discovered.providers.length, 2);

  const applied = await originalFetch(`${serverUrl}/api/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      profileId: mainProfile.id,
      password: mainPassword,
      sources: [{
        repository: "https://github.com/example/plugins",
        ref: "main",
        commit,
        providerIds: ["fixture-plugin"]
      }]
    })
  }).then((response) => response.json());
  assert.deepEqual(applied, { plugins: 1 });
  assert.equal(globalThis.fixturePluginExecuted, undefined);

  const manifestUrl = `${serverUrl}/profiles/${mainProfile.id}/${encodeURIComponent(mainProfile.linkToken)}/manifest.json`;
  const manifest = await originalFetch(manifestUrl).then((response) => response.json());
  assert.equal(manifest.name, "AIOPlugins - Main");
  assert.equal(manifest.scrapers.length, 1);
  assert.equal(manifest.scrapers[0].id, "fixture-plugin");
  assert.equal(manifest.scrapers[0].description, "Preserved source metadata");
  assert.equal(manifest.scrapers[0].author, "Test Author");
  assert.match(manifest.scrapers[0].filename, /^providers\/example-plugins-fixture-plugin-[a-f0-9]{10}\.js$/);

  const fileUrl = new URL(manifest.scrapers[0].filename, manifestUrl);
  const pluginResponse = await originalFetch(fileUrl);
  assert.equal(pluginResponse.status, 200);
  assert.equal(pluginResponse.headers.get("content-type"), "application/javascript; charset=utf-8");
  assert.equal(await pluginResponse.text(), pluginSource);
  assert.equal(globalThis.fixturePluginExecuted, undefined);

  const health = await originalFetch(`${serverUrl}/health`).then((response) => response.json());
  assert.deepEqual(health, { status: "ok", profiles: 1 });
  assert.equal((await originalFetch(`${serverUrl}/manifest.json`)).status, 404);
});

test("keeps named profile manifests and plugin links isolated", async () => {
  const created = await originalFetch(`${serverUrl}/api/profiles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Kids", password: "CorrectHorseBattery!" })
  }).then((response) => response.json());
  const profile = created.profiles.find(({ name }) => name === "Kids");
  assert.ok(profile);
  assert.match(profile.id, /^[a-f0-9-]{36}$/);
  assert.ok(profile.linkToken);
  assert.equal(profile.linkToken.includes("CorrectHorseBattery!"), false);

  const applied = await originalFetch(`${serverUrl}/api/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      profileId: profile.id,
      password: "CorrectHorseBattery!",
      sources: [{
        repository: "https://github.com/example/plugins",
        ref: "main",
        commit,
        providerIds: ["not-selected"]
      }]
    })
  }).then((response) => response.json());
  assert.deepEqual(applied, { plugins: 1 });

  const mainManifestUrl = `${serverUrl}/profiles/${mainProfile.id}/${encodeURIComponent(mainProfile.linkToken)}/manifest.json`;
  const defaultManifest = await originalFetch(mainManifestUrl).then((response) => response.json());
  const profileManifestUrl = `${serverUrl}/profiles/${profile.id}/${encodeURIComponent(profile.linkToken)}/manifest.json`;
  const profileManifest = await originalFetch(profileManifestUrl).then((response) => response.json());
  assert.deepEqual(defaultManifest.scrapers.map(({ id }) => id), ["fixture-plugin"]);
  assert.deepEqual(profileManifest.scrapers.map(({ id }) => id), ["not-selected"]);
  assert.equal(profileManifest.name, "AIOPlugins - Kids");

  const invalidLinkResponse = await originalFetch(`${serverUrl}/profiles/${profile.id}/invalid-token/manifest.json`);
  assert.equal(invalidLinkResponse.status, 401);

  const profileFileUrl = new URL(profileManifest.scrapers[0].filename, profileManifestUrl);
  assert.equal(profileFileUrl.pathname, `/profiles/${profile.id}/${profile.linkToken}/${profileManifest.scrapers[0].filename}`);
  assert.equal((await originalFetch(profileFileUrl)).status, 200);

  const invalidPasswordResponse = await originalFetch(`${serverUrl}/api/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profileId: profile.id, password: "wrong", sources: [] })
  });
  assert.equal(invalidPasswordResponse.status, 400);
});

test("requires the admin password for non-loopback control requests", async () => {
  const remoteServer = createPluginBuilderServer({
    providerStorageRoot: storageRoot,
    adminPassword: "AdminSecret"
  });
  await new Promise((resolve) => remoteServer.listen(0, "127.0.0.1", resolve));
  const address = remoteServer.address();
  try {
    const call = (authorization) => new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/api/profiles",
          method: "GET",
          headers: { host: "example.onrender.com", ...(authorization ? { authorization } : {}) }
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        }
      );
      req.on("error", reject);
      req.end();
    });

    const denied = await call(undefined);
    assert.equal(denied.status, 401);
    assert.equal(denied.body.requiresAdminPassword, true);

    const wrongPassword = await call("Bearer nope");
    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongPassword.body.requiresAdminPassword, true);

    const allowed = await call("Bearer AdminSecret");
    assert.equal(allowed.status, 200);
    assert.ok(Array.isArray(allowed.body.profiles));

    const loopback = await originalFetch(`${serverUrl}/api/profiles`);
    assert.equal(loopback.status, 200);
  } finally {
    await new Promise((resolve) => remoteServer.close(resolve));
  }
});

test("rejects non-loopback control requests when no admin password is configured", async () => {
  const previousPassword = process.env.AIOPLUGINS_ADMIN_PASSWORD;
  delete process.env.AIOPLUGINS_ADMIN_PASSWORD;
  const unconfiguredServer = createPluginBuilderServer({ providerStorageRoot: storageRoot });
  await new Promise((resolve) => unconfiguredServer.listen(0, "127.0.0.1", resolve));
  const address = unconfiguredServer.address();
  try {
    const call = (authorization) => new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/api/profiles",
          method: "GET",
          headers: { host: "example.onrender.com", ...(authorization ? { authorization } : {}) }
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        }
      );
      req.on("error", reject);
      req.end();
    });

    const denied = await call(undefined);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.adminPasswordConfigured, false);
    assert.equal(denied.body.requiresAdminPassword, undefined);

    // No password can succeed when none is configured, so the server must not
    // send the flag that triggers the browser prompt.
    const withToken = await call("Bearer anything");
    assert.equal(withToken.status, 403);
    assert.equal(withToken.body.requiresAdminPassword, undefined);

    const loopback = await originalFetch(
      `http://127.0.0.1:${address.port}/api/profiles`
    );
    assert.equal(loopback.status, 200);
  } finally {
    await new Promise((resolve) => unconfiguredServer.close(resolve));
    if (previousPassword === undefined) delete process.env.AIOPLUGINS_ADMIN_PASSWORD;
    else process.env.AIOPLUGINS_ADMIN_PASSWORD = previousPassword;
  }
});
