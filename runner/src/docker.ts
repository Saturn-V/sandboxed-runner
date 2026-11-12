import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { log, seconds } from "./log.js";

const exec = promisify(execFile);

// Every runner container carries this label so leftovers can be found and removed.
export const LABEL = "sandboxed-runner";
// Also tags containers with the runner process that started them, so one process can check
// for its own leftovers while other runners (or parallel test files) share the host.
export const OWNER_LABEL = `${LABEL}.owner=${randomUUID()}`;
// Per-run metadata, read back by `runner ps`, `runner kill` and the orphan sweep.
export const LABELS = {
  run: `${LABEL}.run`,
  pid: `${LABEL}.pid`,
  step: `${LABEL}.step`,
  started: `${LABEL}.started`,
  task: `${LABEL}.task`,
};

export interface DockerRunOptions {
  step: string;
  name?: string;
  image: string;
  entrypoint?: string;
  cmd?: string[];
  network: "none" | "bridge";
  workspace: string;
  // Passed as `-e NAME` so values are read from the docker process env, never argv.
  env?: string[];
  extraEnv?: Record<string, string>;
  labels?: Record<string, string>;
  timeoutMs: number;
  // Docker size syntax, e.g. "512m". Swap is capped at the same value so the limit is real.
  memory?: string;
  cpus?: number;
  // Called with each complete line as the container produces it, for live output.
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
  // Aborting removes the container and rejects, so a stopped run starts nothing new.
  signal?: AbortSignal;
}

export interface DockerRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  oomKilled: boolean;
}

// Feeds complete lines to emit as they arrive, holding a partial line until its newline
// or the end of the stream.
function forwardLines(stream: Readable, emit: (line: string) => void): void {
  let partial = "";
  stream.on("data", (chunk: string) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop()!;
    for (const line of lines) emit(line.replace(/\r$/, ""));
  });
  stream.on("end", () => {
    if (partial) emit(partial.replace(/\r$/, ""));
  });
}

export function dockerRun(opts: DockerRunOptions): Promise<DockerRunResult> {
  const name = opts.name ?? `runner-${randomUUID().slice(0, 8)}`;
  if (opts.signal?.aborted) {
    return Promise.reject(new Error(`${opts.step} step not started: run was stopped`));
  }

  const memory = opts.memory ?? "2g";
  const labels = { [LABELS.step]: opts.step, ...opts.labels };
  const args = [
    // No --rm: the container must outlive its exit so we can ask docker whether it was
    // OOM-killed. It is force-removed in every path once `docker run` exits.
    "run", "--init", "--quiet",
    "--name", name,
    "--label", LABEL,
    "--label", OWNER_LABEL,
    ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
    "--user", "1000:1000",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--memory", memory,
    "--memory-swap", memory,
    "--cpus", String(opts.cpus ?? 2),
    "--pids-limit", "512",
    "--network", opts.network,
    "-v", `${opts.workspace}:/workspace`,
    "-w", "/workspace",
    ...(opts.env ?? []).flatMap((n) => ["-e", n]),
    ...(opts.entrypoint ? ["--entrypoint", opts.entrypoint] : []),
    opts.image,
    ...(opts.cmd ?? []),
  ];

  const env = opts.env?.length ? `, env: ${opts.env.join(" ")}` : "";
  const limits = `memory: ${memory}, cpus: ${opts.cpus ?? 2}`;
  log(opts.step, `starting ${name} (image: ${opts.image}, network: ${opts.network}, ${limits}${env})`);

  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      env: { ...process.env, ...opts.extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Decode as UTF-8 at the stream so a character split across chunks stays intact.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    const onLine = opts.onLine;
    if (onLine) {
      forwardLines(child.stdout, (line) => onLine("stdout", line));
      forwardLines(child.stderr, (line) => onLine("stderr", line));
    }

    // Force-remove the container, retrying until `docker run` exits. The retry covers
    // a container that was still being created (e.g. image pull) when we gave up on it.
    // Attempts run one at a time, and if docker stops responding we stop waiting on it
    // rather than hang the run forever.
    let closed = false;
    let reaper: NodeJS.Timeout | undefined;
    const forceRemove = () => {
      if (reaper) return;
      const attempt = async (n: number) => {
        await removeContainer(name);
        if (closed) return;
        if (n >= MAX_REMOVE_ATTEMPTS) {
          log(opts.step, `could not remove ${name}; docker is not responding and the container may still exist`);
          child.kill("SIGKILL");
          return;
        }
        reaper = setTimeout(() => attempt(n + 1), 2_000);
      };
      reaper = setTimeout(() => attempt(1), 0);
    };

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(opts.step, `time limit of ${seconds(opts.timeoutMs)} reached, force-removing ${name}`);
      forceRemove();
    }, opts.timeoutMs);

    let stopped = false;
    const onAbort = () => {
      stopped = true;
      log(opts.step, `run stopped, force-removing ${name}`);
      forceRemove();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const stopTimers = () => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(reaper);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (err) => {
      stopTimers();
      log(opts.step, `could not start docker: ${err.message}`);
      reject(new Error(`failed to spawn docker: ${err.message}`));
    });

    child.on("close", async (code) => {
      stopTimers();
      const durationMs = Date.now() - start;
      // Exit code 137 alone is ambiguous (our own timeout also SIGKILLs), so ask docker.
      // It reports OOM even when only a child process was killed and the command went on.
      const oomKilled = !timedOut && !stopped && (await inspectOomKilled(name));
      const removed = (await removeContainer(name)) ? "container removed" : "container may still exist";
      if (stopped) {
        log(opts.step, `${name} stopped after ${seconds(durationMs)}, ${removed}`);
        reject(new Error(`${opts.step} step stopped: run was stopped`));
        return;
      }
      // 125 means docker itself failed (bad image, daemon error), not the command inside.
      if (code === 125 && !timedOut) {
        log(opts.step, `docker could not run ${name}`);
        reject(new Error(`docker run failed: ${stderr.trim()}`));
        return;
      }
      const outcome = timedOut ? "timed out" : `exited with code ${code}`;
      const oom = oomKilled ? `, out of memory (limit ${memory})` : "";
      log(opts.step, `${name} ${outcome}${oom} after ${seconds(durationMs)}, ${removed}`);
      resolve({ exitCode: code, stdout, stderr, durationMs, timedOut, oomKilled });
    });
  });
}

// About a minute of retries, at up to 10s per attempt plus 2s between them.
const MAX_REMOVE_ATTEMPTS = 5;
// Helper commands talk to the daemon directly; if it's unresponsive they would block forever.
const HELPER_TIMEOUT_MS = 10_000;

// Runs a docker command and returns its stdout.
export async function dockerOutput(args: string[]): Promise<string> {
  const { stdout } = await exec("docker", args, { timeout: HELPER_TIMEOUT_MS });
  return stdout;
}

// Resolves false if the container is already gone (e.g. removed by the timeout).
async function inspectOomKilled(name: string): Promise<boolean> {
  const out = await dockerOutput(["inspect", "-f", "{{.State.OOMKilled}}", name]).catch(() => "");
  return out.trim() === "true";
}

// Resolves true once the container is gone, including when it never existed.
export async function removeContainer(name: string): Promise<boolean> {
  try {
    await dockerOutput(["rm", "-f", name]);
    return true;
  } catch (err) {
    return /No such container/.test(String((err as { stderr?: string }).stderr));
  }
}
