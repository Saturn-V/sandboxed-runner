// Integration tests: need Docker and the sandboxed-runner/test-agent image.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OWNER_LABEL } from "../dist/docker.js";
import { run } from "../dist/run.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/dummy-repo");

const runnerContainers = () =>
  execFileSync("docker", ["ps", "-aq", "--filter", `label=${OWNER_LABEL}`], { encoding: "utf8" }).trim();

async function runTask(t, testCmd, timeoutSec) {
  const out = await mkdtemp(join(tmpdir(), "runner-test-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const code = await run({ repo, task: "fix the tests", testCmd, out, timeoutSec });
  const results = JSON.parse(await readFile(join(out, "results.json"), "utf8"));
  return { code, results };
}

test("a runaway command is stopped at its time limit and torn down", async (t) => {
  const { code, results } = await runTask(t, "while true; do :; done", 5);

  assert.equal(code, 3);
  assert.equal(results.status, "timed_out");
  assert.equal(results.timedOut, true);
  assert.equal(results.exitCode, null);
  assert.ok(
    results.durationMs >= 5000 && results.durationMs < 8000,
    `expected about 5s, took ${results.durationMs}ms`,
  );
  assert.equal(runnerContainers(), "", "a runner container was left behind");
});

test("a command that finishes within its limit is not marked timed out", async (t) => {
  const { code, results } = await runTask(t, "npm test", 30);

  assert.equal(code, 0);
  assert.equal(results.status, "passed");
  assert.equal(results.timedOut, false);
  assert.equal(results.exitCode, 0);
});
