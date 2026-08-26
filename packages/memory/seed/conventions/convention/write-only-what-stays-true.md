---
type: Convention
title: Write only what stays true
description: A concept earns its place when it stays true after the current task ends.
source: docs/internals/workflows/memory-conventions.md
source_digest: sha256:86ac600c6dfa41551b1d83a09610ae7e6b6746ac337898e8a6fb3d79be49a9ae
---
A concept earns its place when it stays true after the current task ends. Four
kinds qualify:

- a **convention** the project follows, such as a naming rule or a layout rule
- a **correction** a reviewer or a maintainer gave you, with the reason
- a **command** that is hard to rediscover, such as a long test invocation
- a **debugging insight** that explains a non-obvious failure and its cause

Do not write the task you just finished, the state of a branch, a file listing,
or anything the repository already records. Those go stale within days and push
the durable concepts out of reach. A generated bundle is the one exception: a
generator may derive a concept from a repository page so that a reader with no
checkout still reaches it.
