// Stream middleware settings (filters, sorting, formatter) as edited in the UI.

import {
  DEFAULT_STREAM_DESCRIPTION_FORMAT,
  DEFAULT_STREAM_NAME_FORMAT
} from "../../lib/default-stream-format.js";
import type { StreamFilter } from "../../providers/stream-middleware.js";
import { isRecord, isStreamFilter, VALUELESS_OPERATORS } from "../core/guards.js";
import { createStore } from "../core/store.js";
import type { MiddlewareSettings } from "../core/types.js";

const MAX_FILTERS = 30;

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Turns whatever the server stored into complete editor settings. */
export function toMiddlewareSettings(value: unknown): MiddlewareSettings {
  const settings = isRecord(value) ? value : {};

  return {
    filters: Array.isArray(settings.filters) ? settings.filters.filter(isStreamFilter) : [],
    sortField: typeof settings.sortField === "string" ? settings.sortField : "",
    sortDirection: settings.sortDirection === "asc" ? "asc" : "desc",
    nameFormat: nonEmpty(settings.nameFormat) ?? DEFAULT_STREAM_NAME_FORMAT,
    descriptionFormat:
      nonEmpty(settings.descriptionFormat) ??
      nonEmpty(settings.format) ??
      DEFAULT_STREAM_DESCRIPTION_FORMAT
  };
}

export const middlewareStore = createStore<MiddlewareSettings>(toMiddlewareSettings(undefined));

export function isFilterComplete(filter: StreamFilter): boolean {
  return VALUELESS_OPERATORS.includes(filter.operator) || filter.value.trim() !== "";
}

/** The settings as they should be saved: unfinished filter rows are left out. */
export function middlewarePayload(): MiddlewareSettings {
  const settings = middlewareStore.get();

  return {
    ...settings,
    filters: settings.filters.filter(isFilterComplete).slice(0, MAX_FILTERS)
  };
}

export const STREAM_FORMAT_PRESETS: Record<string, string> = {
  detailed: DEFAULT_STREAM_DESCRIPTION_FORMAT,
  compact: "{stream.title}{? · {stream.resolution}?}{? · {stream.size::sbytes}?}",
  title: "{stream.title}"
};
