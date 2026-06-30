import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGitHubRemoteUrl } from "../src/githubApi.ts";

test("parseGitHubRemoteUrl supports SSH GitHub remotes", () => {
  assert.deepEqual(parseGitHubRemoteUrl("git@github.com:godbrigero/AGSE.git"), {
    owner: "godbrigero",
    repo: "AGSE",
  });
  assert.deepEqual(parseGitHubRemoteUrl("git@github.com:godbrigero/AGSE"), {
    owner: "godbrigero",
    repo: "AGSE",
  });
});

test("parseGitHubRemoteUrl supports HTTPS GitHub remotes", () => {
  assert.deepEqual(parseGitHubRemoteUrl("https://github.com/org/repo.git"), {
    owner: "org",
    repo: "repo",
  });
  assert.deepEqual(parseGitHubRemoteUrl("https://github.com/org/repo"), {
    owner: "org",
    repo: "repo",
  });
  assert.deepEqual(parseGitHubRemoteUrl("  https://github.com/org/repo.git  "), {
    owner: "org",
    repo: "repo",
  });
});

test("parseGitHubRemoteUrl rejects non-GitHub remotes and malformed values", () => {
  assert.equal(parseGitHubRemoteUrl("https://gitlab.com/org/repo.git"), null);
  assert.equal(parseGitHubRemoteUrl("not-a-url"), null);
});
