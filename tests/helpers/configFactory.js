import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, "..", "..");

const baseConfig = JSON.parse(
  readFileSync(path.join(projectRoot, "config.json"), "utf-8"),
);

export function createConfigOverride(overrides) {
  return JSON.parse(JSON.stringify({ ...baseConfig, ...overrides }));
}
