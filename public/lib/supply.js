export function validInventory(count) {
  return Number.isInteger(count) && count >= 0 && count <= 999;
}

export function currentSupplyForecast(forecast, count) {
  return forecast && forecast.inventoryCount === count ? forecast : null;
}

export function capsuleState(count, forecast) {
  if (!validInventory(count)) return "unknown";
  const current = currentSupplyForecast(forecast, count);
  if (current) return current.action === "order" ? "low"
    : current.action === "none" ? "ok" : "unknown";
  return count <= 5 ? "low" : "ok";
}

export function capsuleRecommendation(count, forecast) {
  if (!validInventory(count)) {
    return { title: "Počet tablet není k dispozici",
      text: "V úložišti není k dispozici platný počet tablet do myčky.", tone: "" };
  }
  const current = currentSupplyForecast(forecast, count);
  const reason = current?.reason
    ?? (count === 0 ? "out-of-stock" : count <= 5 ? "stock-only-low" : "estimate-unavailable");
  if (reason === "sufficient-estimated-stock") return null;
  let text;
  if (reason === "out-of-stock") {
    text = "Tablety došly. Objednejte nebo doplňte zásoby před dalším mytím.";
  } else if (reason === "within-reorder-window") {
    text = `Zbývá ${count} tablet, přibližně na ${Math.round(current.estimatedDaysRemaining)} dní podle zaznamenané spotřeby všech myček. Objednejte nyní (dodání 3 dny + rezerva 4 dny). Odhad předpokládá jednu tabletu na dokončené mytí; výpadky sledování a neúplné záznamy mohou skutečnou spotřebu zvýšit.`;
  } else if (reason === "stock-only-low") {
    text = `Zbývá pouze ${count} tablet. Doplnění je doporučeno pouze podle počtu zásob; odhad spotřeby není k dispozici.`;
  } else {
    text = `Zbývá ${count} tablet. Pro odhad výdrže zásob není dostatek zaznamenané spotřeby; nulová pozorovaná spotřeba neznamená nulové používání.`;
  }
  return { title: ["out-of-stock", "within-reorder-window", "stock-only-low"].includes(reason)
    ? "Doplňte tablety do myčky" : "Odhad zásob není k dispozici",
  text, tone: ["out-of-stock", "within-reorder-window", "stock-only-low"].includes(reason)
    ? "warning" : "" };
}
