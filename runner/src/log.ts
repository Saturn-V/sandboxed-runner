// Progress logs go to stderr. Stdout carries only the task's own stdout, relayed live.
export function log(scope: string, msg: string): void {
  process.stderr.write(`${now()} [${scope}] ${msg}\n`);
}

// Relays a line of task output to the matching stream of our own, labeled with its
// source so it can't be mistaken for a progress log or for the other stream.
export function relay(scope: string, stream: "stdout" | "stderr", line: string): void {
  const out = stream === "stdout" ? process.stdout : process.stderr;
  out.write(`${now()} [${scope} ${stream}] ${line}\n`);
}

function now(): string {
  return new Date().toISOString().slice(11, 23);
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
