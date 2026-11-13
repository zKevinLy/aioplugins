// "Best stream first" and the per-resolution cap, shown under Stream order.

import { MAX_PER_QUALITY } from "../../../lib/middleware-limits.js";
import { $ } from "../../core/dom.js";
import { middlewareStore } from "../../state/middleware.js";

const fastestBox = () => $<HTMLInputElement>("#ranking-fastest");
const limitSelect = () => $<HTMLSelectElement>("#ranking-limit");

/** Picks the dropdown entry for a saved cap, adding it if it is not offered. */
function selectLimit(select: HTMLSelectElement, perQuality: number): void {
  const wanted = String(perQuality);

  if (![...select.options].some((option) => option.value === wanted)) {
    select.append(new Option(`${perQuality} streams`, wanted));
  }

  select.value = wanted;
}

function render(): void {
  const { ranking } = middlewareStore.get();

  fastestBox().checked = ranking.preferFastest;
  selectLimit(limitSelect(), ranking.perQuality);
}

function commit(): void {
  const limit = Number(limitSelect().value);

  middlewareStore.update((settings) => ({
    ...settings,
    ranking: {
      preferFastest: fastestBox().checked,
      perQuality: Number.isFinite(limit)
        ? Math.min(MAX_PER_QUALITY, Math.max(0, Math.round(limit)))
        : settings.ranking.perQuality
    }
  }));
}

export function mountRankingEditor(): void {
  for (const control of [fastestBox(), limitSelect()]) {
    control.addEventListener("change", commit);
  }

  // Redraw when settings arrive from the server or an imported backup.
  middlewareStore.subscribe(render);

  render();
}
