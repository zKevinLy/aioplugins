// "Stream order": which field to sort by and in which direction.

import { $ } from "../../core/dom.js";
import { middlewareStore } from "../../state/middleware.js";
import { fieldsStore, findField } from "../../state/workspace.js";
import { sortDirectionLabels } from "./fieldInputs.js";

const fieldSelect = () => $<HTMLSelectElement>("#stream-sort-field");
const directionSelect = () => $<HTMLSelectElement>("#stream-sort-direction");

function renderFieldOptions(): void {
  fieldSelect().replaceChildren(
    new Option("Provider order", ""),
    ...fieldsStore.get().map((field) => new Option(field.label, field.key))
  );
  render();
}

function render(): void {
  const { sortField, sortDirection } = middlewareStore.get();
  const labels = sortDirectionLabels(findField(sortField));

  fieldSelect().value = sortField;
  // A saved field the server no longer offers falls back to provider order.
  if (fieldSelect().value !== sortField) fieldSelect().value = "";

  for (const option of directionSelect().options) {
    option.textContent = option.value === "desc" ? labels.desc : labels.asc;
  }

  directionSelect().value = sortDirection;
  directionSelect().disabled = !fieldSelect().value;
}

export function mountSortControls(): void {
  fieldsStore.subscribe(renderFieldOptions);
  middlewareStore.subscribe(render);

  fieldSelect().addEventListener("change", () => {
    middlewareStore.update((settings) => ({ ...settings, sortField: fieldSelect().value }));
  });

  directionSelect().addEventListener("change", () => {
    middlewareStore.update((settings) => ({
      ...settings,
      sortDirection: directionSelect().value === "asc" ? "asc" : "desc"
    }));
  });

  renderFieldOptions();
}
