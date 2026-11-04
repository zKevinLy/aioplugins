import { api } from "../core/api.js";
import { parseProfileBackup } from "../core/guards.js";
import type { ConfigResponse, ProfileBackup } from "../core/types.js";
import { toMiddlewareSettings, middlewareStore } from "../state/middleware.js";
import { userStore } from "../state/session.js";
import { pruneSelection, sourceKey, sourceStore } from "../state/sources.js";
import { refreshManifest } from "./manifest.js";
import { loadSources } from "./sources.js";

/** Downloads the saved configuration as a JSON file. */
export async function exportBackup(): Promise<void> {
  const user = userStore.get();
  if (!user) throw new Error("Log in to export your configuration.");

  const saved = await api<ConfigResponse>("/api/config");

  const backup: ProfileBackup = {
    format: "aioplugins-profile",
    version: 1,
    sources: saved.sources,
    middleware: saved.middleware
  };

  const blobUrl = URL.createObjectURL(
    new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" })
  );

  try {
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = `aioplugins-${user.id.slice(0, 8)}.json`;
    link.click();
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/** Restores a backup file; returns the sources that could not be loaded. */
export async function importBackup(file: File): Promise<string[]> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("This file is not a valid AIOPlugins backup.");
  }

  const backup = parseProfileBackup(parsed);

  // Saving first verifies every provider; nothing changes on the page if it fails.
  await api("/api/apply", { sources: backup.sources, middleware: backup.middleware });

  middlewareStore.set(toMiddlewareSettings(backup.middleware));

  const { loaded, failures } = await loadSources(backup.sources);

  sourceStore.setOrder(backup.sources.map(sourceKey));
  sourceStore.replaceAll(
    loaded.map(({ source, request }) => ({
      ...source,
      selected: pruneSelection(source, request.providerIds ?? [])
    }))
  );

  await refreshManifest().catch(() => undefined);

  return failures;
}
