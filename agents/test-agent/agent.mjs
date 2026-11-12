// Stand-in for a real model: ignores the task and applies a known fix to the dummy repo.
import { copyFileSync } from "node:fs";

console.log(`task: ${process.env.TASK}`);
copyFileSync("/agent/fix/src/slugify.js", "/workspace/src/slugify.js");
console.log("applied fix to src/slugify.js");
