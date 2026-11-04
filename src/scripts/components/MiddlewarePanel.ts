// The "Filters / Sorting / Formatter" screen: edit session middleware settings.

import { $, $$ } from "../core/dom.js";
import { showMiddlewareTab, viewStore } from "../state/view.js";
import type { MiddlewareTab } from "../core/types.js";
import { mountFilterEditor } from "./middleware/FilterEditor.js";
import { mountFormatterEditor } from "./middleware/FormatterEditor.js";
import { mountSortControls } from "./middleware/SortControls.js";

function isTab(value: string | undefined): value is MiddlewareTab {
  return value === "filters" || value === "sorting" || value === "formatting";
}

function renderTabs(): void {
  const { tab } = viewStore.get();

  for (const panel of $$(".middleware-panel")) {
    panel.hidden = panel.id !== `middleware-${tab}`;
  }

}


export function mountMiddlewarePanel(): void {
  mountFilterEditor();
  mountSortControls();
  mountFormatterEditor();

  viewStore.subscribe(renderTabs);

  renderTabs();
}
