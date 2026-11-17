// "Curated plugins": the subscribe checkbox, and the read-only state the rest
// of the page takes on while the account follows the curated list.

import { $, $$ } from "../core/dom.js";
import { errorMessage } from "../core/guards.js";
import { setStatus } from "../core/status.js";
import { setFollowing } from "../services/curated.js";
import { curatedStore, isCuratedLocked } from "../state/curated.js";
import { userStore } from "../state/session.js";

let busy = false;

function renderToggle(): void {
  const { following, available } = curatedStore.get();
  const checkbox = $<HTMLInputElement>("#curated-follow");

  checkbox.checked = following;
  checkbox.disabled = busy || userStore.get() === null;

  $("#curated-state").textContent = following && available
    ? "Subscribed"
    : following
      ? "Subscribed · waiting for the list"
      : "Not subscribed";

  $("#curated-detail").textContent = following
    ? available
      ? "Your plugins and filter, sorting and formatter settings are managed for you and update automatically. Untick to choose your own."
      : "No curated list has been published yet, so your own selection is used for now."
    : "Tick to use the curated selection instead. Your own selection is saved as a profile first, and you can unsubscribe at any time.";
}

/** Everything that edits the selection or settings is switched off while locked. */
function renderLock(): void {
  const locked = isCuratedLocked();

  for (const element of $$("#configure-view .quick-source-section, #configure-view .custom-source, #middleware-view .middleware-panel, #profiles-card")) {
    element.toggleAttribute("inert", locked);
  }

  $("#middleware-curated-note").hidden = !locked;
  $("#save-curated-note").hidden = !locked;
  $<HTMLButtonElement>("#import-config").disabled = locked;
}

export function mountCuratedPanel(): void {
  const render = () => {
    renderToggle();
    renderLock();
  };

  curatedStore.subscribe(render);
  userStore.subscribe(render);
  render();

  $<HTMLInputElement>("#curated-follow").addEventListener("change", async (event) => {
    const checkbox = event.currentTarget as HTMLInputElement;
    const follow = checkbox.checked;

    busy = true;
    renderToggle();
    setStatus("curated", follow ? "Subscribing…" : "Unsubscribing…");

    try {
      await setFollowing(follow);
      setStatus(
        "curated",
        follow
          ? "Subscribed. Your previous selection is saved in Profiles as \"Before curated plugins\"."
          : "Unsubscribed. You keep the same plugins for now; change them and save whenever you like.",
        "success"
      );
    } catch (error) {
      checkbox.checked = !follow;
      setStatus("curated", errorMessage(error), "error");
    } finally {
      busy = false;
      renderToggle();
    }
  });
}