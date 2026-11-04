// The frame around the app: which screen shows, the sidebar, page titles,
// the session bar and the footer.

import { $ } from "../core/dom.js";
import { isRecord } from "../core/guards.js";
import type { AppView, MiddlewareTab } from "../core/types.js";
import { signOut } from "../services/session.js";
import { runSave } from "./saveFlow.js";
import { savingStore } from "../state/setup.js";
import { sourceStore } from "../state/sources.js";
import { sessionReady, userStore } from "../state/session.js";
import { openReview, showMiddlewareTab, showView, viewStore } from "../state/view.js";

const VIEW_SECTIONS: Record<AppView, string> = {
  configure: "#configure-view",
  middleware: "#middleware-view",
  save: "#save-view",
  account: "#account-view",
  about: "#about-view"
};

const NAV_ITEMS: Record<string, string> = {
  configure: "#configure-tab",
  filters: "#filters-tab",
  sorting: "#sorting-tab",
  formatting: "#formatting-tab",
  save: "#save-tab",
  account: "#account-nav",
  about: "#about-nav"
};

type PageText = { title: string; description: string };

const PAGES: Record<Exclude<AppView, "middleware">, PageText> = {
  configure: {
    title: "Choose your plugins",
    description: "Select plugin sources and choose the providers you want to use."
  },
  save: {
    title: "Save & Install",
    description: "Check your selection, save your setup, and add it to Nuvio."
  },
  account: {
    title: "Account settings",
    description: "Manage your account and configuration backups."
  },
  about: {
    title: "About AIOPlugins",
    description: "Learn about the project, find its source code, and support its hosting costs."
  }
};

const MIDDLEWARE_PAGES: Record<MiddlewareTab, PageText> = {
  filters: { title: "Filter streams", description: "Choose which provider results reach Nuvio." },
  sorting: { title: "Sort streams", description: "Choose the order of each provider's results." },
  formatting: { title: "Format stream details", description: "Surface stream metadata in displayed titles." }
};

async function showAppVersion(): Promise<void> {
  try {
    const response = await fetch("/version.json", { cache: "no-store" });
    if (!response.ok) return;

    const data: unknown = await response.json();

    if (isRecord(data) && typeof data.version === "string" && data.version.trim()) {
      const badge = $("#app-version");
      badge.textContent = data.version;
      badge.hidden = false;
    }
  } catch {
    // Version information is optional.
  }
}

function renderView(): void {
  const { view, tab } = viewStore.get();

  for (const [name, selector] of Object.entries(VIEW_SECTIONS)) {
    $(selector).hidden = name !== view;
  }

  const activeNav = view === "middleware" ? tab : view;

  for (const [name, selector] of Object.entries(NAV_ITEMS)) {
    const button = $<HTMLButtonElement>(selector);
    const active = name === activeNav;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  }

  const page = view === "middleware" ? MIDDLEWARE_PAGES[tab] : PAGES[view];
  $("#page-title").textContent = page.title;
  $("#page-description").textContent = page.description;
}

function renderSession(): void {
  const user = userStore.get();
  const signedIn = user !== null;

  $("#auth-view").hidden = signedIn || !sessionReady.get();
  $("#app-view").hidden = !signedIn;
  $("#session-bar").hidden = !signedIn;
  $("#server-state").hidden = signedIn;

  if (user) $("#session-id").textContent = `${user.id.slice(0, 8)}…`;
}

function refreshIcons(): void {
  const iconLibrary = (globalThis as typeof globalThis & {
    lucide?: { createIcons: () => void };
  }).lucide;
  iconLibrary?.createIcons();
}

export function mountAppShell(): void {
  const year = document.querySelector<HTMLElement>("#copyright-year");
  if (year) year.textContent = String(new Date().getFullYear());

  void showAppVersion();

  userStore.subscribe(renderSession);
  sessionReady.subscribe(renderSession);
  viewStore.subscribe(renderView);
  renderSession();
  renderView();

  $("#configure-tab").addEventListener("click", () => showView("configure"));
  $("#filters-tab").addEventListener("click", () => showMiddlewareTab("filters"));
  $("#sorting-tab").addEventListener("click", () => showMiddlewareTab("sorting"));
  $("#formatting-tab").addEventListener("click", () => showMiddlewareTab("formatting"));
  $("#save-tab").addEventListener("click", openReview);
  $("#account-menu").addEventListener("click", () => showView("account"));
  $("#account-nav").addEventListener("click", () => showView("account"));
  $("#about-nav").addEventListener("click", () => showView("about"));
  $("#logout").addEventListener("click", () => void signOut());

  const quickSave = $<HTMLButtonElement>("#quick-save");
  const updateQuickSave = () => {
    quickSave.disabled = sourceStore.selectionCount() === 0 || savingStore.get();
    quickSave.title = savingStore.get() ? "Saving…" : "Quick save";
    quickSave.setAttribute("aria-label", quickSave.title);
  };
  sourceStore.subscribe(updateQuickSave);
  savingStore.subscribe(updateQuickSave);
  quickSave.addEventListener("click", () => void runSave(quickSave, "quick-save"));
  updateQuickSave();

  const sidebar = $("#app-sidebar");
  const sidebarToggle = $<HTMLButtonElement>("#sidebar-toggle");
  const collapsed = localStorage.getItem("aioplugins-sidebar-collapsed") === "true";
  sidebar.classList.toggle("is-collapsed", collapsed);
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  sidebarToggle.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  sidebarToggle.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  sidebarToggle.innerHTML = `<i data-lucide="${collapsed ? "panel-left-open" : "panel-left-close"}" aria-hidden="true"></i>`;

  sidebarToggle.addEventListener("click", () => {
    const nextCollapsed = !sidebar.classList.contains("is-collapsed");
    sidebar.classList.toggle("is-collapsed", nextCollapsed);
    localStorage.setItem("aioplugins-sidebar-collapsed", String(nextCollapsed));
    sidebarToggle.setAttribute("aria-expanded", String(!nextCollapsed));
    sidebarToggle.setAttribute("aria-label", nextCollapsed ? "Expand sidebar" : "Collapse sidebar");
    sidebarToggle.title = nextCollapsed ? "Expand sidebar" : "Collapse sidebar";
    sidebarToggle.innerHTML = `<i data-lucide="${nextCollapsed ? "panel-left-open" : "panel-left-close"}" aria-hidden="true"></i>`;
    refreshIcons();
  });



  refreshIcons();

  // Every "back to the plugin list" control behaves the same.
  for (const selector of ["#back-from-account", "#edit-selection"]) {
    $(selector).addEventListener("click", () => showView("configure"));
  }
}
