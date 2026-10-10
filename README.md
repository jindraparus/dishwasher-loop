# Dishwasher Loop

A deliberately small Node.js service that:

- requires Microsoft sign-in in Azure and allows only `jparus@gmail.com`;
- authorizes one Home Connect account using OAuth 2.0;
- finds the account's dishwashers;
- keeps the Home Connect Server-Sent Events channel open;
- persists every received event in Azure Table Storage; and
- displays appliance diagnostics and the latest 200 events in a server-rendered
  web page.

Home Connect's public API exposes appliance events, including status changes and
notifications. These are the closest public equivalent to Home Connect app push
notifications, but Home Connect does not guarantee that every proprietary mobile
app notification is exposed by the API.

## Home Connect setup

1. Register an application in the [Home Connect developer portal](https://developer.home-connect.com/applications).
2. Configure the application to use the Authorization Code Grant Flow.
3. Add the callback URL. Locally this is
   `http://localhost:3000/auth/callback`; in Azure it is
   `https://<app-name>.azurewebsites.net/auth/callback`.
4. The service requests only `IdentifyAppliance` and `Dishwasher-Monitor`.

The API uses an [authorization code flow](https://api-docs.home-connect.com/authorization/)
and exposes appliance updates through a long-lived
`/api/homeappliances/{haId}/events` Server-Sent Events response.

## Run locally

Node.js 22 is required. Local development stores data in
`.data/dishwasher-loop.json`; Azure deployments use Table Storage.

```sh
npm install
cp .env.example .env
# Fill in the Home Connect values in .env.
npm start
```

Open `http://localhost:3000` and choose **Connect Home Connect**.

## Deploy to Azure

### Create the Microsoft login registration

In the [Microsoft Entra admin center](https://entra.microsoft.com/), create an
**App registration**:

1. Name it `Dishwasher Loop`.
2. For **Supported account types**, select **Accounts in this organizational
   directory only**.
3. Add a **Web** redirect URI:
   `https://<app-name>.azurewebsites.net/.auth/login/aad/callback`.
4. Under **Authentication → Implicit grant and hybrid flows**, enable
   **ID tokens (used for implicit and hybrid flows)**. App Service Easy Auth
   requests `response_type=code id_token`; leaving this disabled causes
   `AADSTS700054` and HTTP 401 on the callback.
5. Under **Certificates & secrets**, create a client secret. Copy its **Value**
   immediately.
6. Copy the app registration's **Application (client) ID**.

Ensure `jparus@gmail.com` exists in the tenant as a member or guest, then obtain
its Entra **Object ID**. The Azure authentication layer requires Microsoft
login. The Node service compares App Service's immutable principal ID with this
object ID. Other successfully authenticated Microsoft accounts receive HTTP
403. The email is retained only as a human-readable deployment setting.

The Bicep template creates:

- one Linux Basic B1 App Service instance with Always On enabled; and
- one locally redundant Storage account.

Always On and a single worker are intentional: receiving events requires a
continuous connection, and multiple workers would save duplicate events.

```sh
az group create --name dishwasher-loop --location westeurope

APP_NAME="<globally-unique-app-name>"
CLIENT_ID="<home-connect-client-id>"
CLIENT_SECRET="<home-connect-client-secret>"
MICROSOFT_AUTH_CLIENT_ID="<entra-application-client-id>"
MICROSOFT_AUTH_CLIENT_SECRET="<entra-client-secret-value>"
MICROSOFT_TENANT_ID="<entra-tenant-id>"
ALLOWED_PRINCIPAL_ID="<authorized-user-object-id>"
COOKIE_SECRET="$(openssl rand -base64 48)"

az deployment group create \
  --resource-group dishwasher-loop \
  --template-file infra/main.bicep \
  --parameters \
    appName="$APP_NAME" \
    homeConnectClientId="$CLIENT_ID" \
    homeConnectClientSecret="$CLIENT_SECRET" \
    homeConnectRedirectUri="https://$APP_NAME.azurewebsites.net/auth/callback" \
    microsoftAuthClientId="$MICROSOFT_AUTH_CLIENT_ID" \
    microsoftAuthClientSecret="$MICROSOFT_AUTH_CLIENT_SECRET" \
    microsoftTenantId="$MICROSOFT_TENANT_ID" \
    allowedPrincipalId="$ALLOWED_PRINCIPAL_ID" \
    allowedEmail="jparus@gmail.com" \
    cookieSecret="$COOKIE_SECRET"

zip -r app.zip package.json package-lock.json src
az webapp deploy \
  --resource-group dishwasher-loop \
  --name "$APP_NAME" \
  --src-path app.zip \
  --type zip
```

Register the printed Home Connect callback URL in Home Connect before connecting
the account. Register the separate Microsoft callback URL on the Entra app
registration.
Secrets are App Service settings, and OAuth tokens and event history are stored
in encrypted-at-rest Azure Table Storage. The root page is intentionally
protected by App Service Authentication plus the application email allowlist.

### Continuous deployment

The `Deploy to Azure` GitHub Actions workflow runs on every push to `main` and
can also be started manually. It:

1. installs dependencies and runs the test suite;
2. packages only `package.json`, `package-lock.json`, and `src/`;
3. signs in to Azure using GitHub OIDC, without a client secret;
4. deploys the ZIP asynchronously;
5. waits for the new Kudu deployment to succeed; and
6. verifies the anonymous `/healthz` readiness endpoint.

The repository uses these non-secret GitHub Actions variables:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_RESOURCE_GROUP`
- `AZURE_WEBAPP_NAME`

The federated credential is restricted to the `main` branch of
`jindraparus/dishwasher-loop`. Its service principal has Website Contributor
access scoped only to the `jparusdishwasher` App Service resource.

## Operational notes

- The monitor reconnects with exponential backoff when Home Connect closes a
  stream or a transient error occurs.
- Home Connect always sends the complete SSE stream. The service filters it
  before persistence and ignores `KEEP-ALIVE` by default.
- Access tokens are refreshed automatically and persisted.
- `/healthz` is an anonymous, data-free readiness endpoint used by Azure
  App Service warm-up probes.
- Disconnecting removes OAuth tokens but intentionally preserves event history.
- The UI refreshes every 30 seconds and shows the latest 200 stored events.
- Diagnostics show appliance type/model, connectivity, current Home Connect
  status values, salt/rinse-aid refill warnings, and the most recent streamed
  event. Home Connect exposes warning thresholds, not exact consumable levels;
  a value remains unknown until the appliance reports the corresponding event.
- `AZURE_STORAGE_CONNECTION_STRING=local` and the legacy
  `UseDevelopmentStorage=true` setting both select local JSON-file storage.

### Filter persisted events

Home Connect does not support server-side subscriptions to individual event
types or keys. Configure client-side persistence filtering with comma-separated
environment variables:

```env
# Default: store meaningful status, event, and notification messages.
HOME_CONNECT_EVENT_TYPES=STATUS,EVENT,NOTIFY

# Optional: store messages only when at least one item has an exact matching key.
HOME_CONNECT_EVENT_KEYS=BSH.Common.Event.ProgramFinished
```

For example, to persist notifications and events but not routine status changes:

```env
HOME_CONNECT_EVENT_TYPES=EVENT,NOTIFY
HOME_CONNECT_EVENT_KEYS=
```

Filtering affects event history only. Live status messages are still used to
keep the diagnostics panel current.
