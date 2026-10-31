
import { randomUUID } from "node:crypto";

import type { Env } from "./lib/db.js";

import {
  fetchAndCacheSources,
  getCachedPluginFile,
  getPluginRepositoryManifest,
  inspectGitHubSource
} from "./providers/remote.js";

import {
  HttpError,
  createSession,
  deleteUser,
  destroySession,
  getProfiles,
  getSources,
  loginUser,
  registerUser,
  saveProfile,
  deleteProfile,
  saveSources,
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

function clientAddress(request: Request): string {
  const forwarded = request.headers.get("cf-connecting-ip");

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
  request: Request,
  bucket: string,
  maximum: number,
  windowMs: number
): Response | null {
  const now = Date.now();
  const key = `${bucket}:${clientAddress(request)}`;

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

async function startSession(
  user: User,
  env: Env,
  status = 200
): Promise<Response> {
  const { token, maxAgeSeconds } = await createSession(user.id, env);

  return sendJson(
    status,
    { user: publicUser(user) },
    {
      "set-cookie": sessionCookie(token, maxAgeSeconds)
    }
  );
}

// ---------- API routes ----------

async function handleApi(
  request: Request,
  url: URL,
  env: Env
): Promise<Response> {
  const { pathname } = url;
  const method = request.method;
  const sessionToken = readSessionToken(request);

  if (pathname === "/api/session" && method === "GET") {
    const user = await userFromSession(sessionToken, env);

    return sendJson(200, {
      user: user ? publicUser(user) : null
    });
  }

  if (pathname === "/api/register" && method === "POST") {
    const limited = enforceRateLimit(
      request,
      "register",
      5,
      60 * 60 * 1000
    );

    if (limited) return limited;

    const body = await readJsonBody(request);
    const user = await registerUser(body.password, env);

    return startSession(user, env, 201);
  }

  if (pathname === "/api/login" && method === "POST") {
    const limited = enforceRateLimit(
      request,
      "login",
      10,
      15 * 60 * 1000
    );

    if (limited) return limited;

    const body = await readJsonBody(request);

    const user = await loginUser(
      body.uuid,
      body.password,
      env,
      clientAddress(request)
    );

    return startSession(user, env);
  }

  if (pathname === "/api/logout" && method === "POST") {
    await destroySession(sessionToken, env);

    return sendJson(
      200,
      { user: null },
      { "set-cookie": sessionCookie("", 0) }
    );
  }

  const user = await userFromSession(sessionToken, env);

  if (!user) {
    throw new HttpError(401, "Please log in");
  }

  if (pathname === "/api/config" && method === "GET") {
    const sources = (await getSources(user.id, env)).map(
      ({ repository, ref, providerIds }) => ({
        repository,
        ref,
        providerIds
      })
    );

    return sendJson(200, { sources });
  }

  if (pathname === "/api/discover" && method === "POST") {
    const limited = enforceRateLimit(
      request,
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
      ref,
      env
    );

    return sendJson(200, result);
  }

  if (pathname === "/api/apply" && method === "POST") {
    const limited = enforceRateLimit(
      request,
      "apply",
      10,
      10 * 60 * 1000
    );

    if (limited) return limited;

    const body = await readJsonBody(request);

    const { sources, plugins } = await fetchAndCacheSources(
      body.sources,
      env
    );

    await saveSources(user.id, sources, env);

    return sendJson(200, { plugins });
  }

  if (pathname === "/api/profiles" && method === "GET") {
    return sendJson(200, {
      profiles: await getProfiles(user.id, env)
    });
  }

  if (pathname === "/api/profiles" && method === "POST") {
    const limited = enforceRateLimit(
      request,
      "profiles",
      10,
      10 * 60 * 1000
    );

    if (limited) return limited;

    const body = await readJsonBody(request);

    const profileId =
      typeof body.id === "string" && body.id
        ? body.id
        : randomUUID();

    const name =
      typeof body.name === "string"
        ? body.name
        : "Default Profile";

    const { sources, plugins } = await fetchAndCacheSources(
      body.sources,
      env
    );

    await saveProfile(user.id, profileId, name, sources, env);
    await saveSources(user.id, sources, env);

    return sendJson(200, { profileId, plugins });
  }

  if (
    pathname.startsWith("/api/profiles/") &&
    method === "DELETE"
  ) {
    const profileId = pathname.split("/")[3];

    if (profileId) {
      await deleteProfile(user.id, profileId, env);
    }

    return sendJson(200, { success: true });
  }

  if (pathname === "/api/account" && method === "DELETE") {
    const body = await readJsonBody(request);

    await deleteUser(user.id, body.password, env);

    return sendJson(
      200,
      { user: null },
      { "set-cookie": sessionCookie("", 0) }
    );
  }

  return sendJson(404, { error: "Not found" });
}

// ---------- Worker request handler ----------

export async function handleRequest(
  request: Request,
  env: Env
): Promise<Response> {
  let url: URL;

  try {
    url = new URL(request.url);
  } catch {
    return sendJson(400, { error: "Invalid request URL" });
  }

  if (url.pathname === "/" && request.method === "GET") {
    const assetUrl = new URL("/index.html", url.origin);

    const assetResponse = await env.ASSETS.fetch(
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
      return await handleApi(request, url, env);
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

  if (request.method !== "GET") {
    return sendJson(405, {
      error: "Method not allowed"
    });
  }

  if (url.pathname === "/health") {
    return sendJson(200, {
      status: "ok"
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
        env
      );

      if (!user) {
        return sendJson(
          404,
          { error: "Not found" },
          PUBLIC_CORS
        );
      }

      const sources = await getSources(user.id, env);

      const manifest = await getPluginRepositoryManifest(
        env,
        user.id,
        sources
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
        env
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

      const sources = user
        ? await getSources(user.id, env)
        : [];

      const source = user
        ? await getCachedPluginFile(
            env,
            sources,
            `providers/${filename}`
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
          "cache-control": "public, max-age=300"
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

  return sendJson(404, {
    error: "Not found"
  });
}
