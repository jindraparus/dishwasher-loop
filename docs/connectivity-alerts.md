# Dishwasher connectivity alerts

## Behavior

The backend reads each discovered dishwasher's current status every five minutes,
even while the SSE stream stays open or is reconnecting. Status/discovery/token
HTTP requests have a 20-second timeout. Status polling is independent of browser
refreshes and event-history filters.

This uses about 288 scheduled status requests per appliance per day, rather than
1,440 from one-minute polling, respecting Home Connect's documented 1,000 daily
requests per client/user budget for the intended single-dishwasher deployment.
Discovery and reconnect requests also count; additional appliances or another
client using the same credentials consume the shared quota. Reconnecting an SSE
stream does not repeat an existing appliance's status read. Confirmed offline
appliances are not repeatedly probed for a stream when all appliances are offline.
HTTP 429 pauses API requests for at least five minutes or the server's
`Retry-After`, whichever is longer. See [Home Connect rate limits](https://api-docs.home-connect.com/general/#rate-limiting).

Only HTTP 409 with **both** the Home Connect key
`SDK.Error.HomeAppliance.Connection.Initialization.Failed` and description
`HomeAppliance is offline` confirms the motivating offline condition. Other
errors are not evidence that the appliance is offline.

- Confirmed offline checks start a five-minute grace period. The first check at
  or beyond five minutes activates the outage. Brief interruptions do not alert.
  Detection itself can take up to one polling interval, so an outage may take
  approximately five to ten minutes, plus Azure delays, to generate an email.
- Unknown API/authentication results interrupt an unactivated grace period.
  They cannot activate an outage or clear an already active one.
- A successful current status read clears the active outage and stale status
  error. Neither cloud keep-alives, historical events, nor live event messages
  establish recovery.
- The last confirmed state, first offline detection time, and activation flag
  persist in local JSON or the Azure Table `connectivity` partition. Repeated
  checks and backend restarts retain the same outage identity.
- Diagnostics show the latest check result: connected, disconnected, or unknown.
  During an API failure an already active outage remains active, even though
  current connectivity is shown as unknown.

The service emits one-line JSON to stdout:

```json
{"event":"dishwasher.connectivity","applianceId":"example","applianceName":"Kitchen dishwasher","observedAt":"2026-10-23T18:05:00.000Z","checkResult":"offline","state":"offline","offlineSince":"2026-10-23T18:00:00.000Z","alertActive":true,"transition":true,"failureKind":"appliance_offline","httpStatus":409}
```

Every check emits a sample; `transition` marks a durable state change.
Separate `home_connect.failure` records include `operation` (`status`,
`discovery`, `monitor`, or `event_stream`), `failureKind` (`api`,
`authentication`, or `appliance_offline`), and HTTP status when available.
Raw response bodies, error descriptions, OAuth tokens, and credentials are not
included in these records. Do not add them to the alert query or notifications.

## Azure resources and approval

Application deployment alone does **not** enable email. The separate
[monitoring template](../infra/monitoring.bicep) configures an existing Web App
without changing its authentication, application settings, or Home Connect
permissions:

1. A pay-as-you-go Log Analytics workspace, with 30-day retention.
2. A Web App diagnostic setting routing `AppServiceConsoleLogs` to its
   resource-specific table.
3. An Action Group with the explicitly supplied email recipient.
4. A stateful scheduled query alert, disabled by default.

Confirm the subscription/resource group, app, recipient, and monitoring costs
with the owner before creating or enabling these resources. Inspect existing
diagnostic settings first: reuse existing ingestion when appropriate and avoid
duplicating the same log category to the same workspace. Reuse an existing
workspace/Action Group through the Portal path below instead of deploying
duplicate resources.

There is no SMTP, Graph mail permission, or application email credential.
Workspace ingestion/retention, log-search alert evaluation, and notifications
are subject to Azure pricing. App Service Always On must remain enabled.
No infrastructure deployment is performed by the application's GitHub workflow.

### Bicep path (after approval)

Run in the repository root, replacing all placeholders:

```sh
az deployment group create \
  --resource-group '<resource-group>' \
  --template-file infra/monitoring.bicep \
  --parameters appName='<web-app-name>' alertEmail='<recipient>' \
  --name dishwasher-monitoring
```

The rule is deliberately disabled initially and skips initial query validation
because `AppServiceConsoleLogs` may not exist before its first ingestion.
Enable **Application logging > File System** under **App Service > Monitoring >
App Service logs** (see the Portal path below). Deploy the updated application,
verify logs arrive, and test the Action Group.
Then enable the rule in **Azure Monitor > Alerts > Alert rules**. Alternatively,
repeat the same deployment with `alertEnabled=true` after these checks.

The deployment outputs the resolved KQL query as `query`, plus workspace, alert,
and Action Group names. Use the query in Logs to verify it against real telemetry
before enabling the rule; successful Bicep compilation is not query validation.

### Azure Portal path (after approval)

1. Create or choose a **Log Analytics workspace** in the appropriate region.
   Keep its table on the Analytics plan, not Basic/Auxiliary.
2. Open **App Service > Monitoring > App Service logs**. Enable application
   logging to the file system if it is not already enabled. Then open
   **Diagnostic settings > Add diagnostic setting**. Enable
   **AppServiceConsoleLogs**, send to the workspace, and choose
   **Resource specific** as the destination table mode. Do not enable HTTP
   request-body logging or other categories for this feature.
3. Deploy the application and open workspace **Logs**. Confirm
   `AppServiceConsoleLogs` contains `dishwasher.connectivity` samples. Ingestion
   can take several minutes.
4. In **Monitor > Alerts > Action groups**, create or choose an Action Group.
   Add an **Email** notification with the approved recipient and enable the
   **common alert schema**. Use **Test** to verify inbox delivery and check
   junk/spam folders. Respect any subscription/unsubscribe options in Azure's
   notification emails.
5. Create a **Log search** alert rule scoped to the workspace. Use
   [offline-alert.kql](../infra/offline-alert.kql), replacing
   `__APP_RESOURCE_ID__` with the Web App's full Azure resource ID. The query
   selects the most recent sample per appliance **before** testing the active
   flag, so old offline samples cannot override a newer recovery.
6. Set **Measure: Table rows**, **Aggregation: Count**,
   **Operator: Greater than**, **Threshold: 0**. Evaluate every **5 minutes** with
   a **2-day lookback/query time range**. The application already applies the
   five-minute grace period; do not add another five-minute failing-period gate.
   A one-minute Azure evaluation does not support this two-day window.
7. Split by `applianceId`, `applianceName`, and `offlineSince`, including all
   current and future values. These dimensions put the appliance and first
   detection time (UTC) in the email's alert context.
8. Select the email Action Group, severity **2**, and **Automatically resolve
   alerts** (stateful). Do not use a stateless rule or repeat/reminder actions.
   The Bicep template also includes a `dashboardUrl` custom property.
9. Verify ingestion, the query, and test email delivery before enabling the rule.

## Delivery, recovery, and limitations

Azure Monitor owns email delivery and stateful notification deduplication.
Repeated active samples for the same dimensions do not send another fired
notification. The persisted detection time keeps the dimensions stable across
backend restarts. Do not change the appliance name during an active incident:
it is an alert dimension and would create a new time series.

Once a successful status check is ingested, the query stops returning the
outage. Azure resolves the alert after its stateful recovery evaluation period
and sends the resolved notification. This is not immediate: the five-minute
application grace, polling cadence, log ingestion, alert evaluation, and Azure's
resolution delay all affect delivery. A new outage before Azure has resolved
the previous one might not generate a distinct fired email.

An API or authentication failure does not manufacture recovery: the polling
loop continues to emit the persisted active flag for known appliances.
An intentional Home Connect disconnect stops all checks. If the backend is
down, telemetry cannot report current appliance connectivity. After **two days
without samples**, old data leaves this query's lookback and an alert can
resolve from lack of data; this must not be interpreted as verified appliance
recovery. Application availability/no-data alerts are separate concerns.
Appliances never discovered by this backend cannot be checked.

If no email arrives, check, in order:

- the rule is enabled and the current query returns the expected appliance;
- new stdout samples reach the correct workspace/table and resource ID;
- the alert fired and has the intended Action Group attached;
- no alert-processing rule suppresses actions;
- the Action Group test succeeds and the recipient has not unsubscribed;
- Azure **Service Health**, Action Group diagnostic options, and mail filtering.

There is no application-side email retry queue. Delivery problems must be
investigated in Azure Monitor rather than by changing Home Connect credentials.

## Verification before closing the issue

- Run `npm test` and compile `infra/monitoring.bicep`.
- Verify actual Azure ingestion and run the resolved query in workspace Logs.
- Test the Action Group email to the approved recipient.
- With the owner's approval and the appliance idle/not updating, reproduce a
  real offline interval longer than five minutes (for example, temporarily
  block its internet access). Confirm exactly one fired notification with the
  appliance and UTC detection time, despite repeated checks.
- Restore connectivity and verify fresh status success, cleared dashboard
  error, no active query row, and the eventual resolved email without restarting
  the backend.
- Do not disconnect power during a software update or wash to test alerts.

Unit/integration tests simulate confirmed offline responses, the exact grace
threshold, unknown/auth/API failures, historical events, keep-alives, persistent
outage identity, periodic polling, and recovery. They do not prove Azure
ingestion, KQL execution, or real email delivery.
