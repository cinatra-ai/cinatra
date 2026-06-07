#!/usr/bin/env node
// Clean-consumer smoke for the `@cinatra-ai` design-system shadcn registry.
//
// Proves end-to-end that a STANDALONE consumer (the eventual extracted
// extension repo) can consume the registry: serves the committed `public/r`
// over HTTP, points a throwaway consumer's components.json at it, runs
// `shadcn add @cinatra-ai/<item>` for EVERY primitive EXPLICITLY, and asserts
// the source COPIED, imports were rewritten to the consumer's own `@/` alias,
// and the declared npm deps were written to package.json.
//
// HARD CONSTRAINT proven by this smoke: consumers MUST add every primitive
// EXPLICITLY. `shadcn add` installs the npm deps of explicitly-requested items
// (+ the cn lib) but NOT the deps of TRANSITIVELY-pulled registry:ui items —
// so `add field` alone does NOT install radix-ui (pulled via label/separator).
// The extraction flow lists every primitive a connector uses explicitly.
//
// With --full it also `pnpm install`s + `tsc --noEmit`s the copied source,
// proving the declared deps install and the copied code typechecks (slow:
// network install). Default (fast) asserts copy + import-rewrite + deps-written.
//
// Usage:
//   node scripts/extensions/registry-consumer-smoke.mjs           # fast
//   node scripts/extensions/registry-consumer-smoke.mjs --full     # + install + tsc

import { execFileSync, spawn } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHADCN_VERSION = "4.8.2";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC_DIR = join(REPO_ROOT, "public");

// Every primitive in registry.json — added EXPLICITLY (see header constraint).
const ITEMS = [
  "alert", "badge", "button", "card", "field", "input-group", "input", "label", "pagination",
  "paginated-table", "separator", "table", "textarea",
];
const EXPECTED_DEPS = ["class-variance-authority", "clsx", "lucide-react", "radix-ui", "tailwind-merge"];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Serve `public/` via python3's http.server. (A hand-rolled node static server
// hangs `shadcn add`'s fetch flow against it; python's stock server does not.
// python buffers stdout when piped, so we pick a free port ourselves and poll
// the server until it answers rather than parsing its banner.)
async function servePublic() {
  const port = await freePort();
  const proc = spawn(
    "python3",
    ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", PUBLIC_DIR],
    { stdio: "ignore" },
  );
  proc.on("error", (e) => {
    console.error(`[registry-consumer-smoke] python3 http.server failed to spawn: ${e.message}`);
    process.exit(1);
  });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/r/button.json`);
      if (res.ok) return { stop: () => proc.kill("SIGKILL"), port };
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  proc.kill("SIGKILL");
  throw new Error("python3 http.server did not become reachable in time");
}

function writeConsumer(dir, port) {
  mkdirSync(join(dir, "src/lib"), { recursive: true });
  mkdirSync(join(dir, "src/components/ui"), { recursive: true });
  mkdirSync(join(dir, "src/app"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "cinatra-registry-smoke", version: "0.0.0", private: true, type: "module",
  }) + "\n");
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      baseUrl: ".", paths: { "@/*": ["./src/*"] }, jsx: "react-jsx",
      lib: ["es2022", "dom", "dom.iterable"], module: "esnext", moduleResolution: "bundler",
      target: "es2022", strict: true, skipLibCheck: true, noEmit: true, esModuleInterop: true,
    }, include: ["src"],
  }, null, 2) + "\n");
  writeFileSync(join(dir, "src/app/globals.css"), '@import "tailwindcss";\n');
  writeFileSync(join(dir, "components.json"), JSON.stringify({
    $schema: "https://ui.shadcn.com/schema.json", style: "radix-nova", rsc: true, tsx: true,
    tailwind: { config: "", css: "src/app/globals.css", baseColor: "neutral", cssVariables: true, prefix: "" },
    iconLibrary: "lucide",
    aliases: { components: "@/components", utils: "@/lib/utils", ui: "@/components/ui", lib: "@/lib", hooks: "@/hooks" },
    registries: { "@cinatra-ai": `http://127.0.0.1:${port}/r/{name}.json` },
  }, null, 2) + "\n");
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function assert(cond, msg) {
  if (!cond) { console.error(`[registry-consumer-smoke] FAIL: ${msg}`); process.exit(1); }
}

async function main() {
  const full = process.argv.includes("--full");
  const { stop, port } = await servePublic();
  const consumers = [];
  const mkConsumer = () => {
    const d = mkdtempSync(join(tmpdir(), "cinatra-registry-smoke-"));
    consumers.push(d);
    writeConsumer(d, port);
    return d;
  };
  const depsOf = (d) => JSON.parse(readFileSync(join(d, "package.json"), "utf8")).dependencies || {};
  const addItems = (d, items) =>
    run("corepack", ["pnpm", "dlx", `shadcn@${SHADCN_VERSION}`, "add", ...items.map((i) => `@cinatra-ai/${i}`), "--yes"], d);

  try {
    // --- POSITIVE: explicit add of EVERY primitive (the supported flow) ---
    const dir = mkConsumer();
    addItems(dir, ITEMS);

    // copied + import-rewritten to the consumer's own alias (not @/ of some other tree)
    assert(existsSync(join(dir, "src/lib/utils.ts")), "utils.ts not copied");
    for (const item of ITEMS) {
      assert(existsSync(join(dir, `src/components/ui/${item}.tsx`)), `${item}.tsx not copied`);
    }
    const field = readFileSync(join(dir, "src/components/ui/field.tsx"), "utf8");
    assert(/from ["']@\/lib\/utils["']/.test(field), "field.tsx cn import not rewritten to consumer alias");
    assert(/from ["']@\/components\/ui\/label["']/.test(field), "field.tsx label import not rewritten");

    // declared npm deps written (incl. radix-ui — present ONLY because button/label/
    // separator were each added explicitly)
    const deps = depsOf(dir);
    for (const d of EXPECTED_DEPS) assert(deps[d], `expected dep ${d} not written to package.json`);

    // --- NEGATIVE: PROVE the explicit-add constraint ---
    // `add field` ALONE must NOT install radix-ui — radix-ui is declared by the
    // transitively-pulled label/separator, not by field. If it appears here, the
    // transitive closure IS installing registry:ui npm deps, so the explicit-item
    // requirement is moot (or the registry changed) and the docs must be re-derived.
    const negDir = mkConsumer();
    addItems(negDir, ["field"]);
    const negDeps = depsOf(negDir);
    assert(
      !negDeps["radix-ui"],
      "explicit-add constraint NOT demonstrated: `add field` alone installed radix-ui — " +
        "transitive registry:ui deps ARE being installed; re-derive the explicit-add rule.",
    );
    assert(negDeps["class-variance-authority"], "negative-case sanity: field's own cva dep should still install");

    if (full) {
      run("corepack", ["pnpm", "add", "-D", "typescript@5.9.2", "@types/react@^19", "@types/react-dom@^19"], dir);
      run("corepack", ["pnpm", "add", "react@^19", "react-dom@^19", "lucide-react@^1.7.0"], dir);
      run("corepack", ["pnpm", "install"], dir);
      run("corepack", ["pnpm", "exec", "tsc", "--noEmit"], dir);
      console.log(
        "[registry-consumer-smoke] OK (--full) — explicit add copies + rewrites + deps install + " +
          "transitive-only add omits radix-ui (constraint proven) + copied source typechecks.",
      );
    } else {
      console.log(
        "[registry-consumer-smoke] OK — explicit add copies + rewrites + writes deps (incl. radix-ui); " +
          "transitive-only add omits radix-ui (constraint proven).",
      );
    }
  } finally {
    stop();
    for (const d of consumers) rmSync(d, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
