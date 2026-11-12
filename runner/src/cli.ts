#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";
import { run } from "./run.js";

const program = new Command("runner");

program
  .command("run")
  .description("run an agent and a test command against a repo in Docker sandboxes")
  .requiredOption("--repo <dir>", "target repository directory")
  .requiredOption("--task <prompt>", "task prompt for the agent")
  .requiredOption("--test-cmd <cmd>", "test command, run with sh -c in the repo")
  .requiredOption("--out <dir>", "directory to write results into")
  .action(async (opts: { repo: string; task: string; testCmd: string; out: string }) => {
    try {
      process.exitCode = await run({
        repo: resolve(opts.repo),
        task: opts.task,
        testCmd: opts.testCmd,
        out: resolve(opts.out),
      });
    } catch (err) {
      console.error(`runner: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 2;
    }
  });

await program.parseAsync();
