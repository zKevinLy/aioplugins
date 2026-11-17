// Admin: choose the plugins and stream settings that everyone following the
// curated list receives. It keeps its own selection and its own settings,
// separate from the account's, so editing the default never touches the
// admin's own setup. The settings use the same editors as the Filters,
// Sorting and Formatter screens.

import { $, el } from "../core/dom.js";
import { ApiError } from "../core/api.js";
import { errorMessage, parseProfileBackup } from "../core/guards.js";
import { setStatus } from "../core/status.js";
import type { DiscoveredSource, LoadedSource, SavedSource } from "../core/types.js";
import { loadCurated, publishCurated } from "../services/curated.js";
import { refreshWorkspace } from "../services/session.js";
import { discoverSource, loadSources, suggestedSources, type SourceRequest } from "../services/sources.js";
import { curatedStore } from "../state/curated.js";
import { adminMiddlewareStore, middlewarePayload, toMiddlewareSettings } from "../state/middleware.js";
import { userStore } from "../state/session.js";
import { isSelectable, pruneSelection, sourceKey } from "../state/sources.js";
import { viewStore } from "../state/view.js";
import { mountCuratedMiddlewareEditors, showPanel } from "./MiddlewarePanel.js";
import { renderProviderListItem } from "./ProviderListItem.js";

const sources = new Map<string, LoadedSource>();
let order: string[] = [];
let loaded = false;
let busy = false;
/** A source failed to load, so its ticks may be missing from the selection. */
let incomplete = false;

const catalog = () => $("#admin-catalog");
const search = () => $<HTMLInputElement>("#admin-search");

function selectedCount(): number {
  const ids = new Set<string>();
  for (const source of sources.values()) for (const id of source.selected) ids.add(id);
  return ids.size;
}

function payload(): SavedSource[] {
  return order
    .map((key) => sources.get(key))
    .flatMap((source) => (source ? [source] : []))
    .map((source) => ({
      repository: source.repository,
      ref: source.ref,
      commit: source.commit,
      providerIds: [...source.selected]
    }))
    .filter((source) => source.providerIds.length > 0);
}

function upsert(source: DiscoveredSource, ids: Iterable<string>): void {
  const key = sourceKey(source);
  sources.set(key, { ...source, selected: pruneSelection(source, ids) });
  if (!order.includes(key)) order.push(key);
}

function updateSummary(): void {
  const count = selectedCount();
  $("#admin-count").textContent = count === 1 ? "1 plugin selected" : `${count} plugins selected`;
  $<HTMLButtonElement>("#admin-publish").disabled = busy || count === 0;
}

function renderGroup(source: LoadedSource, providers: DiscoveredSource["providers"]): HTMLElement {
  const name = new URL(source.repository).pathname.split("/").filter(Boolean).slice(-1)[0] || source.repository;
  const selectable = providers.filter(isSelectable);

  const all = el("button", { className: "button button-small", text: "Select visible", attrs: { type: "button" } });
  all.addEventListener("click", () => {
    for (const provider of selectable) source.selected.add(provider.id);
    render();
  });

  const none = el("button", { className: "button button-small", text: "Clear", attrs: { type: "button" } });
  none.addEventListener("click", () => {
    for (const provider of selectable) source.selected.delete(provider.id);
    render();
  });

  const group = el(
    "section",
    { className: "source-group" },
    el(
      "div",
      { className: "source-title" },
      el(
        "div",
        {},
        el("h3", {}, el("a", {
          text: name,
          attrs: { href: source.repository, target: "_blank", rel: "noopener noreferrer" }
        })),
        el("p", { className: "source-meta", text: `${source.ref} · ${source.commit.slice(0, 8)}` })
      ),
      el("div", { className: "source-actions" }, all, none)
    )
  );

  for (const provider of providers) {
    group.append(
      renderProviderListItem(provider, {
        checked: source.selected.has(provider.id),
        onChange: (checked) => {
          if (checked) source.selected.add(provider.id);
          else source.selected.delete(provider.id);
          updateSummary(); // not render(): that would drop focus and scroll position
        }
      })
    );
  }

  return group;
}

function render(): void {
  const query = search().value.trim().toLowerCase();
  const groups: HTMLElement[] = [];

  for (const key of order) {
    const source = sources.get(key);
    if (!source) continue;

    const providers = source.providers.filter((provider) =>
      `${provider.name} ${provider.id} ${provider.description}`.toLowerCase().includes(query)
    );

    if (providers.length > 0) groups.push(renderGroup(source, providers));
  }

  catalog().className = groups.length > 0 ? "catalog-content" : "catalog-empty";
  catalog().replaceChildren(
    ...(groups.length > 0
      ? groups
      : [el("p", { text: loaded ? "No plugins match this search." : "Loading…" })])
  );

  updateSummary();
}

async function load(force: boolean): Promise<void> {
  busy = true;
  updateSummary();
  setStatus("admin", force ? "Looking up the newest commits…" : "Loading the curated list…");

  try {
    const curated = await loadCurated();

    $("#admin-followers").textContent =
      `${curated.followers.following} of ${curated.followers.total} accounts subscribed`;

    // Keep ticks the admin already made when reloading; otherwise start from what is published.
    const ticks = new Map<string, Set<string>>();
    if (loaded) {
      for (const [key, source] of sources) ticks.set(key, new Set(source.selected));
    } else {
      adminMiddlewareStore.set(toMiddlewareSettings(curated.middleware));
      for (const source of curated.sources) ticks.set(sourceKey(source), new Set(source.providerIds));
    }

    const requests = new Map<string, SourceRequest>();
    for (const request of [...suggestedSources(), ...curated.sources]) requests.set(sourceKey(request), request);
    for (const key of order) {
      const source = sources.get(key);
      if (source) requests.set(key, { repository: source.repository, ref: source.ref });
    }

    order = [...requests.keys()];
    const previous = new Map(sources);
    sources.clear();

    const { failures } = await loadSources([...requests.values()], {
      force,
      onSource: ({ source }) => upsert(source, ticks.get(sourceKey(source)) ?? [])
    });

    // A source that did not answer keeps what it had, so a hiccup drops nothing.
    for (const key of order) {
      const before = previous.get(key);
      if (!sources.has(key) && before) sources.set(key, before);
    }

    loaded = true;
    incomplete = failures.length > 0;
    order = order.filter((key) => sources.has(key));
    setStatus(
      "admin",
      failures.length > 0 ? `Some sources couldn't load: ${failures.join("; ")}` : "",
      failures.length > 0 ? "error" : ""
    );
  } catch (error) {
    setStatus("admin", errorMessage(error), "error");
  } finally {
    busy = false;
    render();
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
  for (const source of sources.values()) source.selected.clear();

  for (const { source, request } of found) upsert(source, request.providerIds ?? []);

  if (backup.middleware !== undefined) {
    adminMiddlewareStore.set(toMiddlewareSettings(backup.middleware));
  }

  render();

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
    setStatus("admin", "Some sources did not load, so their plugins may be missing. Choose Reload sources first.", "error");
    return;
  }

  if (!confirm("Publish this selection? Everyone following the curated list gets it immediately.")) return;

  busy = true;
  updateSummary();
  setStatus("admin", "Verifying the selected plugins and publishing…");

  try {
    const result = await publishCurated(payload(), middlewarePayload(adminMiddlewareStore));

    $("#admin-followers").textContent =
      `${result.followers.following} of ${result.followers.total} accounts subscribed`;

    setStatus(
      "admin",
      `Published ${result.plugins} plugins. ${result.followers.following} subscribed accounts now receive them.`,
      "success"
    );

    // An admin who follows the list should see what they are now served.
    if (curatedStore.get().following) await refreshWorkspace();
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      await load(true);
      setStatus("admin", `${error.message} The sources were refreshed. Review them and publish again.`, "error");
    } else {
      setStatus("admin", errorMessage(error), "error");
    }
  } finally {
    busy = false;
    updateSummary();
  }
}

export function mountAdminPanel(): void {
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
    sources.clear();
    order = [];
    loaded = false;
    adminMiddlewareStore.set(toMiddlewareSettings(undefined));
    render();
  });

  search().addEventListener("input", render);
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

  $("#admin-add-source").addEventListener("click", async () => {
    const repository = $<HTMLInputElement>("#admin-repository").value.trim();
    const ref = $<HTMLInputElement>("#admin-ref").value.trim() || "main";

    if (!repository) {
      setStatus("admin", "Enter a GitHub repository URL.", "error");
      return;
    }

    setStatus("admin", "Checking GitHub manifest…");

    try {
      const source = await discoverSource(repository, ref, { force: true });
      const key = sourceKey(source);
      upsert(source, sources.get(key)?.selected ?? []);
      render();
      setStatus("admin", `Found ${source.providers.length} providers at commit ${source.commit.slice(0, 8)}.`, "success");
    } catch (error) {
      setStatus("admin", errorMessage(error), "error");
    }
  });

  render();
}
