import { isRecord } from "../core/guards.js";
import { userStore } from "../state/session.js";
import { manifestStore } from "../state/setup.js";

/** Loads the user's generated Nuvio manifest (the install link's content). */
export async function refreshManifest(): Promise<void> {
  const user = userStore.get();
  if (!user) return;

  const response = await fetch(user.installPath, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Could not load the Nuvio manifest preview");
  }

  const data: unknown = await response.json();
  const manifest = isRecord(data) ? data : {};

  // The user may have signed out while the request was in flight.
  if (userStore.get()?.id !== user.id) return;

  manifestStore.set({
    text: JSON.stringify(manifest, null, 2),
    pluginCount: Array.isArray(manifest.scrapers) ? manifest.scrapers.length : 0
  });
}
