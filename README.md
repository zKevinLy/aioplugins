# AIOPlugins

Build personalized Nuvio plugin repositories by selecting plugins from
multiple GitHub sources.

AIOPlugins combines selected Nuvio manifest entries and serves the
corresponding provider files through an account-specific repository URL.
It acts as a builder and delivery layer: **AIOPlugins does not run
provider code.** When Nuvio requests a selected provider file,
AIOPlugins retrieves it from the pinned upstream commit and returns it
to Nuvio. Nuvio runs the plugin in its own plugin runtime.

AIOPlugins is an independent community project. It is not affiliated
with, sponsored by, or endorsed by Nuvio, upstream plugin developers, or
the third-party services that providers may interact with.

## Contents

-   [How it works](#how-it-works)
-   [Accounts, profiles, and repository
    URLs](#accounts-profiles-and-repository-urls)
-   [Sources and execution](#sources-and-execution)
-   [Manifest and stream processing](#manifest-and-stream-processing)
-   [Architecture](#architecture)
-   [Run locally](#run-locally)
-   [Deploy to Cloudflare](#deploy-to-cloudflare)
-   [Security and privacy notes](#security-and-privacy-notes)
-   [Upstream sources and third-party
    licenses](#upstream-sources-and-third-party-licenses)
-   [Disclaimer](#disclaimer)
-   [License](#license)

## How it works

1.  **Create an account.** Choose a password of at least 8 characters.
    AIOPlugins assigns your account a UUID. Your UUID and password are
    used to log in; keep them safe.
2.  **Add a GitHub source.** Enter an HTTPS GitHub repository URL and,
    optionally, a branch or tag. If you do not specify one, AIOPlugins
    uses `main`.
3.  **Review the source.** AIOPlugins resolves the selected branch or
    tag to an exact commit and reads the repository's root
    `manifest.json`.
4.  **Choose plugins.** Select the plugins you want from the source
    manifest, then apply your selection.
5.  **Add your repository to Nuvio.** AIOPlugins creates an
    account-specific repository URL. Add that URL in Nuvio's plugin
    source settings.

AIOPlugins does not require you to clone repositories locally.

## Accounts, profiles, and repository URLs

Each account receives a UUID and can save named **profiles** containing
source selections. Applying or saving a profile makes that selection the
one served by the account's install URL.

Repository URLs follow this format:

``` text
/u/<uuid>/<token>/manifest.json
```

The token in this URL is a **bearer credential**. Anyone who has the
complete URL can access the generated manifest and the selected provider
files it references. Treat the URL like a password and share it only
with people you intend to grant access.

New tokens are 256 random bits from the platform's cryptographic random
number generator (43 URL-safe characters); accounts created earlier keep
their original 192-bit token until it is rerolled. If a link may have been
shared or leaked, use **Account settings → Install link → Generate new
link**. The old link stops working immediately, so anything installed in
Nuvio from it must be updated with the new one. Rerolling asks for your
password.

Your account password is required to delete your account or reroll your
install link. Keep your login details safe.

Sources are pinned to exact commits. Changes made later in an upstream
repository do not automatically change your configured source. To use an
update, review the source again and apply it while logged in.

## Sources and execution

The source picker accepts HTTPS GitHub repository URLs. Supported
manifests contain either a top-level array or an object with a
`scrapers` array.

When Nuvio requests a generated provider-file URL, AIOPlugins fetches
the selected JavaScript file from the configured GitHub repository at
the pinned commit, applies the middleware formatting, and returns the
file. Provider JavaScript is not executed by AIOPlugins and is not
stored in the AIOPlugins database.

**Nuvio executes the returned provider code in its own plugin runtime.**
Selecting a source therefore means trusting the code that source
provides. Review upstream repositories and their code before adding them
to a profile or sharing an install URL. AIOPlugins does not claim to
audit, verify, maintain, or endorse third-party provider code.

AIOPlugins currently contacts only these GitHub hosts:

-   `github.com`
-   `raw.githubusercontent.com`

Request limits:

  Resource                                 Limit
  --------------------------------- ------------
  Manifest files and commit feeds           2 MB
  Provider JavaScript files                 8 MB
  Request bodies                            1 MB
  GitHub request timeout              15 seconds

## Manifest and stream processing

The combined manifest uses Nuvio's `scrapers` format. AIOPlugins
preserves source metadata such as plugin names, descriptions, supported
types, logos, and settings flags, and rewrites each selected `filename`
to a file served by AIOPlugins. See [Nuvio compatibility](#nuvio-compatibility)
for exactly what Nuvio receives.

Nuvio continues to render and store each plugin's native settings.
AIOPlugins wraps each selected plugin's `getStreams` result at request
time. Results are processed in memory and are not stored by AIOPlugins.

### Filtering, sorting, and formatting

A shared typed field catalog drives field-based filtering and sorting.

**Stacked sorting.** Sorting is a list of up to five levels. Each level has
a field, a direction, and a choice of where streams with an unknown value
go (first or last, whichever way the level sorts). A level only orders
streams that the levels above it left tied, and streams still tied after
the last level keep the provider's own order. Settings saved with the
older single sort field are read as one level.

**Unknown values.** Providers do not always supply every field. A value
counts as unknown when it is missing, empty, or a placeholder such as
`Unknown`, `N/A`, `None`, or `-`; free-text fields (title, name,
description, filename, message, url) are exempt, so a title that is
literally "None" stays a title. The same rule applies everywhere:

-   Each filter can keep or remove streams whose value is unknown. If a
    rule makes no choice, "does not equal" and "does not contain" keep
    them and every other operator removes them, as before.
-   "Has a value" and "Is empty" use the same rule.
-   The formatter treats placeholders as missing, so `::exists` is false,
    optional groups disappear, and values can be inferred from the
    filename instead. The editor can insert a token that is left blank,
    skipped with its spacing, or replaced by a label of your choice.

The custom formatter follows the [AIOStreams formatter
syntax](https://docs.aiostreams.viren070.me/reference/custom-formatter/)
for:

-   Nested optional groups
-   Conditional branches and chaining
-   Field references
-   String, number, and array modifiers
-   Track-list modifiers
-   Date and duration patterns

Common release fields are inferred from provider filename, name, or
title fields when recognizable. These include media title, year, season
and episode, resolution, source quality, codec, languages, audio,
release group, container, and size.

`{addon.name}` resolves to the selected plugin's manifest name. Other
AIOStreams-only values---including `metadata`, `user`, `addon`, and
`config`---are unavailable. Service details and probed media tracks are
available only when supplied by the provider.

The formatter has separate stream-name and description templates:

-   The short name is written to `name`.
-   The detailed description is written to `size`, `title` and `description`.
    `size` is the field both Nuvio TV and Nuvio Desktop display (see
    [Nuvio compatibility](#nuvio-compatibility)).
-   The parsed byte count is kept as `behaviorHints.videoSize` and
    `fileSize`; the provider's own `size` text is never shown next to or
    instead of your description.
-   Filtering and sorting use provider metadata, not the formatted
    display text.

**Playback check (optional).** Under *Stream filters*, "Remove streams that
cannot be played" adds a check to the generated plugin file. The check runs
inside Nuvio, on the viewer's device, after the provider returns its streams:
for each `http(s)` stream URL it sends one small `Range: bytes=0-31` request,
using the stream's own headers, and reads only those first bytes. AIOPlugins
does not open, play, or proxy the media, and the check adds no AIOPlugins
server requests.

-   A stream is removed when the check clearly fails: a 4xx response
    (other than 408, 425, and 429), an empty response, an HTML, JSON, or
    XML response, or a body that starts like a web page instead of media.
-   With "Also remove streams that cannot be seeked" (on by default), a
    stream is also removed when the server ignores byte ranges, which
    breaks seeking. HLS playlists are exempt because they seek by segment.
-   A stream is kept, not removed, when the check cannot decide: timeouts,
    network errors, 5xx responses, rate limits, non-HTTP addresses such as
    magnet links, or a plugin runtime without `fetch`.
-   Each distinct URL is checked once, up to eight at a time, and the wait
    per stream is configurable (3 to 12 seconds). Checking adds a delay
    while results load, so the option is off by default.

This is a best-effort heuristic. A host can answer a probe differently from
Nuvio's player (for example, by user agent), so a stream can still fail to
play after passing, or occasionally be removed although it would have played.

AIOPlugins middleware processes the array returned by each plugin's
`getStreams` method. Nuvio remains responsible for plugin execution,
plugin setting storage, debrid services, and playback.

## Nuvio compatibility

Nuvio reads a plugin repository into strictly typed classes, and it keeps only
a few fields of what a plugin returns. AIOPlugins is built around what Nuvio
actually reads.

**Version.** The release workflow writes the deployed tag to
`/version.json`; the Worker reads the same file, so every surface agrees:

-   Manifest `version` is the AIOPlugins version (`0.0.0-dev` locally).
-   Manifest `name` is `AIOPlugins v1.2.3 · <account prefix>`. Nuvio shows the
    repository name on the plugin screen and, with *group streams by
    repository*, on each stream card, so this is where the version is visible.
-   Each plugin's `version` keeps the upstream version and appends build
    metadata: `1.4.0+aio.1.2.3`. Nuvio lists it as "Version 1.4.0+aio.1.2.3".
    Semantic-version precedence ignores build metadata, so comparisons still
    work.
-   `GET /health` reports the version, and each plugin carries an
    `aioplugins` block with the version, middleware revision, source
    repository and pinned commit.

**Manifest validity.** Every upstream entry is coerced to the types Nuvio
requires, so one odd upstream value (a numeric `version`, `"supportedTypes":
null`, a string where a list belongs) cannot make Nuvio reject the whole
repository. Unknown upstream keys are kept. `description`, `author`, `logo`
and `homepage` are set on the repository. `HEAD` requests, which Nuvio sends
before downloading each plugin, are answered without contacting GitHub.

**Logo.** A plugin's `logo` is always an absolute URL: an upstream absolute URL
is kept, a relative path resolves against the upstream repository at the pinned
commit, and anything missing or unusable falls back to the AIOPlugins icon.

**Stream fields.** The two clients draw a plugin stream differently:

| | Nuvio TV | Nuvio Desktop |
|---|---|---|
| Card name | `name`, plus " - Unknown" when `quality` is empty | `name` (`title` only if there is no name), one line |
| Line under the name | `size` • `language`, or `title` when both are missing | `quality` • `size` • `language` |
| `title` shown | only as that fallback | never |

So the wrapper:

-   writes the formatted description to `size`, the one field both clients
    display, so the text on the card is exactly what your templates produce;
-   sends no `quality` or `language`: Desktop would print them around your
    text. To stop TV adding " - Unknown" to the name when quality is missing,
    the unknown label (in every language TV ships) is placed in `provider`,
    which neither client displays;
-   keeps `title` and `description` set to the same text;
-   sends the real file size as `behaviorHints.videoSize` and the filename as
    `behaviorHints.filename` (Stremio's standard hints) for Nuvio versions that
    read them;
-   keeps headers, subtitles, audio delay hints and other provider fields.

Earlier versions wrote the description to `title` by default and offered a
*Show the description in* setting. Desktop never shows `title`, so that default
left its cards with only a resolution; the setting is gone and saved values are
ignored.

**Badges.** Nuvio draws a chip for each imported badge rule whose regular
expression matches a stream's name, title or description. AIOPlugins serves a
ready-made pack of 36 rules (resolution, HDR and Dolby Vision, audio formats and
channels, source, codec, extras) at `/badges.json`, with images in
`/badges/`. In Nuvio, import `https://<your-host>/badges.json` in the stream
badge settings. The URL is public and identical for everyone. Badges match
the formatted text, so a token that your templates leave out cannot produce a
badge. Both clients match only name, title and description (plus filename hints), so
keep the resolution in your name or description template if you want its badge. The
file-size chip needs `behaviorHints.videoSize`, which neither client reads from
plugin results (only from Stremio addon streams); put `📦 {stream.size::sbytes}`
in the description template to show the size as text.

Regenerate the badge images after editing `src/providers/badge-pack.ts`:

``` sh
python3 scripts/generate-badges.py   # needs Pillow
```

## Architecture

The UI is a static Astro site. Astro builds the page and browser module
into `dist/site`; the Cloudflare Worker serves those assets and owns the
API. Cloudflare is currently the only hosting adapter.

``` text
src/
├── pages/index.astro         Main page composed from view components
├── components/               Plugin setup, middleware, review, and account views
├── scripts/app.js            Browser interactions and API calls
├── index.ts                  Wrangler entry point (re-exports the Cloudflare worker)
├── server.ts                 Routing, sessions, rate limiting:
│                             handleRequest(request, platform)
├── users.ts                  Accounts, sessions, profiles, per-user source config
├── providers/remote.ts       GitHub discovery, validation, and live provider fetching
├── lib/
│   ├── db.ts                 Database contract (first, all, run, atomic batch)
│   └── platform.ts           Platform contract (db, static assets, client IP)
└── adapters/cloudflare/      The only place Cloudflare APIs appear
    ├── worker.ts             Workers entry (ExportedHandler)
    ├── platform.ts           Builds a Platform from Wrangler bindings
    ├── d1.ts                 D1 implementation of Database
    └── env.ts                Binding types: DB, ASSETS, GITHUB_TOKEN
```

Astro is the UI and build layer; it does not replace the Worker backend.
Code outside `src/adapters/` is platform-independent and compiles
without Cloudflare types.

To host the application on another platform, implement the `Database`
and `Platform` contracts for that environment and add an entry file that
calls `handleRequest(request, platform)`. The existing `server.ts`,
`users.ts`, and `providers/remote.ts` do not need to change.

Rust could be used for a separate backend implementation, but it is not
an Astro feature. On Cloudflare, it would need to run as a WebAssembly
Worker or as a separately hosted service, and either approach would
require rebuilding the current D1, session, and routing integration. The
current backend is primarily database and network I/O, so Rust is
unlikely to simplify it or meaningfully improve performance without a
measured need.

The `Database` and `Platform` contracts leave room for a different
backend later if a workload or deployment requirement justifies that
additional boundary.

The application's SQL is written for SQLite and uses `?` placeholders.
An adapter for another database engine may need to translate
placeholders (for example, `?` to `$1`) and use 64-bit integer columns,
because timestamps are stored as `Date.now()` values.

## Run locally

### Requirements

-   Node.js 22.23.4 or newer
-   npm

### Install and start

``` sh
npm install
npm run dev
```

`npm run dev` builds the Astro site and runs `wrangler dev`, which
serves the Worker locally with a local D1 database and the generated
static assets. Open the URL printed by Wrangler (port `8787` by
default).

After UI changes, run `npm run build:site` while the development server
is already running.

Available project commands:

  -----------------------------------------------------------------------
  Command                             Purpose
  ----------------------------------- -----------------------------------
  `npm run dev`                       Build the site and start the local
                                      Wrangler development server

  `npm run build:site`                Build the Astro site

  `npm run build`                     Build the Astro site and TypeScript
                                      Worker

  `npm test`                          Build the project, then run the
                                      test suite

  `npm run typecheck`                 Run TypeScript type checking
  -----------------------------------------------------------------------

### Local Worker bindings

The Worker expects these bindings in your Wrangler configuration:

  -----------------------------------------------------------------------
  Binding                 Type                    Purpose
  ----------------------- ----------------------- -----------------------
  `DB`                    D1 database             Accounts, sessions,
                                                  profiles, and source
                                                  selections

  `ASSETS`                Static assets           Astro output in
                                                  `dist/site`; `/` serves
                                                  the generated
                                                  `index.html` and the
                                                  Worker forwards bundled
                                                  assets
  -----------------------------------------------------------------------

The Worker also requires the `nodejs_compat` compatibility flag because
it uses `node:crypto`.

`GITHUB_TOKEN` is declared as an optional binding but is not currently
used.

The database needs these tables:

-   `users`
-   `user_config`
-   `profiles`
-   `sessions`

Apply your schema to the local D1 database before first use. See the
project's migrations.

## Deploy to Cloudflare

1.  Create a D1 database and add its ID to your Wrangler configuration
    under the `DB` binding.
2.  Apply the schema to the remote database.
3.  Configure the `ASSETS` binding and enable the `nodejs_compat`
    compatibility flag.
4.  Add the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
    repository secrets.
5.  Configure the GitHub Actions `prod` environment.

Pull requests run the test suite on Node.js 22 and 24. Every push to
`main` runs the same checks. After the checks pass, GitHub creates a
release and tag, applies remote D1 migrations, and deploys the Worker.

Provider JavaScript is not stored in D1. The database stores selected
source references and provider manifest metadata so the install manifest
can be built without contacting GitHub. Provider files are fetched live
from their pinned commits when Nuvio requests them.

## Security and privacy notes

The following describes the application's current implementation. It is
not a guarantee that the service is free from vulnerabilities or that
every deployment is configured securely.

-   Passwords are hashed with scrypt and a per-user salt.
-   Sessions are stored as SHA-256 hashes and expire after 30 days.
-   The session cookie is `HttpOnly`, `Secure`, and `SameSite=Strict`.
-   Login attempts are throttled per account and client.
-   Sensitive routes are rate limited per client IP.
-   The client IP is read from Cloudflare's `cf-connecting-ip` header.
-   Rate-limit and lockout counters are held in memory per running
    Worker instance; they are not shared across Worker instances.
-   Responses include `nosniff`, frame-deny, and referrer-policy
    headers.
-   Manifest and provider-file routes allow cross-origin reads so Nuvio
    can load them.

### Protect your account and install URL

Your password and account-specific repository URL protect different
things:

-   Your password is used to access your account and is required to
    delete it or to reroll your install link.
-   The token embedded in your repository URL grants access to the
    generated manifest and the provider files it references.

Do not publish or share your repository URL publicly unless you intend
to make that profile accessible to anyone who obtains it. If you believe
a URL has been exposed, generate a new install link from Account
settings and update the affected configuration.

For privacy details, consult the service's Privacy Policy if one is
published for the deployment you use.

## Upstream sources and third-party licenses

AIOPlugins can combine sources from third-party GitHub repositories. The
upstream projects and their contributors retain their respective rights
in their code and other materials. AIOPlugins does not grant users
rights to third-party content.

Known upstream sources include:

-   [Yoru's Nuvio providers](https://github.com/yoruix/nuvio-providers)
-   [All-in-One Nuvio](https://github.com/NuvioPlugin/All-in-One-Nuvio)

Selected repository, commit, provider IDs, and manifest metadata are
stored with your account. Provider JavaScript is fetched from the pinned
Git commit when Nuvio requests it, formatted, and returned without being
stored in the database. Serving provider files therefore depends on
GitHub being available.

Yoru's repository is licensed under GPL-3.0. The All-in-One repository's
README states GPL-3.0, but its main branch did not contain a `LICENSE`
file when last checked. **Verify the current license and applicable
redistribution terms before using or redistributing files from any
upstream repository.** Repository metadata or a README statement should
not be treated as a substitute for checking the actual license and the
rights applicable to the files you use.

See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for additional
notices.

If you are a rights holder and believe material accessible through
AIOPlugins infringes your rights, use the project's published contact or
reporting channel to submit a notice identifying the material and the
basis for your request. A public deployment should publish a monitored
contact address and a clear process for receiving rights-related
notices. Do not assume that this README, by itself, establishes
eligibility for any legal safe harbor.

## Disclaimer

AIOPlugins is an independent tool for organizing and combining
third-party Nuvio plugin sources. It is not affiliated with, sponsored
by, or endorsed by Nuvio, Yoru, All-in-One, or any third-party developer
or service.

AIOPlugins does not create, own, maintain, audit, or endorse third-party
plugins. Users choose the sources they add. AIOPlugins retrieves
selected provider files from their pinned upstream commits and serves
those files to Nuvio; **Nuvio executes the returned code in its own
plugin runtime.** Users should review sources before selecting them and
are responsible for their use of third-party software and services,
including compliance with applicable laws, licenses, and terms.

Third-party repositories, providers, and services may change, become
unavailable, or impose their own requirements. AIOPlugins does not
guarantee the accuracy, safety, legality, availability, or continued
operation of third-party content or services.

The software is provided "as is" and without warranties, express or
implied, to the extent permitted by applicable law. This README is
informational and is not legal advice. The disclaimer does not replace
any terms, privacy notice, or other policies that may apply to a
deployed service.

## Project layout

The application source of truth lives under `src/`. Keep runtime and
browser TypeScript modules there rather than adding duplicate modules at
the repository root.

- `src/adapters/cloudflare/` — Cloudflare Worker entry point, D1 adapter,
  environment bindings, and platform construction.
- `src/components/` — Astro UI components.
- `src/lib/` — shared database, platform, and HTTP utilities.
- `src/pages/` — Astro pages and routes.
- `src/providers/` — upstream source discovery and stream formatting.
- `src/scripts/` — browser application, grouped into components, core
  utilities, services, and state.
- `tests/` — Node test suite.
- `migrations/` — ordered D1 SQL migrations.
- `public/` — static assets copied into the Astro site output.

The repository root is reserved for project configuration, package
metadata, documentation, licensing, and Wrangler-generated type
declarations. The old root-level TypeScript copies were removed because
the active implementations already live under `src/` and the Worker
entry point in `wrangler.toml` targets `src/index.ts`.

## License

The AIOPlugins builder source is licensed under **GPL-3.0-only**. See
the repository's license file for the full license text.

This project license applies to the AIOPlugins source code only. It does
not grant rights to upstream providers, third-party services, logos,
trademarks, or media, and it does not override the licenses or terms
that apply to those materials.
