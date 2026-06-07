"use server";

// The /agents/campaigns/ app route was deleted along with the legacy
// email-outreach pipeline. Only the WordPress upsert action had a surviving
// consumer outside the deleted subtree, so the file is reduced to a thin
// re-export that forwards to src/app/campaigns/actions.

export { saveWordPressInstanceAction } from "@/app/campaigns/actions";
