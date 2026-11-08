
import { renderAioStreamsFormat } from "./custom-formatter.js";
import { probeStreamUrl } from "./stream-probe.js";
import { isUnknownValue, removeUnknownPlaceholders } from "./unknown-values.js";
import {
  DEFAULT_PROBE_SETTINGS,
  MAX_FILTERS,
  MAX_PROBE_TIMEOUT_MS,
  MAX_SORTS,
  MIN_PROBE_TIMEOUT_MS
} from "../lib/middleware-limits.js";
import {
  DEFAULT_STREAM_DESCRIPTION_FORMAT,
  DEFAULT_STREAM_NAME_FORMAT
} from "../lib/default-stream-format.js";

export type StreamFieldType = "text" | "number" | "boolean" | "list" | "date";

export interface StreamFieldOption {
  /** Value stored in the saved filter (for numbers: the plain number). */
  value: string;
  /** Text shown in the dropdown. */
  label: string;
}

export interface StreamFieldUnit {
  /** Unit shown next to the input, e.g. "GB". */
  label: string;
  /** How many stored units make one displayed unit. */
  factor: number;
}

export interface StreamFieldDefinition {
  key: string;
  label: string;
  type: StreamFieldType;
  /** Preset values offered instead of free typing. */
  options?: StreamFieldOption[];
  /** True when `options` are ordered best to worst, which also drives sorting. */
  ranked?: boolean;
  /** Friendly display unit for numbers stored in a smaller base unit. */
  unit?: StreamFieldUnit;
  /** Dedicated picker the UI should use instead of a plain input. */
  picker?: "year";
}

const same = (...values: string[]): StreamFieldOption[] =>
  values.map(value => ({ value, label: value }));

const RESOLUTION_OPTIONS: StreamFieldOption[] = [2160, 1440, 1080, 720, 576, 480]
  .map(value => ({ value: String(value), label: `${value}p` }));

export const STREAM_FIELD_CATALOG: StreamFieldDefinition[] = [
  { key: "title", label: "Title", type: "text" },
  { key: "filename", label: "Filename", type: "text" },
  { key: "date", label: "Release date", type: "date" },
  { key: "resolution", label: "Resolution", type: "number", ranked: true, options: RESOLUTION_OPTIONS },
  {
    key: "quality",
    label: "Quality",
    type: "text",
    ranked: true,
    options: same("BluRay REMUX", "BluRay", "WEB-DL", "WEBRip", "HDRip", "HDTV", "DVDRip", "SCR", "TS", "CAM")
  },
  { key: "year", label: "Year", type: "number", picker: "year" },
  { key: "seasons", label: "Seasons", type: "list" },
  { key: "episodes", label: "Episodes", type: "list" },
  { key: "seasonEpisode", label: "Season and episode", type: "list" },
  { key: "seasonPack", label: "Season pack", type: "boolean" },
  { key: "formattedSeasons", label: "Seasons", type: "text" },
  { key: "formattedEpisodes", label: "Episodes", type: "text" },
  { key: "seadexBest", label: "Best release", type: "boolean" },
  { key: "seadex", label: "SeaDex", type: "list" },
  { key: "rseMatched", label: "Release match", type: "list" },
  { key: "regexMatched", label: "Regex match", type: "text" },
  { key: "visualTags", label: "Visual tags", type: "list", options: same("DV", "HDR10+", "HDR10", "HDR", "10bit", "IMAX", "3D") },
  { key: "encode", label: "Encode", type: "text", ranked: true, options: same("AV1", "HEVC", "AVC", "VP9") },
  { key: "duration", label: "Duration", type: "number", unit: { label: "min", factor: 60_000 } },
  { key: "editions", label: "Editions", type: "list" },
  { key: "proper", label: "Proper", type: "boolean" },
  { key: "repack", label: "Repack", type: "boolean" },
  { key: "regraded", label: "Regraded", type: "boolean" },
  { key: "uncensored", label: "Uncensored", type: "boolean" },
  { key: "unrated", label: "Unrated", type: "boolean" },
  { key: "upscaled", label: "Upscaled", type: "boolean" },
  {
    key: "audioTags",
    label: "Audio tags",
    type: "list",
    options: same("Atmos", "TrueHD", "DTS-HD MA", "DTS:X", "DTS", "DD+", "DD", "FLAC", "Opus", "AAC")
  },
  { key: "audioChannels", label: "Audio channels", type: "list", options: same("7.1", "5.1", "2.0") },
  { key: "audioTracks", label: "Audio tracks", type: "list" },
  {
    key: "languages",
    label: "Languages",
    type: "list",
    options: same("English", "Italian", "Spanish", "French", "German", "Japanese", "Korean", "Hindi", "Multi")
  },
  {
    key: "subtitles",
    label: "Subtitles",
    type: "list",
    options: same("English", "Italian", "Spanish", "French", "German", "Japanese", "Korean", "Hindi")
  },
  { key: "subtitleTracks", label: "Subtitle tracks", type: "list" },
  { key: "dubbed", label: "Dubbed", type: "boolean" },
  { key: "subbed", label: "Subbed", type: "boolean" },
  { key: "size", label: "File size", type: "number", unit: { label: "GB", factor: 1e9 } },
  { key: "folderSize", label: "Folder size", type: "number", unit: { label: "GB", factor: 1e9 } },
  { key: "bitrate", label: "Bitrate", type: "number" },
  { key: "seeders", label: "Seeders", type: "number" },
  { key: "age", label: "Age", type: "text" },
  { key: "releaseGroup", label: "Release group", type: "text" },
  { key: "container", label: "Container", type: "text", options: same("mkv", "mp4", "avi") },
  { key: "extension", label: "Extension", type: "text" },
  { key: "indexer", label: "Indexer", type: "text" },
  { key: "network", label: "Network", type: "text" },
  { key: "cached", label: "Cached", type: "boolean" },
  { key: "service.cached", label: "Service cached", type: "boolean" },
  { key: "service.id", label: "Service", type: "text" },
  { key: "service.shortName", label: "Service short name", type: "text" },
  { key: "library", label: "In library", type: "boolean" },
  { key: "type", label: "Stream type", type: "text", options: same("http", "debrid", "usenet", "p2p") },
  { key: "proxied", label: "Proxied", type: "boolean" },
  { key: "private", label: "Private", type: "boolean" },
  { key: "message", label: "Message", type: "text" },
  { key: "url", label: "URL", type: "text" }
];

export type StreamFilterOperator =
  | "contains"
  | "notContains"
  | "equals"
  | "notEquals"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "isTrue"
  | "isFalse"
  | "exists"
  | "missing";

/** What a filter does with a stream whose field is unknown. */
export type UnknownFilterAction = "keep" | "drop";

export interface StreamFilter {
  field: string;
  operator: StreamFilterOperator;
  value: string;
  /**
   * Keep or drop streams where the field is unknown. When omitted, the
   * operator decides: negative operators ("does not equal", "does not
   * contain") keep them and every other operator drops them.
   */
  unknown?: UnknownFilterAction;
}

/** Where streams with an unknown value are placed within one sort level. */
export type UnknownSortPlacement = "first" | "last";

/** One level of a stacked sort. Later levels break ties in earlier ones. */
export interface StreamSort {
  field: string;
  direction: "asc" | "desc";
  unknown: UnknownSortPlacement;
}

/**
 * Optional check that runs inside Nuvio and drops streams whose URL clearly
 * cannot be played. AIOPlugins never plays or fetches the media itself.
 */
export interface StreamProbeSettings {
  enabled: boolean;
  /** Also drop streams whose server ignores byte-range requests. */
  requireSeekable: boolean;
  /** How long to wait for each URL before keeping the stream unchecked. */
  timeoutMs: number;
}

export const DEFAULT_STREAM_PROBE: StreamProbeSettings = DEFAULT_PROBE_SETTINGS;

export interface StreamMiddlewareSettings {
  filters: StreamFilter[];
  sorts: StreamSort[];
  probe: StreamProbeSettings;
  nameFormat: string;
  descriptionFormat: string;
  format: string;
  hideOriginalMetadata: boolean;
  /**
   * Which Nuvio field carries the formatted description. Nuvio's card shows
   * `size` and `language` when either exists and only falls back to `title`
   * when both are missing. "title" (default) leaves `size` alone; "size" is
   * for older Nuvio builds that never show `title`.
   */
  detailField: DetailField;
}

export type DetailField = "title" | "size";

export const DEFAULT_STREAM_MIDDLEWARE: StreamMiddlewareSettings = {
  filters: [],
  sorts: [],
  probe: DEFAULT_STREAM_PROBE,
  nameFormat: DEFAULT_STREAM_NAME_FORMAT,
  descriptionFormat: DEFAULT_STREAM_DESCRIPTION_FORMAT,
  format: DEFAULT_STREAM_DESCRIPTION_FORMAT,
  hideOriginalMetadata: false,
  detailField: "title"
};

const PREVIOUS_DEFAULT_STREAM_FORMAT = "{?{stream.resolution::replace('2160p', '🔥4K UHD')::replace('1440p', '✨ QHD')::replace('1080p', '🚀 FHD')::replace('720p', '💿 HD')::replace('576p', '💩 Low Quality')::replace('480p', '💩 Low Quality')::replace('360p', '💩 Low Quality')::replace('240p', '💩 Low Quality')::replace('144p', '💩 Low Quality')} · ?}{stream.title}{? · {stream.formattedSeasons}?}{? · {stream.formattedEpisodes}?}{? · 📦 {stream.size::sbytes}?}{? · 🎧 {stream.audioTags::join(' | ')}?}";

const LEGACY_DEFAULT_STREAM_FORMAT = PREVIOUS_DEFAULT_STREAM_FORMAT.replace(
  "{? · {stream.formattedSeasons}?}{? · {stream.formattedEpisodes}?}",
  ""
);

const MAX_FORMAT_LENGTH = 3000;

// Operators that never take a typed value.
const PRESENCE_OPERATORS: StreamFilterOperator[] = ["exists", "missing", "isTrue", "isFalse"];
// Operators that already ask about unknown values directly, so "keep or
// drop unknowns" would have nothing to add.
const UNKNOWN_AWARE_OPERATORS: StreamFilterOperator[] = ["exists", "missing"];
const DATE_OPERATORS: StreamFilterOperator[] = ["equals", "notEquals", "gt", "gte", "lt", "lte"];

function allowedOperators(type: StreamFieldType): StreamFilterOperator[] {
  if (type === "number") {
    return ["equals", "notEquals", "gt", "gte", "lt", "lte", "exists", "missing"];
  }
  if (type === "boolean") return ["isTrue", "isFalse", "exists", "missing"];
  if (type === "date") {
    // contains/notContains are accepted so filters saved when dates were
    // plain text keep working.
    return [...DATE_OPERATORS, "contains", "notContains", "exists", "missing"];
  }
  return ["contains", "notContains", "equals", "notEquals", "exists", "missing"];
}

function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));

  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function parseNumberValue(fieldKey: string, text: string): number | null {
  if (!text) return null;

  if (fieldKey === "resolution") {
    // Accept what the UI used to store ("1080p", "4K") as well as plain numbers.
    const pixels = /^(\d{3,4})p$/i.exec(text);
    if (pixels) return Number(pixels[1]);
    if (/^(4k|uhd)$/i.test(text)) return 2160;
  }

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Returns the canonical stored value, or null when the filter is unusable. */
function normalizeFilterValue(
  field: StreamFieldDefinition,
  operator: StreamFilterOperator,
  value: unknown
): string | null {
  if (PRESENCE_OPERATORS.includes(operator)) return "";

  const text = typeof value === "string" ? value.trim().slice(0, 100) : "";

  if (field.type === "number") {
    const parsed = parseNumberValue(field.key, text);
    return parsed === null ? null : String(parsed);
  }

  if (field.type === "date" && DATE_OPERATORS.includes(operator)) {
    return isIsoDate(text) ? text : null;
  }

  return text;
}

export function normalizeStreamMiddlewareSettings(
  value: unknown
): StreamMiddlewareSettings {
  const candidate =
    value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};

  const fields = new Map(STREAM_FIELD_CATALOG.map(field => [field.key, field]));
  const legacyFilters: StreamFilter[] = [];
  const legacyResolution = Number(candidate.minResolution);

  if ([720, 1080, 1440, 2160].includes(legacyResolution)) {
    legacyFilters.push({
      field: "resolution",
      operator: "gte",
      value: String(legacyResolution)
    });
  }

  if (candidate.cachedOnly === true) {
    legacyFilters.push({
      field: "cached",
      operator: "isTrue",
      value: ""
    });
  }

  if (Array.isArray(candidate.excludeKeywords)) {
    for (const keyword of candidate.excludeKeywords) {
      if (typeof keyword === "string" && keyword.trim()) {
        legacyFilters.push({
          field: "title",
          operator: "notContains",
          value: keyword.trim().slice(0, 100)
        });
      }
    }
  }

  const rawFilters = Array.isArray(candidate.filters)
    ? candidate.filters
    : legacyFilters;

  const filters = rawFilters
    .filter((filter): filter is Record<string, unknown> =>
      Boolean(filter && typeof filter === "object" && !Array.isArray(filter))
    )
    .flatMap(filter => {
      const field = fields.get(String(filter.field));
      const operator = String(filter.operator) as StreamFilterOperator;

      if (!field || !allowedOperators(field.type).includes(operator)) return [];

      const value = normalizeFilterValue(field, operator, filter.value);
      if (value === null) return [];

      const unknown: UnknownFilterAction | undefined =
        filter.unknown === "keep" ? "keep" :
        filter.unknown === "drop" ? "drop" :
        undefined;

      return [{
        field: field.key,
        operator,
        value,
        ...(unknown && !UNKNOWN_AWARE_OPERATORS.includes(operator) ? { unknown } : {})
      }];
    })
    .slice(0, MAX_FILTERS);

  const legacySortFields: Record<string, string> = {
    resolution: "resolution",
    size: "size",
    seeders: "seeders",
    title: "title"
  };

  // Settings saved before stacked sorts had a single sortField/sortDirection.
  // They are read as one level when no levels were saved.
  const requestedSortField = typeof candidate.sortField === "string"
    ? candidate.sortField
    : legacySortFields[String(candidate.sortBy)] || "";

  const legacyDirection =
    candidate.sortDirection === "asc" || candidate.sortDirection === "desc"
      ? candidate.sortDirection
      : candidate.sortBy === "title"
        ? "asc"
        : "desc";

  const rawSorts: unknown[] =
    Array.isArray(candidate.sorts) && candidate.sorts.length > 0
      ? candidate.sorts
      : [{ field: requestedSortField, direction: legacyDirection }];

  const sorts: StreamSort[] = [];

  for (const raw of rawSorts) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;

    const level = raw as Record<string, unknown>;
    const field = fields.get(String(level.field));

    // Sorting twice by the same field can never change the order.
    if (!field || sorts.some(sort => sort.field === field.key)) continue;

    sorts.push({
      field: field.key,
      direction: level.direction === "asc" ? "asc" : "desc",
      unknown: level.unknown === "first" ? "first" : "last"
    });

    if (sorts.length === MAX_SORTS) break;
  }

  const rawProbe =
    candidate.probe && typeof candidate.probe === "object" && !Array.isArray(candidate.probe)
      ? candidate.probe as Record<string, unknown>
      : {};

  const requestedTimeout = Number(rawProbe.timeoutMs);

  const probe: StreamProbeSettings = {
    enabled: rawProbe.enabled === true,
    requireSeekable: rawProbe.requireSeekable !== false,
    timeoutMs: Number.isFinite(requestedTimeout) && rawProbe.timeoutMs !== null && rawProbe.timeoutMs !== ""
      ? Math.min(MAX_PROBE_TIMEOUT_MS, Math.max(MIN_PROBE_TIMEOUT_MS, Math.round(requestedTimeout)))
      : DEFAULT_STREAM_PROBE.timeoutMs
  };

  const requestedNameFormat = typeof candidate.nameFormat === "string"
    ? candidate.nameFormat.trim()
    : "";

  const requestedDescriptionFormat = typeof candidate.descriptionFormat === "string"
    ? candidate.descriptionFormat.trim()
    : "";

  const requestedFormat = typeof candidate.format === "string"
    ? candidate.format.trim()
    : "";

  const hasSplitFormats =
    typeof candidate.nameFormat === "string" ||
    typeof candidate.descriptionFormat === "string";

  const legacyFormatOverridesSplit = requestedFormat &&
    (
      !hasSplitFormats ||
      (
        requestedFormat !== DEFAULT_STREAM_MIDDLEWARE.format &&
        requestedFormat !== requestedDescriptionFormat
      )
    );

  const selectedDescriptionFormat = legacyFormatOverridesSplit
    ? requestedFormat
    : requestedDescriptionFormat || requestedFormat;

  const normalizedPreviousFormat = selectedDescriptionFormat
    .replace(/\r\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

  const normalizedDefaultDescription = DEFAULT_STREAM_DESCRIPTION_FORMAT
    .replace(/\r\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

  const isPreviousDefault =
    normalizedPreviousFormat === normalizedDefaultDescription ||
    selectedDescriptionFormat === PREVIOUS_DEFAULT_STREAM_FORMAT ||
    selectedDescriptionFormat === LEGACY_DEFAULT_STREAM_FORMAT;

  const nameFormat = requestedNameFormat
    ? requestedNameFormat.slice(0, MAX_FORMAT_LENGTH)
    : DEFAULT_STREAM_NAME_FORMAT;

  const descriptionFormat = selectedDescriptionFormat && !isPreviousDefault
    ? selectedDescriptionFormat.slice(0, MAX_FORMAT_LENGTH)
    : DEFAULT_STREAM_DESCRIPTION_FORMAT;

  return {
    filters,
    sorts,
    probe,
    nameFormat,
    descriptionFormat,
    format: descriptionFormat,
    hideOriginalMetadata: candidate.hideOriginalMetadata === true,
    detailField: candidate.detailField === "size" ? "size" : "title"
  };
}

export function wrapPluginStreams(
  source: string,
  value: unknown,
  addonName = ""
): string {
  const settings = JSON.stringify(normalizeStreamMiddlewareSettings(value));
  const formattedAddonName = JSON.stringify(addonName);
  const formatterSource = renderAioStreamsFormat.toString();
  const unknownValueSource = isUnknownValue.toString();
  const removeUnknownSource = removeUnknownPlaceholders.toString();
  const probeSource = probeStreamUrl.toString();

  const fieldTypes = JSON.stringify(
    Object.fromEntries(STREAM_FIELD_CATALOG.map(field => [field.key, field.type]))
  );

  // Ranked text fields (quality, encode) sort by their position in the
  // preset list rather than alphabetically.
  const fieldRanks = JSON.stringify(
    Object.fromEntries(
      STREAM_FIELD_CATALOG
        .filter(field => field.ranked && field.type !== "number" && field.options)
        .map(field => [field.key, field.options!.map(option => option.value)])
    )
  );

  return `${source}
;(() => {
  const config = ${settings};
  const addonName = ${formattedAddonName};
  const __name = (target) => target;
  const renderAioStreamsFormat = ${formatterSource};
  ${unknownValueSource}
  ${removeUnknownSource}
  const probeStreamUrl = ${probeSource};
  const fieldTypes = ${fieldTypes};
  const fieldRanks = ${fieldRanks};
  const dateOperators = ["equals", "notEquals", "gt", "gte", "lt", "lte"];

  const plugin = typeof module !== "undefined" && module.exports
    ? module.exports
    : typeof exports !== "undefined" ? exports : null;

  if (!plugin || typeof plugin.getStreams !== "function") return;

  const originalGetStreams = plugin.getStreams;

  plugin.getStreams = async function (...args) {
    const result = await originalGetStreams.apply(this, args);
    if (!Array.isArray(result)) return result;

    const stripDecorativeCharacters = value => {
      if (typeof value !== "string") return value;

      return value
        .replace(/\\p{Extended_Pictographic}/gu, "")
        .replace(/[\\u200B-\\u200F\\uFE0E\\uFE0F\\u2060\\uFEFF]/g, "")
        .replace(/\\s{2,}/g, " ")
        .trim();
    };

    const getValue = (stream, path) => {
      if (path === "title") return stream.title ?? stream.name ?? "";

      if (path === "resolution") {
        const explicit = stream.resolution ?? stream.quality;
        if (explicit && !isUnknownValue(explicit, "resolution")) return explicit;

        const match = String(stream.title ?? stream.name ?? "")
          .match(/(?:2160|1440|1080|720|576|480|360|240|144)p|4k|uhd|qhd|fhd|hd/i);

        return match ? match[0] : "";
      }

      if (path === "size") return stream.size ?? stream.fileSize ?? "";
      if (path === "cached") return stream.cached ?? stream.service?.cached ?? "";
      if (path === "audioTags") return stream.audioTags ?? stream.audio ?? stream.audioCodec ?? "";
      if (path === "languages") return stream.languages ?? stream.language ?? "";

      return path.split(".").reduce(
        (value, key) => value == null ? "" : value[key],
        stream
      );
    };

    const stringify = value =>
      Array.isArray(value) ? value.join(" | ") : value == null ? "" : String(value);

    const resolutionNumber = stream => {
      const resolution = stringify(getValue(stream, "resolution")).toLowerCase();
      const match = resolution.match(/2160|1440|1080|720|576|480|360|240|144/);

      if (match) return Number(match[0]);
      if (/4k|uhd/.test(resolution)) return 2160;
      if (/qhd/.test(resolution)) return 1440;
      if (/fhd/.test(resolution)) return 1080;
      if (/hd/.test(resolution)) return 720;

      return 0;
    };

    // "Unknown", "N/A" and similar placeholders count as missing, like empty values.
    const hasValue = (value, field) => !isUnknownValue(value, field);

    // Whole days since the epoch, or null when the value is not a date.
    const dayNumber = value => {
      if (value == null || value === "") return null;

      let milliseconds = NaN;

      if (value instanceof Date) milliseconds = value.getTime();
      else if (typeof value === "number") {
        milliseconds = value >= 1e11 ? value : value >= 1e9 ? value * 1000 : NaN;
      } else {
        const text = String(value).trim();
        const parts = text.match(/(\\d{4})[-./](\\d{1,2})[-./](\\d{1,2})/);

        milliseconds = parts
          ? Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
          : Date.parse(text);
      }

      return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 864e5) : null;
    };

    const rankScore = (field, value) => {
      const order = fieldRanks[field];
      const normalize = text => String(text).toLowerCase().replace(/[^a-z0-9+]/g, "");
      let best = 0;

      for (const item of Array.isArray(value) ? value : [value]) {
        const key = normalize(item);
        if (!key) continue;

        let index = order.findIndex(entry => normalize(entry) === key);
        if (index === -1) index = order.findIndex(entry => key.includes(normalize(entry)));
        if (index !== -1) best = Math.max(best, order.length - index);
      }

      return best;
    };

    const prepareFormatterStream = stream => {
      const prepared = removeUnknownPlaceholders(stream);

      try {
        if (prepared.service && typeof prepared.service === "object") {
          prepared.service = { ...prepared.service };
        }
      } catch {
        delete prepared.service;
      }

      return prepared;
    };

    const numericValue = (stream, path) => {
      if (path === "resolution") return resolutionNumber(stream);

      const value = getValue(stream, path);

      if (typeof value === "number") return value;

      const match = stringify(value).match(
        /([-+]?[\\d.]+)\\s*(Gbps|Mbps|Kbps|TB|GB|MB|KB|B)?/i
      );

      if (!match) return 0;

      const factor = {
        B: 1,
        KB: 1e3,
        MB: 1e6,
        GB: 1e9,
        TB: 1e12,
        KBPS: 1e3,
        MBPS: 1e6,
        GBPS: 1e9
      }[(match[2] || "B").toUpperCase()] || 1;

      return Number(match[1]) * factor;
    };

    // Whether a stream whose field is unknown passes this filter.
    const unknownOutcome = filter =>
      filter.unknown
        ? filter.unknown === "keep"
        : filter.operator === "notEquals" || filter.operator === "notContains";

    const filterMatches = (stream, filter) => {
      const value = getValue(stream, filter.field);
      const type = fieldTypes[filter.field] || "text";

      if (filter.operator === "exists") return hasValue(value, filter.field);
      if (filter.operator === "missing") return !hasValue(value, filter.field);
      if (!hasValue(value, filter.field)) return unknownOutcome(filter);

      if (filter.operator === "isTrue") {
        return value === true || value === 1 || String(value).toLowerCase() === "true";
      }

      if (filter.operator === "isFalse") {
        return value === false || value === 0 || String(value).toLowerCase() === "false";
      }

      if (type === "date" && dateOperators.includes(filter.operator)) {
        const expected = dayNumber(filter.value);
        if (expected === null) return true;

        const actual = dayNumber(value);
        if (actual === null) return unknownOutcome(filter);
        if (filter.operator === "equals") return actual === expected;
        if (filter.operator === "notEquals") return actual !== expected;
        if (filter.operator === "gt") return actual > expected;
        if (filter.operator === "gte") return actual >= expected;
        if (filter.operator === "lt") return actual < expected;
        return actual <= expected;
      }

      if (type === "number") {
        const actual = numericValue(stream, filter.field);
        const expected = Number(filter.value);

        if (!Number.isFinite(expected)) return true;
        if (filter.operator === "equals") return actual === expected;
        if (filter.operator === "notEquals") return actual !== expected;
        if (filter.operator === "gt") return actual > expected;
        if (filter.operator === "gte") return actual >= expected;
        if (filter.operator === "lt") return actual < expected;
        if (filter.operator === "lte") return actual <= expected;
      }

      const actual = stringify(value).toLowerCase();
      const expected = String(filter.value).toLowerCase();

      if (filter.operator === "contains") return actual.includes(expected);
      if (filter.operator === "notContains") return !actual.includes(expected);
      if (filter.operator === "equals") return actual === expected;
      if (filter.operator === "notEquals") return actual !== expected;

      return true;
    };

    const formatFallback = (format, stream) => {
      const tokenValue = expression => {
        const parts = expression.split("::");
        const path = parts.shift().replace(/^stream\\./, "");
        let value = getValue(stream, path);

        for (const operation of parts) {
          let match = operation.match(/^replace\\(['"](.*?)['"],\\s*['"](.*?)['"]\\)$/);

          if (match) {
            value = stringify(value).split(match[1]).join(match[2]);
            continue;
          }

          match = operation.match(/^join\\(['"](.*?)['"]\\)$/);

          if (match) {
            value = Array.isArray(value) ? value.join(match[1]) : stringify(value);
            continue;
          }

          if (operation === "title") {
            value = stringify(value).replace(/\\b\\w/g, character => character.toUpperCase());
          } else if (operation === "sbytes" && Number.isFinite(Number(value))) {
            const units = ["B", "KB", "MB", "GB", "TB"];
            let size = Number(value);
            let unit = 0;

            while (size >= 1000 && unit < units.length - 1) {
              size /= 1000;
              unit++;
            }

            value = size.toFixed(unit ? 1 : 0) + " " + units[unit];
          }
        }

        return stringify(value);
      };

      const optional = format.replace(
        /\\{\\?([\\s\\S]*?)\\?\\}/g,
        (_block, contents) => {
          const tokens = [...contents.matchAll(/\\{stream\\.([^{}]+)\\}/g)];

          return tokens.some(([, expression]) => tokenValue(expression))
            ? contents
            : "";
        }
      );

      return optional
        .replace(/\\{stream\\.([^{}]+)\\}/g, (_token, expression) => tokenValue(expression))
        .trim();
    };

    // ---- Nuvio output -------------------------------------------------
    // Nuvio's plugin runtime keeps only: title, name, url, quality, size,
    // language, provider, type, seeders, peers, infoHash, headers, subtitles and
    // behaviorHints.audioDelay*. Its card shows name, then size and language
    // (or title when neither exists). Anything else a plugin returns is dropped.

    const canonicalResolution = value => {
      const text = stringify(value).toLowerCase();
      const match = text.match(/(2160|1440|1080|720|576|480|360|240|144)p?/);

      if (match) return match[1] + "p";
      if (/4k|uhd/.test(text)) return "2160p";
      if (/qhd/.test(text)) return "1440p";
      if (/fhd/.test(text)) return "1080p";
      if (/\\bhd\\b/.test(text)) return "720p";

      return "";
    };

    // Nuvio appends " - Unknown" to the name whenever quality is missing, so a
    // value is always sent: the resolution, the provider's own label, or "Unknown".
    const nuvioQuality = (original, normalized) => {
      const resolved = canonicalResolution(normalized.resolution) ||
        canonicalResolution(original.quality);
      if (resolved) return resolved;

      const own = stringify(original.quality).trim();
      return own && !isUnknownValue(own, "quality") ? own : "Unknown";
    };

    const toNuvioStream = (original, normalized, name, description) => {
      const output = { ...normalized };
      const bytes = Math.round(numericValue(normalized, "size")) ||
        Math.round(numericValue(normalized, "fileSize")) || 0;
      const filename = stringify(normalized.filename).trim();
      const hints = original.behaviorHints && typeof original.behaviorHints === "object" &&
        !Array.isArray(original.behaviorHints) ? { ...original.behaviorHints } : {};

      // The description must not be hidden behind, or doubled by, these two.
      delete output.size;
      delete output.language;
      delete output.fileSize;

      output.name = name;
      output.title = description;
      output.description = description;
      output.quality = nuvioQuality(original, normalized);

      if (config.detailField === "size") output.size = description;

      if (bytes > 0) {
        output.fileSize = bytes;
        if (hints.videoSize === undefined) hints.videoSize = bytes;
      }

      if (filename && hints.filename === undefined) hints.filename = filename;
      if (Object.keys(hints).length > 0) output.behaviorHints = hints;

      return output;
    };

    const candidates = result
      .filter(stream => stream && typeof stream === "object")
      .map((stream, index) => {
        const original = { ...stream };
        const normalized = { ...stream };

        // Remove decorative emoji from provider-supplied display text.
        // Unicode letters from all languages are preserved.
        for (const key of ["name", "title", "description"]) {
          if (typeof normalized[key] === "string") {
            normalized[key] = stripDecorativeCharacters(normalized[key]);
          }
        }

        let name = stringify(normalized.name ?? normalized.title ?? "");

        try {
          name = renderAioStreamsFormat(
            config.nameFormat,
            prepareFormatterStream(normalized),
            addonName
          );
        } catch {
          name = formatFallback(config.nameFormat, normalized) || name;
        }

        let description = stringify(normalized.title ?? normalized.description ?? "");
        const descriptionInput = prepareFormatterStream(normalized);

        try {
          description = renderAioStreamsFormat(
            config.descriptionFormat,
            descriptionInput,
            addonName
          );
        } catch {
          description = formatFallback(config.descriptionFormat, normalized) || description;
        }

        for (const [key, value] of Object.entries(descriptionInput)) {
          if (key !== "service") normalized[key] = value;
        }

        const formatted = toNuvioStream(original, normalized, name, description);

        const sourceStream = { ...normalized };

        return {
          stream: formatted,
          source: sourceStream,
          index
        };
      })
      .filter(item =>
        config.filters.every(filter => filterMatches(item.source, filter))
      );

    // Drops streams whose URL clearly cannot be played (or, if asked, seeked).
    // The probe runs here, in Nuvio; AIOPlugins never plays the media. Streams
    // the probe cannot judge (timeouts, network errors, no http URL) are kept.
    const probeHeaders = stream =>
      stream.headers ?? stream.behaviorHints?.proxyHeaders?.request ?? null;

    const dropUnplayable = async items => {
      const { requireSeekable, timeoutMs } = config.probe;
      const deadline = Date.now() + timeoutMs * 3;
      const probes = new Map();
      const outcomes = new Array(items.length).fill(null);
      let next = 0;

      const worker = async () => {
        while (next < items.length) {
          const position = next++;
          const url = items[position].source.url;
          if (typeof url !== "string" || Date.now() >= deadline) continue;

          if (!probes.has(url)) {
            probes.set(url, probeStreamUrl(url, probeHeaders(items[position].source), timeoutMs));
          }

          outcomes[position] = await probes.get(url);
        }
      };

      await Promise.all(Array.from({ length: Math.min(8, items.length) }, worker));

      return items.filter((_item, position) => {
        const outcome = outcomes[position];
        if (!outcome) return true;
        if (outcome.playable === false) return false;
        return !(requireSeekable && outcome.seekable === false);
      });
    };

    const streams = config.probe.enabled ? await dropUnplayable(candidates) : candidates;

    const isTrue = value =>
      value === true || value === 1 || String(value).toLowerCase() === "true";

    // Orders two streams by one sort level; 0 means this level cannot tell them apart.
    const compareBySort = (left, right, sort) => {
      const leftValue = getValue(left.source, sort.field);
      const rightValue = getValue(right.source, sort.field);
      const leftKnown = hasValue(leftValue, sort.field);
      const rightKnown = hasValue(rightValue, sort.field);

      // Unknown values sit at one end whichever way the sort runs, and tie with
      // each other so the next level can order them.
      if (!leftKnown || !rightKnown) {
        if (leftKnown === rightKnown) return 0;
        return leftKnown === (sort.unknown === "first") ? 1 : -1;
      }

      const sortType = fieldTypes[sort.field];
      let comparison;

      if (fieldRanks[sort.field] && sortType !== "number") {
        comparison = rankScore(sort.field, leftValue) - rankScore(sort.field, rightValue);
      } else if (sortType === "number") {
        comparison = numericValue(left.source, sort.field) -
          numericValue(right.source, sort.field);
      } else if (sortType === "date") {
        comparison = (dayNumber(leftValue) ?? 0) - (dayNumber(rightValue) ?? 0);
      } else if (sortType === "boolean") {
        comparison = Number(isTrue(leftValue)) - Number(isTrue(rightValue));
      } else {
        comparison = stringify(leftValue).localeCompare(
          stringify(rightValue),
          undefined,
          { numeric: true, sensitivity: "base" }
        );
      }

      return (comparison || 0) * (sort.direction === "asc" ? 1 : -1);
    };

    // Each level only breaks ties left by the levels before it; streams still
    // tied after the last level keep the provider's own order.
    streams.sort((left, right) => {
      for (const sort of config.sorts) {
        const result = compareBySort(left, right, sort);
        if (result !== 0) return result;
      }

      return left.index - right.index;
    });

    return streams.map(item => {
      return { ...item.stream };
    });
  };
})();
`;
}
