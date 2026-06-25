#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import { AGSCWorkspace } from "./agscWorkspace.ts";
import { GitHubIssuePoller } from "./githubIssuePolling.ts";

const DEFAULT_SCAN_ROOT = process.cwd();

async function main(): Promise<void> {
  const scanRoots = await promptForScanRoots();

  console.log(`Scanning ${scanRoots.length} folder path(s) for AGSC projects...`);

  const workspace = await AGSCWorkspace.discover(scanRoots);

  if (workspace.size === 0) {
    console.log("No AGSC projects found.");
    return;
  }

  console.log(`Found ${workspace.size} AGSC project(s):`);

  for (const project of workspace.projects) {
    console.log(`- ${project.name}: ${project.rootPath}`);
  }

  const poller = await GitHubIssuePoller.fromWorkspace(workspace);

  if (poller.projectCount === 0) {
    console.log("No GitHub-backed projects found to poll.");
    return;
  }

  console.log(
    `Polling GitHub issues for ${poller.projectCount} project(s) every 20 seconds. Press Ctrl+C to stop.`,
  );

  poller.start();

  process.once("SIGINT", () => {
    poller.stop();
    console.log("\nStopped GitHub issue polling.");
    process.exit(0);
  });
}

async function promptForScanRoots(): Promise<string[]> {
  const terminal = createInterface({ input, output });

  try {
    const answer = await terminal.question(
      `Root folder path(s) to scan, comma-separated [${DEFAULT_SCAN_ROOT}]: `,
    );
    const rawPaths = answer
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

    return (rawPaths.length > 0 ? rawPaths : [DEFAULT_SCAN_ROOT]).map((entry) =>
      resolve(entry),
    );
  } finally {
    terminal.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);

  console.error(`Fatal: ${message}`);
  process.exitCode = 1;
});
