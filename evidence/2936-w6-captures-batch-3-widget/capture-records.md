# The anchor counts the shipped recorder wrote

Every number below was read off the live screen by `observeCapture`, twice around the shutter, and
validated by the shipped audit tier before the record was kept. Nothing here is typed by hand.

| cell | host | kind | state | frame url | sha256 | mean luminance (frame / widget region) |
| --- | --- | --- | --- | --- | --- | --- |
| `W1__recommendation-card__site_widget__held__light` | site_widget | recommendation_hold | pending | `/embed/assistant?assistant=wordpress&instanceId=w6b3-northwind-site` | `348ac4579d75e0576fab25d9aaf6e1466e5ed8d164eaab20be9c00ef0d6159fd` | 240.3 / **237.9** |
| `W2__recommendation-card__site_widget__held__dark` | site_widget | recommendation_hold | pending | `/embed/assistant?assistant=wordpress&instanceId=w6b3-northwind-site` | `4dcff98259d602d5c3b2e94977e2eb1dcda893d4cae5dcdfa04f22d892c02133` | 153.8 / **16.7** |
| `W3__recommendation-card__site_widget__settled__light` | site_widget | recommendation_hold | decided | `/embed/assistant?assistant=wordpress&instanceId=w6b3-northwind-site` | `242280471a084d0646c70d710a9a5faf23998a949ad164e8822ce1c52e940f9f` | 239.8 / **236.6** |
| `W4__recommendation-card__site_widget__settled__dark` | site_widget | recommendation_hold | decided | `/embed/assistant?assistant=wordpress&instanceId=w6b3-northwind-site` | `3b01ebcd4d5d5e804472462f43b28fa26e4a63090c2ae31c9384189be0c2c30e` | 155.7 / **22** |
| `W13__recommendation-card__site_widget__settled__after-reload__light` | site_widget | recommendation_hold | decided | `/embed/assistant?assistant=wordpress&instanceId=w6b3-northwind-site` | `1cb948ff5aa2536280b25578ae05d4b034b2d1201223aed087b620d9cabb515f` | 239.9 / **237** |
| `W14__recommendation-card__site_widget__settled__after-reload__dark` | site_widget | recommendation_hold | decided | `/embed/assistant?assistant=wordpress&instanceId=w6b3-northwind-site` | `dda9b6e55240aca0ea47a14df1f971d2c451862f59e8a3d13e33ff1d0a32d4d5` | 153.9 / **17.1** |

## The assertions, per record

### `W1__recommendation-card__site_widget__held__light`

| selector | scope | counted | painted |
| --- | --- | --- | --- |
| `.cw-frame` | page | 1 | 1 |
| `[data-embed-assistant][data-phase="active"]` | frame | 1 | 1 |
| `[data-conversation-list]` | frame | 1 | 1 |
| `[data-lifecycle-card-host="site_widget"]` | frame | 1 | 1 |
| `[data-lifecycle-card="recommendation_hold"]` | frame | 1 | 1 |
| `[data-skill-action="confirm"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 4 | 4 |
| `[data-skill-action="adjust"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 4 | 4 |
| `[data-skill-action="skip"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 4 | 4 |
| `[data-lifecycle-card-host="site_widget"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 1 | 1 |

### `W2__recommendation-card__site_widget__held__dark`

| selector | scope | counted | painted |
| --- | --- | --- | --- |
| `.cw-frame` | page | 1 | 1 |
| `[data-embed-assistant][data-phase="active"]` | frame | 1 | 1 |
| `[data-conversation-list]` | frame | 1 | 1 |
| `[data-lifecycle-card-host="site_widget"]` | frame | 1 | 1 |
| `[data-lifecycle-card="recommendation_hold"]` | frame | 1 | 1 |
| `[data-skill-action="confirm"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 4 | 4 |
| `[data-skill-action="adjust"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 4 | 4 |
| `[data-skill-action="skip"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 4 | 4 |
| `[data-lifecycle-card-host="site_widget"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 1 | 1 |

### `W3__recommendation-card__site_widget__settled__light`

| selector | scope | counted | painted |
| --- | --- | --- | --- |
| `.cw-frame` | page | 1 | 1 |
| `[data-embed-assistant][data-phase="active"]` | frame | 1 | 1 |
| `[data-conversation-list]` | frame | 1 | 1 |
| `[data-lifecycle-card-host="site_widget"]` | frame | 1 | 1 |
| `[data-lifecycle-card="recommendation_hold"]` | frame | 1 | 1 |
| `[data-lifecycle-card-state]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 1 | 1 |
| `[data-lifecycle-card-host="site_widget"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 1 | 1 |
| `[data-skill-action="confirm"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 0 | 0 |
| `[data-skill-action="adjust"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 0 | 0 |
| `[data-skill-action="skip"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 0 | 0 |

### `W4__recommendation-card__site_widget__settled__dark`

| selector | scope | counted | painted |
| --- | --- | --- | --- |
| `.cw-frame` | page | 1 | 1 |
| `[data-embed-assistant][data-phase="active"]` | frame | 1 | 1 |
| `[data-conversation-list]` | frame | 1 | 1 |
| `[data-lifecycle-card-host="site_widget"]` | frame | 2 | 2 |
| `[data-lifecycle-card="recommendation_hold"]` | frame | 1 | 1 |
| `[data-lifecycle-card-state]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 1 | 1 |
| `[data-lifecycle-card-host="site_widget"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 1 | 1 |
| `[data-skill-action="confirm"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 0 | 0 |
| `[data-skill-action="adjust"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 0 | 0 |
| `[data-skill-action="skip"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 0 | 0 |

### `W13__recommendation-card__site_widget__settled__after-reload__light`

| selector | scope | counted | painted |
| --- | --- | --- | --- |
| `.cw-frame` | page | 1 | 1 |
| `[data-embed-assistant][data-phase="active"]` | frame | 1 | 1 |
| `[data-conversation-list]` | frame | 1 | 1 |
| `[data-lifecycle-card-host="site_widget"]` | frame | 1 | 1 |
| `[data-lifecycle-card="recommendation_hold"]` | frame | 1 | 1 |
| `[data-lifecycle-card-state]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 1 | 1 |
| `[data-lifecycle-card-host="site_widget"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 1 | 1 |
| `[data-skill-action="confirm"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 0 | 0 |
| `[data-skill-action="adjust"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 0 | 0 |
| `[data-skill-action="skip"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 0 | 0 |

### `W14__recommendation-card__site_widget__settled__after-reload__dark`

| selector | scope | counted | painted |
| --- | --- | --- | --- |
| `.cw-frame` | page | 1 | 1 |
| `[data-embed-assistant][data-phase="active"]` | frame | 1 | 1 |
| `[data-conversation-list]` | frame | 1 | 1 |
| `[data-lifecycle-card-host="site_widget"]` | frame | 1 | 1 |
| `[data-lifecycle-card="recommendation_hold"]` | frame | 1 | 1 |
| `[data-lifecycle-card-state]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 1 | 1 |
| `[data-lifecycle-card-host="site_widget"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 1 | 1 |
| `[data-skill-action="confirm"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 0 | 0 |
| `[data-skill-action="adjust"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 0 | 0 |
| `[data-skill-action="skip"]` | root inside `[data-lifecycle-card="recommendation_hold"]` | 0 | 0 |

