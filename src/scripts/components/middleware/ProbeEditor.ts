// "Playback check": drop streams that Nuvio's own probe finds unplayable.

import { MAX_PROBE_TIMEOUT_MS, MIN_PROBE_TIMEOUT_MS } from "../../../lib/middleware-limits.js";
import type { MiddlewareScope } from "./scope.js";

/** Picks the dropdown entry closest to a saved timeout, adding it if it is not offered. */
function selectTimeout(select: HTMLSelectElement, timeoutMs: number): void {
  const wanted = String(timeoutMs);

  if (![...select.options].some((option) => option.value === wanted)) {
    const seconds = Math.round(timeoutMs / 100) / 10;
    select.append(new Option(`${seconds} seconds`, wanted));
  }

  select.value = wanted;
}

export function mountProbeEditor(scope: MiddlewareScope): void {
  const enabledBox = scope.ui<HTMLInputElement>("probe-enabled");
  const seekableBox = scope.ui<HTMLInputElement>("probe-require-seekable");
  const timeoutSelect = scope.ui<HTMLSelectElement>("probe-timeout");

  const render = () => {
    const { probe } = scope.store.get();

    enabledBox.checked = probe.enabled;
    seekableBox.checked = probe.requireSeekable;
    selectTimeout(timeoutSelect, probe.timeoutMs);
    scope.ui("probe-details").hidden = !probe.enabled;
  };

  const commit = () => {
    const timeout = Number(timeoutSelect.value);

    scope.store.update((settings) => ({
      ...settings,
      probe: {
        enabled: enabledBox.checked,
        requireSeekable: seekableBox.checked,
        timeoutMs: Number.isFinite(timeout)
          ? Math.min(MAX_PROBE_TIMEOUT_MS, Math.max(MIN_PROBE_TIMEOUT_MS, timeout))
          : settings.probe.timeoutMs
      }
    }));
  };

  for (const control of [enabledBox, seekableBox, timeoutSelect]) {
    control.addEventListener("change", commit);
  }

  // Redraw when settings arrive from the server or an imported backup.
  scope.store.subscribe(render);

  render();
}
