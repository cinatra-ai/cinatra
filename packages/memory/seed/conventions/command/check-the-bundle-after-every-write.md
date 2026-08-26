---
type: Command
title: Check the bundle after every write
description: Run `memory check` after you add or edit a concept.
source: docs/internals/workflows/memory-conventions.md
source_digest: sha256:3b7e748c0743335a0ad1ddfbf3e625d54ce8a6f44cd789c0d8a8a5af1998692f
---
Run `memory check` after you add or edit a concept. It reports the conformance
diagnostics for the whole bundle and exits non-zero on any error-level finding,
so a broken file never reaches a commit.

A missing `type`, unparseable YAML, or an oversize file is an error, and the
loader skips that file. A link to a file the bundle does not hold is a warning,
because the bundle tolerates a pointer to knowledge nobody has written yet.
