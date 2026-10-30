import { createPluginBuilderServer } from "./server.js";

const port = Number.parseInt(process.env.PORT || "7000", 10);
const host = "0.0.0.0";
const storageRoot = process.env.DATA_DIR || process.cwd();

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT value: ${process.env.PORT}`);
}

const server = createPluginBuilderServer({ providerStorageRoot: storageRoot });

server.listen(port, host, () => {
  console.log(`AIOPlugins listening on http://${host}:${port}`);
  console.log(`AIOPlugins data directory: ${storageRoot}`);
});
