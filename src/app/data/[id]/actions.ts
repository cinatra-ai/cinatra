// restoreObjectToVersionAction lives in a shared module so the inline
// per-version restore button (a client component) imports it without a
// component → route dependency edge. This route module re-exports it for
// discoverability at the canonical /data/[id] surface.
export { restoreObjectToVersionAction } from "@/components/data-safety/restore-object-version-action";
