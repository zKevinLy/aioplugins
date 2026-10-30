
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import {
  dirname,
  join,
  relative,
  resolve,
  sep
} from "node:path";

type MediaType = "movie" | "series";

const MAX_PROVIDER_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

const GITHUB_API = "https://api.github.com";
const GITHUB_RAW = "https://raw.githubusercontent.com";

interface ProviderEntry {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  filename?: unknown;
  enabled?: unknown;
  supportedTypes?: unknown;
  logo?: unknown;
}

interface CachedPluginFile {
  entry: ProviderEntry;
  filename: string;
  path: string;
}

export interface SourceSelection {
  repository: string;
  ref: string;
  providerIds: string[];
  commit?: string;
}

export interface SavedSourceSelection extends SourceSelection {
  commit: string;
}

interface GitHubRepository {
  owner: string;
  repo: string;
  url: string;
}

function parseRepository(value: string): GitHubRepository {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid GitHub repository URL");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Only HTTPS GitHub repository URLs are supported");
  }

  const pathname = url.pathname
    .replace(/\.git\/?$/i, "")
    .replace(/\/$/, "");

  const parts = pathname.split("/").filter(Boolean);

  if (parts.length !== 2) {
    throw new Error("Enter a GitHub repository URL, not a file or organization URL");
  }

  const [owner, repo] = parts;

  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner!) ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(repo!) ||
    repo === "." ||
    repo === ".."
  ) {
    throw new Error("Invalid GitHub repository name");
  }

  return {
    owner: owner!,
    repo: repo!,
    url: `https://github.com/${owner}/${repo}`
  };
}

function validateRef(value: string): string {
  const ref = value.trim() || "main";

  if (
    ref.length > 255 ||
    !/^[A-Za-z0-9._/-]+$/.test(ref) ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.includes("//") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.split("/").some(
      (part) =>
        !part ||
        part.startsWith(".") ||
        part.endsWith(".") ||
        part.endsWith(".lock")
    )
  ) {
    throw new Error("Invalid GitHub branch or tag name");
  }

  return ref;
}

function validateCommit(value: string): string {
  if (!/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error("GitHub returned an invalid commit identifier");
  }

  return value;
}

function safeProviderPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Provider manifest has no filename");
  }

  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/");

  if (
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    /^[A-Za-z]:/.test(normalized) ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".."
    ) ||
    !normalized.endsWith(".js")
  ) {
    throw new Error(`Unsafe provider filename in manifest: ${value}`);
  }

  return segments.join("/");
}

function safeCachePath(cacheDir: string, filename: string): string {
  const target = resolve(cacheDir, ...filename.split("/"));
  const rel = relative(cacheDir, target);

  if (
    !rel ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    resolve(target) === resolve(cacheDir)
  ) {
    throw new Error("Unsafe cache file path");
  }

  return target;
}

function manifestEntries(value: unknown): ProviderEntry[] {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? (value as { scrapers?: unknown }).scrapers
      : undefined;

  if (!Array.isArray(entries)) {
    throw new Error("Unsupported GitHub provider manifest format");
  }

  return entries.filter(
    (entry): entry is ProviderEntry =>
      Boolean(entry && typeof entry === "object" && !Array.isArray(entry))
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

async function readLimitedResponse(
  response: Response,
  maxBytes: number,
  errorMessage: string
): Promise<string> {
  if (!response.body) {
    throw new Error("GitHub returned an empty response");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      totalBytes += value.byteLength;

      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(errorMessage);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(result);
}

async function githubFetch(
  urlValue: string,
  allowedHost: string
): Promise<Response> {
  const url = new URL(urlValue);

  if (
    url.protocol !== "https:" ||
    url.hostname !== allowedHost ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new Error("Blocked request to an unapproved host");
  }

  const token = process.env.GITHUB_TOKEN;

  const headers: Record<string, string> = {
    "user-agent": "aioplugins-local",
    accept: "application/vnd.github+json"
  };

  if (allowedHost === "api.github.com" && token) {
    headers.authorization = `Bearer ${token}`;
  }

  return fetch(url, {
    method: "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
}

async function fetchJson(url: string): Promise<unknown> {
  const parsed = new URL(url);

  if (
    parsed.hostname !== "api.github.com" &&
    parsed.hostname !== "raw.githubusercontent.com"
  ) {
    throw new Error("Blocked request to an unapproved GitHub host");
  }

  const response = await githubFetch(url, parsed.hostname);

  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status})`);
  }

  const text = await readLimitedResponse(
    response,
    MAX_JSON_BYTES,
    "GitHub JSON response is larger than 2 MB"
  );

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("GitHub returned invalid JSON");
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await githubFetch(url, "raw.githubusercontent.com");

  if (!response.ok) {
    throw new Error(`GitHub file request failed (${response.status})`);
  }

  return readLimitedResponse(
    response,
    MAX_PROVIDER_BYTES,
    "Provider file is larger than 8 MB"
  );
}

async function loadSource(repositoryValue: string, refValue = "main") {
  const repository = parseRepository(repositoryValue);
  const ref = validateRef(refValue);

  const commitUrl =
    `${GITHUB_API}/repos/${repository.owner}/${repository.repo}` +
    `/commits/${encodeURIComponent(ref)}`;

  const commitData = await fetchJson(commitUrl);

  if (
    !commitData ||
    typeof commitData !== "object" ||
    typeof (commitData as { sha?: unknown }).sha !== "string"
  ) {
    throw new Error("GitHub did not return a commit for this ref");
  }

  const commit = validateCommit(
    (commitData as { sha: string }).sha
  );

  const manifestUrl =
    `${GITHUB_RAW}/${repository.owner}/${repository.repo}` +
    `/${commit}/manifest.json`;

  const manifest = await fetchJson(manifestUrl);

  return {
    ...repository,
    ref,
    commit,
    manifest,
    entries: manifestEntries(manifest)
  };
}

export async function inspectGitHubSource(
  repository: string,
  ref = "main"
) {
  const source = await loadSource(repository, ref);

  return {
    repository: source.url,
    ref: source.ref,
    commit: source.commit,
    providers: source.entries
      .map((entry) => ({
        id: stringValue(entry.id),
        name:
          stringValue(entry.name) ||
          stringValue(entry.id) ||
          "Unnamed provider",
        description: stringValue(entry.description) || "",
        enabled: entry.enabled !== false,
        types: Array.isArray(entry.supportedTypes)
          ? entry.supportedTypes
              .filter(
                (type): type is "movie" | "tv" =>
                  type === "movie" || type === "tv"
              )
              .map((type): MediaType =>
                type === "tv" ? "series" : "movie"
              )
          : [],
        logo: stringValue(entry.logo)
      }))
      .filter((entry) => Boolean(entry.id))
  };
}

function cacheRoot(storageRoot: string): string {
  return resolve(storageRoot, "data", "cache");
}

function safeIdSlug(id: string): string {
  return (
    id
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "plugin"
  );
}

export function getCachedPluginFiles(
  storageRoot: string,
  sources: SavedSourceSelection[]
): CachedPluginFile[] {
  return sources.flatMap((selection) => {
    const { owner, repo } = parseRepository(selection.repository);
    const commit = validateCommit(selection.commit);

    const cacheDir = join(
      cacheRoot(storageRoot),
      owner,
      repo,
      commit
    );

    const manifestPath = safeCachePath(cacheDir, "manifest.json");

    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8")
    ) as unknown;

    const selected = manifestEntries(manifest).filter(
      (entry) =>
        typeof entry.id === "string" &&
        selection.providerIds.includes(entry.id) &&
        entry.enabled !== false
    );

    return selected.map((entry) => {
      const id = String(entry.id);
      const originalFilename = safeProviderPath(entry.filename);

      const suffix = createHash("sha256")
        .update(`${owner}/${repo}/${commit}/${id}`)
        .digest("hex")
        .slice(0, 10);

      return {
        entry,
        filename:
          `providers/${owner}-${repo}-${safeIdSlug(id)}-${suffix}.js`,
        path: safeCachePath(cacheDir, originalFilename)
      };
    });
  });
}

export function getPluginRepositoryManifest(
  storageRoot: string,
  userId: string,
  sources: SavedSourceSelection[]
) {
  const scrapers = getCachedPluginFiles(storageRoot, sources).map(
    ({ entry, filename }) => ({
      ...entry,
      enabled: true,
      filename
    })
  );

  return {
    name: `AIOPlugins - ${userId.slice(0, 8)}`,
    version: "1.0.0",
    scrapers
  };
}

export function getCachedPluginFile(
  storageRoot: string,
  sources: SavedSourceSelection[],
  filename: string
): string | null {
  const plugin = getCachedPluginFiles(storageRoot, sources).find(
    (entry) => entry.filename === filename
  );

  return plugin ? readFileSync(plugin.path, "utf8") : null;
}

export async function fetchAndCacheSources(
  value: unknown,
  storageRoot: string
): Promise<{ sources: SavedSourceSelection[]; plugins: number }> {
  if (!Array.isArray(value)) {
    throw new Error("Selections must be a list");
  }

  const selections = value
    .map((item): SourceSelection => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("Invalid source selection");
      }

      const candidate = item as Record<string, unknown>;

      if (
        typeof candidate.repository !== "string" ||
        !Array.isArray(candidate.providerIds) ||
        !candidate.providerIds.every(
          (id) =>
            typeof id === "string" &&
            id.length > 0 &&
            id.length <= 200
        )
      ) {
        throw new Error(
          "Each source requires a repository URL and valid provider ID list"
        );
      }

      return {
        repository: parseRepository(candidate.repository).url,
        ref:
          typeof candidate.ref === "string"
            ? validateRef(candidate.ref)
            : "main",
        providerIds: [
          ...new Set(candidate.providerIds as string[])
        ],
        ...(typeof candidate.commit === "string"
          ? { commit: candidate.commit }
          : {})
      };
    })
    .filter((selection) => selection.providerIds.length > 0);

  // The first selection wins when provider IDs are duplicated.
  for (let i = 0; i < selections.length; i++) {
    const selection = selections[i]!;

    for (const id of selection.providerIds) {
      for (let j = i + 1; j < selections.length; j++) {
        selections[j]!.providerIds =
          selections[j]!.providerIds.filter(
            (existingId) => existingId !== id
          );
      }
    }
  }

  const saved: SavedSourceSelection[] = [];
  let plugins = 0;

  for (const selection of selections) {
    const source = await loadSource(
      selection.repository,
      selection.ref
    );

    if (
      selection.commit &&
      selection.commit !== source.commit
    ) {
      throw new Error(
        `The source changed after discovery. Review the new commit for ${source.url} before applying.`
      );
    }

    const selectedEntries = source.entries.filter(
      (entry) =>
        typeof entry.id === "string" &&
        selection.providerIds.includes(entry.id)
    );

    if (
      selectedEntries.length !== selection.providerIds.length
    ) {
      throw new Error(
        `One or more selected IDs were not found in ${source.url}`
      );
    }

    const cacheDir = join(
      cacheRoot(storageRoot),
      source.owner,
      source.repo,
      source.commit
    );

    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(
      safeCachePath(cacheDir, "manifest.json"),
      JSON.stringify(source.manifest, null, 2)
    );

    for (const entry of selectedEntries) {
      if (entry.enabled === false) {
        throw new Error(
          `Provider "${String(entry.id)}" is disabled in its manifest`
        );
      }

      const filename = safeProviderPath(entry.filename);

      const urlPath = filename
        .split("/")
        .map(encodeURIComponent)
        .join("/");

      const code = await fetchText(
        `${GITHUB_RAW}/${source.owner}/${source.repo}/${source.commit}/${urlPath}`
      );

      const filePath = safeCachePath(cacheDir, filename);

      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, code);
    }

    saved.push({
      ...selection,
      repository: source.url,
      commit: source.commit
    });

    plugins += selectedEntries.length;
  }

  return { sources: saved, plugins };
}
