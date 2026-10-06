import fs from "node:fs";
import path from "node:path";

import { getBooleanInput } from "./core.mjs";
import { createConfigFetchGuard } from "./config-fetch-guard.mjs";
import { CONFIG_FILE, InputError } from "./index.mjs";

if (!process.env.GITHUB_REPOSITORY) throw new InputError("GITHUB_REPOSITORY is required to guard release configuration reads.");
const snapshot = fs.readFileSync(path.join(process.env.GITHUB_WORKSPACE ?? process.cwd(), CONFIG_FILE));
globalThis.fetch = createConfigFetchGuard(globalThis.fetch, {
  snapshot,
  repository: process.env.GITHUB_REPOSITORY,
  apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
  requireInitialVersion: getBooleanInput("require_initial_version"),
});
