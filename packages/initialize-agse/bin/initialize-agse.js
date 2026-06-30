#!/usr/bin/env node

import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const CONFIG_FILE_NAME = "agse.config.ts";

const CONFIG_TEMPLATE = `export interface AGSCConfigOptions {
  require_tag?: boolean;
  overwrite_tags?: Record<"codex" | "claude" | "default", string>;
  assignee_tags?: Record<string, "codex" | "claude" | "default">;
  restrict_user_to_local_only?: boolean;
}

const config: AGSCConfigOptions = {
  require_tag: true,
  overwrite_tags: {
    codex: "agse-codex",
    claude: "agse-claude",
    default: "agse",
  },
  assignee_tags: {
    godbrigero: "codex",
  },
  restrict_user_to_local_only: true,
};

export default config;
`;

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  if (args.length > 1) {
    console.error("Expected zero or one folder argument.");
    printUsage();
    process.exitCode = 1;
    return;
  }

  const targetFolderPath = resolve(process.cwd(), args[0] ?? ".");

  await ensureDirectory(targetFolderPath);

  const configPath = join(targetFolderPath, CONFIG_FILE_NAME);
  await writeFile(configPath, CONFIG_TEMPLATE, "utf8");

  console.log(`Wrote ${configPath}`);
}

async function ensureDirectory(folderPath) {
  try {
    const folderStats = await stat(folderPath);

    if (!folderStats.isDirectory()) {
      throw new Error(`Target exists and is not a directory: ${folderPath}`);
    }
  } catch (error) {
    if (error && error.code === "ENOENT") {
      await mkdir(folderPath, { recursive: true });
      return;
    }

    throw error;
  }
}

function printUsage() {
  console.log(`Usage: initialize-agse [folder]

Creates or replaces an agse.config.ts file in the target folder.

Arguments:
  folder  Target folder. Defaults to the current working directory.`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`initialize-agse: ${message}`);
  process.exitCode = 1;
});
