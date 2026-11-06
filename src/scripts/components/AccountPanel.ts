// Account settings: UUID, configuration backup, account deletion.

import { api } from "../core/api.js";
import { $ } from "../core/dom.js";
import { copyText } from "../core/clipboard.js";
import { errorMessage } from "../core/guards.js";
import { setStatus } from "../core/status.js";
import { exportBackup, importBackup } from "../services/backup.js";
import { leaveWorkspace } from "../services/session.js";
import { userStore } from "../state/session.js";
import type { PublicUser } from "../core/types.js";
import { showView } from "../state/view.js";

async function onImport(input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  if (!file) return;

  try {
    setStatus("account", "Restoring plugins…");
    const failures = await importBackup(file);

    if (failures.length > 0) {
      setStatus("catalog", `Some sources couldn't load: ${failures.join("; ")}`, "error");
    } else {
      setStatus("catalog", "Backup restored successfully.", "success");
    }

    setStatus("account", "");
    showView("configure");
  } catch (error) {
    setStatus("account", errorMessage(error), "error");
  } finally {
    input.value = "";
  }
}

export function mountAccountPanel(): void {
  userStore.subscribe((user) => {
    $("#account-uuid").textContent = user?.id ?? "";
    if (!user) {
      $<HTMLInputElement>("#delete-password").value = "";
      $<HTMLInputElement>("#reroll-password").value = "";
    }
  });

  $("#reroll-token").addEventListener("click", async () => {
    const input = $<HTMLInputElement>("#reroll-password");

    if (!input.value) {
      setStatus("account", "Enter your password to generate a new install link.", "error");
      return;
    }

    if (!confirm("Generate a new install link? The current link will stop working immediately.")) return;

    try {
      const { user } = await api<{ user: PublicUser }>("/api/account/token", {
        password: input.value
      });

      input.value = "";
      userStore.set(user);
      setStatus("account", "");
      setStatus(
        "review",
        "New install link generated. The previous link no longer works; update the URL in Nuvio.",
        "success"
      );
      showView("save");
    } catch (error) {
      setStatus("account", errorMessage(error), "error");
    }
  });

  $("#copy-uuid").addEventListener("click", async () => {
    const user = userStore.get();
    if (!user) return;

    const copied = await copyText(user.id);
    setStatus(
      "account",
      copied ? "UUID copied." : "Clipboard access is unavailable.",
      copied ? "success" : "error"
    );
  });

  $("#export-config").addEventListener("click", async () => {
    try {
      await exportBackup();
      setStatus("account", "Backup exported.", "success");
    } catch (error) {
      setStatus("account", errorMessage(error), "error");
    }
  });

  const importInput = $<HTMLInputElement>("#import-config-file");
  $("#import-config").addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", () => void onImport(importInput));

  $("#delete-account").addEventListener("click", async () => {
    const password = $<HTMLInputElement>("#delete-password").value;

    if (!password) {
      setStatus("account", "Enter your password to delete your account.", "error");
      return;
    }

    if (!confirm("Permanently delete this account and its saved selection?")) return;

    try {
      await api("/api/account", { password }, "DELETE");
      leaveWorkspace();
      setStatus("auth", "Account deleted.", "success");
    } catch (error) {
      setStatus("account", errorMessage(error), "error");
    }
  });
}
