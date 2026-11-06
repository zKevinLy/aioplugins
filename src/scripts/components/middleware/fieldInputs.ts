// Inputs for filter values. The goal is that nothing needs typing when a
// picker makes more sense: presets become dropdowns, years a year list,
// dates a calendar, and sizes/durations a number with a unit.

import type {
  StreamFieldDefinition,
  StreamFieldOption,
  StreamFilterOperator,
  UnknownFilterAction
} from "../../../providers/stream-middleware.js";
import { el } from "../../core/dom.js";

type OperatorOption = [StreamFilterOperator, string];

const PRESENCE: OperatorOption[] = [["exists", "Has a value"], ["missing", "Is empty"]];

const TEXT_OPERATORS: OperatorOption[] = [
  ["contains", "Contains"], ["notContains", "Does not contain"],
  ["equals", "Equals"], ["notEquals", "Does not equal"],
  ...PRESENCE
];

const NUMBER_OPERATORS: OperatorOption[] = [
  ["equals", "Equals"], ["notEquals", "Does not equal"],
  ["gt", "Greater than"], ["gte", "At least"],
  ["lt", "Less than"], ["lte", "At most"],
  ...PRESENCE
];

const BOOLEAN_OPERATORS: OperatorOption[] = [
  ["isTrue", "Is true"], ["isFalse", "Is false"],
  ...PRESENCE
];

const DATE_OPERATORS: OperatorOption[] = [
  ["gte", "On or after"], ["lte", "On or before"],
  ["gt", "After"], ["lt", "Before"],
  ["equals", "On"], ["notEquals", "Not on"],
  ["exists", "Has a date"], ["missing", "Has no date"]
];

const EARLIEST_YEAR = 1900;

export function operatorsFor(field: StreamFieldDefinition | undefined): OperatorOption[] {
  if (!field) return TEXT_OPERATORS;

  switch (field.type) {
    case "boolean":
      return BOOLEAN_OPERATORS;
    case "date":
      return DATE_OPERATORS;
    case "number":
      return NUMBER_OPERATORS;
    case "list":
      return field.options?.length
        ? [["contains", "Includes"], ["notContains", "Excludes"], ...PRESENCE]
        : TEXT_OPERATORS;
    default:
      return field.options?.length
        ? [["equals", "Is"], ["notEquals", "Is not"], ...PRESENCE]
        : TEXT_OPERATORS;
  }
}

/**
 * What a filter does with a stream whose field is unknown when the rule makes
 * no explicit choice. Mirrors the server: "does not equal" and "does not
 * contain" keep such streams, every other operator removes them.
 */
export function defaultUnknownAction(operator: string): UnknownFilterAction {
  return operator === "notEquals" || operator === "notContains" ? "keep" : "drop";
}

function yearOptions(): StreamFieldOption[] {
  const latest = new Date().getFullYear() + 1;
  const years: StreamFieldOption[] = [];

  for (let year = latest; year >= EARLIEST_YEAR; year--) {
    years.push({ value: String(year), label: String(year) });
  }

  return years;
}

function selectEditor(
  options: StreamFieldOption[],
  current: string,
  onChange: (value: string) => void
): HTMLSelectElement {
  const select = el("select", { className: "filter-value" });
  select.append(new Option("Select…", ""));

  for (const option of options) select.append(new Option(option.label, option.value));

  // A saved value that is not in the preset list stays visible.
  if (current && !options.some((option) => option.value === current)) {
    select.append(new Option(current, current));
  }

  select.value = current;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function inputEditor(
  type: "text" | "number" | "date",
  current: string,
  onChange: (value: string) => void
): HTMLInputElement {
  const input = el("input", { className: "filter-value", attrs: { type } });

  if (type === "number") input.step = "any";
  if (type !== "date") input.placeholder = "Value";

  input.value = current;
  // `input` fires as the user picks, so the setting is never a click behind.
  input.addEventListener("input", () => onChange(input.value));
  return input;
}

function unitEditor(
  unitLabel: string,
  factor: number,
  current: string,
  onChange: (value: string) => void
): HTMLElement[] {
  const input = el("input", { className: "filter-value", attrs: { type: "number", min: "0", step: "any" } });
  input.placeholder = "Value";
  input.value = current ? String(+(Number(current) / factor).toFixed(3)) : "";

  // The box shows friendly units; the saved value is the raw number.
  input.addEventListener("input", () => {
    const shown = Number(input.value);
    onChange(input.value && Number.isFinite(shown) ? String(Math.round(shown * factor)) : "");
  });

  return [input, el("span", { className: "filter-unit", text: unitLabel })];
}

/** Builds the value control that suits `field`, wired to report changes. */
export function createValueEditor(
  field: StreamFieldDefinition | undefined,
  current: string,
  onChange: (value: string) => void
): HTMLElement {
  const cell = el("div", { className: "filter-value-cell" });

  if (field?.options?.length) {
    cell.append(selectEditor(field.options, current, onChange));
  } else if (field?.picker === "year") {
    cell.append(selectEditor(yearOptions(), current, onChange));
  } else if (field?.type === "date") {
    cell.append(inputEditor("date", current, onChange));
  } else if (field?.type === "number" && field.unit) {
    cell.append(...unitEditor(field.unit.label, field.unit.factor, current, onChange));
  } else {
    cell.append(inputEditor(field?.type === "number" ? "number" : "text", current, onChange));
  }

  return cell;
}

/** Direction labels that read naturally for the chosen sort field. */
export function sortDirectionLabels(
  field: StreamFieldDefinition | undefined
): { desc: string; asc: string } {
  if (!field) return { desc: "Descending", asc: "Ascending" };
  if (field.type === "date") return { desc: "Newest first", asc: "Oldest first" };
  if (field.ranked) return { desc: "Best first", asc: "Worst first" };
  if (field.type === "number") return { desc: "Highest first", asc: "Lowest first" };
  if (field.type === "boolean") return { desc: "Yes first", asc: "No first" };
  return { desc: "Z → A", asc: "A → Z" };
}
