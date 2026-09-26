// Dev loop: TypeScript watch build + server restart on change.
import { spawn } from "node:child_process";

const tsc = spawn("npx", ["tsc", "-p", "tsconfig.json", "--watch", "--preserveWatchOutput"], { stdio: "inherit" });
const server = spawn("node", ["--watch", "dist/server/index.js"], { stdio: "inherit", env: process.env });

function shutdown() {
  tsc.kill();
  server.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
