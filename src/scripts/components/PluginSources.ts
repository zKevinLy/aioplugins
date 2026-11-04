// "Plugin sources": suggested one-click sources and the custom GitHub form.

import { $, $$ } from "../core/dom.js";
import { errorMessage } from "../core/guards.js";
import { setStatus } from "../core/status.js";
import { discoverSource } from "../services/sources.js";
import { sourceStore, sourcesLoading } from "../state/sources.js";

async function addSource(button: HTMLButtonElement, repository: string, ref: string): Promise<void> {
  if (!repository) {
    setStatus("catalog", "Enter a GitHub repository URL.", "error");
    return;
  }

  button.disabled = true;
  button.classList.add("loading");
  setStatus("catalog", "Checking GitHub manifest…");

  try {
    // Explicit action: always look up the newest commit.
    const source = await discoverSource(repository, ref, { force: true });
    sourceStore.upsert(source);
    setStatus(
      "catalog",
      `Found ${source.providers.length} providers at commit ${source.commit.slice(0, 8)}.`,
      "success"
    );
  } catch (error) {
    setStatus("catalog", errorMessage(error), "error");
  } finally {
    button.classList.remove("loading");
    button.disabled = sourcesLoading.get();
  }
}

export function mountPluginSources(): void {
  const discover = $<HTMLButtonElement>("#discover");
  const repository = $<HTMLInputElement>("#repository");
  const ref = $<HTMLInputElement>("#ref");

  sourcesLoading.subscribe((loading) => {
    discover.disabled = loading;
  });

  discover.addEventListener("click", () => {
    void addSource(discover, repository.value.trim(), ref.value.trim() || "main");
  });

  for (const button of $$<HTMLButtonElement>(".quick-source")) {
    button.addEventListener("click", () => {
      const url = button.dataset.repo;
      if (!url) return;

      repository.value = url;
      ref.value = "main";
      void addSource(discover, url, "main");
    });
  }
}
