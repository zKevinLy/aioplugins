import { createStore } from "../core/store.js";
import type { ProviderCheck } from "../core/types.js";

/** Speed-check results for this session, keyed by `healthKey`. */
export const healthStore = createStore<ReadonlyMap<string, ProviderCheck>>(new Map());

export function healthKey(sourceKey: string, providerId: string): string {
  return `${sourceKey}#${providerId}`;
}

/** The latest result, unless the source has moved to a newer commit since. */
export function getCheck(
  sourceKey: string,
  providerId: string,
  commit: string
): ProviderCheck | undefined {
  const check = healthStore.get().get(healthKey(sourceKey, providerId));
  return check && check.commit === commit ? check : undefined;
}

export function setCheck(sourceKey: string, providerId: string, check: ProviderCheck): void {
  const next = new Map(healthStore.get());
  next.set(healthKey(sourceKey, providerId), check);
  healthStore.set(next);
}

export function clearChecks(): void {
  healthStore.set(new Map());
}
