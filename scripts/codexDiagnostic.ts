import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CodexWorkflows } from "../src/codexIntegration/index.ts";
import { __testing as automation } from "../src/agscIssueAutomation.ts";

const execFileAsync = promisify(execFile);
const diagnosticFileName = "AGSE_CODEX_DIAGNOSTIC.txt";
const diagnosticText = "AGSE_DIAGNOSTIC_OK";
const diagnosticDir = await mkdtemp(join(tmpdir(), "agse-codex-diagnostic-"));
const codex = new CodexWorkflows(
  diagnosticDir,
  automation.CODEX_HANDOFF_OPTIONS,
);
const eventMethods = new Set<string>();
let stderr = "";

codex.client.onNotification((notification) => {
  eventMethods.add(notification.method);
});
codex.client.onStderr((chunk) => {
  stderr += chunk;
});

try {
  await execFileAsync("git", ["init"], { cwd: diagnosticDir });
  await execFileAsync("git", ["config", "user.name", "AGSE Diagnostic"], {
    cwd: diagnosticDir,
  });
  await execFileAsync(
    "git",
    ["config", "user.email", "agse-diagnostic@example.invalid"],
    { cwd: diagnosticDir },
  );
  await writeFile(
    join(diagnosticDir, "README.md"),
    "# AGSE Codex diagnostic\n",
    "utf8",
  );
  await execFileAsync("git", ["add", "README.md"], { cwd: diagnosticDir });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: diagnosticDir });

  const thread = await codex.startChat({
    cwd: diagnosticDir,
    title: "AGSE Codex diagnostic",
    sandbox: automation.CODEX_HANDOFF_OPTIONS.sandbox,
    approvalPolicy: automation.CODEX_HANDOFF_OPTIONS.approvalPolicy,
  });
  const result = await codex.sendMessage(
    thread.id,
    [
      "AGSE Codex diagnostic",
      "",
      `Create a file named ${diagnosticFileName} containing exactly ${diagnosticText}.`,
      "Use the local repository tools. Then run git status and report what changed.",
    ].join("\n"),
    {
      cwd: diagnosticDir,
      timeoutMs: 120_000,
      sandbox: automation.CODEX_HANDOFF_OPTIONS.sandbox,
      approvalPolicy: automation.CODEX_HANDOFF_OPTIONS.approvalPolicy,
    },
  );
  const fileContents = await readFile(
    join(diagnosticDir, diagnosticFileName),
    "utf8",
  );
  const status = await execFileAsync("git", ["status", "--short"], {
    cwd: diagnosticDir,
  });

  if (fileContents.trim() !== diagnosticText) {
    throw new Error(
      `Codex created ${diagnosticFileName}, but the contents were ${JSON.stringify(fileContents)}.`,
    );
  }

  console.log("[ok] Codex app-server executed a tool-capable local turn.");
  console.log(`[info] Thread: ${thread.id}`);
  console.log(`[info] Completed: ${result.completed.method}`);
  console.log(`[info] Events: ${[...eventMethods].join(", ")}`);
  console.log(`[info] Git status: ${status.stdout.trim() || "clean"}`);
  console.log(`[info] Final response: ${result.finalResponse.trim()}`);
} catch (error) {
  console.error("[error] Codex diagnostic failed.");
  console.error(error instanceof Error ? error.message : String(error));

  if (stderr.trim()) {
    console.error("[stderr]");
    console.error(stderr.trim().slice(0, 4000));
  }

  process.exitCode = 1;
} finally {
  codex.close();
  await rm(diagnosticDir, { recursive: true, force: true });
}
