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
import {
  addPasskey,
  listPasskeys,
  passkeyErrorMessage,
  passkeysSupported,
  removePasskey,
  type PasskeyInfo
} from "../services/passkeys.js";

function renderPasskeys(passkeys: PasskeyInfo[]): void {
  const list = $("#passkey-list");
  list.replaceChildren();

  for (const passkey of passkeys) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    const added = new Date(passkey.createdAt).toLocaleDateString();
    label.textContent = `${passkey.name} · added ${added}`;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button button-small button-danger";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      if (!confirm(`Remove the passkey "${passkey.name}"?`)) return;
      try {
        renderPasskeys(await removePasskey(passkey.id));
      } catch (error) {
        setStatus("account", errorMessage(error), "error");
      }
    });

    item.append(label, " ", remove);
    list.append(item);
  }
}

async function refreshPasskeys(): Promise<void> {
  try {
    renderPasskeys(await listPasskeys());
  } catch {
    // The list is a convenience; the rest of the page still works.
  }
}

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
  $("#passkey-card").hidden = !passkeysSupported();

  $("#add-passkey").addEventListener("click", async () => {
    const nameInput = $<HTMLInputElement>("#passkey-name");
    try {
      await addPasskey(nameInput.value.trim());
      nameInput.value = "";
      setStatus("account", "Passkey added.", "success");
      await refreshPasskeys();
    } catch (error) {
      setStatus("account", passkeyErrorMessage(error), "error");
    }
  });

  userStore.subscribe((user) => {
    if (user && passkeysSupported()) void refreshPasskeys();
    if (!user) $("#passkey-list").replaceChildren();
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
