import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dirname, "..");
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "dist", ".git", ".tmp", "test-results", "playwright-report"].includes(entry.name) ? [] : sources(path);
    return /\.(?:js|mjs)$/.test(entry.name) ? [path] : [];
  });
}
const files = sources(root);
for (const file of files) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
console.log(`Syntax checked ${files.length} files.`);
