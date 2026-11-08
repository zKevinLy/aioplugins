// Identity and version of the running AIOPlugins deployment.
//
// The release workflow writes the tag it just created to /version.json before
// building (see .github/workflows/ci.yml). The browser reads that file to show
// the version in the sidebar; the Worker reads the same file through the static
// assets binding so the Nuvio manifest reports the same number. In local
// development the file does not exist and the version is reported as "dev".

import type { Platform } from "./platform.js";

export const APP_NAME = "AIOPlugins";
export const APP_HOMEPAGE = "https://github.com/zKevinly/AIOPlugins";
export const DEV_VERSION = "dev";

const VERSION_PATTERN = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

/** Returns a bare semantic version ("0.4.0") from "v0.4.0" or "0.4.0", else null. */
export function normalizeVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = VERSION_PATTERN.exec(value.trim());
  return match ? match[1]! : null;
}

/** The deployed version without a leading "v", or "dev" when unknown. */
export async function loadAppVersion(
  platform: Pick<Platform, "assets">,
  origin: string
): Promise<string> {
  try {
    const response = await platform.assets.fetch(
      new Request(new URL("/version.json", origin).toString())
    );

    if (!response.ok) {
      await response.body?.cancel();
      return DEV_VERSION;
    }

    const data: unknown = await response.json();
    const version =
      data && typeof data === "object" && !Array.isArray(data)
        ? normalizeVersion((data as { version?: unknown }).version)
        : null;

    return version ?? DEV_VERSION;
  } catch {
    return DEV_VERSION;
  }
}

/** "v0.4.0" for a release, "dev" for a local build. */
export function versionLabel(version: string): string {
  return version === DEV_VERSION ? DEV_VERSION : `v${version}`;
}
