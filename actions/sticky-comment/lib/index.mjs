import fs from "node:fs";

import { getInput, info, setFailed, setOutput } from "./core.mjs";

// GitHub refuses a comment body longer than this outright.
export const COMMENT_LIMIT = 65536;

// Single separators only, because the marker sits inside an HTML comment and
// `--` there ends it early.
const MARKER = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;

const TRUNCATED = "\n\n_Truncated to fit GitHub's comment limit._\n";

// Thrown for anything a caller can fix by editing their workflow, so main can
// report it as a GitHub error annotation rather than a stack trace.
export class InputError extends Error {}

export function markerOf(name) {
  if (!MARKER.test(name)) {
    throw new InputError(
      "The `marker` input must be letters and digits, joined by single dots, dashes or underscores: it is written into an HTML comment.",
    );
  }
  return `<!-- ${name} -->`;
}

export function pullRequestNumber(event) {
  if (Number.isInteger(event?.pull_request?.number)) return event.pull_request.number;
  if (event?.issue?.pull_request && Number.isInteger(event.issue.number)) return event.issue.number;
  return undefined;
}

// Keeps the head, because the first lines are the part a reviewer reads. The
// writer of the file is expected to budget well under the limit, so this is
// the backstop for a shape nobody predicted.
export function renderBody({ marker, content, runUrl, sha }) {
  const footer = `\n_[Full log](${runUrl}) · \`${sha.slice(0, 7)}\`_\n`;
  const budget = COMMENT_LIMIT - marker.length - footer.length - TRUNCATED.length - 1;

  let report = content;
  if (report.length > budget) {
    report = report.slice(0, budget);
    if (/[\uD800-\uDBFF]$/.test(report)) report = report.slice(0, -1);
    report += TRUNCATED;
  }

  return `${marker}\n${report}${footer}`;
}

// GraphQL names a GitHub App by its slug and REST appends `[bot]`, so the two
// spellings of the same account have to compare equal.
function sameAccount(left, right) {
  const normalize = (login) => String(login ?? "").replace(/\[bot\]$/, "").toLowerCase();
  return normalize(left) !== "" && normalize(left) === normalize(right);
}

// Only a comment this token wrote, opening with the marker: a person quoting
// the marker owns a comment the token cannot edit, a report can quote another
// marker, and a hidden one was put away on purpose.
export function findExisting({ comments, viewer, marker }) {
  return comments.find(
    (comment) =>
      sameAccount(comment.author?.login, viewer) &&
      !comment.isMinimized &&
      comment.body?.startsWith(`${marker}\n`),
  );
}

export function createClient({ token, apiUrl, graphqlUrl, fetch: send = globalThis.fetch }) {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "TrogonStack/github-actions sticky-comment",
    "x-github-api-version": "2022-11-28",
  };

  async function call(method, url, body) {
    const response = await send(url, { method, headers, body: JSON.stringify(body) });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${url} answered ${response.status}: ${text}`);
    }
    return text ? JSON.parse(text) : {};
  }

  return {
    async graphql(query, variables) {
      const { data, errors } = await call("POST", graphqlUrl, { query, variables });
      if (errors?.length) {
        throw new Error(`GraphQL answered: ${errors.map((entry) => entry.message).join("; ")}`);
      }
      return data;
    },
    request(method, path, body) {
      return call(method, `${apiUrl}${path}`, body);
    },
  };
}

const COMMENTS_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    viewer { login }
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        comments(first: 100, after: $cursor) {
          nodes { databaseId isMinimized body author { login } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

export async function listComments({ client, owner, repo, number }) {
  const comments = [];
  let viewer;
  let cursor = null;

  do {
    const data = await client.graphql(COMMENTS_QUERY, { owner, repo, number, cursor });
    viewer = data.viewer.login;
    const page = data.repository.pullRequest.comments;
    comments.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return { viewer, comments };
}

export async function post({ client, owner, repo, number, marker, body }) {
  const { viewer, comments } = await listComments({ client, owner, repo, number });
  const existing = findExisting({ comments, viewer, marker });

  if (existing) {
    await client.request("PATCH", `/repos/${owner}/${repo}/issues/comments/${existing.databaseId}`, { body });
    return { action: "updated", id: existing.databaseId };
  }

  const created = await client.request("POST", `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
  return { action: "created", id: created.id };
}

export async function run({ inputs, event, env, fetch }) {
  const marker = markerOf(inputs.marker);

  const number = pullRequestNumber(event);
  if (number === undefined) {
    return { action: "skipped", reason: "Not a pull request, so there is nothing to comment on." };
  }

  // Callers run this on `!cancelled()` so a failed step still reports, and the
  // step that writes the file may have failed before it set the path output or
  // wrote the file.
  if (!inputs.path) {
    return { action: "skipped", reason: "No path to post: the step that writes it did not get that far." };
  }
  if (!fs.existsSync(inputs.path)) {
    return { action: "skipped", reason: `No ${inputs.path} to post: the step that writes it did not get that far.` };
  }

  const [owner, repo] = env.GITHUB_REPOSITORY.split("/");
  const serverUrl = env.GITHUB_SERVER_URL || "https://github.com";
  const body = renderBody({
    marker,
    content: fs.readFileSync(inputs.path, "utf8"),
    runUrl: `${serverUrl}/${owner}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`,
    sha: event?.pull_request?.head?.sha ?? env.GITHUB_SHA,
  });

  const client = createClient({
    token: inputs.token,
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
    graphqlUrl: env.GITHUB_GRAPHQL_URL || "https://api.github.com/graphql",
    fetch,
  });

  return post({ client, owner, repo, number, marker, body });
}

function readEvent(path) {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    throw new InputError(`Could not read the event payload at ${path}: ${error.message}`);
  }
}

export async function main() {
  try {
    const result = await run({
      inputs: { path: getInput("path"), marker: getInput("marker"), token: getInput("token") },
      event: readEvent(process.env.GITHUB_EVENT_PATH),
      env: process.env,
    });

    if (result.action === "skipped") {
      info(result.reason);
      return;
    }

    info(`Comment ${result.id} ${result.action}.`);
    setOutput("comment-id", String(result.id));
  } catch (thrown) {
    setFailed(thrown.message);
  }
}
