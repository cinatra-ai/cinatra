---
type: Convention
title: Never write a secret into a concept
description: A bundle is committed, diffed, reviewed, and synced.
source: docs/internals/workflows/memory-conventions.md
source_digest: sha256:3b8415dd2b10961efbacc1e8cfcc868ef33cd37999e7d1441dfbc9fc95e1e918
---
A bundle is committed, diffed, reviewed, and synced. An API key, a token, a
password, a private URL with an embedded credential, or a customer identifier
must never reach a concept file, a title, a description, or a tag.

Record the name of the variable that holds the credential and the place it
comes from. Write "read the token from `GITHUB_TOKEN`" and never the token
value. Remove the concept immediately when a secret does reach one, and rotate
the credential, because the file is already in history.
