import { createStore } from "../core/store.js";

/** True while the complete setup is being saved and installed. */
export const savingStore = createStore(false);

/** The install URL and manifest JSON shown after saving. */
interface ManifestPreview {
  text: string;
  pluginCount: number;
}

export const manifestStore = createStore<ManifestPreview | null>(null);

/** Counts successful saves so panels can react (e.g. show a "saved" hint). */
export const savedStore = createStore(0);
