// "Plugin sources": suggested one-click sources and the custom GitHub form.

import { $$ } from "../core/dom.js";
import { errorMessage } from "../core/guards.js";
import { setStatus } from "../core/status.js";
import { discoverSource } from "../services/sources.js";
import type { PluginScope } from "./pluginScope.js";

async function addSource(
  scope: PluginScope,
  button: HTMLButtonElement,
  repository: string,
  ref: string
): Promise<void> {
  if (!repository) {
    setStatus(scope.status, "Enter a GitHub repository URL.", "error");
    return;
  }

  button.disabled = true;
  button.classList.add("loading");
  setStatus(scope.status, "Checking GitHub manifest…");

  try {
    // Explicit action: always look up the newest commit.
    const source = await discoverSource(repository, ref, { force: true });
    scope.store.upsert(source);
    setStatus(
      scope.status,
      `Found ${source.providers.length} providers at commit ${source.commit.slice(0, 8)}.`,
      "success"
    );
  } catch (error) {
    setStatus(scope.status, errorMessage(error), "error");
  } finally {
    button.classList.remove("loading");
    button.disabled = scope.store.loading.get();
  }
}

export function mountPluginSources(scope: PluginScope): void {
  const discover = scope.ui<HTMLButtonElement>("discover");
  const repository = scope.ui<HTMLInputElement>("repository");
  const ref = scope.ui<HTMLInputElement>("ref");

  scope.store.loading.subscribe((loading) => {
    discover.disabled = loading;
  });

  discover.addEventListener("click", () => {
    void addSource(scope, discover, repository.value.trim(), ref.value.trim() || "main");
  });

  for (const button of $$<HTMLButtonElement>(".quick-source", scope.ui("source-panel"))) {
    button.addEventListener("click", () => {
      const url = button.dataset.repo;
      if (!url) return;

      repository.value = url;
      ref.value = "main";
      void addSource(scope, discover, url, "main");
    });
  }
}
