/**
 * Docs gate: `bun scripts/check-docs.ts [--sync-brand]`. Prints `DOCS PASS`, or
 * one `FAIL <rule>: <path>: <detail>` line per problem and exits 1. The rules
 * live in `docs-check.ts`. `--sync-brand` first writes the four
 * `docs/assets/brand` files from `brand/` and `brand.json`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  brandFiles,
  docsProblems,
  loadBrand,
  loadTree,
  writeBrandFiles,
} from "./docs-check";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== "--sync-brand");
if (unknown.length > 0) {
  console.error(
    `unknown argument ${unknown.join(" ")}; usage: bun scripts/check-docs.ts [--sync-brand]`,
  );
  process.exit(2);
}

const { brand, sources } = loadBrand(ROOT);
if (args.includes("--sync-brand")) {
  const files = brandFiles(brand, sources);
  writeBrandFiles(ROOT, files);
  for (const path of files.keys()) console.log(`wrote ${path}`);
}

const problems = docsProblems(loadTree(ROOT), brand, sources);
if (problems.length > 0) {
  for (const problem of problems) console.log(problem);
  process.exit(1);
}
console.log("DOCS PASS");
