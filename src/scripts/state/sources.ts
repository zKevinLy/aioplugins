// The plugin sources loaded in the UI and which providers are ticked.

import { createStore } from "../core/store.js";
import type { DiscoveredSource, LoadedSource, ProviderSummary, SavedSource } from "../core/types.js";

export function sourceKey(source: { repository: string; ref: string }): string {
  return `${source.repository}@${source.ref}`;
}

/** Only enabled providers that support a media type can be installed. */
export function isSelectable(provider: ProviderSummary): boolean {
  return provider.enabled && provider.types.length > 0;
}

/** Drops IDs that vanished from the source or can no longer be installed. */
export function pruneSelection(
  source: DiscoveredSource,
  ids: Iterable<string>
): Set<string> {
  const selectable = new Set(
    source.providers.filter(isSelectable).map((provider) => provider.id)
  );

  return new Set([...ids].filter((id) => selectable.has(id)));
}

const sources = new Map<string, LoadedSource>();

/** Display order; sources not listed keep insertion order after these. */
let order: string[] = [];

/** Bumped on every change; subscribe to re-render. */
const revision = createStore(0);

/** True while sources are being fetched after sign-in. */
export const sourcesLoading = createStore(false);

function sortedEntries(): [string, LoadedSource][] {
  const rank = (key: string): number => {
    const index = order.indexOf(key);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };

  return [...sources.entries()].sort(([a], [b]) => rank(a) - rank(b));
}

function changed(): void {
  revision.update((value) => value + 1);
}

export const sourceStore = {
  subscribe: revision.subscribe,

  list(): LoadedSource[] {
    return sortedEntries().map(([, source]) => source);
  },

  entries(): [string, LoadedSource][] {
    return sortedEntries();
  },

  /**
   * Fixes the display order. Sources load concurrently and arrive in any
   * order; this keeps the list stable while they appear.
   */
  setOrder(keys: string[]): void {
    order = keys;
    changed();
  },

  get size(): number {
    return sources.size;
  },

  /**
   * Adds or refreshes a source. A refresh keeps the user's ticks (minus any
   * that are no longer valid) unless `selectedIds` says otherwise.
   */
  upsert(source: DiscoveredSource, selectedIds?: Iterable<string>): LoadedSource {
    const key = sourceKey(source);
    const kept = selectedIds ?? sources.get(key)?.selected ?? [];
    const loaded: LoadedSource = { ...source, selected: pruneSelection(source, kept) };

    sources.set(key, loaded);
    changed();
    return loaded;
  },

  replaceAll(entries: LoadedSource[]): void {
    sources.clear();
    for (const entry of entries) sources.set(sourceKey(entry), entry);
    changed();
  },

  remove(key: string): void {
    if (sources.delete(key)) changed();
  },

  clear(): void {
    order = [];
    if (sources.size === 0) return;
    sources.clear();
    changed();
  },

  /**
   * Ticks or unticks one provider in one source. The same provider ID may be
   * ticked in several sources: the server serves it as one plugin that runs
   * every selected source's copy and drops streams that are identical.
   */
  setSelected(source: LoadedSource, providerId: string, checked: boolean): void {
    if (checked) source.selected.add(providerId);
    else source.selected.delete(providerId);
    changed();
  },

  /** Ticks or unticks many providers with a single re-render. */
  setManySelected(
    targets: { source: LoadedSource; providerId: string }[],
    checked: boolean
  ): void {
    for (const { source, providerId } of targets) {
      if (checked) source.selected.add(providerId);
      else source.selected.delete(providerId);
    }
    changed();
  },

  /**
   * Distinct plugin IDs ticked across all sources. This is what Nuvio lists:
   * an ID ticked in two sources is one plugin.
   */
  selectionCount(): number {
    const ids = new Set<string>();
    for (const source of sources.values()) {
      for (const id of source.selected) ids.add(id);
    }
    return ids.size;
  },

  /** How many plugin IDs are ticked in more than one source. */
  combinedCount(): number {
    const counts = new Map<string, number>();
    for (const source of sources.values()) {
      for (const id of source.selected) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts.values()].filter((count) => count > 1).length;
  },

  /** The selection in the shape the server expects (sources with ticks only). */
  toPayload(): SavedSource[] {
    return sortedEntries()
      .map(([, source]) => ({
        repository: source.repository,
        ref: source.ref,
        commit: source.commit,
        providerIds: [...source.selected]
      }))
      .filter((source) => source.providerIds.length > 0);
  }
};
