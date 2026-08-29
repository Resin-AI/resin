import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const FIXTURES_DIR = __dirname;
export const ROLLOUTS_DIR = path.join(__dirname, "rollouts");
export const CONFIGS_DIR = path.join(__dirname, "configs");

export const STANDARD_SESSION_ROLLOUT_PATH = path.join(ROLLOUTS_DIR, "standard-session.jsonl");
export const MULTI_TURN_TOOLS_ROLLOUT_PATH = path.join(ROLLOUTS_DIR, "multi-turn-tools.jsonl");
export const SUBAGENTS_AND_FORKS_ROLLOUT_PATH = path.join(
  ROLLOUTS_DIR,
  "subagents-and-forks.jsonl",
);
export const SAMPLE_CONFIG_TOML_PATH = path.join(CONFIGS_DIR, "sample-config.toml");
export const SAMPLE_CONFIG_JSON_PATH = path.join(CONFIGS_DIR, "sample-config.json");

export async function readFixture(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}
