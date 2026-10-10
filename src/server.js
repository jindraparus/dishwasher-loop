import "dotenv/config";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express from "express";
import { loadConfig } from "./config.js";
import { renderPage } from "./html.js";
import { HomeConnectClient } from "./home-connect.js";
import { requireAllowedMicrosoftUser } from "./microsoft-auth.js";
import { DishwasherMonitor } from "./monitor.js";
import { Storage } from "./storage.js";

const config = loadConfig();
const storage = new Storage(config.storageConnectionString, config.tableName);
await storage.initialize();

const homeConnect = new HomeConnectClient(config, storage);
const monitor = new DishwasherMonitor(homeConnect, storage, console, {
  types: config.persistedEventTypes,
  keys: config.persistedEventKeys,
});
if (await storage.getTokens()) {
  monitor.start();
}

const app = express();
app.disable("x-powered-by");
app.use(express.urlencoded({ extended: false }));

app.get("/healthz", (request, response) => {
  response.json({ ok: true });
});

app.use(requireAllowedMicrosoftUser(config));

app.get("/", async (request, response, next) => {
  try {
    const [events, tokens] = await Promise.all([storage.listEvents(), storage.getTokens()]);
    response.type("html").send(renderPage({
      events,
      authorized: Boolean(tokens),
      monitorStatus: monitor.getStatus(),
      diagnostics: monitor.getDiagnostics(),
      error: typeof request.query.error === "string" ? request.query.error : "",
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/auth/login", (request, response) => {
  const state = randomBytes(32).toString("base64url");
  const value = `${state}.${sign(state, config.cookieSecret)}`;
  response.cookie("oauth_state", value, {
    httpOnly: true,
    maxAge: 10 * 60 * 1000,
    sameSite: "lax",
    secure: config.redirectUri.startsWith("https://"),
  });
  response.redirect(homeConnect.getAuthorizationUrl(state));
});

app.get("/auth/callback", async (request, response, next) => {
  try {
    const { code, state, error, error_description: errorDescription } = request.query;
    if (error) {
      response.redirect(`/?error=${encodeURIComponent(String(errorDescription || error))}`);
      return;
    }
    if (typeof code !== "string" || typeof state !== "string" || !validState(request, state)) {
      response.status(400).send("Invalid OAuth callback");
      return;
    }

    await homeConnect.exchangeCode(code);
    monitor.start();
    response.clearCookie("oauth_state");
    response.redirect("/");
  } catch (callbackError) {
    next(callbackError);
  }
});

app.post("/auth/disconnect", async (request, response, next) => {
  try {
    monitor.stop();
    await storage.deleteTokens();
    response.redirect("/");
  } catch (error) {
    next(error);
  }
});

app.use((error, request, response, next) => {
  console.error(error);
  if (response.headersSent) {
    next(error);
    return;
  }
  response.status(500).type("text").send("An unexpected error occurred. Check the service logs.");
});

const server = app.listen(config.port, () => {
  console.log(`Dishwasher Loop listening on port ${config.port}`);
});

function shutdown() {
  monitor.stop();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function validState(request, state) {
  const cookies = parseCookies(request.headers.cookie);
  const [storedState, signature] = (cookies.oauth_state || "").split(".");
  if (!storedState || !signature || storedState !== state) {
    return false;
  }
  const expected = sign(storedState, config.cookieSecret);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sign(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator === -1) {
      return [];
    }
    return [[
      decodeURIComponent(part.slice(0, separator).trim()),
      decodeURIComponent(part.slice(separator + 1).trim()),
    ]];
  }));
}
