import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const SKIP = new Set(["node_modules", ".git"]);

export interface Workspace {
  root: string;
  dir: string;
  baseline: string;
}

// Copies the source repo into a fresh temp dir and commits a baseline so we can diff
// the agent's changes later. Runs before any untrusted code, so host git is safe here.
export async function prepareWorkspace(repo: string): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), "sandboxed-runner-"));
  const dir = join(root, "workspace");

  try {
    await cp(repo, dir, { recursive: true, filter: (src) => !SKIP.has(basename(src)) });

    const git = (...args: string[]) =>
      exec("git", ["-c", "user.name=runner", "-c", "user.email=runner@local", ...args], { cwd: dir });
    await git("init", "-q");
    await git("add", "-A");
    await git("commit", "-q", "--allow-empty", "-m", "baseline");
    const { stdout } = await git("rev-parse", "HEAD");

    // Containers run as uid 1000, which may not match the host user on Linux.
    await exec("chmod", ["-R", "a+rwX", dir]);

    return { root, dir, baseline: stdout.trim() };
  } catch (err) {
    await rm(root, { recursive: true, force: true });
    throw err;
  }
}
