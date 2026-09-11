// -----------------------------------------------------------------------------
// First-account step — record the operator's registration choice.
//
// A new instance is CLOSED: nobody but the first account can be created until
// someone says otherwise (see isRegistrationClosed). This step is where that
// answer is given, and this action is what takes it down.
//
// Where the answer goes:
//   - Before any account exists (the bootstrap window): nobody can prove they
//     are this instance's operator yet, because this step is reachable by
//     anyone who can reach the instance. The answer is therefore HELD in the
//     caller's own browser and reaches the instance only once that browser
//     carries the first admin's session — see
//     src/lib/bootstrap-registration-choice.ts. A passer-by can never leave an
//     open door behind on somebody else's new instance.
//   - Once an account exists: platform admins only, and the answer is written
//     straight away, exactly like the access-control screen's own toggle, which
//     is the surface that owns this setting from then on.
//
// The account-existence probe is read fail-safe: if it cannot be answered, the
// action behaves as though an account exists and demands an admin session, so a
// database blip can never turn the write into an open door.
// -----------------------------------------------------------------------------
"use server";

import { revalidatePath } from "next/cache";

import { hasAnyBetterAuthUsers } from "@/lib/auth";
import { requireAdminSession } from "@/lib/auth-session";
import { setRegistrationClosed } from "@/lib/authz/instance-mode";
import {
  clearBootstrapRegistrationChoice,
  writeBootstrapRegistrationChoice,
} from "@/lib/bootstrap-registration-choice";

export async function recordBootstrapRegistrationChoiceAction(open: boolean): Promise<void> {
  // Anything that is not exactly `true` is read as "do not open it" — a
  // hand-crafted call cannot open the instance with a truthy non-boolean.
  const openRegistration = open === true;

  const bootstrapWindow = await hasAnyBetterAuthUsers().then(
    (hasUsers) => !hasUsers,
    () => false,
  );

  if (bootstrapWindow) {
    // Nothing is written to the instance here. The answer waits in the browser
    // that gave it for the admin account this step is about to create.
    await writeBootstrapRegistrationChoice(openRegistration ? "open" : "closed");
    return;
  }

  await requireAdminSession();
  await setRegistrationClosed(!openRegistration);
  // An admin has now spoken for the instance; a held answer must never
  // overwrite that later.
  await clearBootstrapRegistrationChoice();

  // Same surfaces the access-control toggle refreshes: the auth pages whose
  // copy depends on the setting, and the root layout, which decides whether the
  // sign-up link is shown at all.
  revalidatePath("/sign-in");
  revalidatePath("/sign-up");
  revalidatePath("/", "layout");
}
