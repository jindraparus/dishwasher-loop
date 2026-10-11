# Dishwasher Loop

Dishwasher Loop is a small Node.js service that:

- connects one Home Connect account using OAuth 2.0;
- discovers the account's dishwashers;
- receives appliance updates over a long-lived Server-Sent Events connection;
- persists status, event, and notification messages;
- shows a dashboard with current appliance diagnostics, active wash progress
  and remaining time, salt status, read-only washing-capsule inventory,
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

## Local Copilot dishwasher agent

The workspace includes a read-only MCP server and a **Dishwasher Advisor**
Copilot agent. The agent combines live data from the locally running Dishwasher
Loop API with dishwasher documentation stored on the same machine.

The MCP integration is local-only. It does not connect to the Azure deployment,
read OAuth tokens directly, or control the appliance.

### Add local dishwasher documentation

Create the default documentation directory:

```sh
mkdir -p .data/dishwasher-docs
```

Copy dishwasher manuals, program descriptions, maintenance instructions, or
troubleshooting guidance into that directory. Files can be organized in nested
directories. Supported formats are:

- Markdown (`.md` and `.markdown`)
- plain text (`.txt`)
- PDF (`.pdf`)

The `.data` directory is ignored by Git, so local manuals are not committed or
deployed. PDF files must contain extractable text; image-only scanned manuals
need OCR before the agent can search them. Individual documentation files are
limited to 25 MB.

To use another location, change `DISHWASHER_DOCUMENTS_DIR` in
`.vscode/mcp.json`. The directory may be outside the repository, but only files
inside that configured directory are available to the MCP tools.

### Start and use the agent

1. Install dependencies with `npm install`.
2. Start Dishwasher Loop with `npm start`.
3. Open http://localhost:3000 and connect Home Connect.
4. In VS Code, open the MCP server list and start **dishwasher-loop** if it is
   not already running. The workspace configuration starts
   `src/mcp/server.js` over standard input/output.
5. Open Copilot Chat and select **Dishwasher Advisor** from the agent picker.

VS Code normally manages the MCP process. To start the same process manually
for protocol clients or diagnostics, run:

```sh
npm run mcp
```

The process waits silently for MCP messages on standard input. The API base URL
defaults to `http://localhost:3000` and can be changed with
`DISHWASHER_LOOP_BASE_URL`. A different URL is configurable for development,
but authenticated Azure access is not supported.

Example questions:

- Is the dishwasher running, and when should it finish?
- Which supplies need attention?
- What happened during the latest cycle?
- According to the manual, how should I clean the filter?
- What does the current status mean, and what should I do next?

The agent cites the local document and section or PDF page used for
documentation-based answers. It distinguishes live appliance state from
documentation and inference.

### MCP troubleshooting

- **Unable to reach Dishwasher Loop:** start the web service with `npm start`
  and verify that http://localhost:3000/healthz returns `{"ok":true}`.
- **Home Connect is not authorized:** open the local dashboard and complete the
  Home Connect connection.
- **Documentation directory does not exist:** create
  `.data/dishwasher-docs`, or update `DISHWASHER_DOCUMENTS_DIR` in
  `.vscode/mcp.json`.
- **No supported documentation found:** add at least one supported text or PDF
  file.
- **PDF text is missing:** use a text-based PDF or run OCR on the scanned manual.
- **Tools do not appear in Copilot Chat:** restart the **dishwasher-loop** MCP
  server from VS Code, then reselect the **Dishwasher Advisor** agent.
- **Server fails with `No such file or directory`:** verify that `node` is on
  the `PATH` visible to VS Code by running `node --version` in its integrated
  terminal, then restart VS Code from an environment that initializes Node.
