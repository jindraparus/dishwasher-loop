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
  const labels = {
    Connection: "Připojení",
    DoorState: "Stav dveří",
    InteriorIlluminationActive: "Vnitřní osvětlení aktivní",
    OperationState: "Provozní stav",
    RemoteControlActive: "Vzdálené ovládání aktivní",
    RemoteControlStartAllowed: "Povolen vzdálený start",
    Status: "Stav",
  };
  if (labels[shortKey]) {
    return labels[shortKey];
  }
  return shortKey.replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function formatValue(value, unit) {
  if (typeof value === "boolean") {
    return value ? "Ano" : "Ne";
  }
  let displayedValue = value !== null && typeof value === "object"
    ? JSON.stringify(value)
    : String(value ?? "");
  if (typeof value === "string" && value.includes(".EnumType.")) {
    const enumValue = value.split(".").at(-1);
    displayedValue = {
      Closed: "Zavřeno",
      DelayedStart: "Odložený start",
      Finished: "Dokončeno",
      Inactive: "Neaktivní",
      Open: "Otevřeno",
      Pause: "Pozastaveno",
      Ready: "Připraveno",
      Run: "Probíhá",
    }[enumValue] || enumValue;
  }
  const displayedUnit = unit === "seconds" ? "s" : unit;
  return displayedUnit ? `${displayedValue} ${displayedUnit}` : displayedValue;
}

export function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("cs-CZ");
}

export function formatDuration(totalSeconds) {
  const minutes = Math.max(0, Math.ceil(totalSeconds / 60));
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours === 0) {
    return `${remainingMinutes} min`;
  }
  return remainingMinutes === 0 ? `${hours} h` : `${hours} h ${remainingMinutes} min`;
}

export function formatProgramName(key) {
  const name = String(key).split(".").at(-1);
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2");
}

export function formatEventType(eventType) {
  return {
    EVENT: "UDÁLOST",
    NOTIFY: "OZNÁMENÍ",
    STATUS: "STAV",
  }[eventType] || eventType;
}

export function formatApplianceType(type) {
  return type === "Dishwasher" ? "Myčka nádobí" : type;
}
