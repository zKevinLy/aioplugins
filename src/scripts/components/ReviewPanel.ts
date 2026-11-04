// "Save & Install": the selection, the save button and the install link.

import { $, el } from "../core/dom.js";
import { copyText } from "../core/clipboard.js";
import { errorMessage } from "../core/guards.js";
import { setStatus } from "../core/status.js";
import { refreshManifest } from "../services/manifest.js";
import { installUrl, userStore } from "../state/session.js";
import { manifestStore, savedStore, savingStore } from "../state/setup.js";
import { sourceStore } from "../state/sources.js";
import { viewStore } from "../state/view.js";
import { renderProviderListItem } from "./ProviderListItem.js";
import { runSave } from "./saveFlow.js";

const NO_LINK_TEXT = "Save your setup to generate a link.";

function renderSelection(): void {
  const count = sourceStore.selectionCount();
  $("#review-count").textContent = count === 1 ? "1 plugin selected" : `${count} plugins selected`;

  const container = $("#review-selection");
  const list = el("div", { className: "review-list" });

  for (const source of sourceStore.list()) {
    for (const provider of source.providers) {
      if (!source.selected.has(provider.id)) continue;

      list.append(
        renderProviderListItem(provider, {
          checked: true,
          onChange: (checked) => {
            if (!checked) sourceStore.setSelected(source, provider.id, false);
          }
        })
      );
    }
  }

  container.replaceChildren(
    count === 0
      ? el("p", { className: "view-intro", text: "No plugins selected yet. Go back and choose some plugins." })
      : list
  );
}

function renderButtons(): void {
  $<HTMLButtonElement>("#apply").disabled = sourceStore.selectionCount() === 0 || savingStore.get();
}

function renderOutput(): void {
  const manifest = manifestStore.get();
  const state = $("#output-state");

  $("#manifest-preview").textContent = manifest?.text ?? "Save your setup to generate your Nuvio manifest.";

  if (manifest) {
    state.textContent = manifest.pluginCount === 1 ? "1 plugin included" : `${manifest.pluginCount} plugins included`;
  } else {
    state.textContent = "Not saved yet";
  }

  state.classList.toggle("ready", (manifest?.pluginCount ?? 0) > 0);
}

function renderUser(): void {
  const user = userStore.get();
  const urlButton = $<HTMLButtonElement>("#plugin-url");

  urlButton.textContent = user ? installUrl(user) : NO_LINK_TEXT;
  $<HTMLButtonElement>("#copy-plugin-url").disabled = !user;
  $<HTMLAnchorElement>("#open-manifest").href = user?.installPath ?? "#";
}

export function mountReviewPanel(): void {
  const feedback = $("#copy-feedback");
  const apply = $<HTMLButtonElement>("#apply");

  sourceStore.subscribe(() => {
    renderSelection();
    renderButtons();
  });
  savingStore.subscribe(renderButtons);
  manifestStore.subscribe(renderOutput);
  userStore.subscribe(renderUser);

  // Re-check the install link's content whenever the review step opens.
  let previousView = viewStore.get().view;
  viewStore.subscribe(({ view }) => {
    if (view === "save" && previousView !== "save") {
      refreshManifest().catch((error) => setStatus("review", errorMessage(error), "error"));
    }
    previousView = view;
  });

  savedStore.subscribe(() => {
    feedback.textContent =
      "Setup saved. Refresh the AIOPlugins source in Nuvio, or add the URL below if it is not installed yet.";
  });

  const copyUrl = async () => {
    const user = userStore.get();
    if (!user) return;

    const copied = await copyText(installUrl(user));
    feedback.textContent = copied
      ? "Copied! Paste this link into Nuvio's plugin source settings."
      : "Clipboard access is unavailable.";
  };

  $("#plugin-url").addEventListener("click", () => void copyUrl());
  $("#copy-plugin-url").addEventListener("click", () => void copyUrl());

  apply.addEventListener("click", async () => {
    if (await runSave(apply, "review")) {
      $(".output-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });

  renderSelection();
  renderButtons();
  renderOutput();
  renderUser();
}
