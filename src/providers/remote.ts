import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

interface SourceSelection {
  repository: string;
  ref: string;
  providerIds: string[];
  commit?: string;
}

interface SavedSourceSelection extends SourceSelection {
  commit: string;
}

export interface PluginProfile {
  id: string;
  name: string;
  linkToken?: string;
}

interface StoredPluginProfile extends PluginProfile {
  passwordSalt?: string;
  passwordHash?: string;
  encryptedPasswordToken?: string;
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

function githubApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "user-agent": "aioplugins-local" };
  const token = process.env.AIOPLUGINS_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function describeGithubError(kind: string, response: Response, body: string): string {
  let detail = body.trim() || response.statusText || "no details";
  try {
    const parsed = JSON.parse(detail) as { message?: unknown; error?: unknown };
    if (typeof parsed.message === "string") detail = parsed.message;
    else if (typeof parsed.error === "string") detail = parsed.error;
  } catch {
    // keep the raw body as-is
  }
  if (detail.length > 300) detail = `${detail.slice(0, 300)}…`;
  const used = response.headers.get("x-ratelimit-used");
  const limit = response.headers.get("x-ratelimit-limit");
  const reset = response.headers.get("x-ratelimit-reset");
  let suffix = "";
  if (limit) {
    const when = reset ? `, resets ${new Date(Number(reset) * 1000).toISOString()}` : "";
    suffix = ` [rate limit ${used ?? "?"}/${limit}${when}]`;
  }
  return `${kind} failed (${response.status}): ${detail}${suffix}`;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: githubApiHeaders() });
  if (!response.ok) {
    throw new Error(describeGithubError("GitHub request", response, await response.text()));
  }
  return response.json();
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: githubApiHeaders() });
  if (!response.ok) {
    throw new Error(describeGithubError("GitHub file request", response, await response.text()));
  }
  const source = await response.text();
  if (Buffer.byteLength(source, "utf8") > MAX_PROVIDER_BYTES) throw new Error("Provider file is larger than 8 MB");
  return source;
}

interface DiscoveryCacheEntry {
  commit: string;
  manifest: unknown;
  fetchedAt: number;
}

// In-production pages re-inspect every saved source on load. Caching the
// discovered commit + manifest (10 minutes) keeps those restores off the
// GitHub API, which is strictly rate-limited on shared hosts like Render.
// `applyRemoteSelections` deliberately bypasses the cache so the
// "source changed after discovery" integrity check still gets fresh data.
const DISCOVERY_CACHE_TTL_MS = 10 * 60 * 1000;

function discoveryCacheFile(storageRoot: string): string {
  return resolve(storageRoot, ".aioplugins-discovery-cache.json");
}

function readDiscoveryCache(storageRoot: string): Record<string, DiscoveryCacheEntry> {
  try {
    const parsed = JSON.parse(readFileSync(discoveryCacheFile(storageRoot), "utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, DiscoveryCacheEntry> : {};
  } catch {
    return {};
  }
}

function writeDiscoveryCache(storageRoot: string, entries: Record<string, DiscoveryCacheEntry>): void {
  writeFileSync(discoveryCacheFile(storageRoot), JSON.stringify(entries, null, 2));
}

async function loadSource(repositoryValue: string, refValue = "main", storageRoot?: string) {
  const repository = parseRepository(repositoryValue);
  const ref = refValue.trim() || "main";
  const cacheKey = `${repository.url}@${ref}`;
  const cached = storageRoot ? readDiscoveryCache(storageRoot)[cacheKey] : undefined;
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_CACHE_TTL_MS) {
    return {
      ...repository,
      ref,
      commit: cached.commit,
      manifest: cached.manifest,
      entries: manifestEntries(cached.manifest)
    };
  }
  const commitData = await fetchJson(`https://api.github.com/repos/${repository.owner}/${repository.repo}/commits/${encodeURIComponent(ref)}`);
  if (!commitData || typeof commitData !== "object" || typeof (commitData as { sha?: unknown }).sha !== "string") {
    throw new Error("GitHub did not return a commit for this ref");
  }
  const commit = (commitData as { sha: string }).sha;
  const manifestUrl = `https://raw.githubusercontent.com/${repository.owner}/${repository.repo}/${commit}/manifest.json`;
  const manifest = await fetchJson(manifestUrl);
  if (storageRoot) {
    const entries = readDiscoveryCache(storageRoot);
    entries[cacheKey] = { commit, manifest, fetchedAt: Date.now() };
    writeDiscoveryCache(storageRoot, entries);
  }
  return { ...repository, ref, commit, manifest, entries: manifestEntries(manifest) };
}

export async function inspectGitHubSource(repository: string, ref = "main", storageRoot = process.cwd()) {
  const source = await loadSource(repository, ref, storageRoot);
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
  return resolve(storageRoot, ".nuvio-cache");
}

function legacySelectionFile(storageRoot: string): string {
  return resolve(storageRoot, ".nuvio-provider-selection.json");
}

function profilesFile(storageRoot: string): string {
  return resolve(storageRoot, ".aioplugins-profiles.json");
}

function profileSecretFile(storageRoot: string): string {
  return resolve(storageRoot, ".aioplugins-secret");
}

function getProfileSecret(storageRoot: string): Buffer {
  try {
    const secret = readFileSync(profileSecretFile(storageRoot));
    if (secret.length !== 32) throw new Error("Invalid AIOPlugins profile secret");
    return secret;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") throw error;
    const secret = randomBytes(32);
    writeFileSync(profileSecretFile(storageRoot), secret, { mode: 0o600, flag: "wx" });
    return secret;
  }
}

function encryptProfilePassword(password: string, storageRoot: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getProfileSecret(storageRoot), iv);
  const ciphertext = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

function decryptProfilePassword(token: string, storageRoot: string): string | null {
  try {
    const [ivPart, tagPart, ciphertextPart] = token.split(".");
    if (!ivPart || !tagPart || !ciphertextPart) return null;
    const decipher = createDecipheriv("aes-256-gcm", getProfileSecret(storageRoot), Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, "base64url")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    return null;
  }
}

function profileSelectionFile(storageRoot: string, profileId: string): string {
  if (!/^[a-z0-9-]{1,64}$/.test(profileId)) throw new Error("Invalid profile ID");
  return resolve(storageRoot, `.aioplugins-profile-${profileId}.json`);
}

function readProfiles(storageRoot: string): StoredPluginProfile[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(profilesFile(storageRoot), "utf8"));
    const profiles = Array.isArray(parsed)
      ? parsed.filter((profile): profile is StoredPluginProfile => Boolean(
          profile && typeof profile === "object" &&
          typeof profile.id === "string" && /^[a-z0-9-]{1,64}$/.test(profile.id) &&
          typeof profile.name === "string" && profile.name.trim() &&
          (profile.id === "default" || (
            typeof profile.passwordSalt === "string" &&
            typeof profile.passwordHash === "string" &&
            typeof profile.encryptedPasswordToken === "string"
          ))
        ))
      : [];
    return profiles;
  } catch {
    return [];
  }
}

export function getPluginProfiles(storageRoot = process.cwd()): PluginProfile[] {
  return readProfiles(storageRoot).map(({ id, name, encryptedPasswordToken }) => ({
    id,
    name,
    ...(encryptedPasswordToken ? { linkToken: encryptedPasswordToken } : {})
  }));
}

function verifyProfilePassword(profile: StoredPluginProfile, password: string): boolean {
  if (!profile.passwordSalt || !profile.passwordHash || !password) return false;
  const expected = Buffer.from(profile.passwordHash, "hex");
  const actual = scryptSync(password, profile.passwordSalt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function verifyPluginProfilePassword(profileId: string, password: string, storageRoot = process.cwd()): boolean {
  const profile = readProfiles(storageRoot).find(({ id }) => id === profileId);
  return profile ? verifyProfilePassword(profile, password) : false;
}

export function resolveProfileLinkPassword(profileId: string, token: string, storageRoot = process.cwd()): string | null {
  const profile = readProfiles(storageRoot).find(({ id }) => id === profileId);
  if (!profile) return null;
  const password = decryptProfilePassword(token, storageRoot);
  return password && verifyProfilePassword(profile, password) ? password : null;
}

export function createPluginProfile(name: string, password: string, storageRoot = process.cwd()): PluginProfile[] {
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 40) throw new Error("Profile name must be between 1 and 40 characters");
  if (password.length < 8) throw new Error("Profile password must be at least 8 characters");
  const profiles = readProfiles(storageRoot);
  const passwordSalt = randomBytes(16).toString("hex");
  const profile: StoredPluginProfile = {
    id: randomUUID(),
    name: normalizedName,
    passwordSalt,
    passwordHash: scryptSync(password, passwordSalt, 64).toString("hex"),
    encryptedPasswordToken: encryptProfilePassword(password, storageRoot)
  };
  if (profiles.length === 0) {
    try {
      const legacySelection = readFileSync(legacySelectionFile(storageRoot), "utf8");
      writeFileSync(profileSelectionFile(storageRoot, profile.id), legacySelection);
    } catch {
      // New profiles have no pre-existing selection to migrate.
    }
  }
  const destination = profilesFile(storageRoot);
  const temporaryFile = `${destination}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify([...profiles, profile], null, 2));
  renameSync(temporaryFile, destination);
  return [...profiles, profile].map(({ id, name, encryptedPasswordToken }) => ({
    id,
    name,
    ...(encryptedPasswordToken ? { linkToken: encryptedPasswordToken } : {})
  }));
}

export function deletePluginProfile(profileId: string, password: string, storageRoot = process.cwd()): PluginProfile[] {
  const profiles = readProfiles(storageRoot);
  const profile = profiles.find(({ id }) => id === profileId);
  if (!profile) throw new Error("Profile not found");
  if (!verifyProfilePassword(profile, password)) throw new Error("Incorrect profile password");
  const remaining = profiles.filter(({ id }) => id !== profileId);
  const destination = profilesFile(storageRoot);
  const temporaryFile = `${destination}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify(remaining, null, 2));
  renameSync(temporaryFile, destination);
  rmSync(profileSelectionFile(storageRoot, profileId), { force: true });
  return remaining.map(({ id, name, encryptedPasswordToken }) => ({
    id,
    name,
    ...(encryptedPasswordToken ? { linkToken: encryptedPasswordToken } : {})
  }));
}

function readSavedSelections(storageRoot: string, profileId: string): SavedSourceSelection[] {
  const profilePath = profileSelectionFile(storageRoot, profileId);
  if (!readProfiles(storageRoot).some(({ id }) => id === profileId)) throw new Error("Profile not found");
  try {
    const value: unknown = JSON.parse(readFileSync(profilePath, "utf8"));
    return Array.isArray(value) ? value as SavedSourceSelection[] : [];
  } catch {
    return [];
  }
}

export function getSavedSelections(storageRoot = process.cwd(), profileId: string): SourceSelection[] {
  return readSavedSelections(storageRoot, profileId).map(({ repository, ref, providerIds }) => ({ repository, ref, providerIds }));
}

function safeIdSlug(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
}

function getCachedPluginFiles(storageRoot: string, profileId: string): CachedPluginFile[] {
  return readSavedSelections(storageRoot, profileId).flatMap((selection) => {
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

export function getPluginRepositoryManifest(storageRoot = process.cwd(), profileId: string, password: string) {
  const profile = readProfiles(storageRoot).find(({ id }) => id === profileId);
  if (!profile) throw new Error("Profile not found");
  if (!verifyProfilePassword(profile, password)) throw new Error("Incorrect profile password");
  const scrapers = getCachedPluginFiles(storageRoot, profileId).map(({ entry, filename }) => ({
    ...entry,
    enabled: true,
    filename
  }));
  return {
    name: `AIOPlugins - ${profile.name}`,
    version: "1.0.0",
    scrapers
  };
}

export function getCachedPluginFile(filename: string, storageRoot = process.cwd(), profileId: string, password: string): string | null {
  if (!verifyPluginProfilePassword(profileId, password, storageRoot)) throw new Error("Incorrect profile password");
  const plugin = getCachedPluginFiles(storageRoot, profileId).find((entry) => entry.filename === filename);
  return plugin ? readFileSync(plugin.path, "utf8") : null;
}

export async function applyRemoteSelections(
  value: unknown,
  storageRoot = process.cwd(),
  profileId: string,
  password: string
): Promise<number> {
  const profile = readProfiles(storageRoot).find(({ id }) => id === profileId);
  if (!profile) throw new Error("Profile not found");
  if (!verifyProfilePassword(profile, password)) throw new Error("Incorrect profile password");
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

  const saved: SavedSourceSelection[] = [];
  const providerIds = new Set<string>();
  let providerCount = 0;

  for (const selection of selections) {
    for (const id of selection.providerIds) {
      if (providerIds.has(id)) throw new Error(`Provider ID "${id}" is already registered or selected more than once`);
      providerIds.add(id);
    }

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
    providerCount += selectedEntries.length;
  }

  const destination = profileSelectionFile(storageRoot, profileId);
  const temporaryFile = `${destination}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify(saved, null, 2));
  renameSync(temporaryFile, destination);
  return providerCount;
}
