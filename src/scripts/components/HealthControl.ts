// The small "Up · 840 ms [Test]" line under a provider, shared by the
// catalog and the review list. Controls update in place when results arrive.

import { $$, el } from "../core/dom.js";
import type { LoadedSource, ProviderCheck } from "../core/types.js";
import { checkProviders } from "../services/health.js";
import { getCheck, healthStore } from "../state/health.js";
import { sourceKey, sourceStore } from "../state/sources.js";

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function describe(check: ProviderCheck): { label: string; title: string } {
  const time = check.ms === undefined ? "" : ` · ${formatDuration(check.ms)}`;

  switch (check.state) {
    case "checking":
      return { label: "Testing…", title: "Running the plugin in a sandbox" };
    case "up":
      return {
        label: `Up${time}`,
        title: `Returned ${check.streams ?? 0} stream(s) in ${formatDuration(check.ms ?? 0)}`
      };
    case "empty":
      return {
        label: `No results${time}`,
        title: "The plugin answered but found no streams for the test title"
      };
    case "blocked":
      return {
        label: "Blocked by browser",
        title:
          "The browser stopped the plugin's request (usually CORS). " +
          "This does not mean the plugin is down in Nuvio. " + (check.message ?? "")
      };
    case "timeout":
      return { label: "Timed out", title: check.message ?? "No answer in time" };
    case "down":
      return { label: "Down", title: check.message ?? "The plugin failed" };
  }
}

function findSource(key: string): LoadedSource | undefined {
  return sourceStore.entries().find(([entryKey]) => entryKey === key)?.[1];
}

function refresh(control: HTMLElement): void {
  const key = control.dataset.sourceKey ?? "";
  const providerId = control.dataset.providerId ?? "";
  const source = findSource(key);
  if (!source) return;

  const check = getCheck(key, providerId, source.commit);
  const busy = check?.state === "checking";

  const test = el("button", {
    className: "button button-small health-test",
    text: busy ? "Testing…" : check ? "Retest" : "Test speed",
    attrs: { type: "button" }
  });
  test.disabled = busy;
  test.addEventListener("click", (event) => {
    // The control sits inside a label; do not toggle the checkbox.
    event.preventDefault();
    event.stopPropagation();

    const provider = source.providers.find((entry) => entry.id === providerId);
    if (provider) checkProviders([{ source, provider }]);
  });

  const children: HTMLElement[] = [];

  if (check) {
    const { label, title } = describe(check);
    children.push(
      el("span", { className: `health-chip ${check.state}`, text: label, attrs: { title } })
    );
  }

  control.replaceChildren(...children, test);
}

/** Creates the control for one provider of one loaded source. */
export function createHealthControl(source: LoadedSource, providerId: string): HTMLElement {
  const control = el("div", {
    className: "provider-health",
    attrs: { "data-source-key": sourceKey(source), "data-provider-id": providerId }
  });
  refresh(control);
  return control;
}

export function mountHealthControls(): void {
  healthStore.subscribe(() => {
    for (const control of $$(".provider-health")) refresh(control);
  });
}
