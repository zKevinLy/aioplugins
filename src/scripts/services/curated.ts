// Following the curated plugin list, and (for admins) publishing it.

import { api } from "../core/api.js";
import type {
  AdminCuratedResponse,
  PublishCuratedResponse,
  SavedSource,
  UserResponse
} from "../core/types.js";
import { enterWorkspace } from "./session.js";

/** Starts or stops following the curated list, then shows what is now served. */
export async function setFollowing(follow: boolean): Promise<void> {
  const { user, workspace } = await api<UserResponse>("/api/account/curated", { follow });
  await enterWorkspace(user, workspace);
}

export function loadCurated(): Promise<AdminCuratedResponse> {
  return api<AdminCuratedResponse>("/api/admin/curated");
}

export function publishCurated(
  sources: SavedSource[],
  middleware: unknown
): Promise<PublishCuratedResponse> {
  return api<PublishCuratedResponse>("/api/admin/curated", { sources, middleware });
}
