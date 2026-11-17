// The filter, sorting and formatter editors are shared: the account's own
// settings and the admin's curated settings both use them. A scope says which
// settings an editor changes and which copy of the panels it draws into.

import { $ } from "../../core/dom.js";
import type { Store } from "../../core/store.js";
import type { MiddlewareSettings } from "../../core/types.js";

export interface MiddlewareScope {
  /** The settings this copy of the editors reads and changes. */
  store: Store<MiddlewareSettings>;
  /** Finds an element of this copy by its id without the scope's prefix. */
  ui: <T extends HTMLElement = HTMLElement>(id: string) => T;
  /** True while the formatter panel can be seen; its preview only renders then. */
  formatterVisible: () => boolean;
  /** Calls `listener` when what is on screen may have changed. */
  onNavigate: (listener: () => void) => void;
}

/** Builds the id lookup for panels rendered with `<Panel prefix={prefix} />`. */
export function idLookup(prefix: string): MiddlewareScope["ui"] {
  return <T extends HTMLElement = HTMLElement>(id: string) => $<T>(`#${prefix}${id}`);
}
