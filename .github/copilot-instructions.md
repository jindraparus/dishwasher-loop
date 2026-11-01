# Dishwasher Loop

## Commands

Run commands from the repository root with Node.js 22 or newer. This is an npm
project using native JavaScript ES modules.

- Install locked dependencies: `npm ci`.
- Local setup: `cp .env.example .env`, then supply Home Connect credentials,
  the registered redirect URI, and a `COOKIE_SECRET` of at least 32 characters.
  Use `AZURE_STORAGE_CONNECTION_STRING=local` for JSON storage.
- Start the web service: `npm start` (default `http://localhost:3000`).
- Run all tests: `npm test`.
- Run one test file: `node --test test/storage.test.js`.
- Run one named test:
  `node --test --test-name-pattern='renders unknown connectivity' test/dashboard.test.js`.
  Put runner options before file paths.
- Start the separate stdio MCP server: `DISHWASHER_LOOP_TARGET=local npm run mcp`.
  Local live-data calls require the web service to be running separately.

Tests use `node:test` and `node:assert/strict`. Storage tests use temporary JSON
files or mocked Table clients; HTTP tests mount routers on ephemeral loopback
ports, and frontend tests import renderers/helpers directly. Follow these
seams rather than importing `src/server.js`, which initializes storage,
monitoring, and a listening server at module load.

## Architecture

`README.md` covers setup, API semantics, deployment, and MCP configuration.
`docs/design.md` describes the end-to-end system; `docs/connectivity-alerts.md`
covers the separately deployed offline-alert infrastructure.

- `src/server.js` composes Express, `Storage`, `CycleTracker`, and
  `DishwasherMonitor`. Persisted Home Connect tokens start monitoring on
  boot. The Home Connect client owns OAuth/token refresh and outbound REST/SSE;
  there is one account and one application worker, with per-appliance state.
- `src/monitor.js` maintains in-memory diagnostics from status checks and SSE.
  Every SSE message updates diagnostics and cycle tracking before the optional
  event-history filter. `HOME_CONNECT_EVENT_TYPES` and
  `HOME_CONNECT_EVENT_KEYS` must not filter live state or cycle derivation.
  Diagnostics restore warnings from the latest 200 events at initialization.
- `src/cycles.js` is the shared live/replay state machine. Startup replays all
  persisted events chronologically and reconciles saved cycles. Summary,
  analytics, and supply-forecast modules derive API projections from the full
  persisted cycle collection, not the dashboard's recent-event/cycle slices.
- `src/storage.js` provides both local `.data/dishwasher-loop.json` and Azure
  Table Storage backends. Tokens, supplies/accounting markers, events, cycles,
  and connectivity share this interface. Local mutations are serialized and
  atomically renamed; Azure uses deterministic cycle upserts and transactional
  inventory updates.
- `public/` is a native-ES-module SPA served directly by Express. Components
  render HTML strings; `public/app.js` fetches `/api/dashboard` every 30 seconds
  while visible and replaces the dashboard in place. The inventory dialog
  lives outside that replacement; refresh pauses while it is open.
- `src/mcp/server.js` is a separate read-only stdio process. Its dashboard
  client calls the selected web service, never Home Connect or application
  storage directly. Documentation search/read uses local Markdown, text, and
  text-extractable PDFs under `docs/dishwasher` (or the configured directory).
  Browser formatting, program-state, and recommendation helpers are also
  imported by the MCP projection; keep them usable without a DOM.

## Domain and API conventions

- Preserve deterministic cycle/source identities and idempotent replay.
  Home Connect SSE `id` is not a unique event identity; persisted Azure events
  use Table row keys. Do not rewrite source events during backfill.
- Exact cycle boundaries may be null. `firstObservedAt`/`lastObservedAt` are
  observation windows, not substitutes for trusted start/finish times.
  Preserve boundary confidence, evidence, and disconnect gaps. A selected
  program or persisted `running` cycle does not establish current operation.
- Summary totals satisfy `totalObserved = completed + running + incomplete`.
  Completed includes inferred finishes and finish-only records; inferred
  completions are a subset. Recorded history is not lifetime usage or proof
  of continuous monitoring. Missing/malformed history and storage failures
  must surface as errors, not empty/zero results.
- Analytics counts all observed records, including incomplete ones, using
  `startedAt` with explicit `firstObservedAt` fallback. Date ranges are
  `[from, to)`; this week starts Monday in `CYCLE_TIMEZONE` (default
  `Europe/Prague`). Preserve ties and null/unknown program keys. Input/output
  Zod schemas are shared with MCP; change producers and validators together.
- Capsule inventory is shared across appliances, is an integer from 0 to 999,
  and initializes durably to 50 only when absent/invalid. Preserve saved zero.
  Saving a completed cycle consumes one capsule only when its finish is
  strictly after the inventory snapshot timestamp; counts clamp at zero.
  Durable cycle markers prevent duplicate deductions even at zero and survive
  absolute-count edits. Azure atomically updates count plus marker using
  ETags; startup repairs a crash between cycle persistence and accounting.
- Supply forecasts count completed cycles by `finishedAt`, unlike usage
  analytics. Ordering policy lives in `src/supply-forecast.js`; UI/MCP should
  use the backend action/reason and retain coverage/estimate uncertainty rather
  than implement a competing reorder rule.
- Connectivity is tri-state: online, offline, or unknown. Independent
  five-minute status checks establish appliance connectivity; cloud
  keep-alives and stream/API/authentication failures do not prove offline or
  online. Durable confirmed outages have a five-minute grace period.
- User-facing UI/error strings are Czech; shared display helpers use `cs-CZ`.
  Escape dynamic values with `escapeHtml` when composing HTML strings.

## Authentication, MCP, and deployment

Microsoft Easy Auth authenticates service users independently of Home Connect
OAuth. Azure authorization checks tenant-local Entra object IDs in
`APP_ALLOWED_PRINCIPAL_IDS`. Keep `/healthz` data-free and before authorization;
appliance APIs and static UI assets are behind the middleware.
`PUT /api/supplies/capsules` is browser-only: JSON body, Origin matching the
configured redirect origin, and an allowlisted Easy Auth browser session in
Azure. Bearer writes are rejected; local mode still checks Origin.

MCP requires explicit `DISHWASHER_LOOP_TARGET=local|azure` with no fallback.
Azure uses a separate public-client Entra registration and delegated
`Dishwasher.Read` access; tokens remain in MCP process memory. Restart MCP
after configuration changes. Keep stdio stdout for protocol messages and
diagnostics on stderr. The Dishwasher Advisor's grounding/read-only rules are
in `.github/agents/dishwasher.agent.md`. Keep private device/network
troubleshooting details local, out of shared issues and documentation.

`.github/workflows/deploy.yml` is manually dispatched: `npm ci`, `npm test`,
then `zip -q -r app.zip package.json package-lock.json src public` and Azure
OIDC deployment. Preserve its pre/post-deployment cycle-history checks;
`/healthz` alone does not validate durable history. `infra/main.bicep` manages
the application; monitoring alerts are deployed separately. Local dishwasher
manuals are not part of the application deployment package.

When using the repository's Dev Loop workflow, load
`.github/skills/dev-loop/SKILL.md`: the issue body is the spec and comments hold
plans/decisions/approvals. Require explicit user approval of both reviewed spec
and reviewed plan; reviewer approval is not user approval. Use the dedicated
review agents, issue-specific branches, and a reviewed draft PR. Stop for human
merge/deployment rather than performing them automatically.
