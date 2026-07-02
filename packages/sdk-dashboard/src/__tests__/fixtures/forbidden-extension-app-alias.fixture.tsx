// Intentionally violates the first-party extension import boundary
// (cinatra#803): extensions must not reach into the app tree via the `@/*`
// tsconfig alias, and the restated Layer-1 bans (e.g. Radix) must still
// fire inside the extensions zone (flat config last-match-wins).
// eslint-boundary.test.ts temp-copies this under extensions/.
import { cn } from "@/lib/utils";
import * as Dialog from "@radix-ui/react-dialog";

export const boundaryProbe = { cn, Dialog };
