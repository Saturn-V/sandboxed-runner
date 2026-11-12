// Integration test: needs Docker and the sandboxed-runner/test-agent image.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../dist/cli.js");
const repo = join(here, "../../fixtures/dummy-repo");

// Records each line with the time it arrived, per stream, as the CLI produces it.
function collect(stream) {
  const lines = [];
  createInterface({ input: stream }).on("line", (text) => lines.push({ text, at: Date.now() }));
  return lines;
}

test("task output is streamed live, each line labeled with its stream", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "runner-test-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const testCmd = 'for i in 1 2 3 4; do echo "out $i"; echo "err $i" >&2; sleep 1; done; printf "end ✓"';

  const child = spawn("node", [cli, "run", "--repo", repo, "--task", "fix the tests", "--test-cmd", testCmd, "--out", out]);
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const [code] = await once(child, "close");
  assert.equal(code, 0);

  // Task stdout only on our stdout, task stderr only on our stderr, each labeled.
  const find = (lines, label) => lines.filter((l) => l.text.includes(`[test ${label}]`));
  assert.deepEqual(find(stdout, "stdout").map((l) => l.text.split("] ")[1]), ["out 1", "out 2", "out 3", "out 4", "end ✓"]);
  assert.deepEqual(find(stderr, "stderr").map((l) => l.text.split("] ")[1]), ["err 1", "err 2", "err 3", "err 4"]);
  assert.deepEqual(find(stdout, "stderr"), [], "task stderr leaked onto stdout");
  assert.deepEqual(find(stderr, "stdout"), [], "task stdout leaked onto stderr");
  assert.ok(stdout.every((l) => / \[\w+ stdout\] /.test(l.text)), "stdout carries only labeled task output");

  // Lines arrived as they were printed, not all at once when the task ended.
  const [first, , , last] = find(stdout, "stdout");
  assert.ok(last.at - first.at >= 2500, `out 1 to out 4 took only ${last.at - first.at}ms`);

  // The run ends with the exit code and total run time.
  assert.match(stderr.at(-1).text, /\[run\] finished in \d+\.\ds: test passed, exit code 0$/);

  // The full output is still captured.
  const results = JSON.parse(await readFile(join(out, "results.json"), "utf8"));
  assert.equal(results.stdout, "out 1\nout 2\nout 3\nout 4\nend ✓");
  assert.equal(results.stderr, "err 1\nerr 2\nerr 3\nerr 4\n");
});
