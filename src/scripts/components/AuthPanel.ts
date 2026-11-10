// Log in, create account, and the "save your UUID" step.

import { api } from "../core/api.js";
import { $, $$ } from "../core/dom.js";
import { copyText } from "../core/clipboard.js";
import { errorMessage } from "../core/guards.js";
import { clearStatus, setStatus } from "../core/status.js";
import type { PublicUser, UserResponse } from "../core/types.js";
import { enterWorkspace } from "../services/session.js";
import { passkeyErrorMessage, passkeysSupported, signInWithPasskey } from "../services/passkeys.js";
import { userStore } from "../state/session.js";

type AuthTab = "login" | "register";

// The new account waits here until the user confirms they saved the UUID.
let pending: UserResponse | null = null;

function showTab(tab: AuthTab): void {
  const login = tab === "login";
  $("#login-form").hidden = !login;
  $("#register-form").hidden = login;
  $("#login-tab").setAttribute("aria-selected", String(login));
  $("#register-tab").setAttribute("aria-selected", String(!login));
  clearStatus("auth");
}

function reset(): void {
  for (const input of $$<HTMLInputElement>("#auth-view input")) {
    input.value = "";
    if (input.type === "checkbox") input.checked = false;
  }

  pending = null;
  $("#new-account").hidden = true;
  $("#auth-tabs").hidden = false;
  $<HTMLButtonElement>("#continue").disabled = true;
  showTab("login");
}

async function login(event: Event): Promise<void> {
  event.preventDefault();

  try {
    const result = await api<UserResponse>("/api/login", {
      uuid: $<HTMLInputElement>("#login-uuid").value.trim(),
      password: $<HTMLInputElement>("#login-password").value
    });

    await enterWorkspace(result.user, result.workspace);
  } catch (error) {
    setStatus("auth", errorMessage(error), "error");
  }
}

async function register(event: Event): Promise<void> {
  event.preventDefault();

  const password = $<HTMLInputElement>("#register-password").value;

  if (password.length < 8) {
    setStatus("auth", "Password must be at least 8 characters.", "error");
    return;
  }

  if (password !== $<HTMLInputElement>("#register-confirm").value) {
    setStatus("auth", "Passwords do not match.", "error");
    return;
  }

  try {
    pending = await api<UserResponse>("/api/register", { password });

    $("#new-uuid").textContent = pending.user.id;
    $("#register-form").hidden = true;
    $("#auth-tabs").hidden = true;
    $("#new-account").hidden = false;
    clearStatus("auth");
  } catch (error) {
    setStatus("auth", errorMessage(error), "error");
  }
}

export function mountAuthPanel(): void {
  // Whenever nobody is signed in, the form starts clean.
  userStore.subscribe((user: PublicUser | null) => {
    if (!user) reset();
  });

  $("#login-tab").addEventListener("click", () => showTab("login"));
  $("#register-tab").addEventListener("click", () => showTab("register"));
  $("#login-form").addEventListener("submit", (event) => void login(event));
  $("#register-form").addEventListener("submit", (event) => void register(event));

  const passkeyButton = $<HTMLButtonElement>("#passkey-login");
  passkeyButton.hidden = !passkeysSupported();
  passkeyButton.addEventListener("click", async () => {
    passkeyButton.disabled = true;
    try {
      const result = await signInWithPasskey();
      await enterWorkspace(result.user, result.workspace);
    } catch (error) {
      setStatus("auth", passkeyErrorMessage(error), "error");
    } finally {
      passkeyButton.disabled = false;
    }
  });

  $("#copy-new-uuid").addEventListener("click", async () => {
    if (!pending) return;
    const copied = await copyText(pending.user.id);
    setStatus(
      "auth",
      copied ? "UUID copied." : "Clipboard access is unavailable.",
      copied ? "success" : "error"
    );
  });

  const ack = $<HTMLInputElement>("#saved-ack");
  const next = $<HTMLButtonElement>("#continue");

  ack.addEventListener("change", () => {
    next.disabled = !ack.checked;
  });

  next.addEventListener("click", () => {
    if (pending) void enterWorkspace(pending.user, pending.workspace);
  });
}
