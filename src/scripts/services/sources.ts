// Discovering plugin sources (a GitHub repo + ref → its providers).
//
// Discovery results are memoised, including requests still in flight, so a
// source asked for by several callers (suggested list, saved selection,
// profile switch, backup import) is fetched once.

import { api, withTransientRetry } from "../core/api.js";
import { $$ } from "../core/dom.js";
import { errorMessage } from "../core/guards.js";
import type { DiscoveredSource } from "../core/types.js";
import { sourceKey, sourceStore } from "../state/sources.js";

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  at: number;
  promise: Promise<DiscoveredSource>;
}

const cache = new Map<string, CacheEntry>();

export interface SourceRequest {
  repository: string;
  ref: string;
  providerIds?: readonly string[];
}

interface LoadedEntry {
  source: DiscoveredSource;
  request: SourceRequest;
}

export function clearDiscoveryCache(): void {
  cache.clear();
}

/**
 * Resolves a source to its latest commit and providers.
 * `force` bypasses the cache (use it for explicit user actions).
 */
export function discoverSource(
  repository: string,
  ref: string,
  { force = false }: { force?: boolean } = {}
): Promise<DiscoveredSource> {
  const key = sourceKey({ repository: repository.trim(), ref });
  const cached = cache.get(key);

  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.promise;
  }

  const entry: CacheEntry = {
    at: Date.now(),
    promise: withTransientRetry(() =>
      api<DiscoveredSource>("/api/discover", { repository, ref })
    )
  };

  cache.set(key, entry);

  entry.promise.then(
    (source) => {
      // The server canonicalises the URL; make that spelling hit the cache too.
      if (cache.get(key) === entry) cache.set(sourceKey(source), entry);
    },
    () => {
      if (cache.get(key) === entry) cache.delete(key);
    }
  );

  return entry.promise;
}

function repositoryName(repository: string): string {
  return repository.split("/").filter(Boolean).slice(-1)[0] ?? repository;
}

interface LoadSourcesResult {
  /** Successfully loaded sources, in the order they were requested. */
  loaded: LoadedEntry[];
  /** Human-readable reasons for the sources that failed. */
  failures: string[];
}

/**
 * Loads every requested source concurrently. `onSource` fires as soon as each
 * one arrives, so the UI can fill in progressively instead of waiting for the
 * slowest source.
 */
export async function loadSources(
  requests: SourceRequest[],
  options: {
    force?: boolean;
    onSource?: (entry: LoadedEntry) => void;
  } = {}
): Promise<LoadSourcesResult> {
  const results = await Promise.all(
    requests.map(async (request) => {
      try {
        const source = await discoverSource(request.repository, request.ref, {
          force: options.force === true
        });
        const entry: LoadedEntry = { source, request };
        options.onSource?.(entry);
        return { entry };
      } catch (error) {
        return { failure: `${repositoryName(request.repository)}: ${errorMessage(error)}` };
      }
    })
  );

  return {
    loaded: results.flatMap((result) => (result.entry ? [result.entry] : [])),
    failures: results.flatMap((result) => (result.failure ? [result.failure] : []))
  };
}

/** Re-fetches every loaded source, keeping the user's selection. */
export async function refreshSources(): Promise<LoadSourcesResult> {
  const requests = sourceStore.list().map((source) => ({
    repository: source.repository,
    ref: source.ref,
    providerIds: [...source.selected]
  }));

  return loadSources(requests, {
    force: true,
    onSource: ({ source, request }) => sourceStore.upsert(source, request.providerIds)
  });
}

/** The sources offered as one-click buttons in the page markup. */
export function suggestedSources(): SourceRequest[] {
  return $$<HTMLElement>(".quick-source").flatMap((button) =>
    button.dataset.repo ? [{ repository: button.dataset.repo, ref: "main" }] : []
  );
}
