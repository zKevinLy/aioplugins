import { renderAioStreamsFormat } from "./custom-formatter.js";
import {
  DEFAULT_STREAM_DESCRIPTION_FORMAT,
  DEFAULT_STREAM_NAME_FORMAT
} from "../lib/default-stream-format.js";

export type StreamFieldType = "text" | "number" | "boolean" | "list";

export interface StreamFieldDefinition {
  key: string;
  label: string;
  type: StreamFieldType;
}

export const STREAM_FIELD_CATALOG: StreamFieldDefinition[] = [
  { key: "title", label: "Title", type: "text" },
  { key: "filename", label: "Filename", type: "text" },
  { key: "date", label: "Release date", type: "text" },
  { key: "resolution", label: "Resolution", type: "number" },
  { key: "quality", label: "Quality", type: "text" },
  { key: "year", label: "Year", type: "number" },
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
  { key: "visualTags", label: "Visual tags", type: "list" },
  { key: "encode", label: "Encode", type: "text" },
  { key: "duration", label: "Duration", type: "number" },
  { key: "editions", label: "Editions", type: "list" },
  { key: "proper", label: "Proper", type: "boolean" },
  { key: "repack", label: "Repack", type: "boolean" },
  { key: "regraded", label: "Regraded", type: "boolean" },
  { key: "uncensored", label: "Uncensored", type: "boolean" },
  { key: "unrated", label: "Unrated", type: "boolean" },
  { key: "upscaled", label: "Upscaled", type: "boolean" },
  { key: "audioTags", label: "Audio tags", type: "list" },
  { key: "audioChannels", label: "Audio channels", type: "list" },
  { key: "audioTracks", label: "Audio tracks", type: "list" },
  { key: "languages", label: "Languages", type: "list" },
  { key: "subtitles", label: "Subtitles", type: "list" },
  { key: "subtitleTracks", label: "Subtitle tracks", type: "list" },
  { key: "dubbed", label: "Dubbed", type: "boolean" },
  { key: "subbed", label: "Subbed", type: "boolean" },
  { key: "size", label: "File size", type: "number" },
  { key: "folderSize", label: "Folder size", type: "number" },
  { key: "bitrate", label: "Bitrate", type: "number" },
  { key: "seeders", label: "Seeders", type: "number" },
  { key: "age", label: "Age", type: "text" },
  { key: "releaseGroup", label: "Release group", type: "text" },
  { key: "container", label: "Container", type: "text" },
  { key: "extension", label: "Extension", type: "text" },
  { key: "indexer", label: "Indexer", type: "text" },
  { key: "network", label: "Network", type: "text" },
  { key: "cached", label: "Cached", type: "boolean" },
  { key: "service.cached", label: "Service cached", type: "boolean" },
  { key: "service.id", label: "Service", type: "text" },
  { key: "service.shortName", label: "Service short name", type: "text" },
  { key: "library", label: "In library", type: "boolean" },
  { key: "type", label: "Stream type", type: "text" },
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

export interface StreamFilter {
  field: string;
  operator: StreamFilterOperator;
  value: string;
}

export interface StreamMiddlewareSettings {
  filters: StreamFilter[];
  sortField: string;
  sortDirection: "asc" | "desc";
  nameFormat: string;
  descriptionFormat: string;
  format: string;
}

export const DEFAULT_STREAM_MIDDLEWARE: StreamMiddlewareSettings = {
  filters: [],
  sortField: "",
  sortDirection: "desc",
  nameFormat: DEFAULT_STREAM_NAME_FORMAT,
  descriptionFormat: DEFAULT_STREAM_DESCRIPTION_FORMAT,
  format: DEFAULT_STREAM_DESCRIPTION_FORMAT
};

const PREVIOUS_DEFAULT_STREAM_FORMAT = "{?{stream.resolution::replace('2160p', '🔥4K UHD')::replace('1440p', '✨ QHD')::replace('1080p', '🚀 FHD')::replace('720p', '💿 HD')::replace('576p', '💩 Low Quality')::replace('480p', '💩 Low Quality')::replace('360p', '💩 Low Quality')::replace('240p', '💩 Low Quality')::replace('144p', '💩 Low Quality')} · ?}{stream.title}{? · {stream.formattedSeasons}?}{? · {stream.formattedEpisodes}?}{? · 📦 {stream.size::sbytes}?}{? · 🎧 {stream.audioTags::join(' | ')}?}";
const LEGACY_DEFAULT_STREAM_FORMAT = PREVIOUS_DEFAULT_STREAM_FORMAT.replace(
  "{? · {stream.formattedSeasons}?}{? · {stream.formattedEpisodes}?}",
  ""
);

const MAX_FORMAT_LENGTH = 3000;
const MAX_FILTERS = 30;

function allowedOperators(type: StreamFieldType): StreamFilterOperator[] {
  if (type === "number") {
    return ["equals", "notEquals", "gt", "gte", "lt", "lte", "exists", "missing"];
  }
  if (type === "boolean") return ["isTrue", "isFalse", "exists", "missing"];
  return ["contains", "notContains", "equals", "notEquals", "exists", "missing"];
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
    legacyFilters.push({ field: "resolution", operator: "gte", value: String(legacyResolution) });
  }
  if (candidate.cachedOnly === true) {
    legacyFilters.push({ field: "cached", operator: "isTrue", value: "" });
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
      if (
        field.type === "number" &&
        !["exists", "missing"].includes(operator) &&
        !Number.isFinite(Number(filter.value))
      ) return [];
      return [{
        field: field.key,
        operator,
        value: typeof filter.value === "string" ? filter.value.slice(0, 100) : ""
      }];
    })
    .slice(0, MAX_FILTERS);
  const legacySortFields: Record<string, string> = {
    resolution: "resolution",
    size: "size",
    seeders: "seeders",
    title: "title"
  };
  const requestedSortField = typeof candidate.sortField === "string"
    ? candidate.sortField
    : legacySortFields[String(candidate.sortBy)] || "";
  const sortField = fields.has(requestedSortField) ? requestedSortField : "";
  const sortDirection = candidate.sortDirection === "asc" || candidate.sortDirection === "desc"
    ? candidate.sortDirection
    : candidate.sortBy === "title" ? "asc" : DEFAULT_STREAM_MIDDLEWARE.sortDirection;
  const requestedNameFormat = typeof candidate.nameFormat === "string"
    ? candidate.nameFormat.trim()
    : "";
  const requestedDescriptionFormat = typeof candidate.descriptionFormat === "string"
    ? candidate.descriptionFormat.trim()
    : "";
  const requestedFormat = typeof candidate.format === "string"
    ? candidate.format.trim()
    : "";
  const hasSplitFormats = typeof candidate.nameFormat === "string" ||
    typeof candidate.descriptionFormat === "string";
  const legacyFormatOverridesSplit = requestedFormat &&
    (!hasSplitFormats || (
      requestedFormat !== DEFAULT_STREAM_MIDDLEWARE.format &&
      requestedFormat !== requestedDescriptionFormat
    ));
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
  const isPreviousDefault = normalizedPreviousFormat === normalizedDefaultDescription ||
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
    sortField,
    sortDirection,
    nameFormat,
    descriptionFormat,
    format: descriptionFormat
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
  const fieldTypes = JSON.stringify(
    Object.fromEntries(STREAM_FIELD_CATALOG.map(field => [field.key, field.type]))
  );

  return `${source}\n;(() => {
  const config = ${settings};
  const addonName = ${formattedAddonName};
  const __name = (target) => target;
  const renderAioStreamsFormat = ${formatterSource};
  const fieldTypes = ${fieldTypes};
  const plugin = typeof module !== "undefined" && module.exports
    ? module.exports
    : typeof exports !== "undefined" ? exports : null;
  if (!plugin || typeof plugin.getStreams !== "function") return;

  const originalGetStreams = plugin.getStreams;
  plugin.getStreams = async function (...args) {
    const result = await originalGetStreams.apply(this, args);
    if (!Array.isArray(result)) return result;

    const getValue = (stream, path) => {
      if (path === "title") return stream.title ?? stream.name ?? "";
      if (path === "resolution") {
        const explicit = stream.resolution ?? stream.quality;
        if (explicit) return explicit;
        const match = String(stream.title ?? stream.name ?? "").match(/(?:2160|1440|1080|720|576|480|360|240|144)p|4k|uhd|qhd|fhd|hd/i);
        return match ? match[0] : "";
      }
      if (path === "size") return stream.size ?? stream.fileSize ?? "";
      if (path === "cached") return stream.cached ?? stream.service?.cached ?? "";
      if (path === "audioTags") return stream.audioTags ?? stream.audio ?? stream.audioCodec ?? "";
      if (path === "languages") return stream.languages ?? stream.language ?? "";
      return path.split(".").reduce((value, key) => value == null ? "" : value[key], stream);
    };
    const stringify = value => Array.isArray(value) ? value.join(" | ") : value == null ? "" : String(value);
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
    const hasValue = value => value !== "" && value != null && (!Array.isArray(value) || value.length > 0);
    const prepareFormatterStream = stream => {
      const prepared = { ...stream };
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
      const match = stringify(value).match(/([-+]?[\\d.]+)\\s*(Gbps|Mbps|Kbps|TB|GB|MB|KB|B)?/i);
      if (!match) return 0;
      const factor = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KBPS: 1e3, MBPS: 1e6, GBPS: 1e9 }[(match[2] || "B").toUpperCase()] || 1;
      return Number(match[1]) * factor;
    };
    const filterMatches = (stream, filter) => {
      const value = getValue(stream, filter.field);
      const type = fieldTypes[filter.field] || "text";
      if (filter.operator === "exists") return hasValue(value);
      if (filter.operator === "missing") return !hasValue(value);
      if (filter.operator === "isTrue") return value === true || value === 1 || String(value).toLowerCase() === "true";
      if (filter.operator === "isFalse") return value === false || value === 0 || String(value).toLowerCase() === "false";
      if (type === "number") {
        const actual = numericValue(stream, filter.field);
        const expected = Number(filter.value);
        if (!Number.isFinite(expected)) return true;
        if (!hasValue(value)) return filter.operator === "notEquals";
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
          let match = operation.match(/^replace\\(['\"](.*?)['\"],\\s*['\"](.*?)['\"]\\)$/);
          if (match) {
            value = stringify(value).split(match[1]).join(match[2]);
            continue;
          }
          match = operation.match(/^join\\(['\"](.*?)['\"]\\)$/);
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
      const optional = format.replace(/\\{\\?([\\s\\S]*?)\\?\\}/g, (_block, contents) => {
        const tokens = [...contents.matchAll(/\\{stream\\.([^{}]+)\\}/g)];
        return tokens.some(([, expression]) => tokenValue(expression)) ? contents : "";
      });
      return optional.replace(/\\{stream\\.([^{}]+)\\}/g, (_token, expression) => tokenValue(expression)).trim();
    };

    const streams = result.filter(stream => stream && typeof stream === "object").map((stream, index) => {
      const normalized = { ...stream };
      let name = stringify(normalized.name ?? normalized.title ?? "");
      try {
        name = renderAioStreamsFormat(config.nameFormat, prepareFormatterStream(normalized), addonName);
      } catch {
        name = formatFallback(config.nameFormat, normalized) || name;
      }
      let description = stringify(normalized.title ?? normalized.description ?? "");
      const descriptionInput = prepareFormatterStream(normalized);
      try {
        description = renderAioStreamsFormat(config.descriptionFormat, descriptionInput, addonName);
      } catch {
        description = formatFallback(config.descriptionFormat, normalized) || description;
      }
      for (const [key, value] of Object.entries(descriptionInput)) {
        if (key !== "service") normalized[key] = value;
      }
      const formatted = {
        ...normalized,
        ...(normalized.size !== undefined
          ? { fileSize: normalized.fileSize ?? normalized.size }
          : {}),
        name,
        description,
        title: description,
        size: description
      };
      const sourceStream = { ...normalized };
      return {
        stream: formatted,
        source: sourceStream,
        index
      };
    }).filter(item =>
      config.filters.every(filter => filterMatches(item.source, filter))
    );

    streams.sort((left, right) => {
      if (!config.sortField) return left.index - right.index;
      const leftValue = getValue(left.source, config.sortField);
      const rightValue = getValue(right.source, config.sortField);
      if (!hasValue(leftValue)) return hasValue(rightValue) ? 1 : left.index - right.index;
      if (!hasValue(rightValue)) return -1;
      const direction = config.sortDirection === "asc" ? 1 : -1;
      const comparison = fieldTypes[config.sortField] === "number"
        ? numericValue(left.source, config.sortField) - numericValue(right.source, config.sortField)
        : fieldTypes[config.sortField] === "boolean"
          ? Number(leftValue === true || leftValue === 1 || String(leftValue).toLowerCase() === "true") - Number(rightValue === true || rightValue === 1 || String(rightValue).toLowerCase() === "true")
          : stringify(leftValue).localeCompare(stringify(rightValue), undefined, { numeric: true, sensitivity: "base" });
      return comparison * direction || left.index - right.index;
    });
    return streams.map(item => item.stream);
  };
})();\n`;
}