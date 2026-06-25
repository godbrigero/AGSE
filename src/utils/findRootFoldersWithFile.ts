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

export type FindRootFoldersProgress = {
  currentIndex: number;
  total: number;
  currentFolderPath: string;
  matchedCount: number;
};

export type FindRootFoldersWithFileProgressOptions = {
  onProgress?: (progress: FindRootFoldersProgress) => void;
};

export async function findRootFoldersWithFileProgress(
  folderPaths: FolderPathInput,
  options: FindRootFoldersWithFileProgressOptions = {},
): Promise<string[]> {
  const scanTargets = await collectTopLevelScanTargets(folderPaths);
  const matchedRoots = new Set<string>();

  for (const [index, folderPath] of scanTargets.entries()) {
    options.onProgress?.({
      currentIndex: index,
      total: scanTargets.length,
      currentFolderPath: folderPath,
      matchedCount: matchedRoots.size,
    });

    if (await folderHasRootMarker(folderPath)) {
      matchedRoots.add(folderPath);
    }

    options.onProgress?.({
      currentIndex: index + 1,
      total: scanTargets.length,
      currentFolderPath: folderPath,
      matchedCount: matchedRoots.size,
    });
  }

  return [...matchedRoots].sort();
}

async function collectTopLevelScanTargets(
  folderPaths: FolderPathInput,
): Promise<string[]> {
  const searchRoots = Array.isArray(folderPaths) ? folderPaths : [folderPaths];
  const scanTargets = new Set<string>();

  for (const folderPath of searchRoots) {
    const resolvedFolderPath = resolve(folderPath);
    scanTargets.add(resolvedFolderPath);

    let entries;

    try {
      entries = await readdir(resolvedFolderPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !isIgnoredTopLevelScanFolder(entry.name)
      ) {
        scanTargets.add(join(resolvedFolderPath, entry.name));
      }
    }
  }

  return [...scanTargets].sort();
}

async function folderHasRootMarker(folderPath: string): Promise<boolean> {
  try {
    const entries = await readdir(folderPath, { withFileTypes: true });

    return entries.some((entry) => entry.name === ROOT_MARKER_FILE_NAME);
  } catch {
    return false;
  }
}

function isIgnoredTopLevelScanFolder(folderName: string): boolean {
  return (
    folderName === ".git" ||
    folderName === ".agse" ||
    folderName === "node_modules"
  );
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
