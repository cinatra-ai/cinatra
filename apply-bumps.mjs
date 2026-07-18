import fs from "node:fs";
import path from "node:path";

const ROOT = "/Users/ordnas/Code/cinatra-ai/.claude/scratch/renovate-rollup";

// [relative file, exact old line, exact new line]
const edits = [
  ["package.json", `    "katex": "^0.16.47",`, `    "katex": "^0.18.0",`],
  ["package.json", `    "pdfjs-dist": "5.4.296",`, `    "pdfjs-dist": "5.7.284",`],
  ["package.json", `    "eslint": "10.4.0",`, `    "eslint": "10.7.0",`],
  ["packages/agent-ui-protocol/package.json", `    "@ag-ui/core": "0.0.53",`, `    "@ag-ui/core": "0.0.57",`],
  ["packages/llm/package.json", `    "@anthropic-ai/sdk": "^0.96.0",`, `    "@anthropic-ai/sdk": "^0.112.0",`],
  ["packages/dashboards/package.json", `    "drizzle-cube": "0.5.7",`, `    "drizzle-cube": "0.6.4",`],
  ["packages/sdk-dashboard/package.json", `    "drizzle-cube": "0.5.7"`, `    "drizzle-cube": "0.6.4"`],
  ["packages/chat/package.json", `    "katex": "^0.16.47",`, `    "katex": "^0.18.0",`],
];

let ok = true;
for (const [rel, oldS, newS] of edits) {
  const fp = path.join(ROOT, rel);
  const src = fs.readFileSync(fp, "utf8");
  const count = src.split(oldS).length - 1;
  if (count !== 1) {
    console.error(`FAIL ${rel}: expected exactly 1 occurrence of old string, found ${count}`);
    ok = false;
    continue;
  }
  fs.writeFileSync(fp, src.replace(oldS, newS));
  console.log(`OK   ${rel}: ${oldS.trim()}  ->  ${newS.trim()}`);
}
if (!ok) { console.error("ABORTED: one or more edits did not match exactly once."); process.exit(1); }
console.log("ALL 8 EDITS APPLIED");
