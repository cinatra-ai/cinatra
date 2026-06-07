// UndoToastHost is mounted app-shell-wide
// and showUndoToast routes through it. Source-pin (the host is a client hook
// component; the repo has no RTL at root) + a runtime check that the handler
// indirection exists.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

describe("DSUV-UI-TOAST-02 — app-shell UndoToast host", () => {
  it("undo-toast exports UndoToastHost + routes showUndoToast through an app-shell handler", () => {
    const src = read("src/components/data-safety/undo-toast.tsx");
    expect(src).toMatch(/export function UndoToastHost/);
    expect(src).toMatch(/appShellHandler/);
    // showUndoToast prefers the installed app-shell handler, falls back to direct.
    expect(src).toMatch(/\(appShellHandler \?\? renderUndoToast\)/);
    // The host supplies the default Undo navigation (deep-link to restore modal).
    expect(src).toMatch(/router\.push\(undoDeepLink\(id\)\)/);
  });

  it("providers.tsx mounts <UndoToastHost> in the app shell", () => {
    const src = read("src/app/providers.tsx");
    expect(src).toMatch(
      /import \{ UndoToastHost \} from "@\/components\/data-safety\/undo-toast"/,
    );
    expect(src).toMatch(/<UndoToastHost \/>/);
  });
});
