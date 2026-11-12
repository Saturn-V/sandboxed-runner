# RFC: Sandboxed Runner

**Status:** Draft · **Date:** 2026-10-23 · **Scope:** local development on Docker

## Summary

The **runner CLI** is written in TypeScript. It takes a target repo directory, a task prompt, a test command, and an output directory. It copies the repo into a disposable workspace and lets an agent edit that copy inside a Docker container. Then it runs the test command in a second container and writes two files to the output directory:

- `diff.patch`: the git diff of what the agent changed
- `results.json`: the result of the test command

There are three supporting pieces:

- **Dummy repo:** a tiny target repo with a failing test.
- **Test agent:** a fake agent that applies a known fix, so we don't need a model.
- **Claude agent:** a Docker image that runs the Claude Code CLI. This is the final proof that the runner can isolate a real LLM.

---

# Section 1: High-level plan

## 1.1 Usage

```
runner run --repo <dir> --task "<prompt>" --test-cmd "<cmd>" --out <dir>
```

The CLI has only these four arguments. The agent defaults to the test agent; set `RUNNER_AGENT=claude` to use Claude instead. The task prompt comes only from `--task`. Nothing is read from the target repo to tell the agent what to do.

## 1.2 Flow

```
runner run --repo R --task T --test-cmd C --out O
  1. copy R → temp workspace, git commit a baseline   (R is never modified)
  2. agent container  gets $TASK=T, edits /workspace   → O/agent.log
  3. diff container   git diff <baseline>              → O/diff.patch
  4. test container   sh -c "C" in /workspace          → O/results.json
```

## 1.3 Isolation

Every container runs with:

- `--rm` and a non-root user (uid 1000)
- `--cap-drop ALL` and `--security-opt no-new-privileges`
- `--memory 2g`, `--cpus 2`, and `--pids-limit 512`
- `--network none`. The one exception is the Claude agent, which needs to reach the Anthropic API.

Only the disposable workspace is mounted, never the source repo. The diff runs in a container rather than through host `git`, because the agent could plant malicious git config in `.git/`.

## 1.4 Layout

```
sandboxed-runner/
├── plan.md
├── package.json              # npm workspace root
├── runner/                   # the CLI
│   └── src/
│       ├── cli.ts            # arg parsing
│       ├── run.ts            # the 4 steps above
│       ├── workspace.ts      # copy + baseline commit
│       └── docker.ts         # dockerRun() helper
├── agents/
│   ├── test-agent/           # Dockerfile + agent.mjs + fix/
│   └── claude-agent/         # Dockerfile + entrypoint.sh
└── fixtures/
    └── dummy-repo/           # package.json, src/, test/
```

## 1.5 Milestones

| # | Milestone | Done when |
|---|---|---|
| M1 | Dummy repo | `npm test` in the dummy repo fails; the known fix makes it pass |
| M2 | Runner, test step only | The runner writes `results.json` with `passed: false` |
| M3 | Test agent + diff | The runner writes a non-empty `diff.patch`, and `results.json` has `passed: true` |
| M4 | Claude agent | Same as M3, but with Claude Code doing the fix |

---

# Section 2: Low-level plan

## 2.1 Output files

`<out>/diff.patch` is the raw output of `git diff --binary <baseline>`, with new files included. It is empty if the agent changed nothing.

`<out>/results.json`:
```json
{
  "command": "npm test",
  "exitCode": 1,
  "passed": false,
  "timedOut": false,
  "durationMs": 1830,
  "stdout": "...",
  "stderr": "..."
}
```

`<out>/agent.log` holds the agent container's combined stdout and stderr, for debugging.

The CLI's exit code is 0 if the tests passed, 1 if they failed, and 2 if the runner itself errored.

## 2.2 Runner modules

**`cli.ts`.** Uses `commander` to parse the `run` subcommand with `--repo`, `--task`, `--test-cmd`, and `--out` (all required). It resolves them to absolute paths and calls `run()`.

**`workspace.ts`: `prepareWorkspace(repo) → { dir, baseline }`**
1. `fs.cp(repo, <tmp>/workspace, { recursive: true })`, skipping `node_modules`. If the source has a `.git`, it is skipped too and the workspace starts a fresh history.
2. `git init -q && git add -A && git commit -qm baseline` in the workspace (the code is still trusted at this point).
3. `chmod -R a+rwX` so uid 1000 can write. This is needed on Linux; Docker Desktop on macOS handles it already.

**`docker.ts`: `dockerRun(opts) → { exitCode, stdout, stderr, durationMs, timedOut }`**
- Spawns `docker run --rm --init --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --memory 2g --cpus 2 --pids-limit 512 --network <net> -v <workspace>:/workspace -w /workspace [-e NAME ...] <image> <cmd...>`.
- Env vars are passed as `-e NAME` (name only). Docker reads each value from the environment of the `docker` process we spawn, which is the runner's env plus extras such as `TASK`. This keeps secrets and the prompt out of argv, and it means the prompt never needs shell quoting.
- Has a timeout: when it fires, it runs `docker kill <name>` and sets `timedOut: true`.

**`run.ts`**
```ts
const { dir, baseline } = await prepareWorkspace(repo);
const agent = AGENTS[process.env.RUNNER_AGENT ?? "test"];

const a = await dockerRun({ image: agent.image, network: agent.network,
                            env: [...agent.env, "TASK"], extraEnv: { TASK: task },
                            workspace: dir, timeoutMs: 10 * 60_000 });
await writeFile(join(out, "agent.log"), a.stdout + a.stderr);

// alpine/git's entrypoint is `git`, so override it to run a shell.
const d = await dockerRun({ image: "alpine/git", entrypoint: "sh", network: "none", workspace: dir,
  cmd: ["-c", `${GIT} add -A && ${GIT} diff --cached --binary ${baseline}`] });
// GIT = "git -c core.hooksPath=/dev/null -c core.fsmonitor= -c safe.directory=/workspace"
await writeFile(join(out, "diff.patch"), d.stdout);

const t = await dockerRun({ image: "node:22-slim", network: "none", workspace: dir,
                            cmd: ["sh", "-c", testCmd], timeoutMs: 5 * 60_000 });
await writeFile(join(out, "results.json"), JSON.stringify({
  command: testCmd, exitCode: t.exitCode, passed: t.exitCode === 0 && !t.timedOut,
  timedOut: t.timedOut, durationMs: t.durationMs, stdout: t.stdout, stderr: t.stderr }, null, 2));
```

```ts
const AGENTS = {
  test:   { image: "sandboxed-runner/test-agent",   network: "none",   env: [] },
  claude: { image: "sandboxed-runner/claude-agent", network: "bridge", env: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] },
};
```

## 2.3 Dummy repo (`fixtures/dummy-repo`)

The dummy repo has no dependencies and uses the built-in `node:test` runner, so its tests work with the network off.

- `package.json`: `{ "type": "module", "scripts": { "test": "node --test" } }`
- `src/slugify.js` (buggy): `input.toLowerCase().replace(/ /g, "-")`
- `test/slugify.test.js` has these cases:
  - `"Hello World"` → `hello-world`. This one passes even with the bug.
  - `"  Hello   World  "`, `"Hello, World!"`, and `"a -- b"` should all become `hello-world`, `hello-world`, and `a-b`. These fail with the bug.

This is the only project in the repo that has tests.

## 2.4 Test agent (`agents/test-agent`)

```dockerfile
FROM node:22-slim
COPY agent.mjs /agent/agent.mjs
COPY fix/ /agent/fix/
USER 1000
ENTRYPOINT ["node", "/agent/agent.mjs"]
```

`agent.mjs` logs the `$TASK` it received, copies `/agent/fix/src/slugify.js` over `/workspace/src/slugify.js`, and exits 0.

## 2.5 Claude agent (`agents/claude-agent`)

```dockerfile
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code
COPY entrypoint.sh /entrypoint.sh
USER 1000
ENV HOME=/tmp
ENTRYPOINT ["/entrypoint.sh"]
```

```sh
#!/bin/sh
# entrypoint.sh
cd /workspace
exec claude -p "$TASK" --dangerously-skip-permissions
```

Skipping permissions is acceptable here because the container is the security boundary. Claude Code also refuses that flag when run as root, which is one more reason the image uses `USER 1000`. Auth comes from `CLAUDE_CODE_OAUTH_TOKEN` (a subscription token from `claude setup-token`) or `ANTHROPIC_API_KEY`. The runner passes both names through, and Docker skips whichever is unset. The image pins Claude Code 2.1.322. That version has no `--max-turns` flag, so the runner's 10-minute agent timeout is what bounds the run.

## 2.6 Build and demo

```sh
docker build -t sandboxed-runner/test-agent   agents/test-agent
docker build -t sandboxed-runner/claude-agent agents/claude-agent
npm run build

TASK="Tests are failing. Fix src/slugify.js so npm test passes. Don't modify test/."

# M3: test agent (ignores the prompt; applies its known fix)
npx runner run --repo fixtures/dummy-repo --task "$TASK" --test-cmd "npm test" --out out/test-agent

# M4: Claude
RUNNER_AGENT=claude CLAUDE_CODE_OAUTH_TOKEN=... \
  npx runner run --repo fixtures/dummy-repo --task "$TASK" --test-cmd "npm test" --out out/claude
```

## 2.7 Later (not now)

- An egress allowlist proxy for the Claude agent
- A setup/install step for repos that have dependencies
- Protecting test files so the agent can't edit them to get a pass
- Choosing the agent with a flag instead of an env var
