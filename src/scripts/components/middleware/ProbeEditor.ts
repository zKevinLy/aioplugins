// "Playback check": drop streams that Nuvio's own probe finds unplayable.

import { MAX_PROBE_TIMEOUT_MS, MIN_PROBE_TIMEOUT_MS } from "../../../lib/middleware-limits.js";
import { $ } from "../../core/dom.js";
import { middlewareStore } from "../../state/middleware.js";

const enabledBox = () => $<HTMLInputElement>("#probe-enabled");
const seekableBox = () => $<HTMLInputElement>("#probe-require-seekable");
const timeoutSelect = () => $<HTMLSelectElement>("#probe-timeout");

/** Picks the dropdown entry closest to a saved timeout, adding it if it is not offered. */
function selectTimeout(select: HTMLSelectElement, timeoutMs: number): void {
  const wanted = String(timeoutMs);

  if (![...select.options].some((option) => option.value === wanted)) {
    const seconds = Math.round(timeoutMs / 100) / 10;
    select.append(new Option(`${seconds} seconds`, wanted));
  }

  select.value = wanted;
}

function render(): void {
  const { probe } = middlewareStore.get();

  enabledBox().checked = probe.enabled;
  seekableBox().checked = probe.requireSeekable;
  selectTimeout(timeoutSelect(), probe.timeoutMs);
  $("#probe-details").hidden = !probe.enabled;
}

function commit(): void {
  const timeout = Number(timeoutSelect().value);

  middlewareStore.update((settings) => ({
    ...settings,
    probe: {
      enabled: enabledBox().checked,
      requireSeekable: seekableBox().checked,
      timeoutMs: Number.isFinite(timeout)
        ? Math.min(MAX_PROBE_TIMEOUT_MS, Math.max(MIN_PROBE_TIMEOUT_MS, timeout))
        : settings.probe.timeoutMs
    }
  }));
}

export function mountProbeEditor(): void {
  for (const control of [enabledBox(), seekableBox(), timeoutSelect()]) {
    control.addEventListener("change", commit);
  }

  // Redraw when settings arrive from the server or an imported backup.
  middlewareStore.subscribe(render);

  render();
}
