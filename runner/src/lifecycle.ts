import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { dockerOutput, LABEL, LABELS, removeContainer } from "./docker.js";
import { log } from "./log.js";
import { OWNER_FILE, WORKSPACE_PREFIX } from "./workspace.js";

export interface Sandbox {
  id: string;
  container: string;
  step: string;
  state: string;
  pid: number | null;
  startedAt: string;
  task: string;
}

export async function listSandboxes(): Promise<Sandbox[]> {
  const labels = [LABELS.run, LABELS.step, LABELS.pid, LABELS.started, LABELS.task];
  const format = ["{{.Names}}", "{{.State}}", ...labels.map((l) => `{{.Label "${l}"}}`)].join("\t");
  const out = await dockerOutput(["ps", "-a", "--filter", `label=${LABEL}`, "--format", format]);
  return out.split("\n").filter(Boolean).map((line) => {
    const [container, state, id, step, pid, startedAt, task] = line.split("\t");
    return { id, container, step, state, pid: pid ? Number(pid) : null, startedAt, task };
  });
}

// A pid can be reused after its runner dies, in which case its leftovers survive
// until that pid is free again. Rare enough locally; a start-time check would close it.
export function isAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Asks the run's runner to stop so it can clean up and record the result itself, then
// removes anything still left (for example if that runner is already gone).
export async function killSandbox(id: string): Promise<boolean> {
  const runContainers = async () => (await listSandboxes()).filter((s) => s.id === id);
  const found = await runContainers();
  if (!found.length) return false;

  const pid = found[0].pid;
  if (pid && isAlive(pid)) {
    log("kill", `sending SIGTERM to runner pid ${pid} for run ${id}`);
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 20 && (await runContainers()).length; i++) await sleep(500);
  }
  for (const s of await runContainers()) {
    const removed = await removeContainer(s.container);
    log("kill", removed ? `removed ${s.container}` : `could not remove ${s.container}`);
  }
  return true;
}

// Removes containers and workspaces whose runner process no longer exists, e.g. after
// it was killed with SIGKILL or the machine lost power. Runs at the start of every command.
export async function sweepOrphans(): Promise<void> {
  for (const s of await listSandboxes()) {
    if (isAlive(s.pid)) continue;
    if (!(await removeContainer(s.container))) {
      log("cleanup", `could not remove ${s.container}; docker did not respond`);
      continue;
    }
    log("cleanup", `removed ${s.container} from run ${s.id || "unknown"}: its runner (pid ${s.pid ?? "unknown"}) is gone`);
  }

  for (const entry of await readdir(tmpdir())) {
    if (!entry.startsWith(WORKSPACE_PREFIX)) continue;
    const root = join(tmpdir(), entry);
    // No owner file means the workspace is still being created; leave it alone.
    const pid = Number(await readFile(join(root, OWNER_FILE), "utf8").catch(() => ""));
    if (!pid || isAlive(pid)) continue;
    await rm(root, { recursive: true, force: true });
    log("cleanup", `removed workspace ${root}: its runner (pid ${pid}) is gone`);
  }
}
