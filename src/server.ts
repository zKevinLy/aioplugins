import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
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

export interface PluginBuilderConfig {
  providerStorageRoot?: string;
}

const SESSION_COOKIE = "aio_session";

function sendJson(response: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  response.end(JSON.stringify(body));
}

const PUBLIC_CORS = { "access-control-allow-origin": "*" };

function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.includes("application/json")) throw new HttpError(400, "Expected application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "Expected a JSON object");
  return parsed as Record<string, unknown>;
}

function isLoopback(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(`http://${value}`).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function readSessionToken(request: IncomingMessage): string | undefined {
  for (const part of (request.headers.cookie || "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=") || undefined;
  }
  return undefined;
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

function publicUser(user: User) {
  return { id: user.id, installPath: `/u/${user.id}/${user.installToken}/manifest.json` };
}

function startSession(response: ServerResponse, user: User, root: string, status = 200): void {
  const { token, maxAgeSeconds } = createSession(user.id, root);
  sendJson(response, status, { user: publicUser(user) }, { "set-cookie": sessionCookie(token, maxAgeSeconds) });
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL, root: string): Promise<void> {
  const { pathname } = url;
  const method = request.method;
  const sessionToken = readSessionToken(request);

  if (pathname === "/api/session" && method === "GET") {
    const user = userFromSession(sessionToken, root);
    sendJson(response, 200, { user: user ? publicUser(user) : null });
    return;
  }
  if (pathname === "/api/register" && method === "POST") {
    const body = await readJsonBody(request);
    startSession(response, await registerUser(body.password, root), root, 201);
    return;
  }
  if (pathname === "/api/login" && method === "POST") {
    const body = await readJsonBody(request);
    startSession(response, await loginUser(body.uuid, body.password, root), root);
    return;
  }
  if (pathname === "/api/logout" && method === "POST") {
    destroySession(sessionToken, root);
    sendJson(response, 200, { user: null }, { "set-cookie": sessionCookie("", 0) });
    return;
  }

  const user = userFromSession(sessionToken, root);
  if (!user) throw new HttpError(401, "Please log in");

  if (pathname === "/api/config" && method === "GET") {
    const sources = getSources(user.id, root).map(({ repository, ref, providerIds }) => ({ repository, ref, providerIds }));
    sendJson(response, 200, { sources });
    return;
  }
  if (pathname === "/api/discover" && method === "POST") {
    const body = await readJsonBody(request);
    if (typeof body.repository !== "string") throw new HttpError(400, "Repository URL is required");
    const ref = typeof body.ref === "string" ? body.ref : "main";
    sendJson(response, 200, await inspectGitHubSource(body.repository, ref));
    return;
  }
  if (pathname === "/api/apply" && method === "POST") {
    const body = await readJsonBody(request);
    const { sources, plugins } = await fetchAndCacheSources(body.sources, root);
    saveSources(user.id, sources, root);
    sendJson(response, 200, { plugins });
    return;
  }

  // Profile endpoints
  if (pathname === "/api/profiles" && method === "GET") {
    sendJson(response, 200, { profiles: getProfiles(user.id, root) });
    return;
  }
  if (pathname === "/api/profiles" && method === "POST") {
    const body = await readJsonBody(request);
    const profileId = typeof body.id === "string" && body.id ? body.id : randomUUID();
    const name = typeof body.name === "string" ? body.name : "Default Profile";
    const { sources, plugins } = await fetchAndCacheSources(body.sources, root);
    saveProfile(user.id, profileId, name, sources, root);
    saveSources(user.id, sources, root);
    sendJson(response, 200, { profileId, plugins });
    return;
  }
  if (pathname.startsWith("/api/profiles/") && method === "DELETE") {
    const profileId = pathname.split("/")[3];
    if (profileId) deleteProfile(user.id, profileId, root);
    sendJson(response, 200, { success: true });
    return;
  }

  if (pathname === "/api/account" && method === "DELETE") {
    const body = await readJsonBody(request);
    await deleteUser(user.id, body.password, root);
    sendJson(response, 200, { user: null }, { "set-cookie": sessionCookie("", 0) });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, config: PluginBuilderConfig): Promise<void> {
  const url = new URL(request.url || "/", "http://localhost");
  const root = config.providerStorageRoot ?? process.cwd();

  if (url.pathname === "/" && request.method === "GET") {
    sendHtml(response, readFileSync(resolve(process.cwd(), "public/index.html"), "utf8"));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    if (!isLoopback(request.headers.host)) {
      sendJson(response, 403, { error: "The plugin builder controls are available only from this computer" });
      return;
    }
    try {
      await handleApi(request, response, url, root);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 400;
      sendJson(response, status, { error: error instanceof Error ? error.message : "Request failed" });
    }
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  if (url.pathname === "/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  const manifestMatch = url.pathname.match(/^\/u\/([0-9a-f-]{36})\/([A-Za-z0-9_-]+)\/manifest\.json$/);
  if (manifestMatch) {
    const user = userFromInstallLink(manifestMatch[1]!, manifestMatch[2]!, root);
    if (!user) {
      sendJson(response, 404, { error: "Not found" }, PUBLIC_CORS);
      return;
    }
    sendJson(response, 200, getPluginRepositoryManifest(root, user.id, getSources(user.id, root)), PUBLIC_CORS);
    return;
  }

  const pluginMatch = url.pathname.match(/^\/u\/([0-9a-f-]{36})\/([A-Za-z0-9_-]+)\/providers\/([^/]+\.js)$/);
  if (pluginMatch) {
    const user = userFromInstallLink(pluginMatch[1]!, pluginMatch[2]!, root);
    let filename: string;
    try {
      filename = decodeURIComponent(pluginMatch[3]!);
    } catch {
      sendJson(response, 400, { error: "Malformed filename" }, PUBLIC_CORS);
      return;
    }
    const source = user ? getCachedPluginFile(root, getSources(user.id, root), `providers/${filename}`) : null;
    if (source === null) {
      sendJson(response, 404, { error: "Not found" }, PUBLIC_CORS);
      return;
    }
    response.writeHead(200, {
      ...PUBLIC_CORS,
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    response.end(source);
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

export function createPluginBuilderServer(config: PluginBuilderConfig = {}): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, config).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: "Plugin repository request failed" });
      else response.destroy();
    });
  });
}