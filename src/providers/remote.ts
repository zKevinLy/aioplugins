
import { createHash } from "node:crypto";
import { HttpError } from "../lib/http-error.js";
import {
  normalizeStreamMiddlewareSettings,
  wrapPluginStreams
} from "./stream-middleware.js";
import { buildNuvioManifest } from "./nuvio-manifest.js";

type MediaType = "movie" | "series";

const MAX_PROVIDER_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const GITHUB_MAX_ATTEMPTS = 2;
const GITHUB_RETRY_DELAY_MS = 250;
/** Parallel "when was this file last changed" lookups while saving. */
const UPDATED_LOOKUP_CONCURRENCY = 6;
export const STREAM_MIDDLEWARE_VERSION = "19";

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

/** One plugin as Nuvio sees it: one provider file from one source. */
interface RemotePluginFile {
  entry: ProviderEntry;
  owner: string;
  repo: string;
  commit: string;
  originalFilename: string;
  filename: string;
}

interface SourceSelection {
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
    throw new HttpError(400, "Enter a valid GitHub repository URL");
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
    throw new HttpError(400, "Only HTTPS GitHub repository URLs are supported");
  }

  const pathname = url.pathname
    .replace(/\.git\/?$/i, "")
    .replace(/\/$/, "");

  const parts = pathname.split("/").filter(Boolean);

  if (parts.length !== 2) {
    throw new HttpError(
      400,
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
    throw new HttpError(400, "Invalid GitHub repository name");
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
    throw new HttpError(400, "Invalid GitHub branch or tag name");
  }

  return ref;
}

function validateCommit(value: string): string {
  if (!/^[a-f0-9]{40}$/i.test(value)) {
    throw new HttpError(502, "GitHub returned an invalid commit identifier");
  }

  return value;
}

function safeProviderPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(422, "Provider manifest has no filename");
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
    throw new HttpError(
      422,
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
    throw new HttpError(422, "Unsupported GitHub provider manifest format");
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
    throw new HttpError(502, "GitHub returned an empty response");
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
        throw new HttpError(502, errorMessage);
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
      if (attempt === GITHUB_MAX_ATTEMPTS) {
        throw new HttpError(
          502,
          "Could not reach GitHub. Please try again in a moment."
        );
      }

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
      throw new HttpError(502, "GitHub returned an unexpected redirect");
    }

    return response;
  }

  throw new HttpError(502, "GitHub request exhausted retry attempts");
}

/**
 * Time of the newest entry in a GitHub commit feed (feeds are newest-first),
 * or null when the feed has no entry or no usable timestamp.
 */
function parseAtomUpdated(atom: string): number | null {
  const entry = atom.match(/<entry[\s>][\s\S]*?<\/entry>/i)?.[0];
  const stamp = entry?.match(/<updated>\s*([^<\s]+)\s*<\/updated>/i)?.[1];
  const time = stamp ? Date.parse(stamp) : Number.NaN;

  return Number.isFinite(time) ? time : null;
}

async function fetchAtomCommit(
  repository: GitHubRepository,
  ref: string
): Promise<{ commit: string; updatedAt: number | null }> {
  const encodedRef = ref
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  const url =
    `${GITHUB_WEB}/${repository.owner}/${repository.repo}` +
    `/commits/${encodedRef}.atom`;

  const response = await githubFetch(url, "github.com");

  if (response.status === 404) {
    await response.body?.cancel();
    throw new HttpError(
      404,
      "Repository or branch not found. Check the URL and the branch or tag name."
    );
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(
      502,
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
      return {
        commit: validateCommit(match[1]),
        updatedAt: parseAtomUpdated(atom)
      };
    }
  }

  throw new HttpError(
    404,
    "Could not find a commit SHA in the GitHub commit feed. Check that the repository and branch exist."
  );
}

async function fetchJson(url: string): Promise<unknown> {
  const parsed = new URL(url);

  if (parsed.hostname !== "raw.githubusercontent.com") {
    throw new HttpError(
      400,
      "Blocked request to an unapproved GitHub host"
    );
  }

  const response = await githubFetch(
    url,
    "raw.githubusercontent.com"
  );

  if (response.status === 404) {
    await response.body?.cancel();
    throw new HttpError(
      404,
      "No manifest.json was found in this repository at the selected branch or tag."
    );
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(
      502,
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
    throw new HttpError(422, "The repository's manifest.json is not valid JSON");
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await githubFetch(
    url,
    "raw.githubusercontent.com"
  );

  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(
      502,
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
  const { commit, updatedAt } = await fetchAtomCommit(repository, ref);

  const manifestUrl =
    `${GITHUB_RAW}/${repository.owner}/${repository.repo}` +
    `/${commit}/manifest.json`;

  const manifest = await fetchJson(manifestUrl);

  return {
    ...repository,
    ref,
    commit,
    updatedAt,
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

// ---------- choosing between duplicate plugins ----------

/**
 * When the newest commit touching one file was made, from the file's own
 * commit feed. Null when it cannot be found: choosing a copy must never make
 * saving fail.
 */
async function fetchFileUpdatedAt(
  owner: string,
  repo: string,
  commit: string,
  filename: string
): Promise<number | null> {
  const path = safeProviderPath(filename)
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  try {
    const response = await githubFetch(
      `${GITHUB_WEB}/${owner}/${repo}/commits/${validateCommit(commit)}/${path}.atom`,
      "github.com"
    );

    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }

    return parseAtomUpdated(
      await readLimitedResponse(
        response,
        MAX_JSON_BYTES,
        "GitHub commit feed is larger than 2 MB"
      )
    );
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await task(items[index]!);
      }
    }
  );

  await Promise.all(workers);
  return results;
}

/**
 * Nuvio needs one plugin per ID. For every ID selected from more than one
 * source, keeps only the source whose provider file changed most recently
 * (ties and unknown dates go to the earlier source) and drops the ID from
 * the others, along with any source left with nothing selected.
 */
async function keepNewestCopies(
  sources: SavedSourceSelection[],
  sourceUpdatedAt: (number | null)[]
): Promise<{ sources: SavedSourceSelection[]; deduped: number }> {
  const selectedBy = new Map<string, number[]>();

  sources.forEach((source, index) => {
    for (const id of source.providerIds) {
      selectedBy.set(id, [...(selectedBy.get(id) ?? []), index]);
    }
  });

  const lookups = [...selectedBy]
    .filter(([, indexes]) => indexes.length > 1)
    .flatMap(([id, indexes]) =>
      indexes.map(index => ({ id, index }))
    );

  if (lookups.length === 0) return { sources, deduped: 0 };

  const times = await mapLimit(
    lookups,
    UPDATED_LOOKUP_CONCURRENCY,
    async ({ id, index }) => {
      const source = sources[index]!;
      const entry = source.providers?.find(provider => provider.id === id);
      const { owner, repo } = parseRepository(source.repository);

      const fileTime = entry
        ? await fetchFileUpdatedAt(owner, repo, source.commit, entry.filename)
        : null;

      // No feed for the file: fall back to the repository's latest commit.
      return fileTime ?? sourceUpdatedAt[index] ?? null;
    }
  );

  const winner = new Map<string, { index: number; time: number }>();

  lookups.forEach(({ id, index }, position) => {
    const time = times[position] ?? Number.NEGATIVE_INFINITY;
    const best = winner.get(id);

    // Lookups run in source order, so a strict > keeps the earlier source on ties.
    if (!best || time > best.time) winner.set(id, { index, time });
  });

  const keeps = (id: string, index: number) =>
    !winner.has(id) || winner.get(id)!.index === index;

  return {
    sources: sources
      .map((source, index): SavedSourceSelection => ({
        ...source,
        providerIds: source.providerIds.filter(id => keeps(id, index)),
        ...(source.providers
          ? { providers: source.providers.filter(entry => keeps(entry.id, index)) }
          : {})
      }))
      .filter(source => source.providerIds.length > 0),
    deduped: winner.size
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

  const byId = new Map<string, RemotePluginFile>();

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
      // Saving keeps one copy of each plugin ID (see keepNewestCopies). A
      // setup saved before that can still list an ID twice; the earlier
      // source wins, so serving never has to compare copies.
      if (byId.has(entry.id)) continue;

      byId.set(entry.id, {
        entry,
        owner,
        repo,
        commit,
        originalFilename: safeProviderPath(entry.filename),
        filename: ""
      });
    }
  }

  for (const [id, plugin] of byId) {
    const identity = `${plugin.owner}/${plugin.repo}/${plugin.commit}/${id}`;

    const suffix = createHash("sha256")
      .update(`${identity}/${middlewareFingerprint}`)
      .digest("hex")
      .slice(0, 10);

    plugin.filename =
      `providers/${plugin.owner}-${plugin.repo}-${safeIdSlug(id)}-${suffix}.js`;
    result.push(plugin);
  }

  return result;
}

export async function getPluginRepositoryManifest(
  userId: string,
  sources: SavedSourceSelection[],
  middlewareSettings: unknown,
  context: { appVersion: string; origin: string }
) {
  const plugins = await getRemotePluginFiles(sources, middlewareSettings);

  return buildNuvioManifest({
    userId,
    appVersion: context.appVersion,
    origin: context.origin,
    middlewareVersion: STREAM_MIDDLEWARE_VERSION,
    plugins: plugins.map(({ entry, filename, owner, repo, commit }) => ({
      entry: entry as Record<string, unknown>,
      filename,
      owner,
      repo,
      commit
    }))
  });
}

/** True when the file belongs to this selection. Never contacts GitHub. */
export async function hasRemotePluginFile(
  sources: SavedSourceSelection[],
  filename: string,
  middlewareSettings: unknown
): Promise<boolean> {
  const plugins = await getRemotePluginFiles(sources, middlewareSettings);
  return plugins.some(entry => entry.filename === filename);
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

  const code = await fetchText(
    `${GITHUB_RAW}/${plugin.owner}/${plugin.repo}/${plugin.commit}/${urlPath}`
  );

  return wrapPluginStreams(
    code,
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
  /** Plugin IDs selected from several sources, reduced to the newest copy. */
  deduped: number;
}> {
  if (!Array.isArray(value)) {
    throw new HttpError(400, "Selections must be a list");
  }

  const selections = value
    .map((item): SourceSelection => {
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item)
      ) {
        throw new HttpError(400, "Invalid source selection");
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
        throw new HttpError(
          400,
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

  // Sources are independent, so resolve them concurrently.
  const resolved = await Promise.all(
    selections.map(async (selection) => {
      const source = await loadSource(
        selection.repository,
        selection.ref
      );

      if (
        selection.commit &&
        selection.commit !== source.commit
      ) {
        throw new HttpError(
          409,
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
        throw new HttpError(
          409,
          `One or more selected plugins are no longer available in ${source.url}. Refresh the source and review your selection.`
        );
      }

      const providers: SelectedProviderEntry[] = selectedEntries.map(entry => {
        if (entry.enabled === false) {
          throw new HttpError(
            400,
            `Provider "${String(entry.id)}" is disabled in its manifest`
          );
        }

        return {
          ...entry,
          id: entry.id,
          filename: safeProviderPath(entry.filename)
        };
      });

      const saved: SavedSourceSelection = {
        ...selection,
        repository: source.url,
        commit: source.commit,
        providers
      };

      return { saved, updatedAt: source.updatedAt };
    })
  );

  // Nuvio lists one plugin per ID, so keep only the most recently updated
  // copy of any plugin selected from more than one source. Doing this once
  // here means nothing has to scan the duplicates when the plugin is served.
  const { sources: saved, deduped } = await keepNewestCopies(
    resolved.map(item => item.saved),
    resolved.map(item => item.updatedAt)
  );

  return {
    sources: saved,
    plugins: saved.reduce((total, source) => total + source.providerIds.length, 0),
    deduped
  };
}
