import { readdir } from "node:fs/promises";
import { resolve, join } from "node:path";

export const ROOT_MARKER_FILE_NAME = "agse.config.ts";

export type FolderPathInput = string | readonly string[];

export async function findRootFoldersWithFile(
  folderPaths: FolderPathInput,
): Promise<string[]> {
  const searchRoots = Array.isArray(folderPaths) ? folderPaths : [folderPaths];
  const matchedRoots = new Set<string>();

  await Promise.all(
    searchRoots.map((folderPath) =>
      collectMatchingRootFolders(resolve(folderPath), matchedRoots),
    ),
  );

  return [...matchedRoots].sort();
}

async function collectMatchingRootFolders(
  folderPath: string,
  matchedRoots: Set<string>,
): Promise<void> {
  let entries;

  try {
    entries = await readdir(folderPath, { withFileTypes: true });
  } catch {
    return;
  }

  if (entries.some((entry) => entry.name === ROOT_MARKER_FILE_NAME)) {
    matchedRoots.add(folderPath);
    return;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) =>
        collectMatchingRootFolders(join(folderPath, entry.name), matchedRoots),
      ),
  );
}
