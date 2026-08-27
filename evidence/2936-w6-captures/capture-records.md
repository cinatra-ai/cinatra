# The capture records of this round

Eight index records, written by the SHIPPED recorder
(`scripts/audit/lib/chat-hitl-capture-driver.mjs --walk`) and registered in the canonical index
through the shipped `mergeWalkRecords`. Four page-control records beside them, which are NOT index
records: the screens they photograph draw no lifecycle card at all, which is half of what they
prove.

## The eight index records

| cell | host | kind | state | final URL | anchors observed | sha256 |
| --- | --- | --- | --- | --- | --- | --- |
| `A1__recommendation-card__chat_thread__pending__light` | chat_thread | recommendation_hold | pending | `/chat/cinatra-ai/cinatra-assistant/c3455510-6980-4584-afcf-99cc25082f9a` | `[data-conversation-list]`(frame)=1; `[data-lifecycle-card-host="chat_thread"]`(frame)=1; `[data-lifecycle-card="recommendation_hold"]`(frame)=1; `[data-skill-action="confirm"]`(root)=4; `[data-skill-action="adjust"]`(root)=4; `[data-skill-action="skip"]`(root)=4; `[data-lifecycle-card-host="chat_thread"]`(root)=1 | `a3fa8291b9f6f208…` |
| `A1__recommendation-card__chat_thread__pending__dark` | chat_thread | recommendation_hold | pending | `/chat/cinatra-ai/cinatra-assistant/c3455510-6980-4584-afcf-99cc25082f9a` | `[data-conversation-list]`(frame)=1; `[data-lifecycle-card-host="chat_thread"]`(frame)=1; `[data-lifecycle-card="recommendation_hold"]`(frame)=1; `[data-skill-action="confirm"]`(root)=4; `[data-skill-action="adjust"]`(root)=4; `[data-skill-action="skip"]`(root)=4; `[data-lifecycle-card-host="chat_thread"]`(root)=1 | `fb1037052f9c4934…` |
| `A2__recommendation-card__run_card__pending__light` | run_card | recommendation_hold | pending | `/agents/cinatra-ai/blog-draft-writer-agent/e8729686-57f8-4b5b-9437-f5bf5be8ab63` | `[data-lifecycle-card-host="run_card"]`(frame)=1; `[data-lifecycle-card="recommendation_hold"]`(frame)=1; `[data-skill-action="confirm"]`(root)=4; `[data-skill-action="adjust"]`(root)=4; `[data-skill-action="skip"]`(root)=4; `[data-lifecycle-card-host="run_card"]`(root)=1 | `2540a311e0e16e9d…` |
| `A2__recommendation-card__run_card__pending__dark` | run_card | recommendation_hold | pending | `/agents/cinatra-ai/blog-draft-writer-agent/e8729686-57f8-4b5b-9437-f5bf5be8ab63` | `[data-lifecycle-card-host="run_card"]`(frame)=1; `[data-lifecycle-card="recommendation_hold"]`(frame)=1; `[data-skill-action="confirm"]`(root)=4; `[data-skill-action="adjust"]`(root)=4; `[data-skill-action="skip"]`(root)=4; `[data-lifecycle-card-host="run_card"]`(root)=1 | `b2fbab4a4e1ebbdd…` |
| `A3__recommendation-card__chat_thread__decided__light` | chat_thread | recommendation_hold | decided | `/chat/cinatra-ai/cinatra-assistant/c3455510-6980-4584-afcf-99cc25082f9a` | `[data-conversation-list]`(frame)=1; `[data-lifecycle-card-host="chat_thread"]`(frame)=2; `[data-lifecycle-card="recommendation_hold"]`(frame)=1; `[data-lifecycle-card-state]`(root)=1; `[data-lifecycle-card-host="chat_thread"]`(root)=1; `[data-skill-action="confirm"]`(root)=0; `[data-skill-action="adjust"]`(root)=0; `[data-skill-action="skip"]`(root)=0 | `d07b8c95d001da94…` |
| `A3__recommendation-card__chat_thread__decided__dark` | chat_thread | recommendation_hold | decided | `/chat/cinatra-ai/cinatra-assistant/c3455510-6980-4584-afcf-99cc25082f9a` | `[data-conversation-list]`(frame)=1; `[data-lifecycle-card-host="chat_thread"]`(frame)=2; `[data-lifecycle-card="recommendation_hold"]`(frame)=1; `[data-lifecycle-card-state]`(root)=1; `[data-lifecycle-card-host="chat_thread"]`(root)=1; `[data-skill-action="confirm"]`(root)=0; `[data-skill-action="adjust"]`(root)=0; `[data-skill-action="skip"]`(root)=0 | `fd1e87ff3dffeb55…` |
| `A4__recommendation-card__run_card__decided__light` | run_card | recommendation_hold | decided | `/agents/cinatra-ai/blog-draft-writer-agent/e8729686-57f8-4b5b-9437-f5bf5be8ab63` | `[data-lifecycle-card-host="run_card"]`(frame)=2; `[data-lifecycle-card="recommendation_hold"]`(frame)=1; `[data-lifecycle-card-state]`(root)=1; `[data-lifecycle-card-host="run_card"]`(root)=1; `[data-skill-action="confirm"]`(root)=0; `[data-skill-action="adjust"]`(root)=0; `[data-skill-action="skip"]`(root)=0 | `3f282133293d7030…` |
| `A4__recommendation-card__run_card__decided__dark` | run_card | recommendation_hold | decided | `/agents/cinatra-ai/blog-draft-writer-agent/e8729686-57f8-4b5b-9437-f5bf5be8ab63` | `[data-lifecycle-card-host="run_card"]`(frame)=2; `[data-lifecycle-card="recommendation_hold"]`(frame)=1; `[data-lifecycle-card-state]`(root)=1; `[data-lifecycle-card-host="run_card"]`(root)=1; `[data-skill-action="confirm"]`(root)=0; `[data-skill-action="adjust"]`(root)=0; `[data-skill-action="skip"]`(root)=0 | `e50f22f98f912193…` |

## The four page-control records

| control | theme | URL | lifecycle cards on the screen | `confirm-schedule-proposal` | `save-schedule-changes` | sha256 |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | light | `/chat/cinatra-ai/cinatra-assistant/c3455510-6980-4584-afcf-99cc25082f9a` | recommendation_hold/decided@chat_thread | 0 | 0 | `2a63aee75e8f58c3…` |
| S1 | dark | `/chat/cinatra-ai/cinatra-assistant/c3455510-6980-4584-afcf-99cc25082f9a` | recommendation_hold/decided@chat_thread | 0 | 0 | `6fcd43f806c3f262…` |
| S2 | light | `/agents/cinatra-ai/blog-draft-writer-agent/e8729686-57f8-4b5b-9437-f5bf5be8ab63` | recommendation_hold/decided@run_card | 0 | 0 | `d3fe710a673b024d…` |
| S2 | dark | `/agents/cinatra-ai/blog-draft-writer-agent/e8729686-57f8-4b5b-9437-f5bf5be8ab63` | recommendation_hold/decided@run_card | 0 | 0 | `81075efe7e9761f0…` |

Every count above was read off the LIVE page through the recorder's own `playwrightPage` port,
twice around the shutter. No count in this file was written by hand.
