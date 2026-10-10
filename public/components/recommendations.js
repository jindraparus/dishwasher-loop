import { escapeHtml } from "../lib/format.js";
import { isProgramActive } from "../lib/program.js";

export function renderRecommendationsCard(state, now = Date.now()) {
  const recommendations = buildRecommendations(state, now);
  return `<section class="card recommendations-card">
    <div class="card-heading"><h2>Recommendations</h2><span class="icon" aria-hidden="true">✦</span></div>
    <ul class="recommendations">${recommendations.map(renderRecommendation).join("")}</ul>
  </section>`;
}

export function buildRecommendations({ authorized, diagnostics, capsuleCount }, now = Date.now()) {
  const recommendations = [];
  const diagnostic = diagnostics[0];
  if (!authorized) {
    return [{
      title: "Connect Home Connect",
      text: "Authorize the appliance account to begin monitoring.",
      tone: "warning",
    }];
  }
  if (!diagnostic) {
    return [{
      title: "Waiting for the dishwasher",
      text: "No paired dishwasher diagnostics are available yet.",
      tone: "warning",
    }];
  }
  if (diagnostic.connected === false) {
    recommendations.push({
      title: "Dishwasher is offline",
      text: "Check appliance power and Home Connect connectivity.",
      tone: "warning",
    });
  }
  if (diagnostic.consumables?.salt?.state === "low") {
    recommendations.push({
      title: "Refill dishwasher salt",
      text: "Add salt before the next wash for reliable water softening.",
      tone: "warning",
    });
  } else if (diagnostic.consumables?.salt?.state === "unknown") {
    recommendations.push({
      title: "Salt status is pending",
      text: "Home Connect has not reported a salt warning state yet.",
      tone: "",
    });
  }
  if (diagnostic.consumables?.rinseAid?.state === "low") {
    recommendations.push({
      title: "Refill rinse aid",
      text: "The appliance reports that rinse aid is nearly empty.",
      tone: "warning",
    });
  }
  if (!Number.isInteger(capsuleCount)) {
    recommendations.push({
      title: "Capsule inventory unavailable",
      text: "No valid capsule amount is available in local browser storage.",
      tone: "",
    });
  } else if (capsuleCount <= 5) {
    recommendations.push({
      title: "Restock washing capsules",
      text: `Only ${capsuleCount} ${capsuleCount === 1 ? "capsule remains" : "capsules remain"}.`,
      tone: "warning",
    });
  }
  if (isProgramActive(diagnostic, now)) {
    recommendations.push({
      title: "Wash cycle in progress",
      text: "No action is needed while the current program is running.",
      tone: "",
    });
  }
  if (recommendations.length === 0) {
    recommendations.push({
      title: "Everything looks ready",
      text: "The dishwasher is connected and supplies look sufficient.",
      tone: "",
    });
  }
  return recommendations;
}

function renderRecommendation(recommendation) {
  return `<li class="recommendation ${escapeHtml(recommendation.tone)}"><strong>${escapeHtml(recommendation.title)}</strong><span>${escapeHtml(recommendation.text)}</span></li>`;
}
