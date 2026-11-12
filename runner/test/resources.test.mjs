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

async function runTask(t, testCmd, limits) {
  const out = await mkdtemp(join(tmpdir(), "runner-test-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const code = await run({ repo, task: "fix the tests", testCmd, out, timeoutSec: 60, ...limits });
  const results = JSON.parse(await readFile(join(out, "results.json"), "utf8"));
  return { code, results };
}

// Off-heap Buffers, so the cgroup OOM killer fires rather than V8's own heap limit.
const MEMORY_HOG = `node -e "const a = []; for (;;) a.push(Buffer.alloc(16 << 20, 1))"`;

test("a command over its memory limit is reported as out_of_memory", async (t) => {
  const { code, results } = await runTask(t, MEMORY_HOG, { memory: "128m", cpus: 1 });

  assert.equal(code, 4);
  assert.equal(results.status, "out_of_memory");
  assert.equal(results.message, "test command exceeded its 128m memory limit and was killed");
  assert.equal(results.passed, false);
  assert.equal(results.timedOut, false);
  assert.equal(results.memory, "128m");
  assert.equal(results.cpus, 1);
  assert.doesNotMatch(results.stderr, /heap out of memory/, "V8 gave up before the cgroup limit");
  assert.equal(runnerContainers(), "", "a runner container was left behind");
});

test("the runner keeps working after a task runs out of memory", async (t) => {
  const { code, results } = await runTask(t, "npm test");

  assert.equal(code, 0);
  assert.equal(results.status, "passed");
  assert.equal(results.message, null);
  assert.equal(results.memory, "2g");
  assert.equal(results.cpus, 2);
});
