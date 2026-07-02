// .mjs twin of forbidden-extension-app-alias.fixture.tsx (cinatra#803):
// the extension vendored-ui import restatement must cover the full JS
// family, or a stray .mjs inside components/ui could reach the app tree.
import { cn } from "@/lib/utils";
import * as Dialog from "@radix-ui/react-dialog";

export const boundaryProbe = { cn, Dialog };
