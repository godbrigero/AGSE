import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  parseLastScanRoots,
  resolveScanRootAnswer,
  serializeScanRoots,
} from "../src/scanRoots.ts";

test("resolveScanRootAnswer defaults to current root when no history exists", () => {
  assert.deepEqual(resolveScanRootAnswer("", "/tmp/current"), [
    resolve("/tmp/current"),
  ]);
});

test("resolveScanRootAnswer uses last scan roots when answer is blank", () => {
  assert.deepEqual(resolveScanRootAnswer("   ", "/tmp/current", ["/tmp/last"]), [
    resolve("/tmp/last"),
  ]);
});

test("resolveScanRootAnswer supports an explicit last-search shortcut", () => {
  assert.deepEqual(resolveScanRootAnswer("last", "/tmp/current", ["/tmp/last"]), [
    resolve("/tmp/last"),
  ]);
  assert.deepEqual(resolveScanRootAnswer("L", "/tmp/current", ["/tmp/last"]), [
    resolve("/tmp/last"),
  ]);
});

test("resolveScanRootAnswer accepts comma-separated replacement roots", () => {
  assert.deepEqual(
    resolveScanRootAnswer("/tmp/a, /tmp/b", "/tmp/current", ["/tmp/last"]),
    [resolve("/tmp/a"), resolve("/tmp/b")],
  );
});

test("parseLastScanRoots reads the persisted JSON value", () => {
  const raw = serializeScanRoots(["/tmp/a", "/tmp/b", "/tmp/a"]);

  assert.deepEqual(parseLastScanRoots(raw), [resolve("/tmp/a"), resolve("/tmp/b")]);
});

test("parseLastScanRoots tolerates the legacy comma-separated form", () => {
  assert.deepEqual(parseLastScanRoots("/tmp/a, /tmp/b"), [
    resolve("/tmp/a"),
    resolve("/tmp/b"),
  ]);
});

test("parseLastScanRoots ignores malformed persisted values", () => {
  assert.deepEqual(parseLastScanRoots('{"root":"/tmp/a"}'), []);
  assert.deepEqual(parseLastScanRoots(""), []);
});
