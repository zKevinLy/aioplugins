
// Builds the application's Platform from Cloudflare Worker bindings.

import type { Platform } from "../../lib/platform.js";
import { createD1Database } from "./d1.js";
import type { Env } from "./env.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** "id1, id2" -> lowercase UUIDs; anything that is not a UUID is ignored. */
export function parseAdminUserIds(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map(id => id.trim().toLowerCase())
    .filter(id => UUID_PATTERN.test(id));
}

export function createCloudflarePlatform(env: Env): Platform {
  return {
    db: createD1Database(env.DB),

    // Workers Static Assets binding.
    assets: {
      fetch: request => env.ASSETS.fetch(request)
    },

    // Set by Cloudflare's edge on every proxied request.
    getClientIp: request => request.headers.get("cf-connecting-ip"),

    adminUserIds: parseAdminUserIds(env.ADMIN_USER_IDS)
  };
}
