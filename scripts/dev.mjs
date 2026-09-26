// Dev loop: TypeScript watch build + server restart on change.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const localTsc = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");

// Ensure initial build exists before starting node --watch so it doesn't crash on missing entrypoint
const distEntry = path.join(rootDir, "dist", "server", "index.js");
if (!fs.existsSync(distEntry)) {
  console.log("Compiling TypeScript for initial startup…");
  if (fs.existsSync(localTsc)) {
    spawnSync(process.execPath, [localTsc, "-p", "tsconfig.json"], { stdio: "inherit", cwd: rootDir });
  } else {
    spawnSync("npx", ["tsc", "-p", "tsconfig.json"], {
      stdio: "inherit",
      cwd: rootDir,
      shell: process.platform === "win32",
    });
  }
}

const tsc = fs.existsSync(localTsc)
  ? spawn(process.execPath, [localTsc, "-p", "tsconfig.json", "--watch", "--preserveWatchOutput"], {
      stdio: "inherit",
      cwd: rootDir,
    })
  : spawn("npx", ["tsc", "-p", "tsconfig.json", "--watch", "--preserveWatchOutput"], {
      stdio: "inherit",
      cwd: rootDir,
      shell: process.platform === "win32",
    });

const server = spawn(process.execPath, ["--watch", "dist/server/index.js"], {
  stdio: "inherit",
  cwd: rootDir,
  env: process.env,
});

function shutdown() {
  tsc.kill();
  server.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

