// Whether the account follows the admins' curated plugin list.

import { createStore } from "../core/store.js";
import type { CuratedStatus } from "../core/types.js";

export const curatedStore = createStore<CuratedStatus>({
  following: false,
  available: false,
  updatedAt: null
});

/**
 * True while the account is served the curated selection. The plugin
 * selection and middleware settings are then read-only: the server would
 * ignore anything saved, so the page does not offer to.
 */
export function isCuratedLocked(): boolean {
  const { following, available } = curatedStore.get();
  return following && available;
}
