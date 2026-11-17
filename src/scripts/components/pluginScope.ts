// The plugin picker (suggested sources, custom source form and the searchable
// list) is shared: the account's own plugins and the admin's curated plugins
// both use it. A scope says which selection a copy edits and where it draws.

import { idLookup } from "../core/dom.js";
import type { StatusChannel } from "../core/status.js";
import { curatedStore, isCuratedLocked } from "../state/curated.js";
import { adminSourceStore, sourceStore, type SourceStore } from "../state/sources.js";
import { openReview, showAdminTab } from "../state/view.js";

export interface PluginScope {
  /** The sources and ticks this copy of the picker edits. */
  store: SourceStore;
  /** Finds an element of this copy by its id without the scope's prefix. */
  ui: ReturnType<typeof idLookup>;
  /** Where this copy reports what it is doing. */
  status: StatusChannel;
  /** True while the selection must not be edited. */
  locked: () => boolean;
  /** Calls `listener` when `locked()` may have changed. */
  onLockChange: (listener: () => void) => void;
  /** The "continue" button at the end of the list. */
  onContinue: () => void;
}

/** The signed-in account's own plugins. Locked while it follows the curated list. */
export const accountPlugins: PluginScope = {
  store: sourceStore,
  ui: idLookup(""),
  status: "catalog",
  locked: isCuratedLocked,
  onLockChange: (listener) => void curatedStore.subscribe(listener),
  onContinue: openReview
};

/** The curated list an admin is drafting; an admin can always edit it. */
export const curatedPlugins: PluginScope = {
  store: adminSourceStore,
  ui: idLookup("admin-"),
  status: "admin",
  locked: () => false,
  onLockChange: () => undefined,
  onContinue: () => showAdminTab("publish")
};
