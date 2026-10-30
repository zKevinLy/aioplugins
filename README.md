# AIOPlugins

Build personalized Nuvio plugin repositories by selecting plugins from multiple GitHub sources. AIOPlugins combines Nuvio manifest entries and serves each selected plugin file under a profile-specific repository URL without running provider code.

## Run locally

Requirements: Node.js 22.5 or newer and npm (the app uses the built-in `node:sqlite` module).

```sh
npm install
npm test
npm run dev
```

Open `http://127.0.0.1:7000/`. Create a profile for each person or setup with a password of at least 8 characters, choose a suggested source or enter an HTTPS GitHub repository URL, inspect its manifest, select plugins, and click **Save & Install**. Each profile gets a UUID, an independent plugin selection, and a password-protected Nuvio repository URL. Add that URL to Nuvio's plugin source settings. The encrypted token in the URL is a bearer credential: share it only with people who should have access to that profile.

No repository clone is needed. Selected bundled files are downloaded from the exact inspected commit and cached in `.nuvio-cache/`. The combined manifest uses the Nuvio `scrapers` format and rewrites each `filename` to a file served by this builder. Profile password hashes, the encryption key, and profile selections are stored locally in ignored `.aioplugins-*` files. Back up the `data/` folder with the profile data; losing it invalidates existing profile links. Restarting uses the cached selection; updates require inspecting and applying the source again with the profile password.

For local development, the server is available at `http://127.0.0.1:7000/`. In production it binds to the host and port supplied by the hosting platform. The source-management API requires an authenticated account session.

## Sources and execution

The picker currently accepts HTTPS GitHub repository URLs with either a top-level array manifest or an object containing `scrapers`. Plugin files are fetched but not executed by the builder. Nuvio downloads the selected JavaScript files from the generated `filename` URLs and runs them in its own plugin runtime. Review sources before building a link because the selected plugin code will execute in Nuvio.

Source metadata such as plugin names, descriptions, supported types, logos, and settings flags is preserved in the combined manifest. Nuvio continues to render and store each plugin's native settings. AIOPlugins does not combine movie metadata or rewrite plugin behavior; it selects and republishes source manifest entries and bundled files.

Profiles carry over AIOStreams-style per-person GUID/password configuration links. Nuvio owns plugin execution, stream filtering, and plugin setting storage, so AIOPlugins does not implement Stremio stream filters, sorting, debrid services, or playback features.

## Upstream sources

- [Yoru's Nuvio providers](https://github.com/yoruix/nuvio-providers)
- [All-in-One Nuvio](https://github.com/NuvioPlugin/All-in-One-Nuvio)

Their source files are fetched on demand and cached locally, not committed to this repository. Yoru's repository is GPL-3.0. All-in-One's README states GPL-3.0, but its main branch did not contain a `LICENSE` file when last checked; confirm its license before redistributing selected plugin files. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License and disclaimer

The builder source is GPL-3.0-only. This does not grant rights to upstream providers, third-party services, or media. The project is independent and is not affiliated with or endorsed by Nuvio, Yoru, All-in-One, or any third-party service. You are responsible for choosing sources and complying with applicable laws and service terms. The software is provided without warranty.


## Deploying to Render

Create a Render **Web Service** with:

- Build command: `npm install && npm run build`
- Start command: `npm run start`
- Environment: `NODE_ENV=production`
- Node.js: `22.5` or newer (the `engines` field enforces this)
- Optional persistent storage: set `DATA_DIR` to the mount path of a Render persistent disk (for example `/var/data`).

The service listens on Render's `PORT` and binds to `0.0.0.0`. The browser API is protected by account sessions rather than a localhost-only Host-header check.

**Important:** SQLite and cached provider files are stored under `DATA_DIR` (or the working directory if unset). Render's ephemeral filesystem can lose this data on redeploy/restart. Attach a persistent disk and set `DATA_DIR` to its mount path for production accounts and plugin caches to survive deployments. Persistent disks may require a paid Render plan.
