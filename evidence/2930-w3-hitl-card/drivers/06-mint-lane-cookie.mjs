// Sign the lane account in through the app's own endpoint and print the cookie
// header the capture driver reads from its environment. Nothing is stored.
const BASE = process.env.WALK_BASE;
const res = await fetch(BASE + "/api/auth/sign-in/email", {
  method: "POST",
  headers: { Origin: BASE, "Content-Type": "application/json" },
  body: JSON.stringify({ email: process.env.LANE_ACCOUNT, password: process.env.LANE_SECRET }),
});
if (!res.ok) { console.error(`sign-in ${res.status}`); process.exit(1); }
const jar = [];
for (const c of res.headers.getSetCookie?.() ?? []) jar.push(c.split(";")[0]);
process.stdout.write(jar.join("; "));
