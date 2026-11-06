import { createStore } from "../core/store.js";
import type { AppView, MiddlewareTab } from "../core/types.js";

interface ViewState {
  view: AppView;
  /** Which middleware panel shows when `view` is "middleware". */
  tab: MiddlewareTab;
}

export const viewStore = createStore<ViewState>({ view: "configure", tab: "filters" });

export function showView(view: AppView): void {
  viewStore.update((current) => ({ ...current, view }));
}

export function showMiddlewareTab(tab: MiddlewareTab): void {
  viewStore.set({ view: "middleware", tab });
}

/** Review is always navigable; selection validity is enforced by the save action. */
export function openReview(): void {
  showView("save");
}
