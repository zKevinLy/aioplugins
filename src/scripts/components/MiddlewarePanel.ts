// The editors for stream middleware settings (filters, sorting, formatter).
// The Filters / Sorting / Formatter screens edit the account's own settings;
// the admin screen mounts the very same editors for the curated settings.

import { $, $$ } from "../core/dom.js";
import type { Store } from "../core/store.js";
import type { MiddlewareSettings } from "../core/types.js";
import { adminMiddlewareStore, middlewareStore } from "../state/middleware.js";
import { viewStore } from "../state/view.js";
import { mountFilterEditor } from "./middleware/FilterEditor.js";
import { mountFormatterEditor } from "./middleware/FormatterEditor.js";
import { mountProbeEditor } from "./middleware/ProbeEditor.js";
import { mountRankingEditor } from "./middleware/RankingEditor.js";
import { idLookup, type MiddlewareScope } from "./middleware/scope.js";
import { mountSortControls } from "./middleware/SortControls.js";

function mountEditors(scope: MiddlewareScope): void {
  mountFilterEditor(scope);
  mountProbeEditor(scope);
  mountSortControls(scope);
  mountRankingEditor(scope);
  mountFormatterEditor(scope);
}

function scopeFor(
  store: Store<MiddlewareSettings>,
  prefix: string,
  formatterVisible: () => boolean
): MiddlewareScope {
  return {
    store,
    ui: idLookup(prefix),
    formatterVisible,
    onNavigate: (listener) => void viewStore.subscribe(listener)
  };
}

/** Shows the one panel of `root` that matches the current tab. */
export function showPanel(root: ParentNode, tab: string): void {
  for (const panel of $$<HTMLElement>("[data-tab]", root)) {
    panel.hidden = panel.dataset.tab !== tab;
  }
}

export function mountMiddlewarePanel(): void {
  const root = $("#middleware-view");

  mountEditors(
    scopeFor(middlewareStore, "", () => {
      const { view, tab } = viewStore.get();
      return view === "middleware" && tab === "formatting";
    })
  );

  const render = () => showPanel(root, viewStore.get().tab);
  viewStore.subscribe(render);
  render();
}

/** The same editors, for the settings an admin publishes to the curated list. */
export function mountCuratedMiddlewareEditors(): void {
  mountEditors(
    scopeFor(adminMiddlewareStore, "admin-", () => {
      const { view, adminTab } = viewStore.get();
      return view === "admin" && adminTab === "formatting";
    })
  );
}
