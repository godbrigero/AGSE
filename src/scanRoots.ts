import { resolve } from "node:path";

export const LAST_SCAN_ROOTS_ENV = "AGSE_LAST_SCAN_ROOTS";

export function parseLastScanRoots(
  rawValue = process.env[LAST_SCAN_ROOTS_ENV],
): string[] {
  if (!rawValue) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(rawValue);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return normalizeScanRoots(parsed.filter(isNonEmptyString));
  } catch {
    return normalizeScanRoots(
      rawValue
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
  }
}

export function serializeScanRoots(scanRoots: readonly string[]): string {
  return JSON.stringify(normalizeScanRoots(scanRoots));
}

export function resolveScanRootAnswer(
  answer: string,
  defaultScanRoot: string,
  lastScanRoots: readonly string[] = [],
): string[] {
  const trimmedAnswer = answer.trim();

  if (!trimmedAnswer) {
    return normalizeScanRoots(
      lastScanRoots.length > 0 ? lastScanRoots : [defaultScanRoot],
    );
  }

  if (lastScanRoots.length > 0 && isLastSearchShortcut(trimmedAnswer)) {
    return normalizeScanRoots(lastScanRoots);
  }

  const rawPaths = trimmedAnswer
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return normalizeScanRoots(rawPaths.length > 0 ? rawPaths : [defaultScanRoot]);
}

export function formatScanRoots(scanRoots: readonly string[]): string {
  return scanRoots.join(", ");
}

function normalizeScanRoots(scanRoots: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const scanRoot of scanRoots) {
    const resolved = resolve(scanRoot);

    if (seen.has(resolved)) {
      continue;
    }

    seen.add(resolved);
    normalized.push(resolved);
  }

  return normalized;
}

function isLastSearchShortcut(value: string): boolean {
  return ["last", "l"].includes(value.toLowerCase());
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
