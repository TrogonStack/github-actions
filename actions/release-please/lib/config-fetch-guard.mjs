import { createHash } from "node:crypto";

import {
  CONFIG_FILE,
  InputError,
  validateInitialVersion,
  validateReleaseDefaults,
  validateSignoff,
} from "./index.mjs";

export function gitBlobSha(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export function createConfigFetchGuard(fetch, { snapshot, repository, apiUrl = "https://api.github.com", requireInitialVersion = true }) {
  const bytes = Buffer.from(snapshot);
  const config = JSON.parse(bytes.toString("utf8"));
  validateReleaseDefaults(config);
  validateSignoff(config);
  if (requireInitialVersion) validateInitialVersion(config);
  const sha = gitBlobSha(bytes);
  const base = new URL(apiUrl);
  const repoPath = `${base.pathname.replace(/\/$/, "")}/repos/${repository}/`;
  const directories = new Map();
  const mismatch = () => new InputError(`${CONFIG_FILE}: configuration differs from the validated checkout. Check out the configuration used by the release branch before releasing.`);

  function verifyContent(data) {
    if (data.encoding !== "base64" || typeof data.content !== "string") {
      throw new InputError(`${CONFIG_FILE}: GitHub did not return base64 configuration content.`);
    }
    if (!Buffer.from(data.content, "base64").equals(bytes)) throw mismatch();
  }

  return async function guardedFetch(input, init) {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const response = await fetch(input, init);
    if (url.origin !== base.origin || !url.pathname.toLowerCase().startsWith(repoPath.toLowerCase()) || !response.ok) return response;
    const endpoint = decodeURIComponent(url.pathname.slice(repoPath.length));
    const method = init?.method ?? input?.method ?? "GET";
    if (method.toUpperCase() !== "GET") return response;

    if (endpoint.startsWith("git/trees/")) {
      const ref = endpoint.slice("git/trees/".length);
      const prefix = directories.get(ref) ?? "";
      const data = await response.clone().json();
      for (const entry of data.tree ?? []) {
        const path = prefix + entry.path;
        if (entry.type === "tree" && path === ".github") directories.set(entry.sha, ".github/");
        if (path === CONFIG_FILE && entry.sha !== sha) throw mismatch();
      }
    } else if (endpoint === `git/blobs/${sha}` || endpoint === `contents/${CONFIG_FILE}`) {
      verifyContent(await response.clone().json());
    }
    return response;
  };
}
