// Stream middleware settings (filters, sorting, formatter) as edited in the UI.

import {
  DEFAULT_STREAM_DESCRIPTION_FORMAT,
  DEFAULT_STREAM_NAME_FORMAT
} from "../../lib/default-stream-format.js";
import type { StreamFilter, StreamProbeSettings, StreamSort } from "../../providers/stream-middleware.js";
import {
  DEFAULT_PROBE_SETTINGS,
  MAX_FILTERS,
  MAX_PROBE_TIMEOUT_MS,
  MAX_SORTS,
  MIN_PROBE_TIMEOUT_MS
} from "../../lib/middleware-limits.js";
import { isRecord, isStreamFilter, isStreamSort, VALUELESS_OPERATORS } from "../core/guards.js";
import { createStore } from "../core/store.js";
import type { MiddlewareSettings } from "../core/types.js";

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** The sort levels to edit: saved levels, or a single level from older settings. */
function toSorts(settings: Record<string, unknown>): StreamSort[] {
  if (Array.isArray(settings.sorts) && settings.sorts.length > 0) {
    return settings.sorts.filter(isStreamSort).slice(0, MAX_SORTS);
  }

  return typeof settings.sortField === "string" && settings.sortField
    ? [{
        field: settings.sortField,
        direction: settings.sortDirection === "asc" ? "asc" : "desc",
        unknown: "last"
      }]
    : [];
}

/** The probe options to edit, filled in with defaults where nothing was saved. */
function toProbe(settings: Record<string, unknown>): StreamProbeSettings {
  const raw = isRecord(settings.probe) ? settings.probe : {};
  const timeout = typeof raw.timeoutMs === "number" ? raw.timeoutMs : NaN;

  return {
    enabled: raw.enabled === true,
    requireSeekable: raw.requireSeekable !== false,
    timeoutMs: Number.isFinite(timeout)
      ? Math.min(MAX_PROBE_TIMEOUT_MS, Math.max(MIN_PROBE_TIMEOUT_MS, Math.round(timeout)))
      : DEFAULT_PROBE_SETTINGS.timeoutMs
  };
}

/** Turns whatever the server stored into complete editor settings. */
export function toMiddlewareSettings(value: unknown): MiddlewareSettings {
  const settings = isRecord(value) ? value : {};

  return {
    filters: Array.isArray(settings.filters) ? settings.filters.filter(isStreamFilter) : [],
    sorts: toSorts(settings),
    probe: toProbe(settings),
    nameFormat: nonEmpty(settings.nameFormat) ?? DEFAULT_STREAM_NAME_FORMAT,
    descriptionFormat:
      nonEmpty(settings.descriptionFormat) ??
      nonEmpty(settings.format) ??
      DEFAULT_STREAM_DESCRIPTION_FORMAT,
    detailField: settings.detailField === "size" ? "size" : "title"
  };
}

export const middlewareStore = createStore<MiddlewareSettings>(toMiddlewareSettings(undefined));

function isFilterComplete(filter: StreamFilter): boolean {
  return VALUELESS_OPERATORS.includes(filter.operator) || filter.value.trim() !== "";
}

/** The settings as they should be saved: unfinished filter rows are left out. */
export function middlewarePayload(): MiddlewareSettings {
  const settings = middlewareStore.get();

  return {
    ...settings,
    filters: settings.filters.filter(isFilterComplete).slice(0, MAX_FILTERS),
    sorts: settings.sorts.slice(0, MAX_SORTS)
  };
}

export const STREAM_FORMAT_PRESETS: Record<string, string> = {
  detailed: DEFAULT_STREAM_DESCRIPTION_FORMAT,
  compact: "{stream.title}{? · {stream.resolution}?}{? · {stream.size::sbytes}?}",
  title: "{stream.title}"
};
