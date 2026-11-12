import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dockerRun, LABELS } from "./docker.js";
import { log, relay, seconds } from "./log.js";
import { prepareWorkspace } from "./workspace.js";

export interface RunOptions {
  repo: string;
  task: string;
  testCmd: string;
  out: string;
  timeoutSec: number;
  memory?: string;
  cpus?: number;
}

export const DEFAULT_TIMEOUT_SEC = 300;
export const DEFAULT_MEMORY = "2g";
export const DEFAULT_CPUS = 2;

interface Agent {
  image: string;
  network: "none" | "bridge";
  env: string[];
}

const AGENTS: Record<string, Agent> = {
  test: { image: "sandboxed-runner/test-agent", network: "none", env: [] },
  // Either auth var works; docker skips any that are unset on the host.
  claude: {
    image: "sandboxed-runner/claude-agent",
    network: "bridge",
    env: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  },
};

// The agent may have written to .git/, so neutralize config that could execute code.
const GIT = "git -c core.hooksPath=/dev/null -c core.fsmonitor= -c safe.directory=/workspace";

// Returns the CLI exit code: 0 if tests passed, 1 if they failed, 3 if they timed out,
// 4 if they ran out of memory, 130/143 if the run was stopped by SIGINT/SIGTERM.
export async function run(opts: RunOptions): Promise<number> {
  const repoStat = await stat(opts.repo).catch(() => null);
  if (!repoStat?.isDirectory()) {
    throw new Error(`repo not found: ${opts.repo}`);
  }

  const agentName = process.env.RUNNER_AGENT ?? "test";
  const agent = AGENTS[agentName];
  if (!agent) {
    throw new Error(`unknown RUNNER_AGENT "${agentName}" (expected: ${Object.keys(AGENTS).join(", ")})`);
  }

  const memory = opts.memory ?? DEFAULT_MEMORY;
  const cpus = opts.cpus ?? DEFAULT_CPUS;
  const runStart = Date.now();
  const runId = randomUUID().slice(0, 8);
  const labels = {
    [LABELS.run]: runId,
    [LABELS.pid]: String(process.pid),
    [LABELS.started]: new Date(runStart).toISOString(),
    [LABELS.task]: opts.task.replace(/\s+/g, " ").slice(0, 100),
  };
  log("run", `id: ${runId} (runner pid ${process.pid})`);
  log("run", `repo: ${opts.repo}`);
  log("run", `agent: ${agentName}, test command: ${opts.testCmd}, timeout: ${opts.timeoutSec}s`);
  log("run", `test limits: memory ${memory}, cpus ${cpus}`);
  log("run", `output: ${opts.out}`);

  await mkdir(opts.out, { recursive: true });
  const ws = await prepareWorkspace(opts.repo);
  log("workspace", `copied repo to ${ws.dir}, baseline ${ws.baseline.slice(0, 7)}`);

  let summary = "";

  // `runner kill` sends SIGTERM and Ctrl-C sends SIGINT. Either way, stop the current
  // container and clean up here instead of dying and leaving the sandbox behind.
  const controller = new AbortController();
  let stopSignal: NodeJS.Signals | undefined;
  const onSignal = (sig: NodeJS.Signals) => {
    log("run", `received ${sig}, stopping run ${runId}`);
    stopSignal = sig;
    controller.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const sandbox = { labels, signal: controller.signal };

  try {
    const a = await dockerRun({
      step: "agent",
      name: `runner-${runId}-agent`,
      ...sandbox,
      image: agent.image,
      network: agent.network,
      env: [...agent.env, "TASK"],
      extraEnv: { TASK: opts.task },
      workspace: ws.dir,
      timeoutMs: 10 * 60_000,
      onLine: (stream, line) => relay("agent", stream, line),
    });
    await writeFile(join(opts.out, "agent.log"), a.stdout + a.stderr);
    if (a.timedOut || a.exitCode !== 0) {
      log("agent", "agent did not finish cleanly; running tests on whatever it left");
    }

    const d = await dockerRun({
      step: "diff",
      name: `runner-${runId}-diff`,
      ...sandbox,
      image: "alpine/git",
      entrypoint: "sh",
      network: "none",
      workspace: ws.dir,
      cmd: ["-c", `${GIT} add -A && ${GIT} diff --cached --binary ${ws.baseline}`],
      timeoutMs: 60_000,
    });
    if (d.exitCode !== 0) {
      throw new Error(`git diff failed: ${d.stderr.trim()}`);
    }
    await writeFile(join(opts.out, "diff.patch"), d.stdout);
    const changed = [...d.stdout.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);
    log("diff", changed.length ? `${changed.length} file(s) changed: ${changed.join(", ")}` : "no changes");

    const t = await dockerRun({
      step: "test",
      name: `runner-${runId}-test`,
      ...sandbox,
      image: "node:22-slim",
      network: "none",
      workspace: ws.dir,
      cmd: ["sh", "-c", opts.testCmd],
      timeoutMs: opts.timeoutSec * 1000,
      memory,
      cpus,
      onLine: (stream, line) => relay("test", stream, line),
    });

    // Timeout wins over OOM. OOM wins over the exit code: a command can survive a killed
    // child and still exit 0, but its result can't be trusted.
    const status = t.timedOut ? "timed_out"
      : t.oomKilled ? "out_of_memory"
      : t.exitCode === 0 ? "passed" : "failed";
    const message = status === "out_of_memory"
      ? `test command exceeded its ${memory} memory limit and was killed`
      : null;
    const results = {
      status,
      message,
      command: opts.testCmd,
      // A killed command has no exit code of its own.
      exitCode: t.timedOut ? null : t.exitCode,
      passed: status === "passed",
      timedOut: t.timedOut,
      timeoutSec: opts.timeoutSec,
      memory,
      cpus,
      durationMs: t.durationMs,
      stdout: t.stdout,
      stderr: t.stderr,
    };
    await writeFile(join(opts.out, "results.json"), JSON.stringify(results, null, 2) + "\n");
    log("test", `status: ${status}${message ? ` (${message})` : ""}`);
    log("run", `wrote agent.log, diff.patch, results.json to ${opts.out}`);
    summary = `test ${status}, exit code ${results.exitCode ?? "none (killed)"}`;

    return { passed: 0, failed: 1, timed_out: 3, out_of_memory: 4 }[status];
  } catch (err) {
    if (!stopSignal) throw err;
    const message = `run ${runId} was stopped by ${stopSignal}`;
    const results = { status: "killed", message, command: opts.testCmd, exitCode: null, passed: false };
    await writeFile(join(opts.out, "results.json"), JSON.stringify(results, null, 2) + "\n");
    log("run", `${message}; wrote results.json to ${opts.out}`);
    summary = "killed";
    return stopSignal === "SIGINT" ? 130 : 143;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await rm(ws.root, { recursive: true, force: true });
    log("workspace", `removed ${ws.root}`);
    // Last line of every run, so the outcome is where the caller looks for it.
    log("run", `finished in ${seconds(Date.now() - runStart)}${summary ? `: ${summary}` : ""}`);
  }
}
