// "Stream order": a stack of sort levels. Each level orders the streams that
// the levels above it left tied.

import type { StreamFieldDefinition, StreamSort } from "../../../providers/stream-middleware.js";
import { MAX_SORTS } from "../../../lib/middleware-limits.js";
import { el } from "../../core/dom.js";
import { fieldsStore, findField } from "../../state/workspace.js";
import { sortDirectionLabels } from "./fieldInputs.js";
import type { MiddlewareScope } from "./scope.js";

type Control = "field" | "direction" | "unknown" | "up" | "down" | "remove";

// Fields worth suggesting first when a level is added.
const PREFERRED_FIELDS = ["resolution", "quality", "size", "seeders"];

type Focus = { index: number; control: Control };

// The array currently drawn, per editor. Changes made here redraw once, with
// focus kept; the store subscriber only redraws for changes from elsewhere.
const drawn = new WeakMap<MiddlewareScope, StreamSort[] | null>();

function commit(scope: MiddlewareScope, sorts: StreamSort[], focus?: Focus): void {
  drawn.set(scope, sorts);
  scope.store.update((settings) => ({ ...settings, sorts }));
  render(scope, focus);
}

/** Text sorts read best A → Z; everything else is "best first". */
function defaultDirection(field: StreamFieldDefinition): "asc" | "desc" {
  return field.type === "text" && !field.ranked ? "asc" : "desc";
}

function nextField(sorts: StreamSort[]): StreamFieldDefinition | undefined {
  const free = fieldsStore.get().filter((field) => !sorts.some((sort) => sort.field === field.key));

  for (const key of PREFERRED_FIELDS) {
    const match = free.find((field) => field.key === key);
    if (match) return match;
  }

  return free[0];
}

function renderLevel(
  scope: MiddlewareScope,
  sort: StreamSort,
  index: number,
  sorts: StreamSort[]
): HTMLElement {
  const take = (change: Partial<StreamSort>, focus: Control) =>
    commit(scope, sorts.map((entry, position) => (position === index ? { ...entry, ...change } : entry)), {
      index,
      control: focus
    });

  const fieldSelect = el("select", {
    className: "sort-field",
    attrs: { "aria-label": `Sort level ${index + 1}: field`, "data-control": "field" }
  });
  const fields = fieldsStore.get();
  fieldSelect.append(
    ...fields.map((field) => {
      const option = new Option(field.label, field.key);
      // A field can only appear once; a second level on it could never change the order.
      option.disabled = sorts.some((other, position) => position !== index && other.field === field.key);
      return option;
    })
  );
  if (!fields.some((field) => field.key === sort.field)) {
    fieldSelect.append(new Option(sort.field, sort.field));
  }
  fieldSelect.value = sort.field;

  const labels = sortDirectionLabels(findField(sort.field));
  const directionSelect = el("select", {
    className: "sort-direction",
    attrs: { "aria-label": `Sort level ${index + 1}: direction`, "data-control": "direction" }
  });
  directionSelect.append(new Option(labels.desc, "desc"), new Option(labels.asc, "asc"));
  directionSelect.value = sort.direction;

  const unknownSelect = el("select", {
    className: "sort-unknown",
    attrs: {
      "aria-label": `Sort level ${index + 1}: where streams with an unknown value go`,
      "data-control": "unknown"
    }
  });
  unknownSelect.append(new Option("Unknown last", "last"), new Option("Unknown first", "first"));
  unknownSelect.value = sort.unknown;

  fieldSelect.addEventListener("change", () => {
    const field = findField(fieldSelect.value);
    // Switching field resets the direction to one that suits it.
    take({ field: fieldSelect.value, direction: field ? defaultDirection(field) : sort.direction }, "field");
  });
  directionSelect.addEventListener("change", () =>
    take({ direction: directionSelect.value === "asc" ? "asc" : "desc" }, "direction")
  );
  unknownSelect.addEventListener("change", () =>
    take({ unknown: unknownSelect.value === "first" ? "first" : "last" }, "unknown")
  );

  const move = (offset: number, control: "up" | "down") => {
    const target = index + offset;
    const next = [...sorts];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(target, 0, moved);
    commit(scope, next, { index: target, control });
  };

  const button = (control: "up" | "down" | "remove", text: string, label: string) =>
    el("button", {
      className: `button button-small sort-${control}`,
      text,
      attrs: { type: "button", "aria-label": label, "data-control": control }
    });

  const up = button("up", "↑", `Move sort level ${index + 1} up`);
  up.disabled = index === 0;
  up.addEventListener("click", () => move(-1, "up"));

  const down = button("down", "↓", `Move sort level ${index + 1} down`);
  down.disabled = index === sorts.length - 1;
  down.addEventListener("click", () => move(1, "down"));

  const remove = button("remove", "Remove", `Remove sort level ${index + 1}`);
  remove.addEventListener("click", () =>
    commit(scope, sorts.filter((_, position) => position !== index), {
      index: Math.min(index, sorts.length - 2),
      control: "remove"
    })
  );

  return el(
    "div",
    { className: "sort-level" },
    el("span", { className: "sort-level-label", text: index === 0 ? "Sort by" : "Then by" }),
    fieldSelect,
    directionSelect,
    unknownSelect,
    el("div", { className: "sort-level-actions" }, up, down, remove)
  );
}

function focusControl(scope: MiddlewareScope, focus: Focus | undefined): void {
  if (!focus) return;

  const row = scope.ui("sort-levels").children[focus.index];
  if (!row) {
    scope.ui("add-stream-sort").focus();
    return;
  }

  const wanted = row.querySelector<HTMLElement>(`[data-control="${focus.control}"]`);
  const fallback = row.querySelector<HTMLElement>('[data-control="field"]');

  // A moved row's own button may now be disabled (top or bottom of the stack).
  const target =
    wanted instanceof HTMLButtonElement && wanted.disabled
      ? row.querySelector<HTMLElement>(
          `[data-control="${focus.control === "up" ? "down" : "up"}"]:not(:disabled)`
        ) ?? fallback
      : wanted ?? fallback;

  target?.focus();
}

function render(scope: MiddlewareScope, focus?: Focus): void {
  const { sorts } = scope.store.get();
  drawn.set(scope, sorts);
  const container = scope.ui("sort-levels");

  container.replaceChildren(
    ...(sorts.length === 0
      ? [el("p", { className: "field-hint sort-empty", text: "No sorting. Streams stay in the provider's order." })]
      : sorts.map((sort, index) => renderLevel(scope, sort, index, sorts)))
  );

  const add = scope.ui<HTMLButtonElement>("add-stream-sort");
  add.disabled = sorts.length >= MAX_SORTS || !nextField(sorts);
  add.textContent = sorts.length === 0 ? "Add sort" : "Add another level";

  focusControl(scope, focus);
}

export function mountSortControls(scope: MiddlewareScope): void {
  // Levels need the field list, which arrives with the workspace.
  fieldsStore.subscribe(() => render(scope));

  // Settings can change from outside (loading a profile, importing a backup).
  scope.store.subscribe(({ sorts }) => {
    if (sorts !== drawn.get(scope)) render(scope);
  });

  scope.ui("add-stream-sort").addEventListener("click", () => {
    const { sorts } = scope.store.get();
    const field = nextField(sorts);
    if (!field || sorts.length >= MAX_SORTS) return;

    commit(
      scope,
      [...sorts, { field: field.key, direction: defaultDirection(field), unknown: "last" }],
      { index: sorts.length, control: "field" }
    );
  });

  render(scope);
}
