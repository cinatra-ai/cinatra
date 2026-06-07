// restoreChangeSetAction lives in a shared module so the inline per-object
// undo affordance (`<UndoLastAction>`) reuses the exact same restore path as
// the change-set detail page. This route module re-exports it for the
// existing `./actions` import.
export { restoreChangeSetAction } from "@/components/data-safety/restore-change-set-action";
