import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createConfigFetchGuard, gitBlobSha } from "../../../actions/release-please/lib/config-fetch-guard.mjs";

const action = new URL("../../../actions/release-please/action.yml", import.meta.url);

test("upstream release execution loads the config response guard", () => {
  const releaseStep = fs.readFileSync(action, "utf8").split("- name: Release Please")[1];
  assert.match(releaseStep, /NODE_OPTIONS:.*--import.*runtime-guard\.mjs/);
  assert.match(releaseStep, /INPUT_REQUIRE_INITIAL_VERSION:/);
});

const snapshot = JSON.stringify({
  signoff: "Release contributor",
  "initial-version": "0.0.1",
  packages: { ".": {} },
});
const jsonResponse = (value) => new Response(JSON.stringify(value), {
  headers: { "content-type": "application/json" },
});

const repo = "https://api.github.com/repos/example/repository/";
const makeGuard = (body, options = {}) => createConfigFetchGuard(
  async () => jsonResponse(body), { snapshot, repository: "example/repository", ...options },
);

test("matching recursive tree and blob remain readable by SDK", async () => {
  const sha = gitBlobSha(Buffer.from(snapshot));
  const responses = [
    { tree: [{ path: ".github/release-please-config.json", type: "blob", sha }] },
    { content: Buffer.from(snapshot).toString("base64"), encoding: "base64" },
  ];
  const guard = createConfigFetchGuard(async () => jsonResponse(responses.shift()), {
    snapshot, repository: "example/repository",
  });
  assert.equal((await (await guard(repo + "git/trees/main?recursive=true")).json()).tree[0].sha, sha);
  assert.equal((await (await guard(repo + "git/blobs/" + sha)).json()).encoding, "base64");
});

test("truncated-tree directory traversal rejects a changed config SHA", async () => {
  const responses = [
    { tree: [], truncated: true },
    { tree: [{ path: ".github", type: "tree", sha: "directory" }], truncated: false },
    { tree: [{ path: "release-please-config.json", type: "blob", sha: "changed" }] },
  ];
  const guard = createConfigFetchGuard(async () => jsonResponse(responses.shift()), {
    snapshot, repository: "example/repository",
  });
  await guard(repo + "git/trees/main?recursive=true");
  await guard(repo + "git/trees/main");
  await assert.rejects(guard(repo + "git/trees/directory?recursive=true"), /configuration differs/);
});

test("config blob bytes must match even if response claims expected SHA", async () => {
  const sha = gitBlobSha(Buffer.from(snapshot));
  await assert.rejects(makeGuard({ encoding: "base64", content: Buffer.from("{}").toString("base64") })(repo + "git/blobs/" + sha), /configuration differs/);
});

test("Contents transport validates the decoded bytes and preserves the response", async () => {
  const response = await makeGuard({ encoding: "base64", content: Buffer.from(snapshot).toString("base64") })(repo + "contents/.github/release-please-config.json?ref=main");
  assert.equal((await response.json()).encoding, "base64");
  await assert.rejects(makeGuard({ encoding: "base64", content: Buffer.from("{}").toString("base64") })(repo + "contents/.github/release-please-config.json"), /configuration differs/);
  await assert.rejects(makeGuard({ encoding: "none" })(repo + "contents/.github/release-please-config.json"), /base64 configuration content/);
});

test("unrelated blobs, repositories, and API hosts pass through", async () => {
  for (const url of [repo + "git/blobs/manifest", "https://api.github.com/repos/other/repository/contents/.github/release-please-config.json", "https://example.com/repos/example/repository/contents/.github/release-please-config.json"]) {
    assert.deepEqual(await (await makeGuard({ untouched: true })(url)).json(), { untouched: true });
  }
});

test("preload policy always checks signoff and supports initial-version opt-out", () => {
  assert.throws(() => makeGuard({}, { snapshot: JSON.stringify({ signoff: "", packages: { ".": {} } }), requireInitialVersion: false }), /signoff/);
  assert.throws(() => makeGuard({}, { snapshot: JSON.stringify({ signoff: "Release contributor", packages: { ".": {} } }) }), /initial-version/);
  assert.doesNotThrow(() => makeGuard({}, { snapshot: JSON.stringify({ signoff: "Release contributor", packages: { ".": {} } }), requireInitialVersion: false }));
});

test("Node preload guards fetch before the action entry point executes", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "release-config-preload-"));
  try {
    fs.mkdirSync(path.join(workspace, ".github"));
    fs.writeFileSync(path.join(workspace, ".github/release-please-config.json"), snapshot);
    const transport = path.join(workspace, "transport.mjs");
    fs.writeFileSync(transport, `globalThis.fetch = async () => new Response(JSON.stringify({tree:[{path:".github/release-please-config.json",type:"blob",sha:"changed"}]}),{headers:{"content-type":"application/json"}});`);
    const guard = fileURLToPath(new URL("../../../actions/release-please/lib/runtime-guard.mjs", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", transport, "--import", guard, "--input-type=module", "-e", `await fetch("${repo}git/trees/main?recursive=true")`], {
      encoding: "utf8", env: { ...process.env, GITHUB_WORKSPACE: workspace, GITHUB_REPOSITORY: "example/repository", INPUT_REQUIRE_INITIAL_VERSION: "true" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /configuration differs from the validated checkout/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Git blob identity uses the native Git object header", () => {
  assert.equal(gitBlobSha(Buffer.from("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
});
