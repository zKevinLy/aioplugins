
import { randomUUID } from "node:crypto";

import type { Database } from "./lib/db.js";
import { HttpError } from "./lib/http-error.js";
import type { Platform } from "./lib/platform.js";

import {
  getRemotePluginFile,
  getPluginRepositoryManifest,
  hasRemotePluginFile,
  inspectGitHubSource,
  resolveSelectedSources,
  type SavedSourceSelection
} from "./providers/remote.js";
import {
  deletePasskey,
  listPasskeys,
  loginWithPasskey,
  passkeyLoginOptions,
  passkeyRegistrationOptions,
  registerPasskey,
  type RelyingParty
} from "./passkeys.js";
import { loadAppVersion } from "./lib/app-info.js";
import { STREAM_FIELD_CATALOG } from "./providers/stream-middleware.js";

import {
  createSession,
  deleteUser,
  destroySession,
  getProfiles,
  getUserConfig,
  loginUser,
  registerUser,
  rerollInstallToken,
  saveProfileAndSources,
  saveUserConfig,
  deleteProfile,
  userFromInstallLink,
  userFromSession,
  type User
} from "./users.js";

const SESSION_COOKIE = "aio_session";
const MAX_REQUEST_BYTES = 1024 * 1024;
const RATE_LIMIT_MAX_KEYS = 10_000;

const PUBLIC_CORS = {
  "access-control-allow-origin": "*"
};

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimits = new Map<string, RateLimitEntry>();

// ---------- response helpers ----------

function securityHeaders(): Headers {
  return new Headers({
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()"
  });
}

function sendJson(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit
): Response {
  const headers = securityHeaders();

  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");

  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => {
      headers.set(key, value);
    });
  }

  return new Response(JSON.stringify(body), {
    status,
    headers
  });
}

function sendText(
  status: number,
  body: string,
  contentType: string,
  extraHeaders?: HeadersInit
): Response {
  const headers = securityHeaders();

  headers.set("content-type", contentType);
  headers.set("cache-control", "no-store");

  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => {
      headers.set(key, value);
    });
  }

  return new Response(body, {
    status,
    headers
  });
}

// ---------- request helpers ----------

function clientAddress(
  platform: Platform,
  request: Request
): string {
  const forwarded = platform.getClientIp(request);

  if (
    forwarded &&
    forwarded.length <= 64 &&
    /^[0-9a-fA-F:.]+$/.test(forwarded)
  ) {
    return forwarded;
  }

  return "unknown";
}

function enforceRateLimit(
  clientIp: string,
  bucket: string,
  maximum: number,
  windowMs: number
): Response | null {
  const now = Date.now();
  const key = `${bucket}:${clientIp}`;

  let entry = rateLimits.get(key);

  if (!entry || entry.resetAt <= now) {
    entry = {
      count: 0,
      resetAt: now + windowMs
    };
  }

  entry.count++;

  if (entry.count > maximum) {
    const retryAfter = Math.max(
      1,
      Math.ceil((entry.resetAt - now) / 1000)
    );

    rateLimits.set(key, entry);

    return sendJson(
      429,
      { error: "Too many requests. Please try again later." },
      { "retry-after": String(retryAfter) }
    );
  }

  rateLimits.set(key, entry);

  if (rateLimits.size > RATE_LIMIT_MAX_KEYS) {
    for (const [storedKey, storedEntry] of rateLimits) {
      if (storedEntry.resetAt <= now) {
        rateLimits.delete(storedKey);
      }
    }

    if (rateLimits.size > RATE_LIMIT_MAX_KEYS) {
      const oldestKey = rateLimits.keys().next().value;

      if (oldestKey) {
        rateLimits.delete(oldestKey);
      }
    }
  }

  return null;
}

async function readJsonBody(
  request: Request
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(400, "Expected application/json");
  }

  const contentLength = Number(
    request.headers.get("content-length") || 0
  );

  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_REQUEST_BYTES
  ) {
    throw new HttpError(413, "Request body is too large");
  }

  const text = await request.text();

  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new HttpError(413, "Request body is too large");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new HttpError(400, "Expected a JSON object");
  }

  return parsed as Record<string, unknown>;
}

function readSessionToken(request: Request): string | undefined {
  const cookie = request.headers.get("cookie") || "";

  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");

    if (name === SESSION_COOKIE) {
      return rest.join("=") || undefined;
    }
  }

  return undefined;
}

function sessionCookie(
  token: string,
  maxAgeSeconds: number
): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}; Secure`;
}

// ---------- account helpers ----------

function publicUser(user: User) {
  return {
    id: user.id,
    installPath: `/u/${user.id}/${user.installToken}/manifest.json`
  };
}

// What the browser may know about a saved source. The cached provider
// entries (filenames, logos, ...) stay on the server.
function publicSources(
  sources: SavedSourceSelection[],
  includeCommit: boolean
) {
  return sources.map(({ repository, ref, providerIds, commit }) => ({
    repository,
    ref,
    providerIds,
    ...(includeCommit ? { commit } : {})
  }));
}

async function loadProfiles(userId: string, db: Database) {
  const profiles = await getProfiles(userId, db);

  return profiles.map(({ id, name, sources }) => ({
    id,
    name,
    sources: publicSources(sources, true)
  }));
}

// Everything the UI needs right after sign-in, in one round trip, so it can
// start loading plugin sources immediately instead of chaining requests.
async function loadWorkspace(userId: string, db: Database) {
  const [{ sources, middleware }, profiles] = await Promise.all([
    getUserConfig(userId, db),
    loadProfiles(userId, db)
  ]);

  return {
    sources: publicSources(sources, false),
    middleware,
    fields: STREAM_FIELD_CATALOG,
    profiles
  };
}

async function startSession(
  user: User,
  db: Database,
  status = 200
): Promise<Response> {
  const [{ token, maxAgeSeconds }, workspace] = await Promise.all([
    createSession(user.id, db),
    loadWorkspace(user.id, db)
  ]);

  return sendJson(
    status,
    { user: publicUser(user), workspace },
    {
      "set-cookie": sessionCookie(token, maxAgeSeconds)
    }
  );
}

// ---------- API routes ----------

async function handleApi(
  request: Request,
  url: URL,
  platform: Platform
): Promise<Response> {
  const { db } = platform;
  const { pathname } = url;
  const method = request.method;
  const sessionToken = readSessionToken(request);
  const clientIp = clientAddress(platform, request);

  if (pathname === "/api/session" && method === "GET") {
    const user = await userFromSession(sessionToken, db);

    if (!user) return sendJson(200, { user: null });

    return sendJson(200, {
      user: publicUser(user),
      workspace: await loadWorkspace(user.id, db)
    });
  }

  if (pathname === "/api/register" && method === "POST") {
    const limited = enforceRateLimit(
      clientIp,
      "register",
      5,
      60 * 60 * 1000
    );

    if (limited) return limited;

    const body = await readJsonBody(request);
    const user = await registerUser(body.password, db);

    return startSession(user, db, 201);
  }

  if (pathname === "/api/login" && method === "POST") {
    const limited = enforceRateLimit(
      clientIp,
      "login",
      10,
      15 * 60 * 1000
    );

    if (limited) return limited;

    const body = await readJsonBody(request);

    const user = await loginUser(
      body.uuid,
      body.password,
      db,
      clientIp
    );

    return startSession(user, db);
  }

  const rp: RelyingParty = { rpId: url.hostname, origin: url.origin };

  if (pathname === "/api/passkey/login/options" && method === "POST") {
    const limited = enforceRateLimit(clientIp, "passkey-options", 30, 15 * 60 * 1000);
    if (limited) return limited;

    return sendJson(200, await passkeyLoginOptions(rp, db));
  }

  if (pathname === "/api/passkey/login" && method === "POST") {
    const limited = enforceRateLimit(clientIp, "passkey-login", 20, 15 * 60 * 1000);
    if (limited) return limited;

    const body = await readJsonBody(request);
    return startSession(await loginWithPasskey(rp, body, db), db);
  }

  if (pathname === "/api/logout" && method === "POST") {
    await destroySession(sessionToken, db);

    return sendJson(
      200,
      { user: null },
      { "set-cookie": sessionCookie("", 0) }
    );
  }

  const user = await userFromSession(sessionToken, db);

  if (!user) {
    throw new HttpError(401, "Please log in");
  }

  if (pathname === "/api/passkeys" && method === "GET") {
    return sendJson(200, { passkeys: await listPasskeys(user.id, db) });
  }

  if (pathname === "/api/passkeys/options" && method === "POST") {
    return sendJson(200, await passkeyRegistrationOptions(user, rp, db));
  }

  if (pathname === "/api/passkeys" && method === "POST") {
    const body = await readJsonBody(request);
    return sendJson(201, { passkey: await registerPasskey(user, rp, body, db) });
  }

  if (pathname === "/api/passkeys" && method === "DELETE") {
    const body = await readJsonBody(request);
    await deletePasskey(user.id, body.id, db);
    return sendJson(200, { passkeys: await listPasskeys(user.id, db) });
  }

  if (pathname === "/api/config" && method === "GET") {
    const { sources, middleware, fields } = await loadWorkspace(user.id, db);

    return sendJson(200, { sources, middleware, fields });
  }

  if (pathname === "/api/discover" && method === "POST") {
    const limited = enforceRateLimit(
      clientIp,
      "discover",
      20,
      10 * 60 * 1000
    );

    if (limited) return limited;

    const body = await readJsonBody(request);

    if (typeof body.repository !== "string") {
      throw new HttpError(400, "Repository URL is required");
    }

    const ref =
      typeof body.ref === "string" ? body.ref : "main";

    const result = await inspectGitHubSource(
      body.repository,
      ref
    );

    return sendJson(200, result);
  }

  if (pathname === "/api/apply" && method === "POST") {
    const limited = enforceRateLimit(
      clientIp,
      "apply",
      10,
      10 * 60 * 1000
    );

    if (limited) return limited;

    const body = await readJsonBody(request);

    const { sources, plugins, merged } = await resolveSelectedSources(body.sources);

    await saveUserConfig(user.id, sources, body.middleware, db);

    return sendJson(200, { plugins, merged });
  }

  if (pathname === "/api/profiles" && method === "GET") {
    return sendJson(200, {
      profiles: await loadProfiles(user.id, db)
    });
  }

  if (pathname === "/api/profiles" && method === "POST") {
    const limited = enforceRateLimit(
      clientIp,
      "profiles",
      10,
      10 * 60 * 1000
    );

    if (limited) return limited;

    const body = await readJsonBody(request);

    const profileId =
      typeof body.id === "string" &&
      /^[A-Za-z0-9_-]{1,100}$/.test(body.id)
        ? body.id
        : randomUUID();

    const name =
      (typeof body.name === "string"
        ? body.name.trim().slice(0, 100)
        : "") || "Default Profile";

    const { sources, plugins, merged } = await resolveSelectedSources(body.sources);

    await saveProfileAndSources(user.id, profileId, name, sources, db);

    return sendJson(200, { profileId, plugins, merged });
  }

  if (
    pathname.startsWith("/api/profiles/") &&
    method === "DELETE"
  ) {
    const profileId = pathname.split("/")[3];

    if (profileId) {
      await deleteProfile(user.id, profileId, db);
    }

    return sendJson(200, { success: true });
  }

  if (pathname === "/api/account/token" && method === "POST") {
    const limited = enforceRateLimit(
      clientIp,
      "reroll-token",
      5,
      15 * 60 * 1000
    );

    if (limited) return limited;

    const body = await readJsonBody(request);

    return sendJson(200, {
      user: publicUser(
        await rerollInstallToken(user.id, body.password, db, clientIp)
      )
    });
  }

  if (pathname === "/api/account" && method === "DELETE") {
    const body = await readJsonBody(request);

    await deleteUser(user.id, body.password, db);

    return sendJson(
      200,
      { user: null },
      { "set-cookie": sessionCookie("", 0) }
    );
  }

  return sendJson(404, { error: "Not found" });
}

// ---------- request handler ----------

export async function handleRequest(
  request: Request,
  platform: Platform
): Promise<Response> {
  const response = await routeRequest(request, platform);

  // HEAD gets the headers GET would send, without a body.
  if (request.method === "HEAD") {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  return response;
}

async function routeRequest(
  request: Request,
  platform: Platform
): Promise<Response> {
  let url: URL;

  try {
    url = new URL(request.url);
  } catch {
    return sendJson(400, { error: "Invalid request URL" });
  }

  if (url.pathname === "/" && request.method === "GET") {
    const assetUrl = new URL("/index.html", url.origin);

    const assetResponse = await platform.assets.fetch(
      new Request(assetUrl.toString(), request)
    );

    const headers = new Headers(assetResponse.headers);

    for (const [key, value] of securityHeaders()) {
      headers.set(key, value);
    }

    headers.set("cache-control", "no-store");

    return new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers
    });
  }

  if (url.pathname.startsWith("/api/")) {
    try {
      return await handleApi(request, url, platform);
    } catch (error) {
      if (error instanceof HttpError) {
        return sendJson(error.status, {
          error: error.message
        });
      }

      console.error("API request failed:", error);

      return sendJson(500, {
        error: "An internal server error occurred"
      });
    }
  }

  const isHead = request.method === "HEAD";

  if (request.method !== "GET" && !isHead) {
    return sendJson(405, {
      error: "Method not allowed"
    }, { allow: "GET, HEAD" });
  }

  if (url.pathname === "/health") {
    return sendJson(200, {
      status: "ok",
      version: await loadAppVersion(platform, url.origin)
    });
  }

  const manifestMatch = url.pathname.match(
    /^\/u\/([0-9a-f-]{36})\/([A-Za-z0-9_-]+)\/manifest\.json$/
  );

  if (manifestMatch) {
    try {
      const user = await userFromInstallLink(
        manifestMatch[1]!,
        manifestMatch[2]!,
        platform.db
      );

      if (!user) {
        return sendJson(
          404,
          { error: "Not found" },
          PUBLIC_CORS
        );
      }

      const { sources, middleware } = await getUserConfig(user.id, platform.db);
      const manifest = await getPluginRepositoryManifest(
        user.id,
        sources,
        middleware,
        {
          appVersion: await loadAppVersion(platform, url.origin),
          origin: url.origin
        }
      );

      return sendJson(200, manifest, PUBLIC_CORS);
    } catch (error) {
      console.error("Manifest request failed:", error);

      return sendJson(
        500,
        { error: "Unable to load manifest" },
        PUBLIC_CORS
      );
    }
  }

  const pluginMatch = url.pathname.match(
    /^\/u\/([0-9a-f-]{36})\/([A-Za-z0-9_-]+)\/providers\/([^/]+\.js)$/
  );

  if (pluginMatch) {
    try {
      const user = await userFromInstallLink(
        pluginMatch[1]!,
        pluginMatch[2]!,
        platform.db
      );

      let filename: string;

      try {
        filename = decodeURIComponent(pluginMatch[3]!);
      } catch {
        return sendJson(
          400,
          { error: "Malformed filename" },
          PUBLIC_CORS
        );
      }

      const config = user
        ? await getUserConfig(user.id, platform.db)
        : null;

      // Nuvio checks the size of a plugin with HEAD before downloading it.
      // Answer without fetching and wrapping the file just to count its bytes.
      if (isHead) {
        const known = config
          ? await hasRemotePluginFile(
              config.sources,
              `providers/${filename}`,
              config.middleware
            )
          : false;

        return known
          ? sendText(200, "", "application/javascript; charset=utf-8", PUBLIC_CORS)
          : sendJson(404, { error: "Not found" }, PUBLIC_CORS);
      }

      const source = config
        ? await getRemotePluginFile(
            config.sources,
            `providers/${filename}`,
            config.middleware
          )
        : null;

      if (source === null) {
        return sendJson(
          404,
          { error: "Not found" },
          PUBLIC_CORS
        );
      }

      return sendText(
        200,
        source,
        "application/javascript; charset=utf-8",
        {
          ...PUBLIC_CORS,
          "cache-control": "no-store"
        }
      );
    } catch (error) {
      console.error("Plugin request failed:", error);

      return sendJson(
        500,
        { error: "Unable to load plugin" },
        PUBLIC_CORS
      );
    }
  }

  const assetResponse = await platform.assets.fetch(request);

  if (assetResponse.status !== 404) {
    const headers = new Headers(assetResponse.headers);

    for (const [key, value] of securityHeaders()) {
      headers.set(key, value);
    }

    return new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers
    });
  }

  return sendJson(404, {
    error: "Not found"
  });
}
