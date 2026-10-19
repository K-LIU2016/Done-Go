import { readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function collect(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    const normalized = path.split(sep).join("/");
    if (["src/screens/s08-blank", "src/screens/s18-m-blank"].includes(normalized)) return [];
    return entry.isDirectory() ? collect(path) : /\.test\.(ts|mjs)$/.test(entry.name) ? [path] : [];
  });
}

// Data includes a browser race harness; keep its pure-test boundary explicit.
// Retired screen experiments stay on disk for research but are outside the current Tango unit boundary.
const files = [
  ...["src/domain", "src/components", "src/screens", "src/styles", "src/appearance", "src/runtime", "src/auth", "tests/unit"].flatMap(collect),
  ...["storage", "context-review", "boundary"].map((name) => `src/data/${name}.test.ts`),
].sort();
const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...files], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
