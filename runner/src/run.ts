import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dockerRun } from "./docker.js";
import { prepareWorkspace } from "./workspace.js";

export interface RunOptions {
  repo: string;
  task: string;
  testCmd: string;
  out: string;
}

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

// Returns the CLI exit code: 0 if tests passed, 1 if they failed.
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

  await mkdir(opts.out, { recursive: true });
  const ws = await prepareWorkspace(opts.repo);

  try {
    const a = await dockerRun({
      image: agent.image,
      network: agent.network,
      env: [...agent.env, "TASK"],
      extraEnv: { TASK: opts.task },
      workspace: ws.dir,
      timeoutMs: 10 * 60_000,
    });
    await writeFile(join(opts.out, "agent.log"), a.stdout + a.stderr);

    const d = await dockerRun({
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

    const t = await dockerRun({
      image: "node:22-slim",
      network: "none",
      workspace: ws.dir,
      cmd: ["sh", "-c", opts.testCmd],
      timeoutMs: 5 * 60_000,
    });

    const passed = t.exitCode === 0 && !t.timedOut;
    const results = {
      command: opts.testCmd,
      exitCode: t.exitCode,
      passed,
      timedOut: t.timedOut,
      durationMs: t.durationMs,
      stdout: t.stdout,
      stderr: t.stderr,
    };
    await writeFile(join(opts.out, "results.json"), JSON.stringify(results, null, 2) + "\n");

    return passed ? 0 : 1;
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
}
