# Visual proof — PR #1518 (dialog backdrop by default, closes #1500)

Component-level before/after of `src/components/ui/dialog.tsx` + `alert-dialog.tsx`,
re-labeled unambiguously as a synthetic demo page; rendered by the repo's real components and real Tailwind CSS in headless Chromium
(minimal harness; no app server). "Before" = the two component files at `origin/main`,
"after" = PR head `f3e53965`. DOM assertion during capture:
`[data-slot=dialog-overlay]` ABSENT before / PRESENT after; alert-dialog overlay
PRESENT on both sides (behavior deliberately preserved).

| | Dialog | AlertDialog |
|---|---|---|
| before (main) | before-dialog.png | before-alert.png |
| after (PR) | after-dialog.png | after-alert.png |
