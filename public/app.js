import { getDashboard } from "./api.js";
import {
  renderDashboard,
  renderDashboardError,
} from "./components/dashboard.js";

const REFRESH_INTERVAL_MS = 30_000;
const app = document.querySelector("#app");
const query = new URLSearchParams(location.search);
let pendingError = query.get("error") || "";
let dashboardState = null;
let refreshPromise = null;

if (pendingError) {
  history.replaceState({}, "", location.pathname);
}

app.addEventListener("click", (event) => {
  if (event.target.closest("[data-retry]")) {
    void refreshDashboard();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void refreshDashboard();
  }
});

setInterval(() => {
  if (document.visibilityState === "visible") {
    void refreshDashboard();
  }
}, REFRESH_INTERVAL_MS);

await refreshDashboard();

async function refreshDashboard() {
  if (refreshPromise) {
    return refreshPromise;
  }
  refreshPromise = (async () => {
    try {
      dashboardState = await getDashboard();
      app.innerHTML = renderDashboard(dashboardState, { error: pendingError });
      pendingError = "";
    } catch (error) {
      showError(error);
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  app.innerHTML = dashboardState
    ? renderDashboard(dashboardState, { error: message })
    : renderDashboardError(message);
}
