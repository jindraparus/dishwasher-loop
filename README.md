# Dishwasher Loop

Dishwasher Loop is a small Node.js service that:

- connects one Home Connect account using OAuth 2.0;
- discovers the account's dishwashers;
- receives appliance updates over a long-lived Server-Sent Events connection;
- persists status, event, and notification messages;
- derives durable washing-cycle history from observed Home Connect signals;
- shows a dashboard with current appliance diagnostics, active wash progress
  and remaining time, salt status, editable washing-capsule inventory,
  recommendations, cycle statistics, recent cycles, and the latest 200 events;
- updates the single-page dashboard in place without full-page refreshes; and
- protects the Azure-hosted UI with Microsoft sign-in and an explicit user
  allowlist.

See the [end-to-end design](docs/design.md) for the architecture, authentication
flows, Azure resources, event protocol, persistence model, and deployment
pipeline.

## Run locally

### Prerequisites

- Node.js 22 or newer
- A [Home Connect developer application](https://developer.home-connect.com/applications)
  configured for the Authorization Code Grant Flow
- This local redirect URI registered on the Home Connect application:

  ```text
  http://localhost:3000/auth/callback
  ```

The application requests only the `IdentifyAppliance` and
`Dishwasher-Monitor` scopes.

### Setup

```sh
npm install
cp .env.example .env
```

Fill in these values in `.env`:

```env
HOME_CONNECT_CLIENT_ID=<Home Connect client ID>
HOME_CONNECT_CLIENT_SECRET=<Home Connect client secret>
HOME_CONNECT_REDIRECT_URI=http://localhost:3000/auth/callback
COOKIE_SECRET=<random string containing at least 32 characters>
AZURE_STORAGE_CONNECTION_STRING=local
```

Local mode stores OAuth tokens and event history in
`.data/dishwasher-loop.json`. Derived cycle history is stored in the same file.
Microsoft authentication is disabled locally by default.

Start the service:

```sh
npm start
```

Open http://localhost:3000 and choose **Connect Home Connect**.

### Capsule inventory

Use the gear button at the top right to open **Nastavení zásob**. Enter the
total number of capsules currently at home (0–999), then choose **Uložit**.
Cancel or Escape leaves the count unchanged.

Inventory starts at **50** when no valid saved count exists; existing counts,
including zero, are preserved. The count is stored alongside the current
settings in local JSON or Azure Table Storage and survives restarts.
Each completed washing cycle, including an inferred completion, consumes one
capsule. Incomplete/cancelled cycles do not consume capsules. Counts never go
below zero, and duplicate completion signals do not consume extra capsules.

Tracking starts when this feature is first activated; historical washes are
not charged. An absolute edit represents the physical count at save time, so
earlier completions discovered later are excluded. Every completed program is
assumed to use one capsule; correct exceptions manually. Existing low-stock
recommendations and read-only MCP behavior are unchanged.

Run the test suite with:

```sh
npm test
```

### Optional event filtering

Home Connect sends the complete appliance event stream. These comma-separated
settings control which messages are persisted:

```env
HOME_CONNECT_EVENT_TYPES=STATUS,EVENT,NOTIFY
HOME_CONNECT_EVENT_KEYS=
```

`KEEP-ALIVE` messages are ignored by default. To persist only messages that
contain an exact Home Connect item key, set `HOME_CONNECT_EVENT_KEYS`, for
example:

```env
HOME_CONNECT_EVENT_KEYS=BSH.Common.Event.ProgramFinished
```

Filtering affects event history only; live status messages still update the
diagnostics panel and cycle tracking. Cycle statistics use `Europe/Prague` by
default. Set `CYCLE_TIMEZONE` to another IANA timezone if required.

### Offline email alerts

The service checks current dishwasher status every five minutes, independently of the
event stream. A confirmed Home Connect offline response lasting at least five
minutes activates durable outage telemetry. API, authentication, and stream
failures are logged separately; cloud keep-alives cannot establish appliance
connectivity.

Optional Azure Monitor log alerts and an email Action Group deliver one fired
notification per sustained outage and a resolved notification after recovery.
There is no application email service or mailbox credential.

See [connectivity alerts](docs/connectivity-alerts.md) for the separate Bicep
template, Azure Portal configuration, recipient setup, costs, limitations, and
end-to-end verification. Deploying application code alone does not enable email.

## Deploy a new Azure environment

This section is the complete setup sequence for a new subscription or
environment. The Bicep template creates the storage account, Linux App Service
plan, Web App, application settings, and App Service Easy Auth configuration.
It does **not** create the resource group, Home Connect application, Microsoft
Entra app registrations, users or guests, GitHub OIDC identity, role
assignments, or GitHub repository variables.

For a new tenant, create new Entra registrations and use object IDs from that
tenant. For another subscription in the same tenant, registrations may be
reused, but separate registrations per environment make callbacks, secrets,
permissions, and revocation easier to manage.

### 1. Prerequisites and environment names

Install and authenticate:

- Azure CLI with permission to create resource groups, deployments, app
  registrations, service principals, federated credentials, and role
  assignments;
- GitHub CLI authenticated to the target repository;
- Node.js 22 or newer; and
- `jq`, `openssl`, and `zip`.

Choose globally unique resource and repository values:

```sh
export AZURE_SUBSCRIPTION_ID="<subscription-id>"
export AZURE_TENANT_ID="<tenant-id>"
export AZURE_LOCATION="westeurope"
export AZURE_RESOURCE_GROUP="dishwasher-loop"
export AZURE_WEBAPP_NAME="<globally-unique-name-3-to-18-characters>"
export GITHUB_OWNER="<github-owner>"
export GITHUB_REPOSITORY="<github-repository>"

az account set --subscription "$AZURE_SUBSCRIPTION_ID"
az group create \
  --name "$AZURE_RESOURCE_GROUP" \
  --location "$AZURE_LOCATION"
```

`AZURE_WEBAPP_NAME` also determines the plan and storage names. It must produce
a globally unique valid storage account name after `store` is appended and
hyphens are removed.

### 2. Create the Home Connect application

In the Home Connect developer portal, create an Authorization Code Grant
application with only these scopes:

- `IdentifyAppliance`
- `Dishwasher-Monitor`

Register this exact production redirect URI:

```text
https://<azure-webapp-name>.azurewebsites.net/auth/callback
```

Keep the Home Connect client ID and secret for the Bicep deployment. Do not
commit them.

### 3. Create the Easy Auth API/web registration

In **Microsoft Entra ID → App registrations → New registration**:

1. Create a single-tenant registration such as
   `Dishwasher Loop - <environment>`.
2. Add this **Web** redirect URI:

   ```text
   https://<azure-webapp-name>.azurewebsites.net/.auth/login/aad/callback
   ```

3. Under **Authentication**, enable ID-token issuance.
4. Under **Expose an API**, set the Application ID URI to:

   ```text
   api://<easy-auth-application-client-id>
   ```

5. Add an enabled delegated scope with:
   - scope name: `Dishwasher.Read`;
   - consent: admins and users;
   - admin display name: `Read Dishwasher Loop state`;
   - user display name: `Read your Dishwasher Loop state`; and
   - a description stating that it reads dishwasher status and recent events.
6. Under **Certificates & secrets**, create a client secret and copy the
   **secret value** immediately. The displayed secret ID is not usable.

Record:

```sh
export MICROSOFT_AUTH_CLIENT_ID="<easy-auth-application-client-id>"
export MICROSOFT_API_AUDIENCE="api://$MICROSOFT_AUTH_CLIENT_ID"
export MICROSOFT_AUTH_CLIENT_SECRET="<easy-auth-client-secret-value>"
```

The Bicep template configures Easy Auth to accept only
`MICROSOFT_API_AUDIENCE`. Creating the exposed scope alone does not configure
the App Service audience.

### 4. Determine the authorized Entra users

Every allowed account must exist as a member or guest in the deployment tenant.
For an external account, invite the user under **Microsoft Entra ID → Users**
and have the user accept the invitation.

Copy each user's tenant-local **Object ID**. Do not use an email address, an
application object ID, or an object ID from another tenant. Supply at least one:

```sh
export ALLOWED_PRINCIPAL_IDS='["<tenant-local-user-object-id>"]'
export ALLOWED_EMAIL="<display-email-for-metadata>"
```

The immutable object-ID allowlist is authoritative. `APP_ALLOWED_EMAIL` is
retained as metadata and legacy fallback only when no principal-ID allowlist is
configured.

### 5. Create the local MCP public-client registration

Create a second registration; do not reuse the confidential Easy Auth web app:

1. Create a single-tenant app named, for example, `Dishwasher Loop MCP`.
2. Add the **Mobile and desktop applications** redirect:

   ```text
   http://localhost
   ```

3. Under **API permissions → Add a permission → APIs my organization uses**,
   select the Easy Auth API app and add delegated `Dishwasher.Read`.
4. Remove the default Microsoft Graph `User.Read` permission; it is not needed.
5. Do not create a client secret or certificate.
6. Grant tenant-wide consent only if tenant policy prevents normal user
   consent. Otherwise the allowed user can consent during first sign-in.

Record the new public application's client ID:

```sh
export MCP_PUBLIC_CLIENT_ID="<mcp-public-application-client-id>"
export MCP_SCOPE="$MICROSOFT_API_AUDIENCE/Dishwasher.Read"
```

The native redirect makes authorization code flow with PKCE available. The
legacy **Allow public client flows** fallback setting is not required for this
flow.

### 6. Deploy the Bicep infrastructure

Generate a new cookie-signing secret and provide the Home Connect credentials:

```sh
export HOME_CONNECT_CLIENT_ID="<home-connect-client-id>"
export HOME_CONNECT_CLIENT_SECRET="<home-connect-client-secret>"
export HOME_CONNECT_REDIRECT_URI="https://$AZURE_WEBAPP_NAME.azurewebsites.net/auth/callback"
export COOKIE_SECRET="$(openssl rand -base64 48)"
```

Deploy from the repository root:

```sh
az deployment group create \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --template-file infra/main.bicep \
  --parameters \
    appName="$AZURE_WEBAPP_NAME" \
    location="$AZURE_LOCATION" \
    homeConnectClientId="$HOME_CONNECT_CLIENT_ID" \
    homeConnectClientSecret="$HOME_CONNECT_CLIENT_SECRET" \
    homeConnectRedirectUri="$HOME_CONNECT_REDIRECT_URI" \
    cookieSecret="$COOKIE_SECRET" \
    microsoftAuthClientId="$MICROSOFT_AUTH_CLIENT_ID" \
    microsoftApiAudience="$MICROSOFT_API_AUDIENCE" \
    microsoftAuthClientSecret="$MICROSOFT_AUTH_CLIENT_SECRET" \
    microsoftTenantId="$AZURE_TENANT_ID" \
    allowedPrincipalIds="$ALLOWED_PRINCIPAL_IDS" \
    allowedEmail="$ALLOWED_EMAIL"
```

The command passes secrets directly to secure Bicep parameters; do not save the
command with populated values in a script, shell history, parameter file, CI
log, or repository. Clear secret environment variables when deployment
finishes:

```sh
unset HOME_CONNECT_CLIENT_SECRET MICROSOFT_AUTH_CLIENT_SECRET COOKIE_SECRET
```

The deployment outputs the application URL, Home Connect callback, and Easy
Auth callback. Verify that both portal registrations use those exact callback
values.

### 7. Configure GitHub Actions OIDC

The deployment workflow uses no Azure client secret. Create a dedicated Entra
application and service principal:

```sh
export DEPLOYMENT_APP_OBJECT_ID="$(
  az ad app create \
    --display-name "Dishwasher Loop GitHub - $AZURE_WEBAPP_NAME" \
    --query id \
    --output tsv
)"
export AZURE_CLIENT_ID="$(
  az ad app show \
    --id "$DEPLOYMENT_APP_OBJECT_ID" \
    --query appId \
    --output tsv
)"
az ad sp create --id "$AZURE_CLIENT_ID"
```

Create a federated credential restricted to this repository's `main` branch:

```sh
export FEDERATED_CREDENTIAL="$(
  jq -cn \
  --arg name "github-main" \
  --arg subject "repo:$GITHUB_OWNER/$GITHUB_REPOSITORY:ref:refs/heads/main" \
  '{
    name: $name,
    issuer: "https://token.actions.githubusercontent.com",
    subject: $subject,
    audiences: ["api://AzureADTokenExchange"]
  }'
)"
az ad app federated-credential create \
  --id "$DEPLOYMENT_APP_OBJECT_ID" \
  --parameters "$FEDERATED_CREDENTIAL"
unset FEDERATED_CREDENTIAL
```

Grant only Website Contributor on the created Web App:

```sh
export WEBAPP_RESOURCE_ID="$(
  az webapp show \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --name "$AZURE_WEBAPP_NAME" \
    --query id \
    --output tsv
)"
export DEPLOYMENT_SP_OBJECT_ID="$(
  az ad sp show \
    --id "$AZURE_CLIENT_ID" \
    --query id \
    --output tsv
)"
az role assignment create \
  --assignee-object-id "$DEPLOYMENT_SP_OBJECT_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Website Contributor" \
  --scope "$WEBAPP_RESOURCE_ID"
```

Set the non-secret repository variables consumed by
`.github/workflows/deploy.yml`:

```sh
gh variable set AZURE_CLIENT_ID \
  --repo "$GITHUB_OWNER/$GITHUB_REPOSITORY" \
  --body "$AZURE_CLIENT_ID"
gh variable set AZURE_TENANT_ID \
  --repo "$GITHUB_OWNER/$GITHUB_REPOSITORY" \
  --body "$AZURE_TENANT_ID"
gh variable set AZURE_SUBSCRIPTION_ID \
  --repo "$GITHUB_OWNER/$GITHUB_REPOSITORY" \
  --body "$AZURE_SUBSCRIPTION_ID"
gh variable set AZURE_RESOURCE_GROUP \
  --repo "$GITHUB_OWNER/$GITHUB_REPOSITORY" \
  --body "$AZURE_RESOURCE_GROUP"
gh variable set AZURE_WEBAPP_NAME \
  --repo "$GITHUB_OWNER/$GITHUB_REPOSITORY" \
  --body "$AZURE_WEBAPP_NAME"
```

The workflow and federated credential intentionally allow deployment only from
`main`. Infrastructure changes are not applied by the workflow; rerun the
Bicep deployment separately whenever `infra/main.bicep` changes.

### 8. Deploy and initialize the application

After the desired code is on `main`, run and watch the manual workflow:

```sh
gh workflow run deploy.yml \
  --repo "$GITHUB_OWNER/$GITHUB_REPOSITORY" \
  --ref main
sleep 5
export DEPLOYMENT_RUN_ID="$(
  gh run list \
    --repo "$GITHUB_OWNER/$GITHUB_REPOSITORY" \
    --workflow deploy.yml \
    --branch main \
    --event workflow_dispatch \
    --limit 1 \
    --json databaseId \
    --jq '.[0].databaseId'
)"
gh run watch \
  --repo "$GITHUB_OWNER/$GITHUB_REPOSITORY" \
  "$DEPLOYMENT_RUN_ID" \
  --exit-status
```

Then verify and initialize:

1. Confirm the public health endpoint returns `{"ok":true}`:

   ```sh
   curl --fail "https://$AZURE_WEBAPP_NAME.azurewebsites.net/healthz"
   ```

2. Open `https://<azure-webapp-name>.azurewebsites.net/`, sign in with an
   allowlisted Microsoft account, and confirm another authenticated account
   receives HTTP 403.
3. Select **Connect Home Connect**, complete consent, and confirm the dashboard
   reports the appliance. The application creates the `DishwasherLoop` table on
   first startup.
4. Configure the local MCP environment:

   ```json
   {
     "DISHWASHER_LOOP_TARGET": "azure",
     "DISHWASHER_LOOP_AZURE_BASE_URL": "https://<azure-webapp-name>.azurewebsites.net",
     "DISHWASHER_LOOP_ENTRA_TENANT_ID": "<tenant-id>",
     "DISHWASHER_LOOP_ENTRA_CLIENT_ID": "<mcp-public-application-client-id>",
     "DISHWASHER_LOOP_ENTRA_SCOPE": "api://<easy-auth-application-client-id>/Dishwasher.Read"
   }
   ```

5. Reload VS Code or restart the MCP server. The first live-data call opens the
   browser for user consent/sign-in. Confirm the tool response says
   `"source": "azure"`.

### 9. Redeployment and secret rotation

- Runtime code: manually dispatch `deploy.yml` from `main`.
- Bicep or App Service settings: rerun `az deployment group create` with every
  required parameter.
- Easy Auth secret: create a replacement on the API/web registration, deploy
  it as `microsoftAuthClientSecret`, verify sign-in, then delete the old secret.
- Home Connect secret: rotate it in the developer portal and redeploy
  `homeConnectClientSecret`.
- Cookie secret: redeploying a new value invalidates in-progress Home Connect
  OAuth state cookies but does not remove stored Home Connect tokens.
- MCP public client: it has no secret; revoke consent or delete the registration
  to disable it.
- Authorized users: update `allowedPrincipalIds` with tenant-local object IDs
  and rerun the Bicep deployment.

## Washing-cycle history

Dishwasher Loop derives observed washing cycles from active-program,
operation-state, progress, remaining-time, and program-finished messages.
Strong start and finish boundaries produce complete duration records. If
monitoring begins or ends mid-cycle, the record remains explicitly incomplete
instead of receiving an invented timestamp.

On startup, persisted raw events are replayed chronologically through the same
state machine used for live events. The backfill is idempotent and does not
modify source events. Home Connect does not provide historical replay, so cycles
that occurred while no Dishwasher Loop monitor was connected cannot be
recovered.

Authenticated cycle APIs:

```text
GET /api/cycles?limit=50
GET /api/cycles/stats?period=week
GET /api/cycles/stats?period=month
GET /api/cycles/summary
GET /api/cycles/analytics?period=all
GET /api/cycles/analytics?period=this-week&timeZone=Europe%2FPrague
GET /api/cycles/analytics?period=range&from=2026-10-25T23:00:00Z&to=2026-10-29T20:46:00Z
```

Limits must be between 1 and 100. Statistics report completed and incomplete
records separately and calculate durations only from cycles with trustworthy
start and finish boundaries.

### Usage-based tablet supply recommendations

The dashboard API includes a backend-computed `supplyForecast`. The existing
`get_dishwasher_overview` MCP tool exposes it under
`supplies.dishwasherCapsules.forecast` and returns the same supply recommendations
as the dashboard. The advisor includes relevant ordering advice in routine
status answers. This is read-only advice, not a purchase or scheduled reminder.
Deploy the updated service and restart MCP to use the forecast.

Fixed policy (no new configuration):

- Use a rolling 28 elapsed-day window, shortened to the earliest available
  recorded observation. Require at least 7 days and 3 completed cycles.
- Count completed cycles by `finishedAt` in [from, to), including inferred
  completions. One tablet per completed cycle, regardless of program, matches
  existing inventory accounting; it is an assumption, not measured consumption.
- Inventory is shared across all recorded/discovered appliances. The forecast
  aggregates their usage, including historical appliances.
- Estimate tablets/day = completed cycles / elapsed observed days, then
  days remaining = current stock / tablets per day.
- Recommend ordering at **7 days remaining or less**: 3-day delivery plus a
  4-day safety buffer. Zero stock always recommends replenishment.
- Without a usable estimate, retain the **5-tablet-or-fewer** stock-only warning,
  explicitly labelled as such. With a usable estimate, it replaces the fixed
  threshold, so low-count but slow consumption need not trigger ordering.

The forecast returns policy, timestamp, counting basis, inventory, full-history
coverage, window counts, rate, days remaining, action and reason. Unknown
continuous monitoring is always flagged; inferred completions, unfinished
records and observation gaps add uncertainty. Missing/invalid inventory,
insufficient evidence and zero observed recent usage do not produce a depletion
date or imply zero actual usage. Malformed history/forecast data is an error.
Older service responses without a forecast explicitly show estimate-unavailable
or stock-only advice. Saving new inventory discards the previous forecast and
refreshes it; stale advice must not carry over after replenishment.

### Program popularity and weekly cycle counts

The read-only MCP tool `get_dishwasher_cycle_analytics` reads the authenticated
`/api/cycles/analytics` endpoint on the selected local or Azure service.
Deploy that endpoint and restart the MCP server to discover the new tool.
Optional `applianceId` selects one appliance, including historical appliances;
omitting it aggregates all listed appliances. Unknown IDs are errors, while
known appliances with no records have zero counts.

- `period: "all"` (default) ranks programs across all persisted cycle history.
- `period: "this-week"` counts Monday at local midnight through the query time.
  `timeZone` defaults to the service's `CYCLE_TIMEZONE` (normally Europe/Prague).
  Boundaries use timezone rules, including daylight-saving changes.
- `period: "range"` requires both `from` and `to` with explicit UTC offsets.
  The interval is inclusive at `from`, exclusive at `to`; omit these arguments
  for other periods. Returned boundaries are normalized to UTC.

The population is **all observed cycles, including incomplete records**.
Membership uses `startedAt`, falling back to `firstObservedAt` for missing starts;
`missingStartFallbackCount` exposes that uncertainty. A cycle starting before
the range and finishing inside it is excluded; one starting inside and finishing
after it is included. These are start-based usage counts, **not completion-date
statistics** (the older dashboard `/api/cycles/stats` uses completion dates).

`summary` contains interval observed/completed/running/incomplete counts,
inferred completions, missing boundaries, observation gaps and appliance scope.
`history` describes the full recorded coverage for that same appliance scope.
`programs` contains descending usage counts, program keys and formatted names;
unknown keys remain a null bucket. `mostUsedPrograms` includes every tied leader,
including null if unknown usage leads or ties. Never claim a definitive named
winner when unknown records could change the ranking.

MCP adds `source`; results include `summarizedAt`, interval/timezone, population
and counting basis. Coverage is not lifetime usage or guaranteed continuous
monitoring. Empty history/ranges return genuine zero counts and no winner;
invalid options, unavailable endpoints, malformed history or responses are errors,
never zero-count fallbacks.

### Observed-so-far totals

`GET /api/cycles/summary` aggregates **all persisted cycle records**, without
the dashboard's 20-cycle, cycle API's 100-cycle, or event-list limits.
The same object appears as `cycleSummary` in `/api/dashboard`. Both endpoints
use the existing Microsoft authentication and allowlist.

The read-only MCP tool `get_dishwasher_cycle_summary` reads the summary endpoint
on the selected `local` or `azure` service and adds `source`. It does not fetch
raw events or infer usage from capsule stock. Optional `applianceId` selects
one appliance; omitting it explicitly aggregates all listed appliances,
including historical appliances no longer discovered. Unknown IDs are errors.
Known appliances with no records have zero counts. Historical access does not
require an active Home Connect authorization, but still requires service access.

Example MCP response for one recorded appliance:

```json
{
  "source": "azure",
  "scope": "persisted-cycle-history",
  "summarizedAt": "2026-10-29T20:00:00.000Z",
  "monitoringStartedAt": null,
  "continuousCoverageKnown": false,
  "totalObserved": 7,
  "completed": 4,
  "running": 1,
  "incomplete": 2,
  "inferredCompletions": 1,
  "completeBoundaries": 2,
  "missingStartBoundaries": 1,
  "missingFinishBoundaries": 3,
  "cyclesWithObservationGaps": 1,
  "earliestObservedAt": "2026-10-10T19:00:00.000Z",
  "latestObservedAt": "2026-10-28T22:00:00.000Z",
  "appliances": [{
    "applianceId": "dishwasher-1",
    "applianceName": "Kitchen dishwasher",
    "totalObserved": 7,
    "completed": 4,
    "running": 1,
    "incomplete": 2,
    "inferredCompletions": 1,
    "completeBoundaries": 2,
    "missingStartBoundaries": 1,
    "missingFinishBoundaries": 3,
    "cyclesWithObservationGaps": 1,
    "earliestObservedAt": "2026-10-10T19:00:00.000Z",
    "latestObservedAt": "2026-10-28T22:00:00.000Z"
  }]
}
```

Counting rules:

- `totalObserved = completed + running + incomplete`, globally and per appliance.
  Each persisted cycle identity contributes once; event duplicates, reconnects,
  and idempotent restart/backfill do not create an additional counting mechanism.
- `completed` means `status: "finished"` / `result: "finished"`, including
  inferred finishes and finish-only records with a missing start.
  `inferredCompletions` is a subset, not an additional count.
- `running` and `incomplete` use the persisted projection statuses.
  Running history is not proof of current operation. Incomplete includes
  unknown outcomes and superseded cycles, not finished cycles with missing starts.
- `completeBoundaries` uses the existing statistics rule: both boundaries
  observed and duration known. `missingStartBoundaries` counts null starts,
  including mid-cycle observations; `missingFinishBoundaries` counts null finishes.
  `cyclesWithObservationGaps` counts records with at least one recorded
  disconnect interval (open or closed). These quality counts overlap.
- Earliest/latest timestamps are the minimum `firstObservedAt` and maximum
  `lastObservedAt` of recorded cycles, not monitoring start/end or continuous
  coverage. Empty history returns zero counts and null observation timestamps.
  Monitoring start is unknown; washes missed while no monitor was connected
  cannot be recovered. An empty appliance list means no appliance identities
  are currently known, not proof that no dishwasher exists.
- Storage, malformed data, and service/authentication failures are errors,
  never zero counts or fallback to another target. Older services without this
  summary endpoint must be deployed before the new MCP tool can work.
  `summarizedAt` marks aggregation time; it does not assert live connectivity.

Example answer: "Azure recorded history contains **7 observed cycles** for
Kitchen dishwasher: **4 completed** (1 inferred finish), **1 marked running**,
and **2 incomplete**, as of 29 October 2026 20:00 UTC. Cycle observations span
10–28 October; one start and three finishes are missing, and one record has
an observation gap. This is recorded history, not lifetime usage or proof
of continuous monitoring."

After review, merge, and deployment, verify the original question end-to-end:

1. Select the Azure target and restart the MCP server to discover the new tool.
2. Ask the Advisor "How many washing cycles have been observed so far?"
   Confirm it calls `get_dishwasher_cycle_summary`, uses the selected appliance
   (or explicitly all listed appliances), and reports the breakdown and limits.
3. Reconcile the MCP structured result with the authenticated
   `/api/cycles/summary` response for the same appliance and snapshot. For a
   deterministic check, replay that captured API JSON through the MCP client's
   fetch transport; independent live requests can differ as cycles progress.
4. If comparing two live reads, record both `summarizedAt` values and repeat
   during a stable period if history changed. Do not equate different snapshots
   or treat `/healthz` alone as cycle-history readiness.

## Copilot dishwasher agent

The workspace includes a read-only MCP server and a **Dishwasher Advisor**
Copilot agent. The agent combines live data from an explicitly selected local
or Azure Dishwasher Loop API with dishwasher documentation stored on the same
machine. It never connects directly to Home Connect or controls the appliance.

`DISHWASHER_LOOP_TARGET` is required and must be `local` or `azure`. There is no
automatic fallback between targets. Live-data tool responses include the
selected source; documentation tools always use local files.

### Add local dishwasher documentation

The default documentation directory is `docs/dishwasher`. Copy dishwasher
manuals, program descriptions, maintenance instructions, or troubleshooting
guidance into that directory. Files can be organized in nested directories.
Supported formats are:

- Markdown (`.md` and `.markdown`)
- plain text (`.txt`)
- PDF (`.pdf`)

Documentation in `docs/dishwasher` can be committed and shared with the
repository. Commit only documents whose license permits redistribution; do not
commit manuals containing private or sensitive information. The Azure
deployment package does not include the `docs` directory.

PDF files must contain extractable text; image-only scanned manuals need OCR
before the agent can search them. Individual documentation files are limited to
25 MB.

To use another location, change `DISHWASHER_DOCUMENTS_DIR` in
`.vscode/mcp.json`. Use an ignored or external directory for documentation that
must remain private. The directory may be outside the repository, but only
files inside that configured directory are available to the MCP tools.

### Use local live data

1. Install dependencies with `npm install`.
2. Start Dishwasher Loop with `npm start`.
3. Open http://localhost:3000 and connect Home Connect.
4. Configure the MCP settings for local mode:

   ```json
   {
     "DISHWASHER_LOOP_TARGET": "local",
     "DISHWASHER_LOOP_BASE_URL": "http://localhost:3000"
   }
   ```

5. In VS Code, open the MCP server list and start **dishwasher-loop** if it is
   not already running. The workspace configuration starts
   `src/mcp/server.js` over standard input/output.
6. Open Copilot Chat and select **Dishwasher Advisor** from the agent picker.

Local mode preserves the existing behavior: the separate `npm start` process
owns the local Home Connect monitor and the MCP server reads its dashboard API.

### Use Azure live data

Azure mode uses delegated Microsoft authentication and the deployed
`/api/dashboard` endpoint. The local MCP process does not start a Dishwasher
Loop monitor, open a Home Connect event stream, or use local Home Connect
tokens.

#### Entra prerequisites

Use the two registrations created in
[Deploy a new Azure environment](#deploy-a-new-azure-environment):

1. On the existing tenant-specific Easy Auth web/API registration:
   - expose a delegated scope named `Dishwasher.Read`;
   - use an Application ID URI such as
     `api://<easy-auth-application-client-id>`;
   - deploy `infra/main.bicep` with `microsoftApiAudience` set to that
     Application ID URI; and
   - keep its Web callback, client secret, and Easy Auth configuration.
2. Create a separate tenant-specific public-client registration for the local
   MCP server:
   - add the **Mobile and desktop applications** redirect URI
     `http://localhost`;
   - add delegated permission
     `api://<easy-auth-application-client-id>/Dishwasher.Read`;
   - grant consent as required by the tenant; and
   - do not create or configure a client secret.

The access-token audience must equal `microsoftApiAudience`, and the requested
scope must be the exposed `Dishwasher.Read` scope. App Service Easy Auth
validates the bearer token and injects the identity headers used by the
existing tenant-local object-ID allowlist. An authenticated account that is not
in `APP_ALLOWED_PRINCIPAL_IDS` still receives HTTP 403.

Configure the MCP server environment in `.vscode/mcp.json`:

```json
{
  "DISHWASHER_LOOP_TARGET": "azure",
  "DISHWASHER_LOOP_AZURE_BASE_URL": "https://<app-name>.azurewebsites.net",
  "DISHWASHER_LOOP_ENTRA_TENANT_ID": "<tenant-id>",
  "DISHWASHER_LOOP_ENTRA_CLIENT_ID": "<public-client-application-id>",
  "DISHWASHER_LOOP_ENTRA_SCOPE": "api://<easy-auth-application-client-id>/Dishwasher.Read"
}
```

Remove `DISHWASHER_LOOP_BASE_URL` when selecting Azure. Restart the MCP server
after changing its environment.

The MCP initialize handshake completes before authentication. The first
live-data tool call opens the system browser for Microsoft sign-in using
authorization code flow with PKCE. The browser displays a success or failure
message, and the original tool call then continues. Documentation tools do not
require sign-in.

Tokens are held only in MCP process memory. They are never written to workspace
configuration or application storage. Stop or restart the MCP server to sign
out; the next live-data call opens a new browser sign-in. Reauthentication is
therefore required after every MCP restart.

### Start manually

VS Code normally manages the MCP process. To start the same process manually
for protocol clients or diagnostics, run:

```sh
DISHWASHER_LOOP_TARGET=local npm run mcp
```

The process waits silently for MCP messages on standard input.

Example questions:

- Is the dishwasher running, and when should it finish?
- Which supplies need attention?
- What happened during the latest cycle?
- How many washing cycles have been observed so far, and how many completed?
- According to the manual, how should I clean the filter?
- What does the current status mean, and what should I do next?

The agent cites the local document and section or PDF page used for
documentation-based answers. It distinguishes the selected local or Azure live
source from local documentation and inference.

### Simple development loop

Select **Dev Loop** in the Copilot Chat agent picker and describe a feature,
bug or enhancement, or provide an existing issue number. Its
[skill](.github/skills/dev-loop/SKILL.md) guides idea -> issue -> plan ->
implementation -> validation -> PR.

Three dedicated read-only agents review in fresh context: **Dev Loop Spec
Reviewer**, **Dev Loop Plan Reviewer**, and **Dev Loop PR Reviewer**.
You must approve both before implementation starts. Questions, decisions, plans,
approvals and PR links are recorded on the issue so work can resume later.
Each issue gets a separate branch. The PR is published as a draft, independently
reviewed, and marked ready only after findings are resolved and the current
published commit passes review. The agent then stops for your review and merge.
Applicable manual/browser validation is required, and blocked checks are reported.

Requires GitHub access (`gh` authentication or suitable MCP tools), question
tools and custom-agent invocation. Reload Chat/VS Code if the agents or skill
are not discovered. The four agents and skill each stay below 100 lines.
These are workflow instructions, not enforced branch protection or approval controls.

### MCP troubleshooting

- **Unable to reach Dishwasher Loop:** start the web service with `npm start`
  for local mode, or check the configured Azure URL, network, and App Service
  status. The unauthenticated `/healthz` endpoint should return `{"ok":true}`.
- **Home Connect is not authorized:** open the dashboard for the selected
  target and complete the Home Connect connection.
- **Microsoft sign-in is canceled or expires:** call a live-data tool again and
  complete the browser flow.
- **Azure returns 401 or redirects to HTML:** verify the tenant, API scope,
  access-token audience, exposed API permission, consent, and Easy Auth
  `allowedAudiences` setting.
- **Azure returns 403:** use an account whose tenant-local object ID is in
  `APP_ALLOWED_PRINCIPAL_IDS`.
- **Browser does not open:** verify that the public-client app has the
  `http://localhost` Mobile and desktop redirect and that the operating system
  can open a default browser.
- **Documentation directory does not exist:** create
  `docs/dishwasher`, or update `DISHWASHER_DOCUMENTS_DIR` in
  `.vscode/mcp.json`.
- **No supported documentation found:** add at least one supported text or PDF
  file.
- **PDF text is missing:** use a text-based PDF or run OCR on the scanned manual.
- **Tools do not appear in Copilot Chat:** restart the **dishwasher-loop** MCP
  server from VS Code, then reselect the **Dishwasher Advisor** agent.
- **Server cannot find Node.js:** the launcher checks standard Homebrew,
  `/usr/local`, and system locations without relying on VS Code's `PATH`. For a
  different installation, set `NODE_BINARY` to the absolute Node.js executable
  path in the MCP server's `env` object.
