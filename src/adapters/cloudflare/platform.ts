
// Builds the application's Platform from Cloudflare Worker bindings.

import type { Platform } from "../../lib/platform.js";
import { createD1Database } from "./d1.js";
import type { Env } from "./env.js";

export function createCloudflarePlatform(env: Env): Platform {
  return {
    db: createD1Database(env.DB),

    // Workers Static Assets binding.
    assets: {
      fetch: request => env.ASSETS.fetch(request)
    },

    // Set by Cloudflare's edge on every proxied request.
    getClientIp: request => request.headers.get("cf-connecting-ip")
  };
}
