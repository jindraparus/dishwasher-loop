import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import {
  captureCycleHistory,
  readDeploymentCycles,
  verifyCycleHistory,
} from "../src/deployment-history.js";
import { Storage } from "../src/storage.js";

const [operation, file] = process.argv.slice(2);
if (!["capture", "verify"].includes(operation) || !file) {
  throw new Error("Usage: node scripts/check-deployment-history.js <capture|verify> <baseline.json>");
}
for (const name of ["AZURE_RESOURCE_GROUP", "AZURE_WEBAPP_NAME"]) {
  if (!process.env[name]) throw new Error(`${name} is required.`);
}

// Keep the storage credential in memory; never print or persist app settings.
let settingsJson;
try {
  settingsJson = execFileSync("az", [
    "webapp", "config", "appsettings", "list",
    "--resource-group", process.env.AZURE_RESOURCE_GROUP,
    "--name", process.env.AZURE_WEBAPP_NAME,
    "--query", "[?name=='AZURE_STORAGE_CONNECTION_STRING' || name=='AZURE_TABLE_NAME' || name=='CYCLE_TIMEZONE']",
    "--output", "json",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 60_000 });
} catch {
  throw new Error("Unable to read Web App settings. Check the Azure CLI error above.");
}
const settings = JSON.parse(settingsJson);
const env = Object.fromEntries(settings.map(({ name, value }) => [name, value]));
if (!env.AZURE_STORAGE_CONNECTION_STRING
  || /^(local|UseDevelopmentStorage=true)$/i.test(env.AZURE_STORAGE_CONNECTION_STRING.trim())) {
  throw new Error("Deployment verification requires production Azure Table Storage.");
}
const storage = new Storage(
  env.AZURE_STORAGE_CONNECTION_STRING,
  env.AZURE_TABLE_NAME || "DishwasherLoop",
);
const timezone = env.CYCLE_TIMEZONE || "Europe/Prague";
const referenceTime = new Date().toISOString();
const cycles = await readDeploymentCycles(storage, operation);
if (operation === "capture") {
  const baseline = captureCycleHistory(cycles, timezone, referenceTime);
  await writeFile(file, JSON.stringify(baseline), { mode: 0o600, flag: "wx" });
  console.log(`Captured ${cycles.length} cycles at ${referenceTime} (${timezone}).`);
  console.log(JSON.stringify(baseline.stats, null, 2));
} else {
  const baseline = JSON.parse(await readFile(file, "utf8"));
  const result = verifyCycleHistory(baseline, cycles, timezone);
  console.log("Cycle-history verification passed.");
  console.log(JSON.stringify(result, null, 2));
}
