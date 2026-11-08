// Builds a manifest that Nuvio's strict (Moshi) parser always accepts.
//
// Nuvio reads `manifest.json` into typed Kotlin classes. A single field of the
// wrong type (for example a numeric `version`, or `"supportedTypes": null`) makes
// Nuvio reject the whole repository, so every scraper entry is coerced to the
// exact shapes Nuvio expects. Unknown upstream keys are kept untouched because
// Nuvio ignores them and other consumers may use them.

import { APP_HOMEPAGE, APP_NAME, DEV_VERSION, versionLabel } from "../lib/app-info.js";

export interface ManifestPluginInput {
  entry: Record<string, unknown>;
  /** Path served by AIOPlugins, relative to the manifest. */
  filename: string;
  owner: string;
  repo: string;
  commit: string;
}

export interface NuvioManifestOptions {
  userId: string;
  appVersion: string;
  /** Origin the manifest is served from; used for absolute asset URLs. */
  origin: string;
  middlewareVersion: string;
  plugins: ManifestPluginInput[];
}

export const DEFAULT_SUPPORTED_TYPES = ["movie", "tv"];
export const FALLBACK_LOGO_PATH = "/favicon-192.png";

const GITHUB_RAW = "https://raw.githubusercontent.com";
const KNOWN_KEYS = [
  "id", "name", "description", "version", "filename", "supportedTypes", "enabled", "logo",
  "contentLanguage", "supportedPlatforms", "disabledPlatforms", "formats", "supportedFormats",
  "supportsExternalPlayer", "limited"
];
const STRING_LIST_KEYS = [
  "contentLanguage", "supportedPlatforms", "disabledPlatforms", "formats", "supportedFormats"
];
const BOOLEAN_KEYS = ["supportsExternalPlayer", "limited"];

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = [...new Set(
    value.map(item => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
  )];
  return items.length > 0 ? items : undefined;
}

/** Appends AIOPlugins build metadata: "1.2.0" -> "1.2.0+aio.0.4.0". */
export function pluginVersion(upstream: unknown, appVersion: string): string {
  const base = text(upstream) ?? "1.0.0";
  const marker = `aio.${appVersion}`;
  return base.includes("+") ? `${base}.${marker}` : `${base}+${marker}`;
}

function safeRelativePath(path: string): string | null {
  const segments = path.replace(/\\/g, "/").replace(/^\.\//, "").split("/");
  if (
    path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\0") ||
    segments.some(segment => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return segments.map(encodeURIComponent).join("/");
}

/**
 * Nuvio loads the logo by URL, so it has to be absolute. Relative logos in an
 * upstream manifest point into that repository at the pinned commit; anything
 * unusable falls back to the AIOPlugins icon.
 */
export function resolveLogo(
  value: unknown,
  source: { owner: string; repo: string; commit: string },
  origin: string
): string {
  const fallback = new URL(FALLBACK_LOGO_PATH, origin).toString();
  const logo = text(value);
  if (!logo) return fallback;

  if (/^https?:\/\//i.test(logo)) {
    try {
      return new URL(logo).toString();
    } catch {
      return fallback;
    }
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(logo) || logo.startsWith("//")) return fallback;

  const path = safeRelativePath(logo);
  return path
    ? `${GITHUB_RAW}/${source.owner}/${source.repo}/${source.commit}/${path}`
    : fallback;
}

export function sanitizeScraper(
  plugin: ManifestPluginInput,
  appVersion: string,
  origin: string,
  middlewareVersion: string
): Record<string, unknown> {
  const { entry } = plugin;
  const id = text(entry.id) ?? "plugin";

  // Keep unknown upstream metadata, drop everything Nuvio types so it is rebuilt below.
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!KNOWN_KEYS.includes(key) && value !== undefined) result[key] = value;
  }

  result.id = id;
  result.name = text(entry.name) ?? id;

  const description = text(entry.description);
  if (description) result.description = description;

  result.version = pluginVersion(entry.version, appVersion);
  result.filename = plugin.filename;
  result.supportedTypes = stringList(entry.supportedTypes) ?? DEFAULT_SUPPORTED_TYPES;
  result.enabled = true;
  result.logo = resolveLogo(entry.logo, plugin, origin);

  for (const key of STRING_LIST_KEYS) {
    const list = stringList(entry[key]);
    if (list) result[key] = list;
  }

  for (const key of BOOLEAN_KEYS) {
    if (typeof entry[key] === "boolean") result[key] = entry[key];
  }

  result.aioplugins = {
    version: appVersion,
    middleware: middlewareVersion,
    source: `${plugin.owner}/${plugin.repo}`,
    commit: plugin.commit,
    upstreamVersion: text(entry.version) ?? null
  };

  return result;
}

export function buildNuvioManifest(options: NuvioManifestOptions) {
  const { appVersion, origin, middlewareVersion, plugins } = options;
  const label = versionLabel(appVersion);
  const sources = new Set(plugins.map(plugin => `${plugin.owner}/${plugin.repo}`)).size;
  const count = plugins.length;

  return {
    name: APP_NAME,
    version: appVersion === DEV_VERSION ? "0.0.0-dev" : appVersion,
    description:
      `Personal Nuvio plugin repository generated by ${APP_NAME} ${label}: ` +
      `${count} plugin${count === 1 ? "" : "s"} from ${sources} source${sources === 1 ? "" : "s"}.`,
    author: APP_NAME,
    logo: new URL(FALLBACK_LOGO_PATH, origin).toString(),
    homepage: APP_HOMEPAGE,
    scrapers: plugins.map(plugin => sanitizeScraper(plugin, appVersion, origin, middlewareVersion))
  };
}
