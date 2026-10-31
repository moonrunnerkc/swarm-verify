/**
 * Fails when a tracked TypeScript file is over 300 lines. Split by responsibility, not by count.
 *
 *   node scripts/check-caps.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const linesPerFile = 300;

export function overCap(files) {
  return files.filter(([, lines]) => lines > linesPerFile);
}

if (import.meta.filename === process.argv[1]) {
  const root = join(import.meta.dirname, "..");
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.ts"], { cwd: root })
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0);
  const counted = tracked.map((path) => {
    const text = readFileSync(join(root, path), "utf8");
    return [path, text.split("\n").length - (text.endsWith("\n") ? 1 : 0)];
  });
  const over = overCap(counted);
  for (const [path, lines] of over) process.stdout.write(`  over: ${path} has ${lines} lines\n`);
  process.stdout.write(
    over.length === 0 ? `${counted.length} files within ${linesPerFile} lines\n` : "",
  );
  if (over.length > 0) process.exitCode = 1;
}
