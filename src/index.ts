import { createPluginBuilderServer } from "./server.js";

const port = Number.parseInt(process.env.PORT || "7000", 10);
const host = "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const server = createPluginBuilderServer();

server.listen(port, host, () => {
  console.log(`AIOPlugins listening on http://${host}:${port}`);
});
