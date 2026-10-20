import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  COMMENT_LIMIT,
  InputError,
  findExisting,
  markerOf,
  pullRequestNumber,
  renderBody,
  run,
} from "../../../actions/sticky-comment/lib/index.mjs";

const ENV = {
  GITHUB_REPOSITORY: "acme/widgets",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_API_URL: "https://api.example.test",
  GITHUB_GRAPHQL_URL: "https://api.example.test/graphql",
  GITHUB_RUN_ID: "42",
  GITHUB_SHA: "0000000000000000000000000000000000000000",
};

const EVENT = { pull_request: { number: 7, head: { sha: "abcdef1234567890" } } };

function reportFile(content) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sticky-comment-")), "report.md");
  fs.writeFileSync(file, content);
  return file;
}

function comment(overrides) {
  return {
    databaseId: 1,
    isMinimized: false,
    body: "<!-- plan -->\nold",
    author: { login: "github-actions" },
    ...overrides,
  };
}

// Answers the GraphQL query with the given pages and records every call, so a
// test reads which comment was written and how.
function fakeGitHub({ pages, viewer = "github-actions[bot]", createdId = 99 }) {
  const calls = [];
  let page = 0;

  async function fetch(url, { method, body }) {
    const payload = body ? JSON.parse(body) : undefined;
    calls.push({ method, url, payload });

    if (url === ENV.GITHUB_GRAPHQL_URL) {
      const nodes = pages[page] ?? [];
      const hasNextPage = page < pages.length - 1;
      page += 1;
      return new Response(
        JSON.stringify({
          data: {
            viewer: { login: viewer },
            repository: {
              pullRequest: {
                comments: { nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? `cursor-${page}` : null } },
              },
            },
          },
        }),
      );
    }

    if (method === "POST") return new Response(JSON.stringify({ id: createdId }), { status: 201 });
    return new Response(JSON.stringify({}));
  }

  return { fetch, calls };
}

function writes(calls) {
  return calls.filter((call) => call.url !== ENV.GITHUB_GRAPHQL_URL);
}

test("marker becomes an HTML comment", () => {
  assert.equal(markerOf("terraform-plan"), "<!-- terraform-plan -->");
});

test("marker refuses what would end the HTML comment", () => {
  for (const name of ["", "a--b", "a -->", "a b", "-a"]) {
    assert.throws(() => markerOf(name), InputError, name);
  }
});

test("pull request number comes from a pull request event", () => {
  assert.equal(pullRequestNumber(EVENT), 7);
});

test("pull request number comes from a comment on a pull request", () => {
  assert.equal(pullRequestNumber({ issue: { number: 3, pull_request: {} } }), 3);
});

test("an issue or a push has no pull request number", () => {
  assert.equal(pullRequestNumber({ issue: { number: 3 } }), undefined);
  assert.equal(pullRequestNumber({ ref: "refs/heads/main" }), undefined);
});

test("body starts with the marker and ends with the run footer", () => {
  const body = renderBody({ marker: "<!-- plan -->", content: "hello", runUrl: "https://run", sha: "abcdef1234" });
  assert.equal(body, "<!-- plan -->\nhello\n_[Full log](https://run) · `abcdef1`_\n");
});

test("an oversized body is cut to fit and says so", () => {
  const body = renderBody({
    marker: "<!-- plan -->",
    content: "x".repeat(COMMENT_LIMIT * 2),
    runUrl: "https://run",
    sha: "abcdef1234",
  });
  assert.ok(body.length <= COMMENT_LIMIT, `${body.length} > ${COMMENT_LIMIT}`);
  assert.match(body, /_Truncated to fit GitHub's comment limit\._/);
  assert.match(body, /`abcdef1`_\n$/);
});

test("a cut never splits a surrogate pair", () => {
  const marker = "<!-- plan -->";
  const footer = "\n_[Full log](https://run) · `abcdef1`_\n";
  const truncated = "\n\n_Truncated to fit GitHub's comment limit._\n";
  const budget = COMMENT_LIMIT - marker.length - footer.length - truncated.length - 1;
  const content = "x".repeat(budget - 1) + "😀".repeat(10);
  const body = renderBody({ marker, content, runUrl: "https://run", sha: "abcdef1234" });
  assert.doesNotMatch(body, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test("existing comment matches only this token's own", () => {
  const found = findExisting({
    comments: [
      comment({ databaseId: 1, author: { login: "someone" } }),
      comment({ databaseId: 2 }),
    ],
    viewer: "github-actions[bot]",
    marker: "<!-- plan -->",
  });
  assert.equal(found.databaseId, 2);
});

test("a hidden comment is not reused", () => {
  const found = findExisting({
    comments: [comment({ isMinimized: true })],
    viewer: "github-actions[bot]",
    marker: "<!-- plan -->",
  });
  assert.equal(found, undefined);
});

test("another marker is not reused", () => {
  const found = findExisting({
    comments: [comment({ body: "<!-- plan-other -->\nold" })],
    viewer: "github-actions",
    marker: "<!-- plan -->",
  });
  assert.equal(found, undefined);
});

test("a marker quoted below the first line is not reused", () => {
  const found = findExisting({
    comments: [comment({ body: "<!-- other -->\nquoting <!-- plan -->" })],
    viewer: "github-actions",
    marker: "<!-- plan -->",
  });
  assert.equal(found, undefined);
});

test("a comment with no author is not reused", () => {
  const found = findExisting({
    comments: [comment({ author: null })],
    viewer: "",
    marker: "<!-- plan -->",
  });
  assert.equal(found, undefined);
});

test("first run creates the comment", async () => {
  const github = fakeGitHub({ pages: [[]] });
  const result = await run({
    inputs: { path: reportFile("plan"), marker: "plan", token: "t" },
    event: EVENT,
    env: ENV,
    fetch: github.fetch,
  });

  assert.deepEqual(result, { action: "created", id: 99 });
  const [write] = writes(github.calls);
  assert.equal(write.method, "POST");
  assert.equal(write.url, "https://api.example.test/repos/acme/widgets/issues/7/comments");
  assert.match(write.payload.body, /^<!-- plan -->\nplan\n_\[Full log\]\(https:\/\/github\.com\/acme\/widgets\/actions\/runs\/42\) · `abcdef1`_\n$/);
});

test("a later run updates the comment it found on a later page", async () => {
  const github = fakeGitHub({
    pages: [[comment({ databaseId: 1, body: "unrelated" })], [comment({ databaseId: 5 })]],
  });
  const result = await run({
    inputs: { path: reportFile("new plan"), marker: "plan", token: "t" },
    event: EVENT,
    env: ENV,
    fetch: github.fetch,
  });

  assert.deepEqual(result, { action: "updated", id: 5 });
  const graphql = github.calls.filter((call) => call.url === ENV.GITHUB_GRAPHQL_URL);
  assert.equal(graphql.length, 2);
  assert.equal(graphql[1].payload.variables.cursor, "cursor-1");
  const [write] = writes(github.calls);
  assert.equal(write.method, "PATCH");
  assert.equal(write.url, "https://api.example.test/repos/acme/widgets/issues/comments/5");
});

test("a run outside a pull request skips without calling GitHub", async () => {
  const github = fakeGitHub({ pages: [[]] });
  const result = await run({
    inputs: { path: reportFile("plan"), marker: "plan", token: "t" },
    event: { ref: "refs/heads/main" },
    env: ENV,
    fetch: github.fetch,
  });

  assert.equal(result.action, "skipped");
  assert.equal(github.calls.length, 0);
});

test("a missing file skips without calling GitHub", async () => {
  const github = fakeGitHub({ pages: [[]] });
  const result = await run({
    inputs: { path: path.join(os.tmpdir(), "sticky-comment-absent.md"), marker: "plan", token: "t" },
    event: EVENT,
    env: ENV,
    fetch: github.fetch,
  });

  assert.equal(result.action, "skipped");
  assert.equal(github.calls.length, 0);
});

test("a refused write names the status", async () => {
  const fetch = async () => new Response("Resource not accessible by integration", { status: 403 });
  await assert.rejects(
    run({ inputs: { path: reportFile("plan"), marker: "plan", token: "t" }, event: EVENT, env: ENV, fetch }),
    /answered 403: Resource not accessible by integration/,
  );
});

test("GraphQL errors fail the run", async () => {
  const fetch = async () => new Response(JSON.stringify({ errors: [{ message: "Could not resolve" }] }));
  await assert.rejects(
    run({ inputs: { path: reportFile("plan"), marker: "plan", token: "t" }, event: EVENT, env: ENV, fetch }),
    /GraphQL answered: Could not resolve/,
  );
});
