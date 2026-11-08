// "Stream name and description": templates plus a live server-side preview.

import { api } from "../../core/api.js";
import { $ } from "../../core/dom.js";
import { errorMessage, parseJsonRecord } from "../../core/guards.js";
import type { FormatterPreviewResponse } from "../../core/types.js";
import { middlewareStore, STREAM_FORMAT_PRESETS } from "../../state/middleware.js";
import { viewStore } from "../../state/view.js";
import { fieldsStore } from "../../state/workspace.js";

const PREVIEW_DELAY_MS = 180;

const nameEditor = () => $<HTMLTextAreaElement>("#stream-name-format");
const descriptionEditor = () => $<HTMLTextAreaElement>("#stream-description-format");

let timer: ReturnType<typeof setTimeout> | undefined;
let requestId = 0;
// True when the preview is out of date but the formatter tab is not showing.
let stale = true;

function formatterVisible(): boolean {
  const { view, tab } = viewStore.get();
  return view === "middleware" && tab === "formatting";
}

function setPreviewState(text: string, className: string): void {
  const state = $("#formatter-preview-state");
  state.textContent = text;
  state.className = `formatter-preview-state ${className}`.trim();
}

async function renderPreview(): Promise<void> {
  const current = ++requestId;
  stale = false;

  const name = $("#formatter-preview-name");
  const description = $("#formatter-preview-description");

  try {
    const stream = parseJsonRecord(
      $<HTMLTextAreaElement>("#formatter-stream-data").value,
      "Stream data must be a JSON object."
    );
    const metadata = parseJsonRecord(
      $<HTMLTextAreaElement>("#formatter-metadata").value,
      "Metadata must be a JSON object."
    );
    stream.filename = $<HTMLInputElement>("#formatter-filename").value.trim();

    const { nameFormat, descriptionFormat } = middlewareStore.get();
    const result = await api<FormatterPreviewResponse>("/api/formatter/preview", {
      nameFormat,
      descriptionFormat,
      stream,
      metadata
    });

    if (current !== requestId) return;

    name.textContent = result.name || "(empty output)";
    description.textContent = result.description || "(empty output)";
    $("#formatter-parsed-fields").textContent = JSON.stringify(result.parsed, null, 2);
    setPreviewState("Updated", "ready");
  } catch (error) {
    if (current !== requestId) return;

    name.textContent = "Preview unavailable";
    description.textContent = "Preview unavailable";
    $("#formatter-parsed-fields").textContent = "{}";
    setPreviewState(errorMessage(error), "error");
  }
}

/** Re-renders soon, but only spends a request when the tab can be seen. */
function schedulePreview(): void {
  clearTimeout(timer);
  stale = true;
  setPreviewState("Updating", "");

  if (!formatterVisible()) return;
  timer = setTimeout(() => void renderPreview(), PREVIEW_DELAY_MS);
}

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

function syncTemplates(): void {
  const { nameFormat, descriptionFormat } = middlewareStore.get();

  // Only touch a box whose text really changed, or the caret would jump.
  if (nameEditor().value !== nameFormat) nameEditor().value = nameFormat;
  if (descriptionEditor().value !== descriptionFormat) descriptionEditor().value = descriptionFormat;
}

export function mountFormatterEditor(): void {
  const formatField = $<HTMLSelectElement>("#format-field");

  fieldsStore.subscribe((fields) => {
    formatField.replaceChildren(...fields.map((field) => new Option(field.label, field.key)));
  });

  let lastNames = "";
  middlewareStore.subscribe(({ nameFormat, descriptionFormat }) => {
    syncTemplates();
    const signature = `${nameFormat}\u0000${descriptionFormat}`;
    if (signature !== lastNames) {
      lastNames = signature;
      schedulePreview();
    }
  });

  viewStore.subscribe(() => {
    if (stale && formatterVisible()) schedulePreview();
  });

  nameEditor().addEventListener("input", () => {
    middlewareStore.update((settings) => ({ ...settings, nameFormat: nameEditor().value }));
  });

  descriptionEditor().addEventListener("input", () => {
    middlewareStore.update((settings) => ({ ...settings, descriptionFormat: descriptionEditor().value }));
  });

  for (const selector of ["#formatter-filename", "#formatter-stream-data", "#formatter-metadata"]) {
    $(selector).addEventListener("input", schedulePreview);
  }

  $("#apply-format-preset").addEventListener("click", () => {
    const preset = $<HTMLSelectElement>("#format-preset").value;
    const template = STREAM_FORMAT_PRESETS[preset] ?? STREAM_FORMAT_PRESETS.detailed ?? "";
    middlewareStore.update((settings) => ({ ...settings, descriptionFormat: template }));
  });

  const unknownMode = $<HTMLSelectElement>("#format-unknown");
  unknownMode.addEventListener("change", () => {
    $("#format-unknown-label-field").hidden = unknownMode.value !== "label";
  });

  $("#insert-format-field").addEventListener("click", () => {
    const target = $<HTMLSelectElement>("#format-target").value;
    const editor = target === "stream-name-format" ? nameEditor() : descriptionEditor();
    const start = editor.selectionStart ?? editor.value.length;
    const end = editor.selectionEnd ?? start;

    const token = tokenFor(
      formatField.value,
      unknownMode.value,
      $<HTMLInputElement>("#format-unknown-label").value
    );
    editor.setRangeText(token, start, end, "end");
    editor.focus();
    editor.dispatchEvent(new Event("input"));
  });

  const detailField = $<HTMLSelectElement>("#detail-field");
  detailField.addEventListener("change", () => {
    middlewareStore.update((settings) => ({
      ...settings,
      detailField: detailField.value === "size" ? "size" : "title"
    }));
  });
  middlewareStore.subscribe(({ detailField: saved }) => {
    if (detailField.value !== saved) detailField.value = saved;
  });
  detailField.value = middlewareStore.get().detailField;

  syncTemplates();
}
