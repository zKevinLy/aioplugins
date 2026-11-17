// "Best stream first" and the per-resolution cap, shown under Stream order.

import { MAX_PER_QUALITY } from "../../../lib/middleware-limits.js";
import type { MiddlewareScope } from "./scope.js";

/** Picks the dropdown entry for a saved cap, adding it if it is not offered. */
function selectLimit(select: HTMLSelectElement, perQuality: number): void {
  const wanted = String(perQuality);

  if (![...select.options].some((option) => option.value === wanted)) {
    select.append(new Option(`${perQuality} streams`, wanted));
  }

  select.value = wanted;
}

export function mountRankingEditor(scope: MiddlewareScope): void {
  const fastestBox = scope.ui<HTMLInputElement>("ranking-fastest");
  const limitSelect = scope.ui<HTMLSelectElement>("ranking-limit");

  const render = () => {
    const { ranking } = scope.store.get();

    fastestBox.checked = ranking.preferFastest;
    selectLimit(limitSelect, ranking.perQuality);
  };

  const commit = () => {
    const limit = Number(limitSelect.value);

    scope.store.update((settings) => ({
      ...settings,
      ranking: {
        preferFastest: fastestBox.checked,
        perQuality: Number.isFinite(limit)
          ? Math.min(MAX_PER_QUALITY, Math.max(0, Math.round(limit)))
          : settings.ranking.perQuality
      }
    }));
  };

  for (const control of [fastestBox, limitSelect]) {
    control.addEventListener("change", commit);
  }

  // Redraw when settings arrive from the server or an imported backup.
  scope.store.subscribe(render);

  render();
}
