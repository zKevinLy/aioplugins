import { createStore } from "../core/store.js";
import type { AdminTab, AppView, MiddlewareTab } from "../core/types.js";

interface ViewState {
  view: AppView;
  /** Which middleware panel shows when `view` is "middleware". */
  tab: MiddlewareTab;
  /** Which admin pane shows when `view` is "admin". */
  adminTab: AdminTab;
}

export const viewStore = createStore<ViewState>({ view: "configure", tab: "filters", adminTab: "plugins" });

export function showView(view: AppView): void {
  viewStore.update((current) => ({ ...current, view }));
}

export function showMiddlewareTab(tab: MiddlewareTab): void {
  viewStore.update((current) => ({ ...current, view: "middleware", tab }));
}

export function showAdminTab(adminTab: AdminTab): void {
  viewStore.update((current) => ({ ...current, view: "admin", adminTab }));
}

/** Review is always navigable; selection validity is enforced by the save action. */
export function openReview(): void {
  showView("save");
}
