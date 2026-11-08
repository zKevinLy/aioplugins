// Renders the stream name and description exactly as the generated plugin
// wrapper does, from a sample stream.
//
// This is pure and platform independent: the browser editor calls it directly
// to draw the live preview, so no request reaches the AIOPlugins server. It
// applies the same placeholder handling as the wrapper that runs inside Nuvio
// (see `wrapPluginStreams`), so the preview matches what Nuvio will show.

import { renderAioStreamsFormat } from "../providers/custom-formatter.js";
import { removeUnknownPlaceholders } from "../providers/unknown-values.js";
import {
  DEFAULT_STREAM_DESCRIPTION_FORMAT,
  DEFAULT_STREAM_NAME_FORMAT
} from "./default-stream-format.js";

export const MAX_FORMAT_TEMPLATE_LENGTH = 3000;

/** Release fields reported back to the editor when the sample has them. */
const PARSED_FIELDS = [
  "title", "filename", "year", "resolution", "quality", "encode", "network",
  "visualTags", "audioTags", "audioChannels", "languages", "subtitles",
  "seasons", "episodes", "formattedSeasons", "formattedEpisodes", "releaseGroup",
  "editions", "size", "container", "extension"
] as const;

export interface FormatterPreviewInput {
  nameFormat?: unknown;
  descriptionFormat?: unknown;
  /** Older callers sent a single template for the description. */
  format?: unknown;
  stream: unknown;
  metadata?: unknown;
}

export interface FormatterPreview {
  name: string;
  description: string;
  title: string;
  parsed: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Throws an Error with a user-facing message when the input is unusable. */
export function buildFormatterPreview(input: FormatterPreviewInput): FormatterPreview {
  const nameFormat = typeof input.nameFormat === "string"
    ? input.nameFormat
    : DEFAULT_STREAM_NAME_FORMAT;
  const descriptionFormat = typeof input.descriptionFormat === "string"
    ? input.descriptionFormat
    : typeof input.format === "string"
      ? input.format
      : DEFAULT_STREAM_DESCRIPTION_FORMAT;

  if (
    nameFormat.length > MAX_FORMAT_TEMPLATE_LENGTH ||
    descriptionFormat.length > MAX_FORMAT_TEMPLATE_LENGTH
  ) {
    throw new Error(
      `Formatter template must be ${MAX_FORMAT_TEMPLATE_LENGTH} characters or fewer`
    );
  }

  if (!isPlainObject(input.stream)) {
    throw new Error("Stream sample must be a JSON object");
  }

  if (input.metadata !== undefined && !isPlainObject(input.metadata)) {
    throw new Error("Metadata sample must be a JSON object");
  }

  const stream = removeUnknownPlaceholders(input.stream);
  const metadata = input.metadata ?? {};

  const name = renderAioStreamsFormat(nameFormat, { ...stream }, "AIOPlugins", { metadata });
  const description = renderAioStreamsFormat(
    descriptionFormat,
    stream,
    "AIOPlugins",
    { metadata }
  );

  const parsed = Object.fromEntries(
    PARSED_FIELDS
      .filter(field => Object.prototype.hasOwnProperty.call(stream, field))
      .map(field => [field, stream[field]])
  );

  return { name, description, title: description, parsed };
}
