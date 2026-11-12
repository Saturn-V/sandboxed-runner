# Sandboxed Runner

A TypeScript CLI that runs a coding agent and a test command against a repository inside isolated Docker containers. It copies the repo into a disposable workspace, lets the agent edit that copy, captures the agent's changes as a diff, then runs the tests with the network off.

```
runner run --repo <dir> --task "<prompt>" --test-cmd "<cmd>" --out <dir>
```

Each run writes three files to `--out`:

| File | Contents |
|---|---|
| `agent.log` | The agent's combined output |
| `diff.patch` | What the agent changed, as a git diff (new files included) |
| `results.json` | The test result: status, exit code, duration, limits, full stdout and stderr |

The original design doc is [`plan.md`](plan.md). Features added since (time limits, resource limits, live output, lifecycle) are described below.

## Requirements

- Node.js 22 or later
- Docker, running (developed on Docker Desktop for macOS)

## Quick start

```sh
npm install
npm run images      # runs images:pull, then images:build
npm run build
npm test            # integration tests; needs Docker and the images above
```

| Script | Does |
|---|---|
| `images:pull` | Pulls the base images the runner uses: `node:22-slim` (test step) and `alpine/git` (diff step) |
| `images:build` | Builds the test agent image, `sandboxed-runner/test-agent` |
| `images:build:claude` | Builds the Claude Code agent image, `sandboxed-runner/claude-agent` (optional, slower) |
| `images` | `images:pull` then `images:build` |

Pull images before running anything. Otherwise the first run downloads them inside its own steps, and that download time counts against the step's time limit.

Then try a run with the test agent, a stand-in for a real model that applies a known fix:

```sh
npm run runner -- run \
  --repo fixtures/dummy-repo \
  --task "Tests are failing. Fix src/slugify.js so npm test passes. Don't modify test/." \
  --test-cmd "npm test" \
  --out out/demo
```

You'll see each step logged as it happens, the agent's and the tests' output streamed live, and a final line with the outcome. `out/demo/diff.patch` shows the fix and `out/demo/results.json` shows `"status": "passed"`.

## Commands

### `runner run`

| Option | Default | Meaning |
|---|---|---|
| `--repo <dir>` | required | Target repository directory. It is copied, never modified. |
| `--task <prompt>` | required | Task prompt for the agent |
| `--test-cmd <cmd>` | required | Test command, run with `sh -c` in the repo |
| `--out <dir>` | required | Where to write `agent.log`, `diff.patch`, `results.json` |
| `--timeout <seconds>` | `300` | Time limit for the test command |
| `--memory <size>` | `2g` | Memory limit for the test command, swap included. A whole number with `k`, `m` or `g`, at least `6m`. |
| `--cpus <n>` | `2` | CPU limit for the test command; decimals allowed |

`RUNNER_AGENT` picks the agent: `test` (default) or `claude`.

Exit codes and `results.json` status:

| Exit code | `status` | Meaning |
|---|---|---|
| 0 | `passed` | Test command exited 0 |
| 1 | `failed` | Test command exited non-zero |
| 2 | (none) | The runner itself failed (bad repo path, Docker error); message on stderr |
| 3 | `timed_out` | Test command hit `--timeout` and was stopped |
| 4 | `out_of_memory` | Test command went over `--memory` and was killed |
| 130 / 143 | `killed` | The run was stopped by Ctrl-C (SIGINT) or `runner kill` (SIGTERM) |

### `runner ps`

Lists sandboxes that are running, with run ID, step, container status, age, the runner's process ID and the task. `--json` prints the same list as JSON.

### `runner kill <id>`

Stops a run by ID. The run's own runner process removes its container and workspace and records `status: "killed"`. If that runner is already gone, `kill` removes the containers directly.

## Agents

- **`test`** (`agents/test-agent`): ignores the prompt and copies a known fix into the dummy repo. Deterministic and offline, used for tests and demos.
- **`claude`** (`agents/claude-agent`): runs the Claude Code CLI headless (`claude -p "$TASK" --dangerously-skip-permissions`) inside the sandbox. Skipping permission prompts is acceptable because the container is the security boundary.

To run the Claude agent:

```sh
npm run images:build:claude
claude setup-token     # creates a subscription token; ANTHROPIC_API_KEY also works
RUNNER_AGENT=claude CLAUDE_CODE_OAUTH_TOKEN=<token> npm run runner -- run \
  --repo fixtures/dummy-repo \
  --task "Tests are failing. Fix src/slugify.js so npm test passes. Don't modify test/." \
  --test-cmd "npm test" --out out/claude
```

Credentials are passed to Docker by name only (`-e NAME`), so their values never appear in process arguments or logs.

## How it works

```
runner run
  0. sweep: remove containers and workspaces left by runners that crashed
  1. copy the repo to a temp workspace and commit a baseline   (the source is never touched)
  2. agent container   edits /workspace                         → agent.log
  3. diff container    git diff against the baseline            → diff.patch
  4. test container    sh -c "<test-cmd>" in /workspace         → results.json
  5. remove the workspace
```

Every container runs as a non-root user (uid 1000) with all Linux capabilities dropped, `no-new-privileges`, memory, CPU and process-count limits, and no network. The one exception is the Claude agent, which needs to reach the Anthropic API.

The diff runs in its own container instead of with the host's `git`, because the agent can write to `.git/`. A planted hook or `core.fsmonitor` setting would otherwise run code on the host. Git hooks and fsmonitor are also disabled for that command.

Containers are not started with `--rm`. After each one exits, the runner asks Docker whether it was killed for running out of memory, then always removes it itself. Exit code 137 alone can't tell an out-of-memory kill from the runner's own timeout kill.

Runner progress goes to stderr, tagged by step (`[test]`). Task output is relayed live and labeled by source: `[test stdout]` lines go to stdout and `[test stderr]` lines go to stderr. That keeps the runner's logs, the task's stdout and the task's stderr distinguishable.

## Features and their tests

| Feature | What it does | Test |
|---|---|---|
| Time limits | `--timeout`; on expiry the container is force-removed (retried until gone, which covers a container still being created) and the result is `timed_out` | `runner/test/timeout.test.mjs` |
| Resource limits | `--memory` / `--cpus`; out-of-memory kills detected through Docker's `OOMKilled` flag and reported as `out_of_memory` with a message; the runner keeps working afterwards | `runner/test/resources.test.mjs` |
| Live output | Agent and test output streamed line by line as it's produced, labeled `stdout` / `stderr`; final line gives the exit code and total time | `runner/test/streaming.test.mjs` |
| Lifecycle | `runner ps`, `runner kill <id>`, clean stop on Ctrl-C / SIGTERM, and a startup sweep that removes what a crashed runner left behind | `runner/test/lifecycle.test.mjs` |

Each test runs the real CLI or `run()` against Docker. For example, the lifecycle test:
1. Starts two runs and checks that `ps` lists both.
2. Kills one and checks it is recorded as `killed`.
3. SIGKILLs the other runner and checks its container really is left behind.
4. Runs `ps` again and checks the container and workspace are gone.

## Known limitations and next steps

- **Network:** the Claude agent has unrestricted outbound network access. It could exfiltrate the workspace or its token. The next step is an allowlisting egress proxy.
- **Workspace contents:** everything in the source directory except `.git` and `node_modules` is copied into the workspace, including gitignored files such as `.env`, and the agent can read them.
- **Writable root filesystem:** inside the container, `/etc` is protected only because the user isn't root. `--read-only` plus tmpfs mounts would close this.
- **Scope of the limits:** `--timeout`, `--memory` and `--cpus` apply to the test command. The agent step has a fixed 10-minute limit.
- **Git history:** real git repos lose their history in the workspace, because the source `.git` is dropped and a fresh baseline is made. `results.json` doesn't record which source commit was tested.
- **Process ID reuse:** if a crashed runner's process ID is reused by another process, its leftovers aren't swept until that process exits. Recording a start time would close this.
- **Stream ordering:** stdout and stderr travel through separate pipes, so their relative order isn't guaranteed. Order within each stream is preserved, and timestamps line them up.

## Layout

```
runner/src/
  cli.ts         commands and option parsing
  run.ts         the run: workspace, agent, diff, test, results
  docker.ts      dockerRun(): sandboxed container, limits, timeout, OOM check, live output
  lifecycle.ts   ps, kill, orphan sweep
  workspace.ts   copy + baseline commit
  log.ts         progress logs and labeled output relay
runner/test/     integration tests (node:test, need Docker)
agents/          test agent and Claude Code agent images
fixtures/        dummy-repo: a tiny repo with a failing test
plan.md          original design doc
```
