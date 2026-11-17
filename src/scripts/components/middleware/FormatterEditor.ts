// "Stream name and description": templates plus a live preview that is
// rendered in the browser; no request is sent to the server.

import { errorMessage, parseJsonRecord } from "../../core/guards.js";
import { buildFormatterPreview } from "../../../lib/formatter-preview.js";
import { STREAM_FORMAT_PRESETS } from "../../state/middleware.js";
import { fieldsStore } from "../../state/workspace.js";
import type { MiddlewareScope } from "./scope.js";

const PREVIEW_DELAY_MS = 180;

/**
 * The template text for one field. A fallback label uses the same
 * `::exists[...||...]` form as the default name template; a skipped token sits
 * in an optional group, which disappears with its spacing when empty.
 */
function tokenFor(key: string, mode: string, label: string): string {
  const token = `{stream.${key}}`;

  if (mode === "skip") return `{?${token} ?}`;
  if (mode !== "label") return token;

  // Characters that would end the label early or start new syntax.
  const safe = label.replace(/["{}\[\]|\r\n]/g, "").trim() || "Unknown";
  return `{stream.${key}::exists["${token}"||"${safe}"]}`;
}

export function mountFormatterEditor(scope: MiddlewareScope): void {
  const { ui } = scope;
  const nameEditor = ui<HTMLTextAreaElement>("stream-name-format");
  const descriptionEditor = ui<HTMLTextAreaElement>("stream-description-format");

  let timer: ReturnType<typeof setTimeout> | undefined;
  let requestId = 0;
  // True when the preview is out of date but the formatter panel is not showing.
  let stale = true;

  const setPreviewState = (text: string, className: string) => {
    const state = ui("formatter-preview-state");
    state.textContent = text;
    state.className = `formatter-preview-state ${className}`.trim();
  };

  const renderPreview = () => {
    const current = ++requestId;
    stale = false;

    const name = ui("formatter-preview-name");
    const description = ui("formatter-preview-description");

    try {
      const stream = parseJsonRecord(
        ui<HTMLTextAreaElement>("formatter-stream-data").value,
        "Stream data must be a JSON object."
      );
      const metadata = parseJsonRecord(
        ui<HTMLTextAreaElement>("formatter-metadata").value,
        "Metadata must be a JSON object."
      );
      stream.filename = ui<HTMLInputElement>("formatter-filename").value.trim();

      const { nameFormat, descriptionFormat } = scope.store.get();
      const result = buildFormatterPreview({ nameFormat, descriptionFormat, stream, metadata });

      if (current !== requestId) return;

      name.textContent = result.name || "(empty output)";
      description.textContent = result.description || "(empty output)";
      ui("formatter-parsed-fields").textContent = JSON.stringify(result.parsed, null, 2);
      setPreviewState("Updated", "ready");
    } catch (error) {
      if (current !== requestId) return;

      name.textContent = "Preview unavailable";
      description.textContent = "Preview unavailable";
      ui("formatter-parsed-fields").textContent = "{}";
      setPreviewState(errorMessage(error), "error");
    }
  };

  /** Re-renders soon, but only when the panel can be seen. */
  const schedulePreview = () => {
    clearTimeout(timer);
    stale = true;
    setPreviewState("Updating", "");

    if (!scope.formatterVisible()) return;
    timer = setTimeout(renderPreview, PREVIEW_DELAY_MS);
  };

  const syncTemplates = () => {
    const { nameFormat, descriptionFormat } = scope.store.get();

    // Only touch a box whose text really changed, or the caret would jump.
    if (nameEditor.value !== nameFormat) nameEditor.value = nameFormat;
    if (descriptionEditor.value !== descriptionFormat) descriptionEditor.value = descriptionFormat;
  };

  const formatField = ui<HTMLSelectElement>("format-field");

  fieldsStore.subscribe((fields) => {
    formatField.replaceChildren(...fields.map((field) => new Option(field.label, field.key)));
  });

  let lastNames = "";
  scope.store.subscribe(({ nameFormat, descriptionFormat }) => {
    syncTemplates();
    const signature = `${nameFormat}\u0000${descriptionFormat}`;
    if (signature !== lastNames) {
      lastNames = signature;
      schedulePreview();
    }
  });

  scope.onNavigate(() => {
    if (stale && scope.formatterVisible()) schedulePreview();
  });

  nameEditor.addEventListener("input", () => {
    scope.store.update((settings) => ({ ...settings, nameFormat: nameEditor.value }));
  });

  descriptionEditor.addEventListener("input", () => {
    scope.store.update((settings) => ({ ...settings, descriptionFormat: descriptionEditor.value }));
  });

  for (const id of ["formatter-filename", "formatter-stream-data", "formatter-metadata"]) {
    ui(id).addEventListener("input", schedulePreview);
  }

  ui("apply-format-preset").addEventListener("click", () => {
    const preset = ui<HTMLSelectElement>("format-preset").value;
    const template = STREAM_FORMAT_PRESETS[preset] ?? STREAM_FORMAT_PRESETS.detailed ?? "";
    scope.store.update((settings) => ({ ...settings, descriptionFormat: template }));
  });

  const unknownMode = ui<HTMLSelectElement>("format-unknown");
  unknownMode.addEventListener("change", () => {
    ui("format-unknown-label-field").hidden = unknownMode.value !== "label";
  });

  ui("insert-format-field").addEventListener("click", () => {
    const target = ui<HTMLSelectElement>("format-target").value;
    const editor = target === "stream-name-format" ? nameEditor : descriptionEditor;
    const start = editor.selectionStart ?? editor.value.length;
    const end = editor.selectionEnd ?? start;

    const token = tokenFor(formatField.value, unknownMode.value, ui<HTMLInputElement>("format-unknown-label").value);
    editor.setRangeText(token, start, end, "end");
    editor.focus();
    editor.dispatchEvent(new Event("input"));
  });

  syncTemplates();
}
