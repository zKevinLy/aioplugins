// Speed checks: how long does a provider take to answer, and is it up?
//
// Nothing is installed or saved. The plugin file is downloaded through the
// server (so it comes from the exact reviewed commit), then run once in the
// browser sandbox with a well-known title.

import { api } from "../core/api.js";
import { errorMessage } from "../core/guards.js";
import type { LoadedSource, ProviderCheck, ProviderSummary } from "../core/types.js";
import { getCheck, setCheck } from "../state/health.js";
import { isSelectable, sourceKey } from "../state/sources.js";
import { runInSandbox, type SandboxResult } from "./sandbox.js";

const TIMEOUT_MS = 20_000;
const MAX_CONCURRENT = 3;

// Fight Club for movie providers, Breaking Bad S01E01 for TV-only ones.
const MOVIE_ARGS: unknown[] = ["550", "movie"];
const TV_ARGS: unknown[] = ["1396", "tv", 1, 1];

export interface CheckTarget {
  source: LoadedSource;
  provider: ProviderSummary;
}

export function toCheck(result: SandboxResult, commit: string): ProviderCheck {
  if (result.ok) {
    return {
      state: result.count > 0 ? "up" : "empty",
      commit,
      ms: result.ms,
      streams: result.count
    };
  }

  const state =
    result.kind === "timeout" ? "timeout" :
    result.kind === "network" ? "blocked" :
    "down";

  return {
    state,
    commit,
    message: result.message,
    ...(result.ms === undefined ? {} : { ms: result.ms })
  };
}

async function checkOne({ source, provider }: CheckTarget): Promise<void> {
  const key = sourceKey(source);
  const { commit } = source;

  setCheck(key, provider.id, { state: "checking", commit });

  try {
    const query = new URLSearchParams({
      repository: source.repository,
      commit,
      id: provider.id
    });
    const { source: code } = await api<{ source: string }>(`/api/provider-source?${query}`);

    const args = provider.types.includes("movie") ? MOVIE_ARGS : TV_ARGS;
    const result = await runInSandbox(code, args, TIMEOUT_MS);

    setCheck(key, provider.id, toCheck(result, commit));
  } catch (error) {
    setCheck(key, provider.id, {
      state: "down",
      commit,
      message: `Could not download the plugin file: ${errorMessage(error)}`
    });
  }
}

const queue: CheckTarget[] = [];
let running = 0;

function pump(): void {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const target = queue.shift();
    if (!target) return;

    running++;
    void checkOne(target).finally(() => {
      running--;
      pump();
    });
  }
}

/** Queues speed checks; providers already being checked are skipped. */
export function checkProviders(targets: CheckTarget[]): void {
  for (const target of targets) {
    if (!isSelectable(target.provider)) continue;

    const key = sourceKey(target.source);
    const current = getCheck(key, target.provider.id, target.source.commit);
    const queued = queue.some(
      (item) => sourceKey(item.source) === key && item.provider.id === target.provider.id
    );

    if (current?.state === "checking" || queued) continue;

    // Show "Testing…" immediately, even while waiting for a free slot.
    setCheck(key, target.provider.id, { state: "checking", commit: target.source.commit });
    queue.push(target);
  }

  pump();
}
