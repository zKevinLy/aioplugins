
import { createHash } from "node:crypto";
import {
  normalizeStreamMiddlewareSettings,
  wrapPluginStreams
} from "./stream-middleware.js";

type MediaType = "movie" | "series";

const MAX_PROVIDER_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const GITHUB_MAX_ATTEMPTS = 2;
const GITHUB_RETRY_DELAY_MS = 250;
const STREAM_MIDDLEWARE_VERSION = "15";

const GITHUB_RAW = "https://raw.githubusercontent.com";
const GITHUB_WEB = "https://github.com";

interface ProviderEntry {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  filename?: unknown;
  enabled?: unknown;
  supportedTypes?: unknown;
  logo?: unknown;
}

interface SelectedProviderEntry extends ProviderEntry {
  id: string;
  filename: string;
}

interface RemotePluginFile {
  entry: ProviderEntry;
  filename: string;
  owner: string;
  repo: string;
  commit: string;
  originalFilename: string;
}

export interface SourceSelection {
  repository: string;
  ref: string;
  providerIds: string[];
  commit?: string;
}

export interface SavedSourceSelection extends SourceSelection {
  commit: string;
  providers?: SelectedProviderEntry[];
}

interface GitHubRepository {
  owner: string;
  repo: string;
  url: string;
}

// ---------- validation ----------

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
    throw new Error(
      "Enter a GitHub repository URL, not a file or organization URL"
    );
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
      part =>
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
      segment =>
        !segment ||
        segment === "." ||
        segment === ".."
    ) ||
    !normalized.endsWith(".js")
  ) {
    throw new Error(
      `Unsafe provider filename in manifest: ${value}`
    );
  }

  return segments.join("/");
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
      Boolean(
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry)
      )
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function safeIdSlug(id: string): string {
  return (
    id
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "plugin"
  );
}

// ---------- GitHub requests ----------

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

  return new TextDecoder("utf-8", {
    fatal: false,
    ignoreBOM: false
  }).decode(result);
}

async function githubFetch(
  urlValue: string,
  allowedHost: string
): Promise<Response> {
  const url = new URL(urlValue);

  const allowedHosts = [
    "github.com",
    "raw.githubusercontent.com"
  ];

  if (
    url.protocol !== "https:" ||
    !allowedHosts.includes(allowedHost) ||
    url.hostname !== allowedHost ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new Error("Blocked request to an unapproved GitHub host");
  }

  const headers: Record<string, string> = {
    "user-agent": "aioplugins",
    accept:
      allowedHost === "github.com"
        ? "application/atom+xml"
        : "*/*"
  };

  for (let attempt = 1; attempt <= GITHUB_MAX_ATTEMPTS; attempt++) {
    let response: Response;

    try {
      response = await fetch(url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      if (attempt === GITHUB_MAX_ATTEMPTS) throw error;

      await new Promise(resolve =>
        setTimeout(resolve, GITHUB_RETRY_DELAY_MS)
      );
      continue;
    }

    if (
      attempt < GITHUB_MAX_ATTEMPTS &&
      (response.status === 429 || response.status >= 500)
    ) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter >= 0
        ? Math.min(retryAfter * 1000, 2_000)
        : GITHUB_RETRY_DELAY_MS;

      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }

    if (response.status >= 300 && response.status < 400) {
      throw new Error("GitHub returned an unexpected redirect");
    }

    return response;
  }

  throw new Error("GitHub request exhausted retry attempts");
}

async function fetchAtomCommit(
  repository: GitHubRepository,
  ref: string
): Promise<string> {
  const encodedRef = ref
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  const url =
    `${GITHUB_WEB}/${repository.owner}/${repository.repo}` +
    `/commits/${encodedRef}.atom`;

  const response = await githubFetch(url, "github.com");

  if (!response.ok) {
    throw new Error(
      `GitHub commit feed request failed (${response.status})`
    );
  }

  const atom = await readLimitedResponse(
    response,
    MAX_JSON_BYTES,
    "GitHub commit feed is larger than 2 MB"
  );

  // GitHub Atom entries contain commit IDs in their entry IDs.
  // Prefer the first commit because Atom feeds are newest-first.
  const patterns = [
    /Grit::Commit\/([a-f0-9]{40})/i,
    /\/commit\/([a-f0-9]{40})(?:\.atom)?/i
  ];

  for (const pattern of patterns) {
    const match = atom.match(pattern);

    if (match?.[1]) {
      return validateCommit(match[1]);
    }
  }

  throw new Error(
    "Could not find a commit SHA in the GitHub commit feed. Check that the repository and branch exist."
  );
}

async function fetchJson(url: string): Promise<unknown> {
  const parsed = new URL(url);

  if (parsed.hostname !== "raw.githubusercontent.com") {
    throw new Error(
      "Blocked request to an unapproved GitHub host"
    );
  }

  const response = await githubFetch(
    url,
    "raw.githubusercontent.com"
  );

  if (!response.ok) {
    throw new Error(
      `GitHub manifest request failed (${response.status})`
    );
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
  const response = await githubFetch(
    url,
    "raw.githubusercontent.com"
  );

  if (!response.ok) {
    throw new Error(
      `GitHub file request failed (${response.status})`
    );
  }

  return readLimitedResponse(
    response,
    MAX_PROVIDER_BYTES,
    "Provider file is larger than 8 MB"
  );
}

// ---------- source discovery ----------

async function loadSource(
  repositoryValue: string,
  refValue = "main"
) {
  const repository = parseRepository(repositoryValue);
  const ref = validateRef(refValue);

  // Resolve the branch or tag without using api.github.com.
  const commit = await fetchAtomCommit(repository, ref);

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
      .map(entry => ({
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
      .filter(entry => Boolean(entry.id))
  };
}

// ---------- live plugin lookup ----------

async function fetchSourceManifest(
  owner: string,
  repo: string,
  commit: string
): Promise<SelectedProviderEntry[]> {
  const manifest = await fetchJson(
    `${GITHUB_RAW}/${owner}/${repo}/${validateCommit(commit)}/manifest.json`
  );

  return manifestEntries(manifest).filter(
    (entry): entry is SelectedProviderEntry =>
      typeof entry.id === "string" &&
      typeof entry.filename === "string"
  );
}

async function getRemotePluginFiles(
  sources: SavedSourceSelection[],
  middlewareSettings: unknown
): Promise<RemotePluginFile[]> {
  const result: RemotePluginFile[] = [];
  const middlewareFingerprint = createHash("sha256")
    .update(`${STREAM_MIDDLEWARE_VERSION}:${JSON.stringify(normalizeStreamMiddlewareSettings(middlewareSettings))}`)
    .digest("hex")
    .slice(0, 10);

  for (const selection of sources) {
    const { owner, repo } = parseRepository(selection.repository);
    const commit = validateCommit(selection.commit);
    const entries = selection.providers ??
      await fetchSourceManifest(owner, repo, commit);
    const selected = entries.filter(
      entry =>
        selection.providerIds.includes(entry.id) &&
        entry.enabled !== false
    );

    for (const entry of selected) {
      const id = entry.id;
      const originalFilename = safeProviderPath(entry.filename);

      const suffix = createHash("sha256")
        .update(`${owner}/${repo}/${commit}/${id}/${middlewareFingerprint}`)
        .digest("hex")
        .slice(0, 10);

      result.push({
        entry,
        filename:
          `providers/${owner}-${repo}-${safeIdSlug(id)}-${suffix}.js`,
        owner,
        repo,
        commit,
        originalFilename
      });
    }
  }

  return result;
}

export async function getPluginRepositoryManifest(
  userId: string,
  sources: SavedSourceSelection[],
  middlewareSettings: unknown
) {
  const plugins = await getRemotePluginFiles(sources, middlewareSettings);

  const scrapers = plugins.map(({ entry, filename }) => ({
    ...entry,
    enabled: true,
    filename
  }));

  return {
    name: `AIOPlugins - ${userId.slice(0, 8)}`,
    version: "1.0.0",
    scrapers
  };
}

export async function getRemotePluginFile(
  sources: SavedSourceSelection[],
  filename: string,
  middlewareSettings: unknown
): Promise<string | null> {
  const plugins = await getRemotePluginFiles(sources, middlewareSettings);

  const plugin = plugins.find(
    entry => entry.filename === filename
  );

  if (!plugin) return null;

  const urlPath = plugin.originalFilename
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const source = await fetchText(
    `${GITHUB_RAW}/${plugin.owner}/${plugin.repo}/${plugin.commit}/${urlPath}`
  );

  return wrapPluginStreams(
    source,
    middlewareSettings,
    typeof plugin.entry.name === "string" ? plugin.entry.name : ""
  );
}

// ---------- resolve selected providers ----------

export async function resolveSelectedSources(
  value: unknown
): Promise<{
  sources: SavedSourceSelection[];
  plugins: number;
}> {
  if (!Array.isArray(value)) {
    throw new Error("Selections must be a list");
  }

  const selections = value
    .map((item): SourceSelection => {
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item)
      ) {
        throw new Error("Invalid source selection");
      }

      const candidate = item as Record<string, unknown>;

      if (
        typeof candidate.repository !== "string" ||
        !Array.isArray(candidate.providerIds) ||
        !candidate.providerIds.every(
          id =>
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
    .filter(selection => selection.providerIds.length > 0);

  // The first selection wins when provider IDs are duplicated.
  for (let i = 0; i < selections.length; i++) {
    const selection = selections[i]!;

    for (const id of selection.providerIds) {
      for (let j = i + 1; j < selections.length; j++) {
        selections[j]!.providerIds =
          selections[j]!.providerIds.filter(
            existingId => existingId !== id
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
      (entry): entry is ProviderEntry & { id: string } =>
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

    const providers: SelectedProviderEntry[] = selectedEntries.map(entry => {
      if (entry.enabled === false) {
        throw new Error(
          `Provider "${String(entry.id)}" is disabled in its manifest`
        );
      }

      return {
        ...entry,
        id: entry.id,
        filename: safeProviderPath(entry.filename)
      };
    });

    saved.push({
      ...selection,
      repository: source.url,
      commit: source.commit,
      providers
    });

    plugins += selectedEntries.length;
  }

  return {
    sources: saved,
    plugins
  };
}
