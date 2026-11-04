// Saving the current selection and middleware settings.

import { ApiError, api } from "../core/api.js";
import type { ApplyResponse } from "../core/types.js";
import { middlewarePayload } from "../state/middleware.js";
import { savingStore } from "../state/setup.js";
import { sourceStore } from "../state/sources.js";
import { refreshManifest } from "./manifest.js";
import { refreshSources } from "./sources.js";

/**
 * Verifies the selected providers against GitHub and saves the setup.
 * Returns null when there is nothing to do (already saving, or no selection).
 */
export async function saveSetup(): Promise<ApplyResponse | null> {
  if (savingStore.get() || sourceStore.selectionCount() === 0) return null;

  savingStore.set(true);

  try {
    const result = await api<ApplyResponse>("/api/apply", {
      sources: sourceStore.toPayload(),
      middleware: middlewarePayload()
    });

    // The setup is saved; a preview failure must not make it look unsaved.
    await refreshManifest().catch(() => undefined);

    return result;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      // A source moved on since it was loaded. Show the user the new state.
      await refreshSources().catch(() => undefined);
      throw new Error(`${error.message} The source list was refreshed. Review it and save again.`);
    }

    throw error;
  } finally {
    savingStore.set(false);
  }
}
