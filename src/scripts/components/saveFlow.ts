// The single "Save & Install" action saves the complete current setup and reports the outcome.

import { errorMessage } from "../core/guards.js";
import { setStatus, type StatusChannel } from "../core/status.js";
import { saveSetup } from "../services/setup.js";
import { savedStore, savingStore } from "../state/setup.js";
import { sourceStore } from "../state/sources.js";

export async function runSave(
  button: HTMLButtonElement,
  channel: StatusChannel
): Promise<boolean> {
  if (savingStore.get() || sourceStore.selectionCount() === 0) return false;

  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  setStatus(channel, "Verifying selected providers and saving your plugins and middleware settings…");

  try {
    const result = await saveSetup();
    if (!result) return false;

    const note = result.merged > 0
      ? ` ${result.merged} ${result.merged === 1 ? "plugin is" : "plugins are"} selected from more than one source and will run every selected copy, dropping streams that are identical.`
      : "";

    setStatus(channel, `Saved ${result.plugins} selected plugins and all middleware settings. Your Nuvio repository is ready.${note}`, "success");
    savedStore.update((count) => count + 1);
    return true;
  } catch (error) {
    setStatus(channel, errorMessage(error), "error");
    return false;
  } finally {
    button.disabled = sourceStore.selectionCount() === 0 || savingStore.get();
    button.removeAttribute("aria-busy");
  }
}
