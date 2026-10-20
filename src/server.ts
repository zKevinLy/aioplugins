import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyRemoteSelections,
  createPluginProfile,
  deletePluginProfile,
  getCachedPluginFile,
  getPluginProfiles,
  getPluginRepositoryManifest,
  getSavedSelections,
  inspectGitHubSource,
  resolveProfileLinkPassword
} from "./providers/remote.js";

export interface PluginBuilderConfig {
  providerStorageRoot?: string;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.includes("application/json")) throw new Error("Expected application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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

function isLocalControlRequest(request: IncomingMessage): boolean {
  return isLoopback(request.headers.host);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: PluginBuilderConfig
): Promise<void> {
  const url = new URL(request.url || "/", "http://localhost");

  if (url.pathname === "/" && request.method === "GET") {
    sendHtml(response, readFileSync(resolve(process.cwd(), "public/index.html"), "utf8"));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    if (!isLocalControlRequest(request)) {
      sendJson(response, 403, { error: "The plugin builder controls are available only from this computer" });
      return;
    }
    if (url.pathname === "/api/profiles" && request.method === "GET") {
      sendJson(response, 200, { profiles: getPluginProfiles(config.providerStorageRoot) });
      return;
    }
    if (url.pathname === "/api/selection" && request.method === "GET") {
      const profileId = url.searchParams.get("profileId") || "";
      sendJson(response, 200, { sources: getSavedSelections(config.providerStorageRoot, profileId) });
      return;
    }
    const profileMatch = url.pathname.match(/^\/api\/profiles\/([a-z0-9-]+)$/);
    if (profileMatch && request.method === "DELETE") {
      try {
        const body = await readJsonBody(request) as { password?: unknown };
        if (typeof body.password !== "string") throw new Error("Profile password is required");
        sendJson(response, 200, {
          profiles: deletePluginProfile(profileMatch[1] || "", body.password, config.providerStorageRoot)
        });
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not delete profile" });
      }
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    try {
      const body = await readJsonBody(request);
      if (url.pathname === "/api/profiles") {
        if (!body || typeof body !== "object" || typeof (body as { name?: unknown }).name !== "string") {
          throw new Error("Profile name is required");
        }
        const profileBody = body as { name: string; password?: unknown };
        if (typeof profileBody.password !== "string") throw new Error("Profile password is required");
        sendJson(response, 201, {
          profiles: createPluginProfile(profileBody.name, profileBody.password, config.providerStorageRoot)
        });
        return;
      }
      if (url.pathname === "/api/discover") {
        if (!body || typeof body !== "object") throw new Error("Invalid source request");
        const source = body as Record<string, unknown>;
        if (typeof source.repository !== "string") throw new Error("Repository URL is required");
        const ref = typeof source.ref === "string" ? source.ref : "main";
        sendJson(response, 200, await inspectGitHubSource(source.repository, ref, config.providerStorageRoot));
        return;
      }
      if (url.pathname === "/api/apply") {
        if (!body || typeof body !== "object" || !Array.isArray((body as { sources?: unknown }).sources)) {
          throw new Error("A sources list is required");
        }
        const applyBody = body as { sources: unknown[]; profileId?: unknown; password?: unknown };
        const profileId = typeof applyBody.profileId === "string" ? applyBody.profileId : "";
        const password = typeof applyBody.password === "string" ? applyBody.password : "";
        const plugins = await applyRemoteSelections(applyBody.sources, config.providerStorageRoot, profileId, password);
        sendJson(response, 200, { plugins });
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Source request failed" });
    }
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  if (url.pathname === "/health") {
    sendJson(response, 200, { status: "ok", profiles: getPluginProfiles(config.providerStorageRoot).length });
    return;
  }

  if (url.pathname === "/manifest.json") {
    sendJson(response, 404, { error: "Create a password-protected profile to get an install link" });
    return;
  }

  const profileManifest = url.pathname.match(/^\/profiles\/([a-z0-9-]+)\/([^/]+)\/manifest\.json$/);
  if (profileManifest) {
    let token: string;
    try {
      token = decodeURIComponent(profileManifest[2] || "");
    } catch {
      sendJson(response, 400, { error: "Malformed profile token" });
      return;
    }
    const profileId = profileManifest[1] || "";
    const password = resolveProfileLinkPassword(profileId, token, config.providerStorageRoot);
    if (password === null) {
      sendJson(response, 401, { error: "Invalid profile link" });
      return;
    }
    sendJson(response, 200, getPluginRepositoryManifest(config.providerStorageRoot, profileId, password));
    return;
  }

  const profilePluginMatch = url.pathname.match(/^\/profiles\/([a-z0-9-]+)\/([^/]+)\/providers\/([^/]+\.js)$/);
  const match = profilePluginMatch;
  if (match) {
    const profileId = profilePluginMatch[1] || "";
    let password = "";
    let token: string;
    try {
      token = decodeURIComponent(profilePluginMatch[2] || "");
    } catch {
      sendJson(response, 400, { error: "Malformed profile token" });
      return;
    }
    const resolvedPassword = resolveProfileLinkPassword(profileId, token, config.providerStorageRoot);
    if (resolvedPassword === null) {
      sendJson(response, 401, { error: "Invalid profile link" });
      return;
    }
    password = resolvedPassword;
    const filename = decodeURIComponent(match[3] || "");
    const source = getCachedPluginFile(`providers/${filename}`, config.providerStorageRoot, profileId, password);
    if (source === null) {
      sendJson(response, 404, { error: "Plugin file not found" });
      return;
    }
    response.writeHead(200, {
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
