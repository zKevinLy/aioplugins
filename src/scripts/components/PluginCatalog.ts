// "Available plugins": the searchable list of providers per source.

import { $, el } from "../core/dom.js";
import type { LoadedSource } from "../core/types.js";
import { isSelectable, sourceStore, sourcesLoading } from "../state/sources.js";
import { openReview } from "../state/view.js";
import { renderProviderListItem } from "./ProviderListItem.js";

const catalog = () => $("#catalog");
const search = () => $<HTMLInputElement>("#search");
const selectionFilter = () => $<HTMLSelectElement>("#selection-filter");

// Ticking a box updates the totals only; rebuilding the list on every click
// would drop keyboard focus and scroll position.
let ignoreChanges = false;

function matching(source: LoadedSource) {
  const query = search().value.trim().toLowerCase();

  const mode = selectionFilter().value;

  return source.providers.filter((provider) => {
    if (!`${provider.name} ${provider.id} ${provider.description}`.toLowerCase().includes(query)) {
      return false;
    }

    if (mode === "selected") return source.selected.has(provider.id);
    if (mode === "unselected") return !source.selected.has(provider.id);
    return true;
  });
}

function visibleTargets() {
  return sourceStore.list().flatMap((source) =>
    matching(source)
      .filter(isSelectable)
      .map((provider) => ({ source, providerId: provider.id }))
  );
}

function updateSummary(): void {
  const count = sourceStore.selectionCount();
  const combined = sourceStore.combinedCount();
  const targets = visibleTargets();
  const allSelected = targets.length > 0 &&
    targets.every(({ source, providerId }) => source.selected.has(providerId));

  const label = count === 1 ? "1 plugin selected" : `${count} plugins selected`;

  $("#source-count").textContent = String(sourceStore.size);
  $("#selection-count").textContent = combined > 0
    ? `${label} (${combined} combined from several sources)`
    : label;
  $<HTMLButtonElement>("#go-save").disabled = count === 0;

  const selectAll = $<HTMLButtonElement>("#select-filtered");
  selectAll.disabled = targets.length === 0;
  selectAll.textContent = allSelected ? "Deselect all" : "Select all";
}

function renderEmpty(): void {
  const loading = sourcesLoading.get();

  catalog().className = "catalog-empty";
  catalog().replaceChildren(
    el("strong", { text: loading ? "Loading your plugin sources..." : "No plugin sources loaded." }),
    el("p", {
      text: loading
        ? "Your suggested sources will appear here automatically."
        : "Check the source error above, or add a custom GitHub source."
    })
  );
}

function renderGroup(key: string, source: LoadedSource, providers: ReturnType<typeof matching>): HTMLElement {
  const name = new URL(source.repository).pathname.split("/").filter(Boolean).slice(-1)[0] || source.repository;

  const link = el("a", {
    text: name,
    attrs: { href: source.repository, target: "_blank", rel: "noopener noreferrer" }
  });

  const selectVisible = el("button", { className: "button button-small", text: "Select visible", attrs: { type: "button" } });
  selectVisible.addEventListener("click", () => {
    sourceStore.setManySelected(
      providers.filter(isSelectable).map((provider) => ({ source, providerId: provider.id })),
      true
    );
  });

  const remove = el("button", {
    className: "button button-small",
    text: "Remove",
    attrs: { type: "button", "aria-label": `Remove ${source.repository}` }
  });
  remove.addEventListener("click", () => sourceStore.remove(key));

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
        onChange: (checked) => {
          ignoreChanges = true;
          sourceStore.setSelected(source, provider.id, checked);
          ignoreChanges = false;

          // With a selection filter the row may need to leave the list;
          // otherwise only the totals change.
          if (selectionFilter().value !== "all") render();
          else updateSummary();
        }
      })
    );
  }

  return group;
}

function render(): void {
  if (sourceStore.size === 0) {
    renderEmpty();
    updateSummary();
    return;
  }

  const groups: HTMLElement[] = [];

  for (const [key, source] of sourceStore.entries()) {
    const providers = matching(source);
    if (providers.length > 0) groups.push(renderGroup(key, source, providers));
  }

  catalog().className = groups.length > 0 ? "catalog-content" : "catalog-empty";

  if (groups.length > 0) {
    catalog().replaceChildren(...groups);
  } else {
    catalog().replaceChildren(
      el("p", {
        text: search().value.trim() || selectionFilter().value !== "all"
          ? "No plugins match this search or filter."
          : "No available plugins found."
      })
    );
  }

  updateSummary();
}

export function mountPluginCatalog(): void {
  const refresh = () => {
    if (!ignoreChanges) render();
  };

  sourceStore.subscribe(refresh);
  sourcesLoading.subscribe(refresh);
  search().addEventListener("input", render);
  selectionFilter().addEventListener("change", render);

  $("#select-filtered").addEventListener("click", () => {
    const targets = visibleTargets();
    const shouldSelect = !targets.every(({ source, providerId }) => source.selected.has(providerId));
    sourceStore.setManySelected(targets, shouldSelect);
  });

  $("#go-save").addEventListener("click", openReview);

  render();
}
