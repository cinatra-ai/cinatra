// The unified extension store's `skill/` subtree (cinatra#793) — extracted
// vertical slice (file-size ratchet: skills-store.ts is a baselined
// bottleneck; new roots live here, not there).
//
// `<CINATRA_EXTENSION_DATA_ROOT>/skill/<slug>/<digest>/`: a verdaccio-installed
// skill package's `repositoryPath`/`sourcePath` point INTO the finalized store
// digest dir the shared install pipeline materialized (the dispatcher runs
// that pipeline BEFORE the skill handler), so this root joins the skill read
// allowlists in skills-store.ts. The host resolver import is safe here:
// `@/lib/extension-data-root` reads env > DB metadata > default with no heavy
// graph (the same dependency shape skills-store already has via
// `@/lib/database`).

import path from "path";
import { resolveExtensionDataRoot } from "@/lib/extension-data-root";

export function getExtensionStoreSkillRootPath(): string {
  return path.join(resolveExtensionDataRoot(), "skill");
}
