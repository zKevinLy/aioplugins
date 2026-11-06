// Runtime checks for data that crosses a trust boundary (server JSON,
// imported files, saved settings).

import type {
  StreamFilter,
  StreamFilterOperator,
  StreamSort
} from "../../providers/stream-middleware.js";
import type { ProfileBackup, SavedSource } from "./types.js";

const FILTER_OPERATORS: readonly string[] = [
  "contains", "notContains", "equals", "notEquals", "gt", "gte",
  "lt", "lte", "isTrue", "isFalse", "exists", "missing"
];

/** Operators that never take a value. */
export const VALUELESS_OPERATORS: readonly string[] = [
  "exists", "missing", "isTrue", "isFalse"
];

/** Operators that already test for unknown values, so a keep/drop choice adds nothing. */
export const UNKNOWN_AWARE_OPERATORS: readonly string[] = ["exists", "missing"];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

export function isStreamFilterOperator(value: string): value is StreamFilterOperator {
  return FILTER_OPERATORS.includes(value);
}

export function isStreamFilter(value: unknown): value is StreamFilter {
  return isRecord(value) &&
    typeof value.field === "string" &&
    typeof value.operator === "string" &&
    isStreamFilterOperator(value.operator) &&
    typeof value.value === "string" &&
    (value.unknown === undefined || value.unknown === "keep" || value.unknown === "drop");
}

export function isStreamSort(value: unknown): value is StreamSort {
  return isRecord(value) &&
    typeof value.field === "string" &&
    (value.direction === "asc" || value.direction === "desc") &&
    (value.unknown === "first" || value.unknown === "last");
}

export function parseJsonRecord(value: string, message: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error(message);
  return parsed;
}

function isSavedSource(value: unknown): value is SavedSource {
  return isRecord(value) &&
    typeof value.repository === "string" &&
    typeof value.ref === "string" &&
    Array.isArray(value.providerIds) &&
    value.providerIds.every((id) => typeof id === "string") &&
    (value.commit === undefined || typeof value.commit === "string");
}

export function parseProfileBackup(value: unknown): ProfileBackup {
  if (
    !isRecord(value) ||
    value.format !== "aioplugins-profile" ||
    value.version !== 1 ||
    !Array.isArray(value.sources) ||
    !value.sources.every(isSavedSource)
  ) {
    throw new Error("This file is not a valid AIOPlugins backup.");
  }

  return {
    format: "aioplugins-profile",
    version: 1,
    // Commits are dropped on purpose: a backup should restore against the
    // current state of each source, not fail because a branch moved.
    sources: value.sources.map(({ repository, ref, providerIds }) => ({
      repository,
      ref,
      providerIds
    })),
    middleware: value.middleware
  };
}
