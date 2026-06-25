import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";

export async function resolveFolderRoot(folderPath: string): Promise<string> {
  const rootPath = resolve(folderPath);

  await access(rootPath);

  const stats = await stat(rootPath);

  if (!stats.isDirectory()) {
    throw new Error(`Expected a folder path for Codex cwd: ${rootPath}`);
  }

  return rootPath;
}
