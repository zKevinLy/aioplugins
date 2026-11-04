import { api, withTransientRetry } from "../core/api.js";
import type { ProfilesResponse, SavedProfile } from "../core/types.js";
import { pruneSelection, sourceKey, sourceStore } from "../state/sources.js";
import { profilesStore } from "../state/workspace.js";
import { refreshManifest } from "./manifest.js";
import { loadSources } from "./sources.js";

export async function reloadProfiles(): Promise<void> {
  const { profiles } = await withTransientRetry(() => api<ProfilesResponse>("/api/profiles"));
  profilesStore.set(profiles);
}

/** Saves the current selection under `name`, replacing a profile of that name. */
export async function saveProfile(name: string): Promise<void> {
  const sources = sourceStore.toPayload();

  if (sources.length === 0) {
    throw new Error("Select at least one plugin before saving a profile.");
  }

  const existing = profilesStore
    .get()
    .find((profile) => profile.name.trim().toLowerCase() === name.toLowerCase());

  await api("/api/profiles", {
    ...(existing ? { id: existing.id } : {}),
    name,
    sources
  });

  await reloadProfiles();

  // Saving a profile also makes it the live setup on the server.
  await refreshManifest().catch(() => undefined);
}

export async function deleteProfile(id: string): Promise<void> {
  await api(`/api/profiles/${encodeURIComponent(id)}`, undefined, "DELETE");
  await reloadProfiles();
}

/** Replaces the loaded sources with a profile's; returns what failed to load. */
export async function applyProfile(profile: SavedProfile): Promise<string[]> {
  const { loaded, failures } = await loadSources(profile.sources);

  sourceStore.setOrder(profile.sources.map(sourceKey));
  sourceStore.replaceAll(
    loaded.map(({ source, request }) => ({
      ...source,
      selected: pruneSelection(source, request.providerIds ?? [])
    }))
  );

  return failures;
}
