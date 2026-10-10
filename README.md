# Dishwasher Loop

Dishwasher Loop is a small Node.js service that:

- connects one Home Connect account using OAuth 2.0;
- discovers the account's dishwashers;
- receives appliance updates over a long-lived Server-Sent Events connection;
- persists status, event, and notification messages;
- shows a dashboard with current appliance diagnostics, active wash progress
  and remaining time, salt status, manually tracked washing-capsule inventory,
  recommendations, and the latest 200 events;
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
`.data/dishwasher-loop.json`. Microsoft authentication is disabled locally by
default.

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
diagnostics panel.
