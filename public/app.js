import { getDashboard, saveCapsuleCount } from "./api.js";
import {
  renderDashboard,
  renderDashboardError,
} from "./components/dashboard.js";

const REFRESH_INTERVAL_MS = 30_000;
const app = document.querySelector("#app");
const dialog = document.querySelector("#capsule-settings");
const capsuleForm = document.querySelector("#capsule-form");
const capsuleInput = document.querySelector("#capsule-count");
const capsuleError = document.querySelector("#capsule-error");
let savingCapsules = false;
const query = new URLSearchParams(location.search);
let pendingError = query.get("error") || "";
let dashboardState = null;
let refreshPromise = null;

if (pendingError) {
  history.replaceState({}, "", location.pathname);
}

app.addEventListener("click", (event) => {
  if (event.target.closest("[data-settings]")) {
    capsuleInput.value = dashboardState.capsuleCount;
    capsuleError.hidden = true;
    document.querySelector("#settings-status").textContent = "";
    dialog.showModal();
  }
  if (event.target.closest("[data-retry]")) {
    void refreshDashboard();
  }
});

dialog.addEventListener("cancel", (event) => {
  if (savingCapsules) event.preventDefault();
});
dialog.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    if (!savingCapsules) dialog.close();
  }
});
dialog.addEventListener("close", () => {
  app.querySelector("[data-settings]")?.focus();
});
document.querySelector("[data-cancel-settings]").addEventListener("click", () => dialog.close());
capsuleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (savingCapsules || !capsuleForm.reportValidity()) return;
  savingCapsules = true;
  capsuleError.hidden = true;
  capsuleForm.querySelectorAll("button, input").forEach((control) => { control.disabled = true; });
  try {
    // Finish any older refresh before applying the newly saved count.
    await refreshPromise;
    const { capsuleCount } = await saveCapsuleCount(Number(capsuleInput.value));
    dashboardState = { ...dashboardState, capsuleCount, supplyForecast: undefined };
    app.innerHTML = renderDashboard(dashboardState);
    dialog.close();
    document.querySelector("#settings-status").textContent = "Počet tablet byl uložen.";
    await refreshDashboard();
  } catch (error) {
    capsuleError.textContent = error.message;
    capsuleError.hidden = false;
  } finally {
    savingCapsules = false;
    capsuleForm.querySelectorAll("button, input").forEach((control) => { control.disabled = false; });
    if (dialog.open) capsuleInput.focus();
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
  if (dialog.open) return;
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
