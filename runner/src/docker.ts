import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface DockerRunOptions {
  image: string;
  entrypoint?: string;
  cmd?: string[];
  network: "none" | "bridge";
  workspace: string;
  // Passed as `-e NAME` so values are read from the docker process env, never argv.
  env?: string[];
  extraEnv?: Record<string, string>;
  timeoutMs: number;
}

export interface DockerRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export function dockerRun(opts: DockerRunOptions): Promise<DockerRunResult> {
  const name = `runner-${randomUUID().slice(0, 8)}`;
  const args = [
    "run", "--rm", "--init", "--quiet",
    "--name", name,
    "--user", "1000:1000",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--memory", "2g",
    "--cpus", "2",
    "--pids-limit", "512",
    "--network", opts.network,
    "-v", `${opts.workspace}:/workspace`,
    "-w", "/workspace",
    ...(opts.env ?? []).flatMap((n) => ["-e", n]),
    ...(opts.entrypoint ? ["--entrypoint", opts.entrypoint] : []),
    opts.image,
    ...(opts.cmd ?? []),
  ];

  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      env: { ...process.env, ...opts.extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      spawn("docker", ["kill", name], { stdio: "ignore" });
    }, opts.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn docker: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      // 125 means docker itself failed (bad image, daemon error), not the command inside.
      if (code === 125 && !timedOut) {
        reject(new Error(`docker run failed: ${stderr.trim()}`));
        return;
      }
      resolve({ exitCode: code, stdout, stderr, durationMs: Date.now() - start, timedOut });
    });
  });
}
