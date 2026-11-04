// Saved plugin combinations the user can switch between.

import { $ } from "../core/dom.js";
import { errorMessage } from "../core/guards.js";
import { setStatus } from "../core/status.js";
import { applyProfile, deleteProfile, saveProfile } from "../services/profiles.js";
import { profilesStore } from "../state/workspace.js";
import { showView } from "../state/view.js";

function renderOptions(): void {
  const profiles = profilesStore.get();
  const select = $<HTMLSelectElement>("#profile-select");
  const previous = select.value;

  // The placeholder lets a profile be picked even when it is the only one.
  const options = [
    new Option(profiles.length === 0 ? "No saved profiles" : "Choose a profile…", ""),
    ...profiles.map((profile) => new Option(profile.name, profile.id))
  ];

  select.replaceChildren(...options);
  select.value = profiles.some((profile) => profile.id === previous) ? previous : "";
  select.disabled = profiles.length === 0;
  $<HTMLButtonElement>("#delete-profile").disabled = profiles.length === 0;
}

export function mountProfilesPanel(): void {
  const select = $<HTMLSelectElement>("#profile-select");

  profilesStore.subscribe(renderOptions);
  renderOptions();

  select.addEventListener("change", async () => {
    const profile = profilesStore.get().find((entry) => entry.id === select.value);
    if (!profile) return;

    setStatus("review", "Switching profile…");

    try {
      const failures = await applyProfile(profile);
      showView("configure");

      if (failures.length > 0) {
        setStatus("catalog", `Some profile sources couldn't load: ${failures.join("; ")}`, "error");
      } else {
        setStatus("catalog", `Profile "${profile.name}" loaded successfully.`, "success");
      }
    } catch (error) {
      setStatus("review", errorMessage(error), "error");
    }
  });

  $("#save-profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    const input = $<HTMLInputElement>("#profile-name");
    const name = input.value.trim();

    if (!name) {
      input.focus();
      return;
    }

    try {
      await saveProfile(name);
      input.value = "";
      setStatus("review", "Profile saved successfully.", "success");
    } catch (error) {
      setStatus("review", errorMessage(error), "error");
    }
  });

  $("#delete-profile").addEventListener("click", async () => {
    if (!select.value) {
      setStatus("review", "Select a profile to delete.", "error");
      return;
    }

    if (!confirm("Are you sure you want to delete this profile?")) return;

    try {
      await deleteProfile(select.value);
      setStatus("review", "Profile deleted.", "success");
    } catch (error) {
      setStatus("review", errorMessage(error), "error");
    }
  });
}
