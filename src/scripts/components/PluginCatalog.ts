// "Available plugins": the searchable list of providers per source.

import { el } from "../core/dom.js";
import type { LoadedSource } from "../core/types.js";
import { isSelectable } from "../state/sources.js";
import type { PluginScope } from "./pluginScope.js";
import { renderProviderListItem } from "./ProviderListItem.js";

// Ticking a box updates the totals only; rebuilding the list on every click
// would drop keyboard focus and scroll position.
const ignoring = new WeakSet<PluginScope>();

function matching(scope: PluginScope, source: LoadedSource) {
  const query = scope.ui<HTMLInputElement>("search").value.trim().toLowerCase();
  const mode = scope.ui<HTMLSelectElement>("selection-filter").value;

  return source.providers.filter((provider) => {
    if (!`${provider.name} ${provider.id} ${provider.description}`.toLowerCase().includes(query)) {
      return false;
    }

    if (mode === "selected") return source.selected.has(provider.id);
    if (mode === "unselected") return !source.selected.has(provider.id);
    return true;
  });
}

function visibleTargets(scope: PluginScope) {
  return scope.store.list().flatMap((source) =>
    matching(scope, source)
      .filter(isSelectable)
      .map((provider) => ({ source, providerId: provider.id }))
  );
}

function updateSummary(scope: PluginScope): void {
  const { store, ui } = scope;
  const count = store.selectionCount();
  const combined = store.combinedCount();
  const targets = visibleTargets(scope);
  const allSelected = targets.length > 0 &&
    targets.every(({ source, providerId }) => source.selected.has(providerId));

  const label = count === 1 ? "1 plugin selected" : `${count} plugins selected`;

  ui("source-count").textContent = String(store.size);
  ui("selection-count").textContent = combined > 0
    ? `${label} (${combined} combined from several sources)`
    : label;
  ui<HTMLButtonElement>("go-save").disabled = count === 0;

  const selectAll = ui<HTMLButtonElement>("select-filtered");
  selectAll.disabled = targets.length === 0 || scope.locked();
  selectAll.textContent = allSelected ? "Deselect all" : "Select all";
}

function renderEmpty(scope: PluginScope): void {
  const loading = scope.store.loading.get();
  const catalog = scope.ui("catalog");

  catalog.className = "catalog-empty";
  catalog.replaceChildren(
    el("strong", { text: loading ? "Loading your plugin sources..." : "No plugin sources loaded." }),
    el("p", {
      text: loading
        ? "Your suggested sources will appear here automatically."
        : "Check the source error above, or add a custom GitHub source."
    })
  );
}

function renderGroup(
  scope: PluginScope,
  key: string,
  source: LoadedSource,
  providers: ReturnType<typeof matching>
): HTMLElement {
  const { store } = scope;
  const name = new URL(source.repository).pathname.split("/").filter(Boolean).slice(-1)[0] || source.repository;

  const link = el("a", {
    text: name,
    attrs: { href: source.repository, target: "_blank", rel: "noopener noreferrer" }
  });

  const locked = scope.locked();
  const selectVisible = el("button", { className: "button button-small", text: "Select visible", attrs: { type: "button" } });
  selectVisible.disabled = locked;
  selectVisible.addEventListener("click", () => {
    store.setManySelected(
      providers.filter(isSelectable).map((provider) => ({ source, providerId: provider.id })),
      true
    );
  });

  const remove = el("button", {
    className: "button button-small",
    text: "Remove",
    attrs: { type: "button", "aria-label": `Remove ${source.repository}` }
  });
  remove.disabled = locked;
  remove.addEventListener("click", () => store.remove(key));

  const group = el(
    "section",
    { className: "source-group" },
    el(
      "div",
      { className: "source-title" },
      el(
        "div",
        {},
        el("h3", {}, link),
        el("p", { className: "source-meta", text: `${source.ref} · ${source.commit.slice(0, 8)}` })
      ),
      el("div", { className: "source-actions" }, selectVisible, remove)
    )
  );

  for (const provider of providers) {
    group.append(
      renderProviderListItem(provider, {
        checked: source.selected.has(provider.id),
        ...(locked ? { disabled: true } : {}),
        onChange: (checked) => {
          ignoring.add(scope);
          store.setSelected(source, provider.id, checked);
          ignoring.delete(scope);

          // With a selection filter the row may need to leave the list;
          // otherwise only the totals change.
          if (scope.ui<HTMLSelectElement>("selection-filter").value !== "all") render(scope);
          else updateSummary(scope);
        }
      })
    );
  }

  return group;
}

function render(scope: PluginScope): void {
  if (scope.store.size === 0) {
    renderEmpty(scope);
    updateSummary(scope);
    return;
  }

  const catalog = scope.ui("catalog");
  const groups: HTMLElement[] = [];

  for (const [key, source] of scope.store.entries()) {
    const providers = matching(scope, source);
    if (providers.length > 0) groups.push(renderGroup(scope, key, source, providers));
  }

  catalog.className = groups.length > 0 ? "catalog-content" : "catalog-empty";

  if (groups.length > 0) {
    catalog.replaceChildren(...groups);
  } else {
    const filtered =
      scope.ui<HTMLInputElement>("search").value.trim() ||
      scope.ui<HTMLSelectElement>("selection-filter").value !== "all";

    catalog.replaceChildren(
      el("p", { text: filtered ? "No plugins match this search or filter." : "No available plugins found." })
    );
  }

  updateSummary(scope);
}

export function mountPluginCatalog(scope: PluginScope): void {
  const refresh = () => {
    if (!ignoring.has(scope)) render(scope);
  };

  scope.store.subscribe(refresh);
  scope.store.loading.subscribe(refresh);
  scope.onLockChange(() => render(scope));
  scope.ui("search").addEventListener("input", () => render(scope));
  scope.ui("selection-filter").addEventListener("change", () => render(scope));

  scope.ui("select-filtered").addEventListener("click", () => {
    const targets = visibleTargets(scope);
    const shouldSelect = !targets.every(({ source, providerId }) => source.selected.has(providerId));
    scope.store.setManySelected(targets, shouldSelect);
  });

  scope.ui("go-save").addEventListener("click", scope.onContinue);

  render(scope);
}
