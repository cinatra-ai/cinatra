---
type: Convention
title: Write only what stays true
description: A concept earns its place when it stays true after the current task ends.
source: docs/internals/workflows/memory-conventions.md
source_digest: sha256:74839d95f4cc3a1b656ab499aebe521dfe03959c946adeeb4233f7a8de7186eb
---
A concept earns its place when it stays true after the current task ends. Four
kinds qualify:

- a **convention** the project follows, such as a naming rule or a layout rule
- a **correction** a reviewer or a maintainer gave you, with the reason
- a **command** that is hard to rediscover, such as a long test invocation
- a **debugging insight** that explains a non-obvious failure and its cause

Do not write the task you just finished, the state of a branch, a file listing,
or anything the repository already records. Those go stale within days and push
the durable concepts out of reach.
