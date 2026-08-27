// W5c picture leg — put the ordinary accounts into the organization the
// instance's own boot import stamped its agent templates with, THROUGH THE
// APP'S OWN membership road: the administrator invites, the invited person
// accepts. No membership row is written by hand.
//   env: APP_ORIGIN, ADMIN_EMAIL, ADMIN_PW, OWNER_EMAIL, OWNER_PW,
//        BYSTANDER_EMAIL, BYSTANDER_PW, ORG_ID, OUT_JSON
import fs from "node:fs";
const APP = process.env.APP_ORIGIN;
const ORG = process.env.ORG_ID;
if (!APP || !ORG) throw new Error("02-join-organization needs APP_ORIGIN and ORG_ID");

function jarFor() {
  const jar = new Map();
  return {
    capture(res) {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [kv] = c.split(";"); const i = kv.indexOf("=");
        jar.set(kv.slice(0, i), kv.slice(i + 1));
      }
    },
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
  };
}
async function call(jar, path, body) {
  const res = await fetch(APP + path, {
    method: "POST",
    headers: { Origin: APP, "Content-Type": "application/json", Cookie: jar.header() },
    body: JSON.stringify(body),
  });
  jar.capture(res);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text: text.slice(0, 300) };
}

const out = { invited: [], accepted: [] };
const adminJar = jarFor();
console.log("admin sign-in", (await call(adminJar, "/api/auth/sign-in/email", { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PW })).status);

for (const [email, password] of [
  [process.env.OWNER_EMAIL, process.env.OWNER_PW],
  [process.env.BYSTANDER_EMAIL, process.env.BYSTANDER_PW],
]) {
  if (!email) continue;
  const inv = await call(adminJar, "/api/auth/organization/invite-member", { email, role: "member", organizationId: ORG, resend: true });
  const invitationId = inv.json?.id ?? inv.json?.invitation?.id ?? null;
  console.log(`invite ${email} -> ${inv.status} id=${invitationId ?? "none"} ${invitationId ? "" : inv.text}`);
  out.invited.push({ email, status: inv.status, invitationId });
  if (!invitationId) continue;
  const jar = jarFor();
  console.log(`  sign-in ${email} -> ${(await call(jar, "/api/auth/sign-in/email", { email, password })).status}`);
  const acc = await call(jar, "/api/auth/organization/accept-invitation", { invitationId });
  console.log(`  accept -> ${acc.status} ${acc.status === 200 ? "" : acc.text}`);
  out.accepted.push({ email, status: acc.status });
  await call(jar, "/api/auth/organization/set-active", { organizationId: ORG });
}
if (process.env.OUT_JSON) fs.writeFileSync(process.env.OUT_JSON, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
