import { createPluginBuilderServer } from "./server.js";

const port = Number.parseInt(process.env.PORT || "7000", 10);
const host = process.env.HOST || "0.0.0.0";
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
if (typeof host !== "string" || host.length === 0) {
  throw new Error("HOST must be a non-empty string");
}

const server = createPluginBuilderServer();

server.listen(port, host, () => {
  console.log(`AIOPlugins listening on http://${host}:${port}`);
});
