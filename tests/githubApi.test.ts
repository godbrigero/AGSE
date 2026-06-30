import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubApiClient, parseGitHubRemoteUrl } from "../src/githubApi.ts";

test("parseGitHubRemoteUrl supports SSH GitHub remotes", () => {
  assert.deepEqual(parseGitHubRemoteUrl("git@github.com:godbrigero/AGSE.git"), {
    owner: "godbrigero",
    repo: "AGSE",
  });
});

test("parseGitHubRemoteUrl supports HTTPS GitHub remotes", () => {
  assert.deepEqual(parseGitHubRemoteUrl("https://github.com/org/repo.git"), {
    owner: "org",
    repo: "repo",
  });
});

test("parseGitHubRemoteUrl rejects non-GitHub remotes and malformed values", () => {
  assert.equal(parseGitHubRemoteUrl("https://gitlab.com/org/repo.git"), null);
  assert.equal(parseGitHubRemoteUrl("not-a-url"), null);
});

test("GitHubApiClient creates repository hooks", async () => {
  const calls = await withMockFetch(async () => {
    const github = new GitHubApiClient("token-1");
    const hook = await github.createRepositoryHook(
      { owner: "org", repo: "repo" },
      {
        name: "cli",
        active: false,
        events: ["issues"],
        config: {},
      },
    );

    assert.equal(hook.id, 42);
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.github.com/repos/org/repo/hooks");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.authorization, "Bearer token-1");
  assert.deepEqual(JSON.parse(calls[0]?.body ?? ""), {
    name: "cli",
    active: false,
    events: ["issues"],
    config: {},
  });
});

test("GitHubApiClient updates repository hooks", async () => {
  const calls = await withMockFetch(async () => {
    const github = new GitHubApiClient("token-1");
    const hook = await github.updateRepositoryHook(
      { owner: "org", repo: "repo" },
      42,
      { active: true },
    );

    assert.equal(hook.active, true);
  });

  assert.equal(calls[0]?.url, "https://api.github.com/repos/org/repo/hooks/42");
  assert.equal(calls[0]?.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0]?.body ?? ""), { active: true });
});

test("GitHubApiClient deletes repository hooks", async () => {
  const calls = await withMockFetch(async () => {
    const github = new GitHubApiClient("token-1");
    await github.deleteRepositoryHook({ owner: "org", repo: "repo" }, 42);
  }, 204);

  assert.equal(calls[0]?.url, "https://api.github.com/repos/org/repo/hooks/42");
  assert.equal(calls[0]?.method, "DELETE");
});

test("GitHubApiClient lists pull request review comments", async () => {
  const calls = await withMockFetch(async () => {
    const github = new GitHubApiClient("token-1");
    await github.listPullRequestReviewComments({ owner: "org", repo: "repo" }, 7);
  });

  assert.equal(
    calls[0]?.url,
    "https://api.github.com/repos/org/repo/pulls/7/comments",
  );
  assert.equal(calls[0]?.method, "GET");
});

test("GitHubApiClient reacts to pull request review comments", async () => {
  const calls = await withMockFetch(async () => {
    const github = new GitHubApiClient("token-1");
    await github.addPullRequestReviewCommentReaction(
      { owner: "org", repo: "repo" },
      501,
      "eyes",
    );
  });

  assert.equal(
    calls[0]?.url,
    "https://api.github.com/repos/org/repo/pulls/comments/501/reactions",
  );
  assert.equal(calls[0]?.method, "POST");
  assert.deepEqual(JSON.parse(calls[0]?.body ?? ""), { content: "eyes" });
});

type FetchCall = {
  url: string;
  method: string;
  authorization: string | null;
  body: string | null;
};

async function withMockFetch(
  fn: () => Promise<void>,
  status = 200,
): Promise<FetchCall[]> {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];

  globalThis.fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    calls.push({
      url: input.toString(),
      method: init.method ?? "GET",
      authorization: headers.get("authorization"),
      body: typeof init.body === "string" ? init.body : null,
    });

    if (status === 204) {
      return new Response(null, { status });
    }

    return Response.json({
      id: 42,
      name: "cli",
      active: true,
      events: ["issues"],
      config: {},
      ws_url: "ws://localhost/webhook",
    });
  };

  try {
    await fn();
    return calls;
  } finally {
    globalThis.fetch = originalFetch;
  }
}
