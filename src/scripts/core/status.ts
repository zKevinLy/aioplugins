// Status messages. Each area of the UI owns one channel, so a message always
// appears next to the thing that produced it, whichever view is showing.

import { $ } from "./dom.js";
import type { StatusKind } from "./types.js";

export type StatusChannel = "auth" | "catalog" | "review" | "account" | "quick-save";

const ELEMENT_IDS: Record<StatusChannel, string> = {
  auth: "auth-status",
  catalog: "status",
  review: "save-status",
  account: "account-status",
  "quick-save": "quick-save-status"
};

export function setStatus(channel: StatusChannel, message: string, kind: StatusKind = ""): void {
  const target = $(`#${ELEMENT_IDS[channel]}`);
  target.textContent = message;
  target.className = `status ${kind}`.trim();
}

export function clearStatus(channel: StatusChannel): void {
  setStatus(channel, "");
}
