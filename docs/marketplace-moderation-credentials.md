# Marketplace moderation credentials

The cinatra instance talks to the remote marketplace with **two distinct
bearer credentials**, partitioned by authority. Reading the consumer credential
for an admin operation is a confused-deputy, so the two are never
interchangeable and there is **no fallback** from one to the other.

| Env var | Identity | Used for |
| --- | --- | --- |
| `MARKETPLACE_INSTANCE_TOKEN` | This instance's **consumer / self** identity | Listing and managing *this instance's own* extension submissions (`extension_submission_list_self`, `extension_submit_for_review`, `extension_submission_withdraw`). |
| `MARKETPLACE_ADMIN_TOKEN` | The **admin / moderator** identity (`PRINCIPAL_ADMIN`-bound) | Moderating *all vendors'* submissions and vendor applications: `extension_submission_list_admin`, `extension_submission_approve`, `extension_submission_reject`, `extension_submission_promotion_retry`, and the vendor-application moderation abilities. |

Both surfaces are additionally gated cinatra-side by `requireAdminSession()`, and
the marketplace independently enforces the `cinatra_vendor_approve` (WP
`CAP_VENDOR_APPROVE`) capability on the token regardless of which one is
presented.

## Migration note — extension-submission moderation now requires `MARKETPLACE_ADMIN_TOKEN`

Extension-submission moderation (the `/configuration/marketplace/submissions/admin`
queue and the **Extension submissions** section of the unified
`/configuration/approvals` inbox) previously authenticated with
`MARKETPLACE_INSTANCE_TOKEN`. It now resolves `MARKETPLACE_ADMIN_TOKEN`, matching
vendor-application moderation and the catalog sync-worker partition.

**If your self-hosted install moderated extension submissions with only
`MARKETPLACE_INSTANCE_TOKEN` set, set `MARKETPLACE_ADMIN_TOKEN` as well.** Until
you do, extension-submission moderation **fails closed** — this is intended, not a
regression:

- The admin queue page shows an inline banner naming `MARKETPLACE_ADMIN_TOKEN`.
- In the unified approvals inbox, the **Extension submissions** section is hidden
  with a discoverable "not configured" hint (the marketplace is otherwise still
  connected via the instance token).
- Approve / reject / promotion-retry actions surface the operator-visible
  `admin-token-missing` message rather than an opaque error.

The consumer/self surfaces (`My submissions`, withdraw) keep working on
`MARKETPLACE_INSTANCE_TOKEN` unchanged.
