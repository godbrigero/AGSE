import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "../src/codexIntegration/appServerClient.ts";

test("required daemon proxy fails instead of falling back to private stdio", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agse-fake-codex-"));
  const binary = join(dir, "codex");
  const argsLog = join(dir, "args.log");

  try {
    await writeFile(
      binary,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> "${argsLog}"`,
        "echo 'managed standalone Codex install not found' >&2",
        "exit 7",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(binary, 0o755);

    const client = new CodexAppServerClient({
      codexBinary: binary,
      useDaemonProxy: true,
      requireDaemonProxy: true,
    });

    await assert.rejects(
      () => client.connect(),
      /managed standalone Codex install not found[\s\S]*refusing to create a hidden private-stdio chat/,
    );
    assert.equal((await readFile(argsLog, "utf8")).trim(), "app-server daemon start");
    client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("remote-control daemon proxy uses background remote-control start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agse-fake-codex-"));
  const binary = join(dir, "codex");
  const argsLog = join(dir, "args.log");

  try {
    await writeFile(
      binary,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> "${argsLog}"`,
        "echo 'standalone missing' >&2",
        "exit 7",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(binary, 0o755);

    const client = new CodexAppServerClient({
      codexBinary: binary,
      useDaemonProxy: true,
      useRemoteControlDaemon: true,
      requireDaemonProxy: true,
    });

    await assert.rejects(
      () => client.connect(),
      /Codex remote-control daemon start failed/,
    );
    assert.equal((await readFile(argsLog, "utf8")).trim(), "remote-control start --json");
    client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
