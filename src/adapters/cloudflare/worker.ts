
// Cloudflare Workers entry point.
//
// This is the only module that knows about the Workers runtime
// (ExportedHandler, the `fetch` export shape). It converts Cloudflare's
// bindings into a Platform and calls the platform-independent app.

import { handleRequest } from "../../server.js";
import type { Env } from "./env.js";
import { createCloudflarePlatform } from "./platform.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, createCloudflarePlatform(env));
  },
} satisfies ExportedHandler<Env>;
