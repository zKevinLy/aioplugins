// "Stream filters": the editable list of filter rules.

import type { StreamFilter } from "../../../providers/stream-middleware.js";
import { el } from "../../core/dom.js";
import {
  isStreamFilterOperator,
  UNKNOWN_AWARE_OPERATORS,
  VALUELESS_OPERATORS
} from "../../core/guards.js";
import { fieldsStore, findField } from "../../state/workspace.js";
import { createValueEditor, defaultUnknownAction, operatorsFor } from "./fieldInputs.js";
import type { MiddlewareScope } from "./scope.js";

// The array currently drawn, per editor. Edits that keep this array do not
// redraw, so typing in a value box never loses focus.
const drawn = new WeakMap<MiddlewareScope, StreamFilter[] | null>();

function commit(scope: MiddlewareScope, filters: StreamFilter[], redraw: boolean): void {
  if (redraw) drawn.set(scope, null);
  scope.store.update((settings) => ({ ...settings, filters }));
}

function renderRule(
  scope: MiddlewareScope,
  rule: StreamFilter,
  index: number,
  rules: StreamFilter[]
): HTMLElement {
  const fieldSelect = el("select", { className: "filter-field" });
  fieldSelect.append(...fieldsStore.get().map((field) => new Option(field.label, field.key)));
  fieldSelect.value = rule.field;

  const operators = operatorsFor(findField(rule.field));
  const operatorSelect = el("select", { className: "filter-operator" });
  operatorSelect.append(...operators.map(([value, label]) => new Option(label, value)));

  const operator = operators.some(([value]) => value === rule.operator)
    ? rule.operator
    : (operators[0]?.[0] ?? "contains");
  operatorSelect.value = operator;
  rule.operator = operator;

  const valueCell = createValueEditor(findField(rule.field), rule.value, (value) => {
    rule.value = value;
    commit(scope, rules, false);
  });

  const syncValueVisibility = () => {
    valueCell.style.display = VALUELESS_OPERATORS.includes(operatorSelect.value) ? "none" : "";
  };
  syncValueVisibility();

  // What happens to a stream that has no value for this field. "Has a value"
  // and "Is empty" already answer that, so the choice is hidden for them.
  const unknownSelect = el("select", { className: "filter-unknown-select" });
  unknownSelect.append(new Option("Remove the stream", "drop"), new Option("Keep the stream", "keep"));
  const unknownControl = el(
    "label",
    { className: "filter-unknown" },
    el("span", { text: "If the value is unknown" }),
    unknownSelect
  );

  const syncUnknown = () => {
    unknownControl.hidden = UNKNOWN_AWARE_OPERATORS.includes(operatorSelect.value);
    unknownSelect.value = rule.unknown ?? defaultUnknownAction(operatorSelect.value);
  };
  syncUnknown();

  unknownSelect.addEventListener("change", () => {
    rule.unknown = unknownSelect.value === "keep" ? "keep" : "drop";
    commit(scope, rules, false);
  });

  fieldSelect.addEventListener("change", () => {
    const next = rules.map((entry, position) => {
      if (position !== index) return entry;
      const available = operatorsFor(findField(fieldSelect.value));
      const keep = available.some(([value]) => value === entry.operator);
      return {
        field: fieldSelect.value,
        operator: keep ? entry.operator : (available[0]?.[0] ?? "contains"),
        value: ""
      };
    });
    commit(scope, next, true);
  });

  operatorSelect.addEventListener("change", () => {
    if (isStreamFilterOperator(operatorSelect.value)) rule.operator = operatorSelect.value;
    syncValueVisibility();
    syncUnknown();
    commit(scope, rules, false);
  });

  const remove = el("button", {
    className: "button button-small filter-remove",
    text: "Remove",
    attrs: { type: "button", "aria-label": `Remove ${rule.field} filter` }
  });
  remove.addEventListener("click", () => {
    commit(scope, rules.filter((_, position) => position !== index), true);
  });

  return el(
    "div",
    { className: "filter-rule" },
    fieldSelect,
    operatorSelect,
    valueCell,
    remove,
    unknownControl
  );
}

function renderRules(scope: MiddlewareScope): void {
  const rules = scope.store.get().filters;
  const container = scope.ui("filter-rules");
  drawn.set(scope, rules);

  if (rules.length === 0) {
    container.replaceChildren(el("p", { className: "field-hint filter-empty", text: "No filters added." }));
    return;
  }

  container.replaceChildren(...rules.map((rule, index) => renderRule(scope, rule, index, rules)));
}

export function mountFilterEditor(scope: MiddlewareScope): void {
  const refresh = () => {
    if (scope.store.get().filters !== drawn.get(scope)) renderRules(scope);
  };

  scope.store.subscribe(refresh);
  // Rules need the field list, which arrives with the workspace.
  fieldsStore.subscribe(() => renderRules(scope));

  scope.ui("add-stream-filter").addEventListener("click", () => {
    const first = fieldsStore.get()[0];
    if (!first) return;

    commit(
      scope,
      [
        ...scope.store.get().filters,
        { field: first.key, operator: operatorsFor(first)[0]?.[0] ?? "contains", value: "" }
      ],
      true
    );
  });

  renderRules(scope);
}
