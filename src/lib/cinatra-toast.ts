"use client";

// Canonical toast wrapper — the implementation moved to
// `@cinatra-ai/sdk-ui/toast` so extension packages share the host's single
// sonner instance (`sonner` is a peerDependency of sdk-ui). This host path
// stays the stable in-app import: `import { toast } from "@/lib/cinatra-toast";`
// (every existing call site is unchanged). `sonner` may be imported directly
// ONLY from the sdk-ui wrapper and the host Toaster (src/components/ui/sonner.tsx)
// — the ESLint no-restricted-imports rule enforces this.
export { cinatraToast, toast } from "@cinatra-ai/sdk-ui/toast";
export type { CinatraToastOptions } from "@cinatra-ai/sdk-ui/toast";
