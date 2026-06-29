---
name: skill-canary
description: Hot-install canary skill. Resolvable only while its owning package is install-active.
---
# Skill Canary
This skill body is registered into the cinatra.skills catalog only while the owning
extension is live (active|locked). An archived owner tombstones it without a rebuild.
