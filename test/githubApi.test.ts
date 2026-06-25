import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGitHubRemoteUrl } from "../src/githubApi.ts";

describe("parseGitHubRemoteUrl", () => {
  it("parses GitHub SSH remotes", () => {
    assert.deepEqual(parseGitHubRemoteUrl("git@github.com:owner/repo.git"), {
      owner: "owner",
      repo: "repo",
    });
    assert.deepEqual(parseGitHubRemoteUrl("git@github.com:owner/repo"), {
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses GitHub HTTPS remotes", () => {
    assert.deepEqual(parseGitHubRemoteUrl("https://github.com/owner/repo.git"), {
      owner: "owner",
      repo: "repo",
    });
    assert.deepEqual(parseGitHubRemoteUrl(" https://github.com/owner/repo "), {
      owner: "owner",
      repo: "repo",
    });
  });

  it("rejects non-GitHub or incomplete remotes", () => {
    assert.equal(parseGitHubRemoteUrl("https://gitlab.com/owner/repo.git"), null);
    assert.equal(parseGitHubRemoteUrl("https://github.com/owner"), null);
    assert.equal(parseGitHubRemoteUrl("not a remote"), null);
  });
});
