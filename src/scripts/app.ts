// Browser entry point. Each component owns one part of the page and talks to
// the others only through the stores in ./state; this file just starts them.

import { mountAccountPanel } from "./components/AccountPanel.js";
import { mountAppShell } from "./components/AppShell.js";
import { mountAuthPanel } from "./components/AuthPanel.js";
import { mountMiddlewarePanel } from "./components/MiddlewarePanel.js";
import { mountPluginCatalog } from "./components/PluginCatalog.js";
import { mountPluginSources } from "./components/PluginSources.js";
import { mountProfilesPanel } from "./components/ProfilesPanel.js";
import { mountReviewPanel } from "./components/ReviewPanel.js";
import { onUnauthorized } from "./core/api.js";
import { onReady } from "./core/dom.js";
import { setStatus } from "./core/status.js";
import { showVersion } from "./services/version.js";
import { leaveWorkspace, restoreSession } from "./services/session.js";
import { userStore } from "./state/session.js";

function start(): void {
  mountAppShell();
  mountAuthPanel();
  mountPluginSources();
  mountPluginCatalog();
  mountMiddlewarePanel();
  mountReviewPanel();
  mountProfilesPanel();
  mountAccountPanel();

  // An expired session on any request sends the user back to the login form.
  onUnauthorized(() => {
    if (!userStore.get()) return;
    leaveWorkspace();
    setStatus("auth", "Your session expired. Please log in again.", "error");
  });

  void restoreSession();
  void showVersion();
}

onReady(start);
