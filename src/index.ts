
import { handleRequest } from "./server.js";
import type { Env } from "./lib/db.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
