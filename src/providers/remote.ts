import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type MediaType = "movie" | "series";

const MAX_PROVIDER_BYTES = 8 * 1024 * 1024;

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
  const parts = url.pathname.replace(/\.git\/?$/, "").split("/").filter(Boolean);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || parts.length !== 2) {
    throw new Error("Only HTTPS GitHub repository URLs are supported");
  }
  return { owner: parts[0]!, repo: parts[1]!, url: `https://github.com/${parts[0]}/${parts[1]}` };
}

function safeProviderPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Provider manifest has no filename");
  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (normalized.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === "..") || !normalized.endsWith(".js")) {
    throw new Error(`Unsafe provider filename in manifest: ${value}`);
  }
  return segments.join("/");
}

function manifestEntries(value: unknown): ProviderEntry[] {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? (value as { scrapers?: unknown }).scrapers
      : undefined;
  if (!Array.isArray(entries)) throw new Error("Unsupported GitHub provider manifest format");
  return entries.filter((entry): entry is ProviderEntry => Boolean(entry && typeof entry === "object"));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function fetchJson(url: string): Promise<unknown> {
  const token = process.env.GITHUB_TOKEN;
  const response = await fetch(url, {
    headers: {
      "user-agent": "aioplugins-local",
      ...(token && new URL(url).hostname === "api.github.com" ? { authorization: `Bearer ${token}` } : {})
    }
  });
  if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
  return response.json();
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "user-agent": "aioplugins-local" } });
  if (!response.ok) throw new Error(`GitHub file request failed (${response.status})`);
  const source = await response.text();
  if (Buffer.byteLength(source, "utf8") > MAX_PROVIDER_BYTES) throw new Error("Provider file is larger than 8 MB");
  return source;
}

async function loadSource(repositoryValue: string, refValue = "main") {
  const repository = parseRepository(repositoryValue);
  const ref = refValue.trim() || "main";
  const commitData = await fetchJson(`https://api.github.com/repos/${repository.owner}/${repository.repo}/commits/${encodeURIComponent(ref)}`);
  if (!commitData || typeof commitData !== "object" || typeof (commitData as { sha?: unknown }).sha !== "string") {
    throw new Error("GitHub did not return a commit for this ref");
  }
  const commit = (commitData as { sha: string }).sha;
  const manifestUrl = `https://raw.githubusercontent.com/${repository.owner}/${repository.repo}/${commit}/manifest.json`;
  const manifest = await fetchJson(manifestUrl);
  return { ...repository, ref, commit, manifest, entries: manifestEntries(manifest) };
}

export async function inspectGitHubSource(repository: string, ref = "main") {
  const source = await loadSource(repository, ref);
  return {
    repository: source.url,
    ref: source.ref,
    commit: source.commit,
    providers: source.entries.map((entry) => ({
      id: stringValue(entry.id),
      name: stringValue(entry.name) || stringValue(entry.id) || "Unnamed provider",
      description: stringValue(entry.description) || "",
      enabled: entry.enabled !== false,
      types: Array.isArray(entry.supportedTypes)
        ? entry.supportedTypes.filter((type): type is "movie" | "tv" => type === "movie" || type === "tv").map((type): MediaType => type === "tv" ? "series" : "movie")
        : [],
      logo: stringValue(entry.logo)
    })).filter((entry) => Boolean(entry.id))
  };
}

function cacheRoot(storageRoot: string): string {
  return resolve(storageRoot, "data", "cache");
}

function safeIdSlug(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
}

export function getCachedPluginFiles(storageRoot: string, sources: SavedSourceSelection[]): CachedPluginFile[] {
  return sources.flatMap((selection) => {
    const { owner, repo } = parseRepository(selection.repository);
    const cacheDir = join(cacheRoot(storageRoot), owner, repo, selection.commit);
    const manifest = JSON.parse(readFileSync(join(cacheDir, "manifest.json"), "utf8")) as unknown;
    const selected = manifestEntries(manifest).filter((entry) =>
      typeof entry.id === "string" && selection.providerIds.includes(entry.id) && entry.enabled !== false
    );
    return selected.map((entry) => {
      const id = String(entry.id);
      const originalFilename = safeProviderPath(entry.filename);
      const suffix = createHash("sha256").update(`${owner}/${repo}/${selection.commit}/${id}`).digest("hex").slice(0, 10);
      return {
        entry,
        filename: `providers/${owner}-${repo}-${safeIdSlug(id)}-${suffix}.js`,
        path: join(cacheDir, ...originalFilename.split("/"))
      };
    });
  });
}

export function getPluginRepositoryManifest(storageRoot: string, userId: string, sources: SavedSourceSelection[]) {
  const scrapers = getCachedPluginFiles(storageRoot, sources).map(({ entry, filename }) => ({
    ...entry,
    enabled: true,
    filename
  }));
  return { name: `AIOPlugins - ${userId.slice(0, 8)}`, version: "1.0.0", scrapers };
}

export function getCachedPluginFile(storageRoot: string, sources: SavedSourceSelection[], filename: string): string | null {
  const plugin = getCachedPluginFiles(storageRoot, sources).find((entry) => entry.filename === filename);
  return plugin ? readFileSync(plugin.path, "utf8") : null;
}


export async function fetchAndCacheSources(
  value: unknown,
  storageRoot: string
): Promise<{ sources: SavedSourceSelection[]; plugins: number }> {
  if (!Array.isArray(value)) throw new Error("Selections must be a list");
  const selections = value.map((item): SourceSelection => {
    if (!item || typeof item !== "object") throw new Error("Invalid source selection");
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.repository !== "string" || !Array.isArray(candidate.providerIds) || !candidate.providerIds.every((id) => typeof id === "string")) {
      throw new Error("Each source requires a repository URL and provider ID list");
    }
    return {
      repository: parseRepository(candidate.repository).url,
      ref: typeof candidate.ref === "string" ? candidate.ref : "main",
      providerIds: [...new Set(candidate.providerIds as string[])],
      ...(typeof candidate.commit === "string" ? { commit: candidate.commit } : {})
    };
  }).filter((selection) => selection.providerIds.length > 0);

  // Override duplicate provider IDs across inputs (the latest selection wins)
  for (const selection of selections) {
    for (const id of selection.providerIds) {
      for (const existingSelection of selections) {
        if (existingSelection !== selection) {
          existingSelection.providerIds = existingSelection.providerIds.filter(existingId => existingId !== id);
        }
      }
    }
  }

  const saved: SavedSourceSelection[] = [];
  let plugins = 0;

  for (const selection of selections) {
    const source = await loadSource(selection.repository, selection.ref);
    if (selection.commit && selection.commit !== source.commit) {
      throw new Error(`The source changed after discovery. Review the new commit for ${source.url} before applying.`);
    }
    const selectedEntries = source.entries.filter((entry) => typeof entry.id === "string" && selection.providerIds.includes(entry.id));
    if (selectedEntries.length !== selection.providerIds.length) throw new Error(`One or more selected IDs were not found in ${source.url}`);
    const cacheDir = join(cacheRoot(storageRoot), source.owner, source.repo, source.commit);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "manifest.json"), JSON.stringify(source.manifest, null, 2));

    for (const entry of selectedEntries) {
      if (entry.enabled === false) throw new Error(`Provider "${String(entry.id)}" is disabled in its manifest`);
      const filename = safeProviderPath(entry.filename);
      const urlPath = filename.split("/").map(encodeURIComponent).join("/");
      const code = await fetchText(`https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.commit}/${urlPath}`);
      const filePath = join(cacheDir, ...filename.split("/"));
      mkdirSync(resolve(filePath, ".."), { recursive: true });
      writeFileSync(filePath, code);
    }

    saved.push({ ...selection, repository: source.url, commit: source.commit });
    plugins += selectedEntries.length;
  }

  return { sources: saved, plugins };
}