// Signing in and out, and loading everything a signed-in user needs.

import { api, withTransientRetry } from "../core/api.js";
import { errorMessage } from "../core/guards.js";
import { setStatus } from "../core/status.js";
import type { PublicUser, SessionResponse, Workspace } from "../core/types.js";
import { middlewareStore, toMiddlewareSettings } from "../state/middleware.js";
import { sessionReady, userStore } from "../state/session.js";
import { manifestStore } from "../state/setup.js";
import { sourceKey, sourceStore, sourcesLoading } from "../state/sources.js";
import { showView } from "../state/view.js";
import { fieldsStore, profilesStore } from "../state/workspace.js";
import { clearDiscoveryCache, loadSources, suggestedSources, type SourceRequest } from "./sources.js";
import { refreshManifest } from "./manifest.js";

// Bumped on every sign-in/out so a slow load for a previous user can never
// write into the current one's screen.
let generation = 0;

/** Suggested sources first, then the user's saved ones (which win on ties). */
function sourcesToLoad(workspace: Workspace): SourceRequest[] {
  const wanted = new Map<string, SourceRequest>();

  for (const request of [...suggestedSources(), ...workspace.sources]) {
    wanted.set(sourceKey(request), request);
  }

  return [...wanted.values()];
}

/**
 * Shows the app for `user` and starts loading their plugin sources right
 * away. The workspace (settings, fields, profiles, saved selection) arrives
 * with the sign-in response, so nothing here waits on a second round trip,
 * and all sources are requested together.
 */
export async function enterWorkspace(user: PublicUser, workspace: Workspace): Promise<void> {
  const mine = ++generation;
  const current = () => mine === generation;

  clearDiscoveryCache();
  sourceStore.clear();
  manifestStore.set(null);
  fieldsStore.set(workspace.fields);
  profilesStore.set(workspace.profiles);
  middlewareStore.set(toMiddlewareSettings(workspace.middleware));
  userStore.set(user);
  showView("configure");

  const requests = sourcesToLoad(workspace);
  const saved = new Map(workspace.sources.map((source) => [sourceKey(source), source]));

  sourceStore.setOrder(requests.map(sourceKey));
  sourcesLoading.set(true);
  setStatus("catalog", "Loading your plugin sources…");

  // The install link's content only matters if something has been saved.
  if (workspace.sources.length > 0) refreshManifest().catch(() => undefined);

  try {
    const { failures } = await loadSources(requests, {
      onSource: ({ source }) => {
        if (!current()) return;
        const savedSelection = saved.get(sourceKey(source));
        sourceStore.upsert(source, savedSelection?.providerIds ?? []);
      }
    });

    if (!current()) return;

    if (failures.length > 0) {
      setStatus("catalog", `Some sources couldn't load: ${failures.join("; ")}`, "error");
    } else {
      setStatus(
        "catalog",
        `Loaded ${sourceStore.size} plugin sources. Choose the plugins you want.`,
        "success"
      );
    }
  } catch (error) {
    if (current()) setStatus("catalog", errorMessage(error), "error");
  } finally {
    if (current()) sourcesLoading.set(false);
  }
}

/** Returns to the login screen and forgets everything about the user. */
export function leaveWorkspace(): void {
  generation++;
  clearDiscoveryCache();
  sourceStore.clear();
  sourcesLoading.set(false);
  manifestStore.set(null);
  profilesStore.set([]);
  userStore.set(null);
}

export async function signOut(): Promise<void> {
  try {
    await api("/api/logout", {});
  } finally {
    leaveWorkspace();
  }
}

/** Resumes an existing session on page load. */
export async function restoreSession(): Promise<void> {
  try {
    const { user, workspace } = await withTransientRetry(() => api<SessionResponse>("/api/session"));

    if (user && workspace) {
      await enterWorkspace(user, workspace);
    } else {
      leaveWorkspace();
    }
  } catch (error) {
    leaveWorkspace();
    setStatus("auth", errorMessage(error), "error");
  } finally {
    sessionReady.set(true);
  }
}
