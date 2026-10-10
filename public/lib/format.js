export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function formatKey(key) {
  const shortKey = String(key || "Status").split(".").at(-1);
  return shortKey.replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function formatValue(value, unit) {
  let displayedValue = value !== null && typeof value === "object"
    ? JSON.stringify(value)
    : String(value ?? "");
  if (typeof value === "string" && value.includes(".EnumType.")) {
    displayedValue = value.split(".").at(-1);
  }
  return unit ? `${displayedValue} ${unit}` : displayedValue;
}

export function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

export function formatDuration(totalSeconds) {
  const minutes = Math.max(0, Math.ceil(totalSeconds / 60));
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours === 0) {
    return `${remainingMinutes}m`;
  }
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

export function formatProgramName(key) {
  const name = String(key).split(".").at(-1);
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2");
}
