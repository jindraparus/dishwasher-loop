# Dishwasher Loop

Dishwasher Loop is a small Node.js service that:

- connects one Home Connect account using OAuth 2.0;
- discovers the account's dishwashers;
- receives appliance updates over a long-lived Server-Sent Events connection;
- persists status, event, and notification messages;
- derives durable washing-cycle history from observed Home Connect signals;
- shows a dashboard with current appliance diagnostics, active wash progress
  and remaining time, salt status, read-only washing-capsule inventory,
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
```

Limits must be between 1 and 100. Statistics report completed and incomplete
records separately and calculate durations only from cycles with trustworthy
start and finish boundaries.

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
- According to the manual, how should I clean the filter?
- What does the current status mean, and what should I do next?

The agent cites the local document and section or PDF page used for
documentation-based answers. It distinguishes the selected local or Azure live
source from local documentation and inference.

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
