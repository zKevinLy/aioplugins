// Server-provided lists the UI reads from: stream fields and saved profiles.

import type { StreamFieldDefinition } from "../../providers/stream-middleware.js";
import { createStore } from "../core/store.js";
import type { SavedProfile } from "../core/types.js";

export const fieldsStore = createStore<StreamFieldDefinition[]>([]);
export const profilesStore = createStore<SavedProfile[]>([]);

export function findField(key: string): StreamFieldDefinition | undefined {
  return fieldsStore.get().find((field) => field.key === key);
}
