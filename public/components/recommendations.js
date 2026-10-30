import { escapeHtml } from "../lib/format.js";
import { isProgramActive } from "../lib/program.js";
import { capsuleRecommendation } from "../lib/supply.js";

export function renderRecommendationsCard(state, now = Date.now()) {
  const recommendations = buildRecommendations(state, now);
  return `<section class="card recommendations-card">
    <div class="card-heading"><h2>Doporučení</h2><span class="icon" aria-hidden="true">✦</span></div>
    <ul class="recommendations">${recommendations.map(renderRecommendation).join("")}</ul>
  </section>`;
}

export function buildRecommendations({ authorized, diagnostics, capsuleCount, supplyForecast }, now = Date.now()) {
  const recommendations = [];
  const supply = capsuleRecommendation(capsuleCount, supplyForecast);
  const diagnostic = diagnostics[0];
  if (!authorized) {
    return [{
      title: "Připojte Home Connect",
      text: "Pro zahájení sledování autorizujte účet spotřebiče.",
      tone: "warning",
    }, ...(supply ? [supply] : [])];
  }
  if (!diagnostic) {
    return [{
      title: "Čeká se na myčku",
      text: "Diagnostika spárované myčky zatím není k dispozici.",
      tone: "warning",
    }, ...(supply ? [supply] : [])];
  }
  if (diagnostic.connected === false) {
    recommendations.push({
      title: "Myčka je offline",
      text: "Zkontrolujte napájení spotřebiče a připojení Home Connect.",
      tone: "warning",
    });
  }
  if (diagnostic.consumables?.salt?.state === "low") {
    recommendations.push({
      title: "Doplňte sůl do myčky",
      text: "Pro spolehlivé změkčování vody doplňte sůl před dalším mytím.",
      tone: "warning",
    });
  } else if (diagnostic.consumables?.salt?.state === "unknown") {
    recommendations.push({
      title: "Čeká se na stav soli",
      text: "Home Connect zatím neoznámil stav upozornění na sůl.",
      tone: "",
    });
  }
  if (diagnostic.consumables?.rinseAid?.state === "low") {
    recommendations.push({
      title: "Doplňte leštidlo",
      text: "Spotřebič hlásí, že leštidlo je téměř prázdné.",
      tone: "warning",
    });
  }
  if (supply) recommendations.push(supply);
  if (isProgramActive(diagnostic, now)) {
    recommendations.push({
      title: "Probíhá mycí cyklus",
      text: "Během aktuálního programu není potřeba žádná akce.",
      tone: "",
    });
  }
  if (recommendations.length === 0) {
    recommendations.push({
      title: "Vše je připraveno",
      text: "Myčka je připojena a zásoby vypadají dostatečně.",
      tone: "",
    });
  }
  return recommendations;
}

function renderRecommendation(recommendation) {
  return `<li class="recommendation ${escapeHtml(recommendation.tone)}"><strong>${escapeHtml(recommendation.title)}</strong><span>${escapeHtml(recommendation.text)}</span></li>`;
}
