# AIOPlugins

Build personalized Nuvio plugin repositories by selecting plugins from multiple GitHub sources. AIOPlugins combines Nuvio manifest entries and serves each selected plugin file under an account-specific repository URL without running provider code.

## How it works

1. Create an account with a password of at least 8 characters. You receive a UUID; the UUID and password are your login. Keep both.
2. Enter an HTTPS GitHub repository URL (and optionally a branch or tag; the default is `main`). AIOPlugins resolves it to an exact commit and reads the `manifest.json` at the repository root.
3. Select the plugins you want and apply. The selected files are downloaded from that exact commit and cached in the database.
4. Your account gets a Nuvio repository URL of the form `/u/<uuid>/<token>/manifest.json`. Add it to Nuvio's plugin source settings.

The token in that URL is a bearer credential: anyone who has the URL can load your manifest and plugin files, so share it only with people who should have access. Your password is required to delete the account.

Sources are pinned to a commit. If a source repository changes, nothing updates until you inspect and apply it again while logged in.

You can also save named **profiles** (stored source selections). Saving a profile makes that selection the one your install link serves.

No repository clone is needed. The combined manifest uses the Nuvio `scrapers` format and rewrites each `filename` to a file served by this app.

## Sources and execution

The picker accepts HTTPS GitHub repository URLs with either a top-level array manifest or an object containing `scrapers`. Plugin files are fetched but not executed by the builder. Nuvio downloads the selected JavaScript files from the generated `filename` URLs and runs them in its own plugin runtime. Review sources before building a link because the selected plugin code will execute in Nuvio.

Limits: manifests and commit feeds up to 2 MB, provider files up to 8 MB, request bodies up to 1 MB. Requests to GitHub use a 15 second timeout and only the hosts `github.com` and `raw.githubusercontent.com` are contacted.

Source metadata such as plugin names, descriptions, supported types, logos, and settings flags is preserved in the combined manifest. Nuvio continues to render and store each plugin's native settings. AIOPlugins wraps each selected plugin's `getStreams` result at request time. A shared typed field catalog drives field-based filters, sorting, and formatter token insertion, covering stream details such as resolution, title, size, languages, audio, release group, service state, and more. Common resolution values are inferred from quality or title when absent. Results are handled in memory by Nuvio and are never stored by AIOPlugins. The formatter supports AIOStreams-style `{stream.field}` tokens, optional blocks, and common modifiers such as `replace`, `join`, `sbytes`, and `time`; it is not a full AIOStreams template-engine implementation.

Accounts carry per-person GUID/password configuration links. Nuvio still owns plugin execution, plugin setting storage, debrid services, and playback. AIOPlugins middleware only processes the array returned by each plugin's `getStreams` method.

## Architecture

The application is separated from its hosting platform. Cloudflare is currently the only hosting adapter.

```
src/
├── index.ts                  Wrangler entry point (re-exports the Cloudflare worker)
├── server.ts                 Routing, sessions, rate limiting: handleRequest(request, platform)
├── users.ts                  Accounts, sessions, profiles, per-user source config
├── providers/remote.ts       GitHub discovery, validation, and provider caching
├── lib/
│   ├── db.ts                 Contract: Database (first, all, run, atomic batch)
│   └── platform.ts           Contract: Platform (db, static assets, client IP)
└── adapters/cloudflare/      The only place Cloudflare APIs appear
    ├── worker.ts             Workers entry (ExportedHandler)
    ├── platform.ts           Builds a Platform from Wrangler bindings
    ├── d1.ts                 D1 implementation of Database
    └── env.ts                Binding types: DB, ASSETS, GITHUB_TOKEN
```

Everything outside `src/adapters/` is platform-independent and compiles without Cloudflare types. To host somewhere else, implement `Database` and `Platform` for the new environment and add an entry file that calls `handleRequest(request, platform)`; `server.ts`, `users.ts`, and `providers/remote.ts` do not change.

The application's SQL is written for SQLite with `?` placeholders. An adapter for another engine may need to translate placeholders (for example `?` to `$1`) and use 64-bit integer columns, because timestamps are stored as `Date.now()` values.

## Run locally

Requirements: Node.js 22.5 or newer and npm.

```sh
npm install
npm run dev
```

`npm run dev` runs `wrangler dev`, which serves the Worker locally with a local D1 database and the static assets. Open the URL Wrangler prints (port 8787 by default).

The Worker expects these bindings in your Wrangler configuration:

| Binding | Type | Purpose |
| --- | --- | --- |
| `DB` | D1 database | Accounts, sessions, profiles, source selections, provider cache |
| `ASSETS` | Static assets | The front end; `/` serves `index.html` |

It also needs the `nodejs_compat` compatibility flag because it uses `node:crypto`. `GITHUB_TOKEN` is declared as an optional binding but is not currently used.

The database needs these tables: `users`, `user_config`, `profiles`, `sessions`, and `provider_cache`. Apply your schema to the local D1 database before first use (see your migrations).

Type-check with `npm run typecheck`.

## Deploying to Cloudflare

1. Create a D1 database and put its ID in your Wrangler configuration under the `DB` binding.
2. Apply the schema to the remote database.
3. Configure the `ASSETS` binding and the `nodejs_compat` flag.
4. Add the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets, and configure the `prod` GitHub Actions environment.

Pull requests run the test suite on Node.js 22 and 24. Every push to `main` runs the same checks; after they pass, GitHub creates a release and tag, applies remote D1 migrations, and deploys the Worker.

Plugin files and manifests are cached in D1 (in 512 KB chunks), so there is no local filesystem state and no persistent disk to configure.

## Releases

Every successful push to `main` creates a GitHub Release and matching `vX.Y.Z` tag, then deploys that revision. The tag is the deployed app version; `package.json` is not used as the release version after the initial fallback. If a push contains multiple commits, the highest applicable bump is used. Releases follow [Conventional Commits](https://www.conventionalcommits.org/):

| Commit message | Effect |
| --- | --- |
| `feat: add profile export` | minor bump |
| `feat!: change install URL format` or a `BREAKING CHANGE:` footer | major bump, including before 1.0.0 |
| Any other commit, including `fix:`, `chore:`, `docs:`, and `test:` | patch bump |

GitHub generates release notes for each tag. `CHANGELOG.md` is not automatically rewritten by the release workflow.

## Security notes

- Passwords are hashed with scrypt and a per-user salt. Sessions are stored as SHA-256 hashes and expire after 30 days; the session cookie is `HttpOnly`, `Secure`, and `SameSite=Strict`.
- Login attempts are throttled per account and client, and sensitive routes are rate limited per client IP. The client IP comes from Cloudflare's `cf-connecting-ip` header. Rate-limit and lockout counters are kept in memory per running instance, so they are not shared across Worker instances.
- Responses carry `nosniff`, frame-deny, and referrer-policy headers. The manifest and plugin routes allow cross-origin reads so Nuvio can load them.

## Upstream sources

- [Yoru's Nuvio providers](https://github.com/yoruix/nuvio-providers)
- [All-in-One Nuvio](https://github.com/NuvioPlugin/All-in-One-Nuvio)

Their source files are fetched on demand and cached in the database, not committed to this repository. Yoru's repository is GPL-3.0. All-in-One's README states GPL-3.0, but its main branch did not contain a `LICENSE` file when last checked; confirm its license before redistributing selected plugin files. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License and disclaimer

The builder source is GPL-3.0-only. This does not grant rights to upstream providers, third-party services, or media. The project is independent and is not affiliated with or endorsed by Nuvio, Yoru, All-in-One, or any third-party service. You are responsible for choosing sources and complying with applicable laws and service terms. The software is provided without warranty.
