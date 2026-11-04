import { createStore } from "../core/store.js";
import type { PublicUser } from "../core/types.js";

/** False until the first session check finishes, so the login form never flashes. */
export const sessionReady = createStore(false);

/** The signed-in user, or null on the login screen. */
export const userStore = createStore<PublicUser | null>(null);

/** The private plugin repository URL the user pastes into Nuvio. */
export function installUrl(user: PublicUser): string {
  return `${location.origin}${user.installPath}`;
}
