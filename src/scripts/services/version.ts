// Shows the deployed release (for example "v0.4.0") in the sidebar and About page.
//
// The release workflow writes the tag it just created to /version.json before
// building. That file does not exist in local development, in which case the
// version labels stay hidden instead of showing something misleading.

import { isRecord } from "../core/guards.js";

const VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export async function loadVersion(): Promise<string | null> {
  try {
    const response = await fetch("/version.json", { cache: "no-cache" });
    if (!response.ok) return null;

    const data: unknown = await response.json();
    const version = isRecord(data) && typeof data.version === "string" ? data.version.trim() : "";

    return VERSION_PATTERN.test(version) ? version : null;
  } catch {
    return null;
  }
}

/** Fills every `[data-app-version]` element and reveals it. */
export async function showVersion(): Promise<void> {
  const version = await loadVersion();
  if (!version) return;

  const label = version.startsWith("v") ? version : `v${version}`;

  for (const element of document.querySelectorAll<HTMLElement>("[data-app-version]")) {
    element.textContent = label;
    element.title = `AIOPlugins ${label}`;
    element.hidden = false;
  }
}
