// One definition of "unknown" for filtering, sorting and formatting.
//
// Providers often fill a field with a placeholder such as "Unknown" or "N/A"
// instead of leaving it out. Treating those as real values would, for
// example, rank a stream with quality "Unknown" next to genuine releases.
//
// This function is also copied into the generated plugin wrapper with
// `Function.prototype.toString`, so it must stay self-contained: no imports
// and no references to anything outside its own body.

export function isUnknownValue(value: unknown, field = ""): boolean {
  if (value === undefined || value === null) return true;

  if (Array.isArray(value)) {
    return value.every(item => isUnknownValue(item, field));
  }

  if (typeof value !== "string") return false;

  const text = value.trim();
  if (text === "") return true;

  // Free-text fields hold what the provider wrote; "None" can be a real title.
  const literalFields = ["title", "name", "description", "filename", "message", "url"];
  if (literalFields.includes(field)) return false;

  return /^(?:unknown|n\/a|na|none|null|undefined|nil|-+|\?+)$/i.test(text);
}

/**
 * Returns a copy of `stream` without placeholder values, so the formatter
 * treats them as missing: inference can fill them in, optional groups
 * disappear, and `::exists` is false. Like `isUnknownValue`, it is copied into
 * the plugin wrapper as source text and calls only that function.
 */
export function removeUnknownPlaceholders(
  stream: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...stream };

  for (const key of Object.keys(result)) {
    const value = result[key];

    if (typeof value === "string") {
      if (isUnknownValue(value, key)) delete result[key];
    } else if (Array.isArray(value) && value.some(item => typeof item === "string")) {
      result[key] = value.filter(item => !(typeof item === "string" && isUnknownValue(item, key)));
    }
  }

  return result;
}
