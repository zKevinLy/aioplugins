// Admin: choose the plugins and stream settings that everyone following the
// curated list receives. Every tab is the same component the account uses,
// pointed at the admin's own draft (separate from the account's selection and
// settings), so editing the default never touches the admin's own setup.

import { $ } from "../core/dom.js";
import { ApiError } from "../core/api.js";
import { errorMessage, parseProfileBackup } from "../core/guards.js";
import { setStatus } from "../core/status.js";
import { loadCurated, publishCurated } from "../services/curated.js";
import { refreshWorkspace } from "../services/session.js";
import { loadSources, suggestedSources, type SourceRequest } from "../services/sources.js";
import { curatedStore } from "../state/curated.js";
import { adminMiddlewareStore, middlewarePayload, toMiddlewareSettings } from "../state/middleware.js";
import { userStore } from "../state/session.js";
import { adminSourceStore as store, sourceKey } from "../state/sources.js";
import { viewStore } from "../state/view.js";
import { mountCuratedMiddlewareEditors, showPanel } from "./MiddlewarePanel.js";
import { mountPluginCatalog } from "./PluginCatalog.js";
import { curatedPlugins } from "./pluginScope.js";
import { mountPluginSources } from "./PluginSources.js";

let loaded = false;
let busy = false;
/** A source failed to load, so its ticks may be missing from the selection. */
let incomplete = false;

function updateSummary(): void {
  const count = store.selectionCount();

  $("#admin-count").textContent =
    count === 0 ? "No plugins selected" : count === 1 ? "1 plugin selected" : `${count} plugins selected`;
  $<HTMLButtonElement>("#admin-publish").disabled = busy || count === 0;
}

function showFollowers(followers: { following: number; total: number }): void {
  $("#admin-followers").textContent = `${followers.following} of ${followers.total} accounts subscribed`;
}

async function load(force: boolean): Promise<void> {
  busy = true;
  store.loading.set(true);
  updateSummary();
  setStatus("admin", force ? "Looking up the newest commits…" : "Loading the curated list…");

  try {
    const curated = await loadCurated();
    showFollowers(curated.followers);

    // Keep ticks the admin already made when reloading; otherwise start from what is published.
    const ticks = new Map<string, Set<string>>();
    if (loaded) {
      for (const [key, source] of store.entries()) ticks.set(key, new Set(source.selected));
    } else {
      adminMiddlewareStore.set(toMiddlewareSettings(curated.middleware));
      for (const source of curated.sources) ticks.set(sourceKey(source), new Set(source.providerIds));
    }

    const requests = new Map<string, SourceRequest>();
    for (const request of [...suggestedSources(), ...curated.sources]) requests.set(sourceKey(request), request);
    for (const [key, source] of store.entries()) {
      requests.set(key, { repository: source.repository, ref: source.ref });
    }

    const previous = new Map(store.entries());
    store.clear();
    store.setOrder([...requests.keys()]);

    const { failures } = await loadSources([...requests.values()], {
      force,
      onSource: ({ source }) => void store.upsert(source, ticks.get(sourceKey(source)) ?? [])
    });

    // A source that did not answer keeps what it had, so a hiccup drops nothing.
    const present = new Set(store.entries().map(([key]) => key));
    for (const [key, before] of previous) {
      if (!present.has(key)) store.upsert(before, before.selected);
    }

    loaded = true;
    incomplete = failures.length > 0;
    setStatus(
      "admin",
      failures.length > 0
        ? `Some sources couldn't load: ${failures.join("; ")}`
        : `Loaded ${store.size} plugin sources. Choose the plugins you want.`,
      failures.length > 0 ? "error" : "success"
    );
  } catch (error) {
    setStatus("admin", errorMessage(error), "error");
  } finally {
    busy = false;
    store.loading.set(false);
    updateSummary();
  }
}

async function importBackup(file: File): Promise<void> {
  let backup;

  try {
    backup = parseProfileBackup(JSON.parse(await file.text()));
  } catch {
    throw new Error("This file is not a valid AIOPlugins backup.");
  }

  setStatus("admin", "Loading the backup's sources…");

  const { loaded: found, failures } = await loadSources(backup.sources);

  // The backup replaces the whole selection.
  for (const [, source] of store.entries()) source.selected.clear();
  store.setManySelected([], false);

  for (const { source, request } of found) store.upsert(source, request.providerIds ?? []);

  if (backup.middleware !== undefined) {
    adminMiddlewareStore.set(toMiddlewareSettings(backup.middleware));
  }

  setStatus(
    "admin",
    failures.length > 0
      ? `Backup loaded, but some sources couldn't load: ${failures.join("; ")}`
      : "Backup loaded. Review it, then publish.",
    failures.length > 0 ? "error" : "success"
  );
}

async function publish(): Promise<void> {
  if (incomplete) {
    setStatus(
      "admin-publish",
      "Some sources did not load, so their plugins may be missing. Choose Reload sources on the Plugins tab first.",
      "error"
    );
    return;
  }

  if (!confirm("Publish this selection? Everyone following the curated list gets it immediately.")) return;

  busy = true;
  updateSummary();
  setStatus("admin-publish", "Verifying the selected plugins and publishing…");

  try {
    const result = await publishCurated(store.toPayload(), middlewarePayload(adminMiddlewareStore));

    showFollowers(result.followers);

    setStatus(
      "admin-publish",
      `Published ${result.plugins} plugins and all stream settings. ${result.followers.following} subscribed accounts now receive them.`,
      "success"
    );

    // An admin who follows the list should see what they are now served.
    if (curatedStore.get().following) await refreshWorkspace();
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      await load(true);
      setStatus("admin-publish", `${error.message} The sources were refreshed. Review them and publish again.`, "error");
    } else {
      setStatus("admin-publish", errorMessage(error), "error");
    }
  } finally {
    busy = false;
    updateSummary();
  }
}

export function mountAdminPanel(): void {
  mountPluginSources(curatedPlugins);
  mountPluginCatalog(curatedPlugins);
  mountCuratedMiddlewareEditors();

  const root = $("#admin-view");
  const renderTabs = () => showPanel(root, viewStore.get().adminTab);

  // Load when the screen is opened, not at sign-in: most accounts never see it.
  // Every admin tab reads the same draft, so whichever opens first loads it.
  viewStore.subscribe(({ view }) => {
    if (view === "admin" && !loaded && !busy && userStore.get()?.isAdmin) void load(false);
    renderTabs();
  });
  renderTabs();

  userStore.subscribe((user) => {
    if (user?.isAdmin) return;
    store.clear();
    adminMiddlewareStore.set(toMiddlewareSettings(undefined));
    loaded = false;
    incomplete = false;
  });

  store.subscribe(updateSummary);
  $("#admin-reload").addEventListener("click", () => void load(true));
  $("#admin-publish").addEventListener("click", () => void publish());

  const file = $<HTMLInputElement>("#admin-import-file");
  $("#admin-import").addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const chosen = file.files?.[0];
    if (!chosen) return;

    try {
      await importBackup(chosen);
    } catch (error) {
      setStatus("admin", errorMessage(error), "error");
    } finally {
      file.value = "";
    }
  });

  updateSummary();
}
