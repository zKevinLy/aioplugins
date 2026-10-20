import { createPluginBuilderServer } from "./server.js";

const port = 7000;
const host = "127.0.0.1";

const server = createPluginBuilderServer();

server.listen(port, host, () => {
  console.log(`AIOPlugins listening on http://${host}:${port}`);
});
