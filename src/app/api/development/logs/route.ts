import { NextResponse } from "next/server";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import { clearAllProviderLogEntries } from "@/lib/logging";

export async function DELETE() {
  // Purging provider logs is a destructive, platform-wide operation. The
  // route-guard middleware only checks for a session cookie's presence, so
  // authorization is enforced here: a validated session that belongs to a
  // platform admin. The check runs BEFORE any mutation.
  const session = await getAuthSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isPlatformAdmin(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    await clearAllProviderLogEntries();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unable to purge API logs.",
      },
      { status: 500 },
    );
  }
}
