#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { basename, resolve } from "node:path";
import { Writable } from "node:stream";
import { AGSCWorkspace } from "./agscWorkspace.ts";
import { GitHubIssuePoller } from "./githubIssuePolling.ts";
import { loadDotEnv, saveDotEnvValue } from "./envCache.ts";
import { errorMessage, info, style, success, warning } from "./terminalStyle.ts";
import {
  findRootFoldersWithFileProgress,
  type FindRootFoldersProgress,
} from "./utils/findRootFoldersWithFile.ts";

const DEFAULT_SCAN_ROOT = process.cwd();

async function main(): Promise<void> {
  await loadDotEnv();
  await ensureGitHubToken();

  const scanRoots = await promptForScanRoots();

  console.log(
    info(`Scanning ${scanRoots.length} folder path(s) for AGSC projects...`),
  );

  const projectRootPaths = await findRootFoldersWithFileProgress(scanRoots, {
    onProgress: renderScanProgress,
  });
  finishScanProgress();

  const workspace = await AGSCWorkspace.fromRootPaths(projectRootPaths);

  if (workspace.size === 0) {
    console.log(warning("No AGSC projects found."));
    return;
  }

  console.log(success(`Found ${workspace.size} AGSC project(s):`));

  for (const project of workspace.projects) {
    console.log(`- ${style.bold(project.name)}: ${style.dim(project.rootPath)}`);
  }

  const poller = await GitHubIssuePoller.fromWorkspace(workspace);

  if (poller.projectCount === 0) {
    console.log(warning("No GitHub-backed projects found to poll."));
    return;
  }

  console.log(
    info(
      `Polling GitHub issues for ${poller.projectCount} project(s) every 20 seconds. Press Ctrl+C to stop.`,
    ),
  );

  poller.start();

  process.once("SIGINT", () => {
    poller.stop();
    console.log(`\n${warning("Stopped GitHub issue polling.")}`);
    process.exit(0);
  });
}

async function ensureGitHubToken(): Promise<void> {
  if (process.env.GITHUB_TOKEN) {
    console.log(success("Loaded GitHub token."));
    return;
  }

  console.log(
    warning(
      "GITHUB_TOKEN is not set. AGSE needs it to create branches, open PRs, and identify the local GitHub user.",
    ),
  );
  console.log(
    info(
      "Create a fine-grained token with Issues read, Pull requests read/write, and Contents read/write.",
    ),
  );

  const token = await promptForSecret(
    "Paste GitHub token to save in .env (leave blank to continue without saving): ",
  );

  if (!token) {
    console.log(warning("Continuing without GITHUB_TOKEN."));
    return;
  }

  await saveDotEnvValue("GITHUB_TOKEN", token);
  console.log(success("Saved GitHub token to .env."));
}

function renderScanProgress(progress: FindRootFoldersProgress): void {
  const width = 28;
  const completed = Math.min(progress.currentIndex, progress.total);
  const ratio = progress.total === 0 ? 1 : completed / progress.total;
  const filled = Math.round(ratio * width);
  const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
  const percent = Math.round(ratio * 100).toString().padStart(3, " ");
  const folderName =
    basename(progress.currentFolderPath) || progress.currentFolderPath;
  const label = truncateMiddle(folderName, 38);
  const line = `${style.cyan(`[${bar}]`)} ${percent}% ${completed}/${progress.total} | ${label} | found ${progress.matchedCount}`;

  if (output.isTTY) {
    output.clearLine(0);
    output.cursorTo(0);
    output.write(line);
    return;
  }

  console.log(line);
}

function finishScanProgress(): void {
  if (!output.isTTY) {
    return;
  }

  output.write("\n");
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const edgeLength = Math.floor((maxLength - 3) / 2);

  return `${value.slice(0, edgeLength)}...${value.slice(-edgeLength)}`;
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

async function promptForSecret(prompt: string): Promise<string> {
  if (!output.isTTY) {
    const terminal = createInterface({ input, output });

    try {
      return (await terminal.question(prompt)).trim();
    } finally {
      terminal.close();
    }
  }

  const mutableOutput = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();

      if (text.includes(prompt)) {
        output.write(text);
      }

      callback();
    },
  });
  const terminal = createInterface({ input, output: mutableOutput });

  try {
    const answer = await terminal.question(prompt);
    output.write("\n");
    return answer.trim();
  } finally {
    terminal.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);

  console.error(errorMessage(`Fatal: ${message}`));
  process.exitCode = 1;
});
