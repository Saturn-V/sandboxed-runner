// Integration test: needs Docker and the sandboxed-runner/test-agent image.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "../dist/cli.js");
const repo = join(here, "../../fixtures/dummy-repo");

const runner = (...args) => execFileSync("node", [cli, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const ps = () => JSON.parse(runner("ps", "--json"));
const containersOf = (id) =>
  execFileSync("docker", ["ps", "-aq", "--filter", `label=sandboxed-runner.run=${id}`], { encoding: "utf8" }).trim();

async function workspacesOwnedBy(pid) {
  const found = [];
  for (const entry of await readdir(tmpdir())) {
    if (!entry.startsWith("sandboxed-runner-")) continue;
    const owner = await readFile(join(tmpdir(), entry, "owner.pid"), "utf8").catch(() => "");
    if (Number(owner) === pid) found.push(entry);
  }
  return found;
}

// Starts a run whose test step sleeps, and resolves once that test container is running.
async function startRun(t) {
  const out = await mkdtemp(join(tmpdir(), "runner-test-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const child = spawn("node", [cli, "run", "--repo", repo, "--task", "lifecycle test", "--test-cmd", "sleep 60", "--out", out]);
  t.after(() => child.kill("SIGKILL"));
  child.stdout.resume();

  const lines = createInterface({ input: child.stderr });
  let id;
  for await (const line of lines) {
    id ??= line.match(/\[run\] id: (\w+)/)?.[1];
    if (/\[test\] starting /.test(line)) break;
  }
  lines.close();
  child.stderr.resume();
  return { id, child, out };
}

test("runs can be listed, killed, and recovered after the runner crashes", async (t) => {
  const a = await startRun(t);
  const b = await startRun(t);

  // List: both runs show up, in their test step, owned by their runner processes.
  const listed = ps().filter((s) => s.id === a.id || s.id === b.id);
  assert.deepEqual(listed.map((s) => [s.id, s.step, s.state, s.pid]).sort(), [
    [a.id, "test", "running", a.child.pid],
    [b.id, "test", "running", b.child.pid],
  ].sort());

  // Kill one by ID: its runner stops cleanly and records the run as killed.
  assert.match(runner("kill", a.id), new RegExp(`killed ${a.id}`));
  const [code] = await once(a.child, "close");
  assert.equal(code, 143);
  const results = JSON.parse(await readFile(join(a.out, "results.json"), "utf8"));
  assert.equal(results.status, "killed");
  assert.equal(containersOf(a.id), "");
  assert.deepEqual(await workspacesOwnedBy(a.child.pid), []);
  assert.ok(!ps().some((s) => s.id === a.id), "killed run still listed");

  // Crash the other runner: its sandbox and workspace are left behind...
  b.child.kill("SIGKILL");
  await once(b.child, "close");
  assert.notEqual(containersOf(b.id), "", "expected the crashed run's container to be left running");
  assert.equal((await workspacesOwnedBy(b.child.pid)).length, 1);

  // ...until the runner starts again, which finds and removes them.
  assert.ok(!ps().some((s) => s.id === b.id), "crashed run still listed after restart");
  assert.equal(containersOf(b.id), "");
  assert.deepEqual(await workspacesOwnedBy(b.child.pid), []);
});

test("killing an unknown ID fails clearly", () => {
  assert.throws(() => runner("kill", "nope1234"), (err) => {
    assert.equal(err.status, 1);
    assert.match(err.stderr, /no sandbox with id nope1234/);
    return true;
  });
});
