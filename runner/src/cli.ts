#!/usr/bin/env node
import { resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { killSandbox, listSandboxes, sweepOrphans, type Sandbox } from "./lifecycle.js";
import { DEFAULT_CPUS, DEFAULT_MEMORY, DEFAULT_TIMEOUT_SEC, run } from "./run.js";

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError("must be a positive whole number of seconds");
  }
  return n;
}

function positiveNumber(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError("must be a positive number, e.g. 2 or 0.5");
  }
  return n;
}

const UNITS: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

// Docker rejects limits under 6m with an obscure error, so check that here too.
function memorySize(value: string): string {
  const m = /^(\d+)([kmg])$/i.exec(value);
  if (!m || Number(m[1]) * UNITS[m[2].toLowerCase()] < 6 * UNITS.m) {
    throw new InvalidArgumentError("must be a size of at least 6m, like 512m or 2g");
  }
  return value.toLowerCase();
}

function age(startedAt: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function printTable(sandboxes: Sandbox[]): void {
  const rows = [["ID", "STEP", "STATUS", "AGE", "RUNNER PID", "TASK"]];
  for (const s of sandboxes) {
    rows.push([s.id, s.step, s.state, s.startedAt ? age(s.startedAt) : "?", String(s.pid ?? "?"), s.task]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd());
}

async function main(action: () => Promise<number | void>): Promise<void> {
  try {
    process.exitCode = (await action()) ?? 0;
  } catch (err) {
    console.error(`runner: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 2;
  }
}

const program = new Command("runner");

// Every command first clears out sandboxes left behind by runners that crashed.
program.hook("preAction", () => main(sweepOrphans));

program
  .command("run")
  .description("run an agent and a test command against a repo in Docker sandboxes")
  .requiredOption("--repo <dir>", "target repository directory")
  .requiredOption("--task <prompt>", "task prompt for the agent")
  .requiredOption("--test-cmd <cmd>", "test command, run with sh -c in the repo")
  .requiredOption("--out <dir>", "directory to write results into")
  .option("--timeout <seconds>", "time limit for the test command", positiveInt, DEFAULT_TIMEOUT_SEC)
  .option(
    "--memory <size>",
    "memory limit for the test command, swap included: a whole number with k, m or g, at least 6m (e.g. 512m, 2g)",
    memorySize,
    DEFAULT_MEMORY,
  )
  .option("--cpus <n>", "CPU limit for the test command", positiveNumber, DEFAULT_CPUS)
  .action(async (opts: {
    repo: string; task: string; testCmd: string; out: string; timeout: number; memory: string; cpus: number;
  }) => {
    await main(() => run({
        repo: resolve(opts.repo),
        task: opts.task,
        testCmd: opts.testCmd,
        out: resolve(opts.out),
        timeoutSec: opts.timeout,
        memory: opts.memory,
        cpus: opts.cpus,
      }));
  });

program
  .command("ps")
  .description("list sandboxes the runner has running")
  .option("--json", "print as JSON")
  .action(async (opts: { json?: boolean }) => {
    await main(async () => {
      const sandboxes = await listSandboxes();
      if (opts.json) console.log(JSON.stringify(sandboxes, null, 2));
      else if (sandboxes.length) printTable(sandboxes);
      else console.log("no sandboxes running");
    });
  });

program
  .command("kill")
  .description("stop a run and remove its sandbox")
  .argument("<id>", "run ID, as shown by runner ps")
  .action(async (id: string) => {
    await main(async () => {
      if (!(await killSandbox(id))) {
        console.error(`runner: no sandbox with id ${id} (see runner ps)`);
        return 1;
      }
      console.log(`killed ${id}`);
    });
  });

await program.parseAsync();
