import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const DEFAULT_ENV_FILE_PATH = resolve(".env");

export async function loadDotEnv(
  envFilePath = DEFAULT_ENV_FILE_PATH,
): Promise<Record<string, string>> {
  const values = await readDotEnv(envFilePath);

  for (const [key, value] of Object.entries(values)) {
    process.env[key] ??= value;
  }

  return values;
}

export async function saveDotEnvValue(
  key: string,
  value: string,
  envFilePath = DEFAULT_ENV_FILE_PATH,
): Promise<void> {
  const current = await readRawEnvFile(envFilePath);
  const lines = current ? current.split(/\r?\n/) : [];
  const keyPattern = new RegExp(`^${escapeRegExp(key)}=`);
  const nextLine = `${key}=${quoteEnvValue(value)}`;
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (keyPattern.test(line)) {
      replaced = true;
      return nextLine;
    }

    return line;
  });

  if (!replaced) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") {
      nextLines.push("");
    }

    nextLines.push(nextLine);
  }

  await writeFile(envFilePath, `${nextLines.join("\n").replace(/\n+$/, "")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(envFilePath, 0o600);
  process.env[key] = value;
}

async function readDotEnv(
  envFilePath: string,
): Promise<Record<string, string>> {
  const raw = await readRawEnvFile(envFilePath);
  const values: Record<string, string> = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    values[key] = unquoteEnvValue(value);
  }

  return values;
}

async function readRawEnvFile(envFilePath: string): Promise<string> {
  try {
    return await readFile(envFilePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

function quoteEnvValue(value: string): string {
  return JSON.stringify(value);
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }

  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
