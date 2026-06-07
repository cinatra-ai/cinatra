/**
 * Cinatra Demo Seed Script — ACME Group fixtures
 *
 * Populates the app with generic sample data for testing. All names, domains,
 * and content are fictional. Domains use the RFC 2606 reserved `.example` TLD
 * to avoid collision with real-world systems.
 *
 * CRM seeding note (Twenty migration): the account/contact/list rows this
 * script writes land in the legacy `cinatra.objects` substrate. After the
 * Twenty cutover (the operator wipe-and-reseed), CRM records live in Twenty
 * and cinatra holds only pointer rows — so a post-cutover `pnpm seed` can no
 * longer rely on these object pointer rows for CRM fixtures. CRM-native
 * reseeding is owned by the cutover path (`crm_*` facade), not this script.
 *
 * Org structure (4 organizations):
 *   ACME Group              — parent holding company
 *   ACME Robotics           — subsidiary: hardware / manufacturing
 *   ACME Cloud Services     — subsidiary: SaaS / cloud infrastructure
 *   ACME Studios            — subsidiary: creative / media
 *
 * Users (~24, varied membership profiles):
 *   - Platform admins (Better Auth role contains 'admin')
 *   - Org owners / admins / members (per org)
 *   - Cross-org user (member of 2 orgs)
 *   - No-org user (platform-only)
 *   - No-team user (org member, no team)
 *   - Multi-team user (3 teams across 2 orgs)
 *   - Team-lead-only user
 *
 * Teams (~12, including one empty + one cross-org).
 * Projects (6) — user-, team-, and org-owned.
 * CRM accounts (~12) — fictional companies, generic industries.
 *
 * NOT touched by the seed (no fixture content inserted):
 *   - Agent templates (`cinatra.agent_templates`) — registered at Next.js boot
 *     from `agents/<vendor>/<slug>/cinatra/oas.json`. The seed wipes the table
 *     so stale fixture data from older seed runs doesn't survive, but does NOT
 *     insert any agents. Restart `pnpm dev` after seeding to re-register from
 *     the agents/ folder.
 *   - Chat threads (`cinatra.chat_threads`) — the seed INSERTS two fictional
 *     user-owned demo threads (`chat-seed-v65-*`) so `/chat` is non-empty,
 *     but never TRUNCATEs the table. The registered admin's own chat
 *     history is preserved across `pnpm seed` runs.
 *
 * Pre-condition:
 *   At least one Better Auth user with role containing 'admin' must exist.
 *   Register the first user via the app to bootstrap admin, then run this seed.
 *
 * Usage:
 *   node --env-file=.env.local scripts/seed.mjs
 *   # or: pnpm seed
 *
 * Safe to re-run: wipes only seedable data (not auth settings/credentials).
 */

import pg from "pg";

const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now() { return new Date().toISOString(); }

async function q(sql, params = []) {
  return pool.query(sql, params);
}

// ---------------------------------------------------------------------------
// Admin user discovery (Better Auth role can be a comma-separated list)
// ---------------------------------------------------------------------------

async function findAdminUser() {
  const result = await q(`
    SELECT id, email
    FROM public."user"
    WHERE EXISTS (
      SELECT 1 FROM regexp_split_to_table(COALESCE(role, ''), '\\s*,\\s*') r WHERE r = 'admin'
    )
    AND (
      COALESCE("userType", 'human') = 'human'
      OR "userType" IS NULL
    )
    ORDER BY "createdAt" ASC
    LIMIT 1
  `);
  return result.rows[0] ?? null;
}

async function listProtectedUserIds() {
  // Preserve real registered admin users and every system assistant user. We
  // never overwrite or delete these in the wipe phase.
  //
  // Stale fixture-promoted admins (e.g. a previous seed run promoted
  // `usr-peer-heinlein` to platform admin) must NOT survive. Detection:
  // seeded user IDs always start with `usr-`; Better Auth-generated IDs for
  // real registrations do not. So we protect admins ONLY when their id does
  // not match the seed-pattern prefix. New ACME admins like `usr-alice-cooper`
  // will be wiped and re-created by the seed (their id collisions are handled
  // by ON CONFLICT (id) DO UPDATE in seedUsers).
  const adminRows = await q(`
    SELECT id FROM public."user"
    WHERE EXISTS (
      SELECT 1 FROM regexp_split_to_table(COALESCE(role, ''), '\\s*,\\s*') r WHERE r = 'admin'
    )
    AND id NOT LIKE 'usr-%'
  `);
  const systemRows = await q(`
    SELECT id FROM public."user"
    WHERE COALESCE("userType", 'human') <> 'human'
  `);
  const ids = new Set();
  for (const r of adminRows.rows) ids.add(r.id);
  for (const r of systemRows.rows) ids.add(r.id);
  return Array.from(ids);
}

// ---------------------------------------------------------------------------
// Wipe seedable data (not settings/credentials)
// ---------------------------------------------------------------------------

async function wipeSeedableData(protectedUserIds) {
  console.log("Wiping seedable data…");

  // v65 fixture-tagged rows: FK-safe delete order BEFORE the bulk TRUNCATEs
  // below. workflow_task_attempt/artifact/approval have ON DELETE RESTRICT on
  // workflow_task, so the order matters: attempts → events → artifacts →
  // approvals → dependencies → gates → tasks → workflow → template. Lists,
  // dashboards, chat threads, and team role-grants are wiped here too because
  // they live in tables that we don't TRUNCATE wholesale (objects, dashboards,
  // chat_threads, role_grant — those tables hold real user/runtime data we
  // must not clobber).
  await q(`DELETE FROM cinatra.workflow_task_attempt WHERE workflow_id LIKE 'wf-seed-v65-%'`);
  await q(`DELETE FROM cinatra.workflow_event WHERE workflow_id LIKE 'wf-seed-v65-%'`);
  await q(`DELETE FROM cinatra.workflow_artifact WHERE workflow_id LIKE 'wf-seed-v65-%'`);
  await q(`DELETE FROM cinatra.workflow_approval WHERE workflow_id LIKE 'wf-seed-v65-%'`);
  await q(`DELETE FROM cinatra.workflow_dependency WHERE workflow_id LIKE 'wf-seed-v65-%'`);
  await q(`DELETE FROM cinatra.workflow_gate WHERE workflow_id LIKE 'wf-seed-v65-%'`);
  await q(`DELETE FROM cinatra.workflow_task WHERE workflow_id LIKE 'wf-seed-v65-%'`);
  await q(`DELETE FROM cinatra.workflow WHERE id LIKE 'wf-seed-v65-%'`);
  await q(`DELETE FROM cinatra.workflow_template WHERE id LIKE 'wftpl-seed-v65-%'`);
  await q(`DELETE FROM cinatra.dashboard_revisions WHERE dashboard_id LIKE 'dash-seed-v65-%'`);
  await q(`DELETE FROM cinatra.dashboards WHERE id LIKE 'dash-seed-v65-%'`);
  await q(`DELETE FROM cinatra.chat_threads WHERE id LIKE 'chat-seed-v65-%'`);
  await q(`DELETE FROM cinatra.objects WHERE source = 'seed-v65-lists'`);
  // Team-scope role grants are wiped by user CASCADE below for seeded users
  // (subject_user_id FK ON DELETE CASCADE); explicit DELETE here handles
  // grants whose subject_user_id might survive the user wipe (defensive).
  await q(`DELETE FROM cinatra.role_grant WHERE scope_level = 'team' AND scope_record_id LIKE 'team-%'`);

  // Bulk TRUNCATEs for tables wholly owned by the seed fixture. Note: the
  // legacy review_tasks + planned_actions TRUNCATEs were removed — both
  // tables are DROPed in drizzle-store.ts (legacy retirement), so TRUNCATE
  // would 42P01-fail on a fresh schema.
  await q(`
    TRUNCATE cinatra.agent_run_messages CASCADE;
    TRUNCATE cinatra.audit_events CASCADE;
    TRUNCATE cinatra.agent_runs CASCADE;
    TRUNCATE cinatra.agent_forks CASCADE;
    TRUNCATE cinatra.agent_share_bindings CASCADE;
    TRUNCATE cinatra.agent_registry_entries CASCADE;
    TRUNCATE cinatra.agent_campaign_overrides CASCADE;
    TRUNCATE cinatra.agent_versions CASCADE;
    TRUNCATE cinatra.agent_templates CASCADE;
    TRUNCATE cinatra.project_co_owners CASCADE;
    TRUNCATE cinatra.projects CASCADE;
    TRUNCATE cinatra.drafts CASCADE;
    TRUNCATE cinatra.campaigns CASCADE;
    TRUNCATE cinatra.campaign_types CASCADE;
    TRUNCATE cinatra.startup_overrides CASCADE;
    TRUNCATE cinatra.startups CASCADE;
    TRUNCATE cinatra.notifications CASCADE;
    TRUNCATE cinatra.record_activities CASCADE;
    TRUNCATE cinatra.usage_events CASCADE;
    TRUNCATE cinatra.legacy_costs CASCADE;
  `);
  // chat_threads INTENTIONALLY excluded from the bulk TRUNCATE — the
  // registered admin's real chat history must survive `pnpm seed`. The
  // prefixed DELETE at the top of this function wipes only the
  // `chat-seed-v65-%` fixture rows.

  // Wipe extra orgs/users/teams added by seed (preserve all admins + system users + default org).
  await q(`DELETE FROM public."teamMember" WHERE TRUE`);
  await q(`DELETE FROM public.team WHERE TRUE`);
  const protectedList = protectedUserIds.length > 0 ? protectedUserIds : [""];
  await q(
    `DELETE FROM public.member WHERE "userId" <> ALL($1::text[])`,
    [protectedList],
  );
  await q(`DELETE FROM public.invitation WHERE TRUE`);
  await q(
    `DELETE FROM public."user" WHERE id <> ALL($1::text[])`,
    [protectedList],
  );
  await q(`DELETE FROM public.organization WHERE slug NOT IN ('default')`);
  console.log("  done.");
}

// ---------------------------------------------------------------------------
// Organizations — ACME Group + 3 subsidiaries
// ---------------------------------------------------------------------------

async function seedOrganizations() {
  console.log("Seeding organizations…");

  const orgs = [
    { id: "org-acme-group",    slug: "acme-group",    name: "ACME Group" },
    { id: "org-acme-robotics", slug: "acme-robotics", name: "ACME Robotics" },
    { id: "org-acme-cloud",    slug: "acme-cloud",    name: "ACME Cloud Services" },
    { id: "org-acme-studios",  slug: "acme-studios",  name: "ACME Studios" },
  ];

  for (const org of orgs) {
    await q(
      `INSERT INTO public.organization (id, name, slug, "createdAt", metadata)
       VALUES ($1, $2, $3, NOW(), '{}')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug`,
      [org.id, org.name, org.slug]
    );
  }

  // Default org (created on first-user bootstrap) is preserved.
  const existing = await q(`SELECT id, slug FROM public.organization`);
  const orgMap = {};
  for (const row of existing.rows) orgMap[row.slug] = row.id;

  const allOrgs = {
    "acme-group":    orgMap["acme-group"]    ?? "org-acme-group",
    "acme-robotics": orgMap["acme-robotics"] ?? "org-acme-robotics",
    "acme-cloud":    orgMap["acme-cloud"]    ?? "org-acme-cloud",
    "acme-studios":  orgMap["acme-studios"]  ?? "org-acme-studios",
    "default":       orgMap["default"]       ?? null,
  };

  console.log(`  orgs: ${orgs.length} seeded + default preserved`);
  return allOrgs;
}

// ---------------------------------------------------------------------------
// Users — fully fictional, varied membership profiles
// ---------------------------------------------------------------------------

async function seedUsers(orgMap, adminUserId) {
  console.log("Seeding users…");

  // Each entry: a user with their primary org membership.
  // Cross-org users get extra memberships added after this list.
  const people = [
    // ── ACME Group leadership ────────────────────────────────────────────
    { id: "usr-alice-cooper",    name: "Alice Cooper",     email: "alice.cooper@acme-group.example",    org: "acme-group",    role: "owner",  title: "Group CEO",                    platformAdmin: true  },
    { id: "usr-bob-singh",       name: "Bob Singh",        email: "bob.singh@acme-group.example",       org: "acme-group",    role: "admin",  title: "Group COO",                    platformAdmin: true  },
    { id: "usr-carla-mendes",    name: "Carla Mendes",     email: "carla.mendes@acme-group.example",    org: "acme-group",    role: "member", title: "Group CFO"                                          },
    // ── ACME Robotics ───────────────────────────────────────────────────
    { id: "usr-david-kim",       name: "David Kim",        email: "david.kim@acme-robotics.example",    org: "acme-robotics", role: "owner",  title: "Managing Director, Robotics"                        },
    { id: "usr-elena-rossi",     name: "Elena Rossi",      email: "elena.rossi@acme-robotics.example",  org: "acme-robotics", role: "admin",  title: "Head of Engineering"                                },
    { id: "usr-fenway-park",     name: "Fenway Park",      email: "fenway.park@acme-robotics.example",  org: "acme-robotics", role: "member", title: "Lead Firmware Engineer"                             },
    { id: "usr-grace-okafor",    name: "Grace Okafor",     email: "grace.okafor@acme-robotics.example", org: "acme-robotics", role: "member", title: "QA Engineer"                                        },
    { id: "usr-henrik-lund",     name: "Henrik Lund",      email: "henrik.lund@acme-robotics.example",  org: "acme-robotics", role: "member", title: "Field Operations Manager"                           },
    { id: "usr-isabela-souza",   name: "Isabela Souza",    email: "isabela.souza@acme-robotics.example",org: "acme-robotics", role: "member", title: "Hardware Engineer"                                  },
    // ── ACME Cloud Services ─────────────────────────────────────────────
    { id: "usr-jamal-bright",    name: "Jamal Bright",     email: "jamal.bright@acme-cloud.example",    org: "acme-cloud",    role: "owner",  title: "Managing Director, Cloud"                           },
    { id: "usr-kira-tanaka",     name: "Kira Tanaka",      email: "kira.tanaka@acme-cloud.example",     org: "acme-cloud",    role: "admin",  title: "Head of Platform"                                   },
    { id: "usr-leo-fischer",     name: "Leo Fischer",      email: "leo.fischer@acme-cloud.example",     org: "acme-cloud",    role: "member", title: "Site Reliability Engineer"                          },
    { id: "usr-maya-patel",      name: "Maya Patel",       email: "maya.patel@acme-cloud.example",      org: "acme-cloud",    role: "member", title: "Customer Success Manager"                           },
    { id: "usr-niko-ivanov",     name: "Niko Ivanov",      email: "niko.ivanov@acme-cloud.example",     org: "acme-cloud",    role: "member", title: "Solutions Architect"                                },
    // ── ACME Studios ────────────────────────────────────────────────────
    { id: "usr-olivia-brand",    name: "Olivia Brand",     email: "olivia.brand@acme-studios.example",  org: "acme-studios",  role: "owner",  title: "Managing Director, Studios"                         },
    { id: "usr-patrick-yu",      name: "Patrick Yu",       email: "patrick.yu@acme-studios.example",    org: "acme-studios",  role: "admin",  title: "Creative Director"                                  },
    { id: "usr-quinn-aldridge",  name: "Quinn Aldridge",   email: "quinn.aldridge@acme-studios.example",org: "acme-studios",  role: "member", title: "Senior Producer"                                    },
    { id: "usr-rosa-deleon",     name: "Rosa de Leon",     email: "rosa.deleon@acme-studios.example",   org: "acme-studios",  role: "member", title: "Account Executive"                                  },
    { id: "usr-sven-larsson",    name: "Sven Larsson",     email: "sven.larsson@acme-studios.example",  org: "acme-studios",  role: "member", title: "Motion Designer"                                    },
    // ── Special-case profiles for diverse testing ───────────────────────
    // Cross-org user: member of both Robotics + Cloud
    { id: "usr-talia-novak",     name: "Talia Novak",      email: "talia.novak@acme-group.example",     org: "acme-robotics", role: "member", title: "Contractor — Shared Engineering",  extraOrgs: [{ org: "acme-cloud", role: "member" }] },
    // No-team user: org member but on no teams
    { id: "usr-uli-werner",      name: "Uli Werner",       email: "uli.werner@acme-cloud.example",      org: "acme-cloud",    role: "member", title: "Pre-Sales Engineer (no team)"                       },
    // Team-lead-only: org member + lead of exactly one team (see seedTeams)
    { id: "usr-vera-petrov",     name: "Vera Petrov",      email: "vera.petrov@acme-studios.example",   org: "acme-studios",  role: "member", title: "Sales Team Lead"                                    },
    // No-org user: platform-only, no org membership
    { id: "usr-wade-johnson",    name: "Wade Johnson",     email: "wade.johnson@personal.example",      org: null,            role: null,     title: "External Reviewer (no org)"                         },
    // Multi-team user (3 teams across 2 orgs — wired in seedTeams)
    { id: "usr-xenia-baker",     name: "Xenia Baker",      email: "xenia.baker@acme-group.example",     org: "acme-group",    role: "member", title: "Cross-Functional Strategist"                        },
  ];

  for (const p of people) {
    await q(
      `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role)
       VALUES ($1, $2, $3, true, NOW(), NOW(), $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email`,
      [p.id, p.name, p.email, p.platformAdmin ? "admin" : "user"]
    );

    if (p.org) {
      const orgId = orgMap[p.org];
      if (orgId) {
        await q(
          `INSERT INTO public.member (id, "organizationId", "userId", role, "createdAt")
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT DO NOTHING`,
          [`mem-${p.id}-${p.org}`, orgId, p.id, p.role]
        );
      }
    }
    for (const extra of p.extraOrgs ?? []) {
      const orgId = orgMap[extra.org];
      if (!orgId) continue;
      await q(
        `INSERT INTO public.member (id, "organizationId", "userId", role, "createdAt")
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT DO NOTHING`,
        [`mem-${p.id}-${extra.org}`, orgId, p.id, extra.role]
      );
    }
  }

  // Make the existing platform admin a member of every ACME org so they can
  // see all data during testing.
  if (adminUserId) {
    for (const slug of ["acme-group", "acme-robotics", "acme-cloud", "acme-studios"]) {
      const orgId = orgMap[slug];
      if (!orgId) continue;
      await q(
        `INSERT INTO public.member (id, "organizationId", "userId", role, "createdAt")
         VALUES ($1, $2, $3, 'owner', NOW())
         ON CONFLICT DO NOTHING`,
        [`mem-${adminUserId}-${slug}`, orgId, adminUserId]
      );
    }
  }

  console.log(`  created ${people.length} users`);
  return people;
}

// ---------------------------------------------------------------------------
// Teams — ~13 across orgs, including one empty + one cross-org team + one
// platform-demo team for the real admin user.
// ---------------------------------------------------------------------------

async function seedTeams(orgMap, adminUserId) {
  console.log("Seeding teams…");

  const userRows = await q(`SELECT id, email FROM public."user"`);
  const userByEmail = {};
  for (const r of userRows.rows) userByEmail[r.email] = r.id;
  const uid = (email) => userByEmail[email];

  const teams = [
    // ── ACME Robotics teams ──────────────────────────────────────────────
    {
      id: "team-rob-hardware", name: "Hardware Engineering",
      org: "acme-robotics",
      members: [
        "isabela.souza@acme-robotics.example",
        "fenway.park@acme-robotics.example",
        "talia.novak@acme-group.example",   // cross-org member
      ],
    },
    {
      id: "team-rob-firmware", name: "Firmware",
      org: "acme-robotics",
      members: [
        "fenway.park@acme-robotics.example",
        "elena.rossi@acme-robotics.example",
      ],
    },
    {
      id: "team-rob-qa", name: "Quality Assurance",
      org: "acme-robotics",
      members: [
        "grace.okafor@acme-robotics.example",
      ],
    },
    {
      id: "team-rob-fieldops", name: "Field Operations",
      org: "acme-robotics",
      members: [
        "henrik.lund@acme-robotics.example",
      ],
    },
    // ── ACME Cloud Services teams ────────────────────────────────────────
    {
      id: "team-cloud-platform", name: "Platform Engineering",
      org: "acme-cloud",
      members: [
        "kira.tanaka@acme-cloud.example",
        "leo.fischer@acme-cloud.example",
        "talia.novak@acme-group.example",   // cross-org member (also on Robotics Hardware)
        "xenia.baker@acme-group.example",   // multi-team strategist
      ],
    },
    {
      id: "team-cloud-sre", name: "Site Reliability",
      org: "acme-cloud",
      members: [
        "leo.fischer@acme-cloud.example",
      ],
    },
    {
      id: "team-cloud-customer-success", name: "Customer Success",
      org: "acme-cloud",
      members: [
        "maya.patel@acme-cloud.example",
        "niko.ivanov@acme-cloud.example",
      ],
    },
    // ── ACME Studios teams ───────────────────────────────────────────────
    {
      id: "team-studios-creative", name: "Creative",
      org: "acme-studios",
      members: [
        "patrick.yu@acme-studios.example",
        "sven.larsson@acme-studios.example",
        "xenia.baker@acme-group.example",   // multi-team strategist
      ],
    },
    {
      id: "team-studios-production", name: "Production",
      org: "acme-studios",
      members: [
        "quinn.aldridge@acme-studios.example",
      ],
    },
    {
      id: "team-studios-sales", name: "Sales",
      org: "acme-studios",
      // Vera is the team lead (sole member here, used as "team-lead-only" profile)
      members: [
        "vera.petrov@acme-studios.example",
        "rosa.deleon@acme-studios.example",
      ],
    },
    // ── ACME Group cross-functional ──────────────────────────────────────
    {
      id: "team-group-executive", name: "Executive Committee",
      org: "acme-group",
      members: [
        "alice.cooper@acme-group.example",
        "bob.singh@acme-group.example",
        "carla.mendes@acme-group.example",
        "david.kim@acme-robotics.example",
        "jamal.bright@acme-cloud.example",
        "olivia.brand@acme-studios.example",
      ],
    },
    // ── Intentionally empty team (empty-state UI testing) ────────────────
    {
      id: "team-group-strategy", name: "Cross-Functional Strategy (empty)",
      org: "acme-group",
      members: [],
    },
    // ── Platform demo team for the real admin user ───────────────────────
    // The seeded ACME users live behind fictional `*.example` emails; the
    // real registered admin (any non-`usr-*` user id) does not appear in
    // those team rosters. Without this team the admin opens `/teams` after
    // a fresh seed and sees a populated DB-side `public."teamMember"` table
    // but zero membership rows that match their own user id — i.e. the
    // "no teams sample data" symptom the owner flagged. Membership is
    // wired below in the admin-backfill block.
    {
      id: "team-platform-demo", name: "Platform Demo",
      org: "acme-group",
      members: [],
    },
  ];

  for (const team of teams) {
    const orgId = orgMap[team.org];
    if (!orgId) { console.warn(`  skipping team ${team.name} — org ${team.org} not found`); continue; }

    // public.team.slug is NOT NULL with a UNIQUE (organizationId, slug) constraint
    // (team_slug_format CHECK: lowercase / hyphens / no leading-tilde / ≤63 chars).
    // The seed team IDs (e.g. "team-rob-hardware") already match the format and
    // are globally unique, so reuse them as the slug for the seeded fixture.
    await q(
      `INSERT INTO public.team (id, name, "organizationId", slug, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug`,
      [team.id, team.name, orgId, team.id]
    );

    for (const email of team.members) {
      const userId = uid(email);
      if (!userId) continue;

      // For UI/authz consistency, every team member must also be an org
      // member of the team's organization. This is the safety net for
      // cross-org users (Talia, Xenia) who are added to teams in other orgs.
      await q(
        `INSERT INTO public.member (id, "organizationId", "userId", role, "createdAt")
         VALUES ($1, $2, $3, 'member', NOW())
         ON CONFLICT DO NOTHING`,
        [`mem-${userId}-${team.org}`, orgId, userId]
      );

      await q(
        `INSERT INTO public."teamMember" (id, "teamId", "userId", "createdAt")
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT DO NOTHING`,
        [`tm-${team.id}-${userId}`, team.id, userId]
      );
    }
  }

  // ── Real-admin team-membership backfill ────────────────────────────────
  // Wires the registered admin user (the operator who actually opens the
  // app) into three seeded teams so `/teams` is non-empty for the only user
  // who'll be running the demo. Without this, the fictional `usr-*` users
  // are members of every team but the real admin is not. Idempotent via
  // `ON CONFLICT DO NOTHING` on the natural `teamMember.id` key.
  if (adminUserId) {
    const adminTeams = ["team-platform-demo", "team-rob-hardware", "team-cloud-platform"];
    for (const teamId of adminTeams) {
      const team = teams.find(t => t.id === teamId);
      const orgId = team ? orgMap[team.org] : null;
      if (!team || !orgId) continue;
      // Ensure the admin is an org member of the team's organization. The
      // admin is already seeded as `owner` of every ACME org by seedUsers,
      // but cross-org safety net mirrors the same guard used for the
      // fictional cross-org users (Talia, Xenia).
      await q(
        `INSERT INTO public.member (id, "organizationId", "userId", role, "createdAt")
         VALUES ($1, $2, $3, 'owner', NOW())
         ON CONFLICT DO NOTHING`,
        [`mem-${adminUserId}-${team.org}`, orgId, adminUserId]
      );
      await q(
        `INSERT INTO public."teamMember" (id, "teamId", "userId", "createdAt")
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT DO NOTHING`,
        [`tm-${teamId}-${adminUserId}`, teamId, adminUserId]
      );
    }
    console.log(`  backfilled admin into ${adminTeams.length} teams`);
  }

  console.log(`  created ${teams.length} teams (1 empty, 1 cross-org)`);
  return teams;
}

// ---------------------------------------------------------------------------
// Projects — owner scope model (user / team / organization)
// ---------------------------------------------------------------------------

async function seedProjects(orgMap, adminUserId) {
  console.log("Seeding projects…");

  const projects = [
    // User-owned (private workspace)
    {
      id: "proj-alice-scratchpad",
      name: "Research scratchpad",
      description: "Alice's private experiments and notes.",
      ownerLevel: "user",
      ownerId: "usr-alice-cooper",
      organizationId: orgMap["acme-group"],
      visibility: "private",
    },
    // Team-owned (2)
    {
      id: "proj-rob-q3-launch",
      name: "Q3 Hardware launch",
      description: "Cross-functional plan for the autumn product launch.",
      ownerLevel: "team",
      ownerId: "team-rob-hardware",
      organizationId: orgMap["acme-robotics"],
      visibility: "private",
    },
    {
      id: "proj-cloud-v2-migration",
      name: "Cloud Platform v2 migration",
      description: "Cut-over plan for the next-generation platform rollout.",
      ownerLevel: "team",
      ownerId: "team-cloud-platform",
      organizationId: orgMap["acme-cloud"],
      visibility: "private",
    },
    // Organization-owned (3)
    {
      id: "proj-group-brand-refresh",
      name: "ACME Group brand refresh",
      description: "Cross-subsidiary refresh of brand language and visual identity.",
      ownerLevel: "organization",
      ownerId: orgMap["acme-group"],
      organizationId: orgMap["acme-group"],
      visibility: "internal",
    },
    {
      id: "proj-rob-safety-audit",
      name: "Robotics safety audit",
      description: "Annual compliance and field-incident review.",
      ownerLevel: "organization",
      ownerId: orgMap["acme-robotics"],
      organizationId: orgMap["acme-robotics"],
      visibility: "internal",
    },
    {
      id: "proj-cloud-soc2-readiness",
      name: "Cloud SOC2 readiness",
      description: "Originally a small private effort (Jamal); promoted to org-level after scope expanded.",
      ownerLevel: "organization",
      ownerId: orgMap["acme-cloud"],
      organizationId: orgMap["acme-cloud"],
      visibility: "internal",
    },
  ];

  for (const p of projects) {
    if (!p.organizationId) {
      console.warn(`  skipping project ${p.name} — organizationId is null`);
      continue;
    }
    // cinatra.projects.slug is NOT NULL with UNIQUE per
    // (owner_level, owner_id, slug). Seed project IDs already match the slug
    // format and are globally unique — reuse them as the slug for the fixture.
    await q(
      `INSERT INTO cinatra.projects (id, name, description, owner_level, owner_id, organization_id, visibility, slug, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         owner_level = EXCLUDED.owner_level,
         owner_id = EXCLUDED.owner_id,
         organization_id = EXCLUDED.organization_id,
         visibility = EXCLUDED.visibility,
         slug = EXCLUDED.slug`,
      [p.id, p.name, p.description, p.ownerLevel, p.ownerId, p.organizationId, p.visibility, p.id]
    );
  }

  // Co-owner example: Bob is a co-owner of Alice's scratchpad.
  if (adminUserId) {
    await q(
      `INSERT INTO cinatra.project_co_owners (project_id, user_id, granted_by, granted_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT DO NOTHING`,
      ["proj-alice-scratchpad", "usr-bob-singh", "usr-alice-cooper"]
    );
  }

  console.log(`  created ${projects.length} projects (1 user, 2 team, 3 organization)`);
}

// ---------------------------------------------------------------------------
// RBAC grants — realistic access-control fixtures
//
// Without grants the seeded ACME data shows no realistic RBAC complexity. This
// fixture adds:
//   - 5 project_access grants across user/team principals (read/write/admin)
//   - 2 role_grant rows at organization scope
//   - 1 external customer user + project-scoped customer grant (showcases
//     the invite→revoke + scoped-view flow)
//
// Idempotency: project_access is wiped by `TRUNCATE cinatra.projects CASCADE`
// in wipeSeedableData (FK ON DELETE CASCADE). role_grant rows for seeded
// users are wiped by the user-deletion in the same function (FK ON DELETE
// CASCADE on subject_user_id). All inserts also carry ON CONFLICT clauses so
// running this function out of order or twice is safe.
// ---------------------------------------------------------------------------

async function seedRbacGrants(orgMap, adminUserId) {
  console.log("Seeding RBAC grants…");

  // ── project_access ─────────────────────────────────────────────────────
  //   N:M project access (read/write/admin) for user/team/org principals.
  //   PK (project_id, principal_level, principal_id). Role CHECK: read|write|admin.
  const projectAccess = [
    { projectId: "proj-rob-q3-launch",       level: "team", id: "team-rob-firmware",      role: "write" },
    { projectId: "proj-rob-q3-launch",       level: "team", id: "team-rob-qa",            role: "read"  },
    { projectId: "proj-cloud-v2-migration",  level: "team", id: "team-cloud-sre",         role: "admin" },
    // Same-org rule (cinatra.fn_project_access_same_org): the principal must be
    // a member of the project's org. proj-group-brand-refresh is in acme-group,
    // so the team principal here is the group's executive committee.
    { projectId: "proj-group-brand-refresh", level: "team", id: "team-group-executive",   role: "write" },
    { projectId: "proj-group-brand-refresh", level: "user", id: "usr-bob-singh",          role: "admin" },
  ];
  for (const g of projectAccess) {
    // principal_{user,team,org}_id are GENERATED columns (computed from
    // principal_level + principal_id), so they aren't INSERTable.
    await q(
      `INSERT INTO cinatra.project_access
         (project_id, principal_level, principal_id, role, granted_by, granted_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (project_id, principal_level, principal_id) DO UPDATE SET
         role = EXCLUDED.role,
         granted_by = EXCLUDED.granted_by`,
      [g.projectId, g.level, g.id, g.role, adminUserId],
    );
  }

  // ── role_grant ─────────────────────────────────────────────────────────
  //   Capability ceilings (developer | release_manager | customer) bound to
  //   a scope. PK (subject_user_id, role, scope_level, scope_record_id).
  //   Mix of org-scope (existing) + team-scope (added). Team-scope grants
  //   surface the per-team permission view at /projects/<id>/permissions
  //   and team detail pages.
  const roleGrants = [
    { subject: "usr-elena-rossi", role: "release_manager", scopeLevel: "organization",
      scopeRecordId: orgMap["acme-robotics"], orgId: orgMap["acme-robotics"] },
    { subject: "usr-leo-fischer",  role: "developer",       scopeLevel: "organization",
      scopeRecordId: orgMap["acme-cloud"],   orgId: orgMap["acme-cloud"] },
    // Team-scope grants — exercise the team-permission UI.
    { subject: "usr-leo-fischer",  role: "developer",       scopeLevel: "team",
      scopeRecordId: "team-cloud-platform", orgId: orgMap["acme-cloud"] },
    { subject: "usr-niko-ivanov",  role: "developer",       scopeLevel: "team",
      scopeRecordId: "team-cloud-platform", orgId: orgMap["acme-cloud"] },
    { subject: "usr-fenway-park",  role: "release_manager", scopeLevel: "team",
      scopeRecordId: "team-rob-hardware",   orgId: orgMap["acme-robotics"] },
    // Carla Mendes (acme-group member) is the right subject for a
    // platform-demo team grant: she's already an org member of acme-group,
    // so the team-scope grant is reachable in active-org flows.
    { subject: "usr-carla-mendes", role: "customer",        scopeLevel: "team",
      scopeRecordId: "team-platform-demo",  orgId: orgMap["acme-group"] },
  ];
  for (const r of roleGrants) {
    if (!r.scopeRecordId || !r.orgId) continue;
    await q(
      `INSERT INTO cinatra.role_grant
         (subject_user_id, role, scope_level, scope_record_id, org_id, granted_by, granted_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (subject_user_id, role, scope_level, scope_record_id) DO UPDATE SET
         org_id = EXCLUDED.org_id,
         granted_by = EXCLUDED.granted_by`,
      [r.subject, r.role, r.scopeLevel, r.scopeRecordId, r.orgId, adminUserId]
    );
  }

  // ── External customer + scoped customer grant ──────────────────────────
  //   Charlie is an external partner with project-scoped read access to the
  //   Robotics safety-audit project. Mirrors the two-write customer-grant
  //   model (cinatra.role_grant + cinatra.project_access).
  const customerUserId = "usr-charlie-customer";
  await q(
    `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role)
     VALUES ($1, $2, $3, true, NOW(), NOW(), null)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email`,
    [customerUserId, "Charlie Partner", "charlie@external-partner.example"]
  );
  if (orgMap["acme-robotics"]) {
    await q(
      `INSERT INTO public.member (id, "organizationId", "userId", role, "createdAt")
       VALUES ($1, $2, $3, 'member', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [`mem-${customerUserId}-acme-robotics`, orgMap["acme-robotics"], customerUserId]
    );
    await q(
      `INSERT INTO cinatra.role_grant
         (subject_user_id, role, scope_level, scope_record_id, org_id, granted_by, granted_at)
       VALUES ($1, 'customer', 'project', 'proj-rob-safety-audit', $2, $3, NOW())
       ON CONFLICT (subject_user_id, role, scope_level, scope_record_id) DO NOTHING`,
      [customerUserId, orgMap["acme-robotics"], adminUserId]
    );
    await q(
      `INSERT INTO cinatra.project_access
         (project_id, principal_level, principal_id, role, granted_by, granted_at)
       VALUES ('proj-rob-safety-audit', 'user', $1, 'read', $2, NOW())
       ON CONFLICT (project_id, principal_level, principal_id) DO NOTHING`,
      [customerUserId, adminUserId]
    );
  }

  console.log(
    `  created ${projectAccess.length} project_access grants, ${roleGrants.length} role_grants, 1 customer user (${customerUserId}) with project-scoped grant`,
  );
}

// ---------------------------------------------------------------------------
// CRM Data — fictional companies in mixed industries
// ---------------------------------------------------------------------------

function makeStartup({ id, slug, companyName, website, country, city, founded, summary, offeringSummary, contacts, enrichmentStatus = "partial" }) {
  const host = website.replace(/^https?:\/\//, "").split("/")[0];
  return {
    id, slug, companyName, website,
    websiteHost: host,
    country: country ?? "Generica",
    city, founded,
    raisedMillions: null,
    latestRaisedMillions: null,
    latestGithubStars: null,
    currentUpdates: [],
    summary,
    offeringSummary: offeringSummary ?? "",
    founderContacts: contacts.map((c, i) => ({
      id: id + "-c" + i,
      name: c.name,
      title: c.title ?? "",
      email: c.email ?? "",
      linkedinUrl: c.linkedinUrl ?? "",
      notes: c.notes ?? "",
    })),
    enrichmentNotes: [],
    enrichmentStatus,
    agentUrls: [],
    appearances: [],
    createdAt: now(),
    updatedAt: now(),
  };
}

async function seedCrmData() {
  console.log("Seeding CRM data (accounts + contacts)…");

  const startups = [
    // ── Public sector prospects ──────────────────────────────────────────
    makeStartup({
      id: "acc-northbrook-council",
      slug: "northbrook-county-council",
      companyName: "Northbrook County Council",
      website: "https://northbrook-council.example",
      city: "Northbrook",
      founded: 1974,
      summary: "Fictional county council managing services for ~120k residents. Evaluating sovereign collaboration tooling.",
      offeringSummary: "Public administration, citizen services, infrastructure planning",
      contacts: [
        { name: "Harriet Vance", title: "Chief Executive", email: "ceo@northbrook-council.example" },
        { name: "Idris Patel",   title: "Head of IT",     email: "it@northbrook-council.example" },
      ],
    }),
    makeStartup({
      id: "acc-midland-state-uni",
      slug: "midland-state-university",
      companyName: "Midland State University",
      website: "https://midland-state.example",
      city: "Midland",
      founded: 1962,
      summary: "Fictional state university with 28,000 students. IT department evaluating self-hosted video conferencing for teaching.",
      offeringSummary: "Higher education, research, 28,000+ students",
      contacts: [
        { name: "Prof. Joaquin Reyes", title: "President",       email: "president@midland-state.example" },
        { name: "Karine Boucher",      title: "CIO",             email: "cio@midland-state.example" },
        { name: "Lin Zhao",            title: "IT Project Lead", email: "lin.zhao@midland-state.example" },
      ],
    }),
    // ── Tech / SaaS ──────────────────────────────────────────────────────
    makeStartup({
      id: "acc-brightside-ai",
      slug: "brightside-ai",
      companyName: "BrightSide AI",
      website: "https://brightside-ai.example",
      city: "Lakeport",
      founded: 2021,
      summary: "Fictional applied-AI startup focused on document automation. ~40 employees. Series A.",
      offeringSummary: "AI-powered document understanding and workflow automation",
      contacts: [
        { name: "Mira Hollander", title: "CEO & Co-founder", email: "mira@brightside-ai.example", linkedinUrl: "https://linkedin.example/in/mirahollander" },
        { name: "Nate Olufemi",   title: "CTO",              email: "nate@brightside-ai.example" },
      ],
    }),
    makeStartup({
      id: "acc-quickform",
      slug: "quickform-platform",
      companyName: "QuickForm Platform Inc.",
      website: "https://quickform.example",
      city: "Riverbend",
      founded: 2017,
      summary: "Fictional no-code form builder with 50k+ paying customers. Considering an enterprise tier with SSO and audit logs.",
      offeringSummary: "No-code forms, automations, lightweight CRM",
      contacts: [
        { name: "Owen Marsh",   title: "CEO",              email: "owen@quickform.example" },
        { name: "Petra Solano", title: "VP Engineering",   email: "petra@quickform.example" },
        { name: "Ravi Bhatt",   title: "Head of Security", email: "security@quickform.example" },
      ],
    }),
    makeStartup({
      id: "acc-flintridge-devtools",
      slug: "flintridge-devtools",
      companyName: "Flintridge DevTools",
      website: "https://flintridge.example",
      city: "Flintridge",
      founded: 2019,
      summary: "Fictional developer-tools company building observability and CI primitives. ~110 employees.",
      offeringSummary: "Developer observability, CI pipelines, deployment automation",
      contacts: [
        { name: "Sigrid Andersen", title: "CEO",                email: "sigrid@flintridge.example" },
        { name: "Tarek Hassan",    title: "Head of Partnerships", email: "tarek@flintridge.example" },
      ],
    }),
    // ── Consumer brands ──────────────────────────────────────────────────
    makeStartup({
      id: "acc-cottage-coffee",
      slug: "cottage-coffee-co",
      companyName: "Cottage Coffee Co.",
      website: "https://cottagecoffee.example",
      city: "Maplewood",
      founded: 2008,
      summary: "Fictional specialty coffee retailer with 60 stores. Currently rebuilding their e-commerce platform.",
      offeringSummary: "Specialty coffee retail and direct-to-consumer subscriptions",
      contacts: [
        { name: "Uma Reddy",        title: "COO",                email: "uma@cottagecoffee.example" },
        { name: "Viktor Petrescu", title: "Head of E-commerce", email: "viktor@cottagecoffee.example" },
      ],
    }),
    makeStartup({
      id: "acc-westlake-outdoors",
      slug: "westlake-outdoors",
      companyName: "Westlake Outdoors",
      website: "https://westlake-outdoors.example",
      city: "Westlake",
      founded: 1996,
      summary: "Fictional outdoor-apparel brand. Looking to bring customer support in-house with a unified inbox.",
      offeringSummary: "Outdoor apparel, equipment, and adventure travel",
      contacts: [
        { name: "Wendy Chase", title: "CMO",                  email: "wendy@westlake-outdoors.example" },
        { name: "Xavier Holt", title: "Head of Customer Care", email: "xavier@westlake-outdoors.example" },
      ],
    }),
    makeStartup({
      id: "acc-blue-haven-resorts",
      slug: "blue-haven-resorts",
      companyName: "Blue Haven Resorts",
      website: "https://bluehaven.example",
      city: "Bayshore",
      founded: 2002,
      summary: "Fictional boutique-hotel chain with 14 properties. Building an internal AI concierge.",
      offeringSummary: "Hospitality and travel — boutique resorts and event venues",
      contacts: [
        { name: "Yara Saleh",   title: "VP Operations", email: "yara@bluehaven.example" },
        { name: "Zane Whitlock", title: "IT Director",  email: "zane@bluehaven.example" },
      ],
    }),
    // ── NGO / civil society ──────────────────────────────────────────────
    makeStartup({
      id: "acc-greenfield-trust",
      slug: "greenfield-conservation-trust",
      companyName: "Greenfield Conservation Trust",
      website: "https://greenfield-trust.example",
      city: "Greenfield",
      founded: 1983,
      summary: "Fictional environmental NGO. Self-hosts infrastructure; piloting privacy-first video for board meetings.",
      offeringSummary: "Environmental advocacy, land conservation, public-policy work",
      contacts: [
        { name: "Aine Murphy",    title: "Executive Director", email: "director@greenfield-trust.example" },
        { name: "Boris Kowalski", title: "Board Chair",        email: "chair@greenfield-trust.example" },
      ],
    }),
    makeStartup({
      id: "acc-civic-code-collective",
      slug: "civic-code-collective",
      companyName: "Civic Code Collective",
      website: "https://civiccode.example",
      city: "Old Town",
      founded: 2011,
      summary: "Fictional civic-tech non-profit. 4,000+ members. Advocates for open standards and accessible public services.",
      offeringSummary: "Civic technology, open source, accessibility advocacy",
      contacts: [
        { name: "Cyrus Eldridge",  title: "Spokesperson",       email: "press@civiccode.example" },
        { name: "Delphine Maurer", title: "Security Researcher", email: "delphine@civiccode.example" },
      ],
    }),
    // ── Industrial / manufacturing ───────────────────────────────────────
    makeStartup({
      id: "acc-ironforge-mfg",
      slug: "ironforge-manufacturing",
      companyName: "Ironforge Manufacturing",
      website: "https://ironforge.example",
      city: "Steelton",
      founded: 1978,
      summary: "Fictional industrial-equipment manufacturer with 3,200 employees. Modernizing field-service operations.",
      offeringSummary: "Heavy machinery, industrial automation, field service",
      contacts: [
        { name: "Eitan Bartolo",  title: "VP Operations", email: "eitan@ironforge.example" },
        { name: "Fanny Bergman", title: "CTO",            email: "tech@ironforge.example" },
        { name: "Guillermo Diaz", title: "Head of Partnerships", email: "partners@ironforge.example" },
      ],
    }),
    makeStartup({
      id: "acc-meridian-energy",
      slug: "meridian-energy-coop",
      companyName: "Meridian Energy Cooperative",
      website: "https://meridian-energy.example",
      city: "Northpoint",
      founded: 2006,
      summary: "Fictional regional energy cooperative running renewable-microgrid pilots for member towns.",
      offeringSummary: "Renewable-energy cooperative, microgrids, member services",
      contacts: [
        { name: "Hanna Krüger",  title: "CEO",                 email: "hanna@meridian-energy.example" },
        { name: "Ismael Castaneda", title: "Director of Operations", email: "ismael@meridian-energy.example" },
      ],
    }),
  ];

  for (const startup of startups) {
    await q(
      `INSERT INTO cinatra.startups (id, payload) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`,
      [startup.id, JSON.stringify(startup)]
    );
  }

  console.log(`  created ${startups.length} accounts with contacts`);
}
// Campaign types
// ---------------------------------------------------------------------------

async function seedCampaignTypes() {
  console.log("Seeding campaign types…");
  const types = [
    { id: "ct-outreach-email",    name: "Email Outreach Campaign",   category: "email_outreach", description: "Cold and warm outreach email sequences" },
    { id: "ct-event-followup",    name: "Event Follow-up Campaign",  category: "email_outreach", description: "Follow-ups after trade shows, webinars, conferences" },
    { id: "ct-newsletter",        name: "Newsletter Campaign",       category: "newsletter",     description: "Recurring newsletter to subscribers" },
    { id: "ct-content-promotion", name: "Content Promotion Campaign",category: "content",        description: "Promote blog posts, whitepapers, case studies" },
  ];
  for (const t of types) {
    await q(
      `INSERT INTO cinatra.campaign_types (id, payload) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`,
      [t.id, JSON.stringify(t)]
    );
  }
  console.log(`  created ${types.length} campaign types`);
}

// ---------------------------------------------------------------------------
// Canonical blog fixtures (cinatra.objects)
//
// Populates a demo blog project + idea + post at the canonical
// `@cinatra-ai/assets:blog-*` namespace so the assets browser, draft editor,
// and auto-mapping dispatcher all have something to render on a clean
// `cinatra setup dev` boot. Without these the blog screens would render empty.
//
// Idempotent: prior seed rows (source='seed-v62-blog') are wiped before
// re-inserting. ID prefixes are stable so consumers can link reliably.
// Owner: blog-pipeline-agent (the consumer of these types).
//
// This function seeds only blog objects. Accounts and contacts are not seeded
// canonically here.
// ---------------------------------------------------------------------------

async function seedCanonicalBlogFixtures() {
  console.log("Seeding canonical blog fixtures (cinatra.objects)…");

  await q(`DELETE FROM cinatra.objects WHERE source = 'seed-v62-blog'`);

  const projectId = "seed-v62-blog-project-acme-cloud";
  const ideaId    = "seed-v62-blog-idea-multi-region-launch";
  const postId    = "seed-v62-blog-post-multi-region-launch-overview";
  const now = new Date().toISOString();

  const defaultGenerationState = (msg) => ({
    status: "idle",
    message: msg,
    updatedAt: now,
  });

  await q(
    `INSERT INTO cinatra.objects
       (id, type, parent_id, parent_type, data, source, owner_level, visibility)
     VALUES ($1, $2, NULL, NULL, $3, 'seed-v62-blog', 'organization', 'organization')`,
    [
      projectId,
      "@cinatra-ai/assets:blog-project",
      JSON.stringify({
        id: projectId,
        name: "ACME Cloud — Engineering Blog",
        companyUrl: "https://acme-cloud.example",
        ideasPerTranscript: 1,
        transcriptIds: [],
        ideaGeneration:            defaultGenerationState("demo seed row"),
        postGeneration:            defaultGenerationState("demo seed row"),
        imageGeneration:           defaultGenerationState("demo seed row"),
        wordpressDraftGeneration:  defaultGenerationState("demo seed row"),
        linkedinDraftGeneration:   defaultGenerationState("demo seed row"),
        createdAt: now,
        updatedAt: now,
      }),
    ],
  );

  await q(
    `INSERT INTO cinatra.objects
       (id, type, parent_id, parent_type, data, source, owner_level, visibility)
     VALUES ($1, $2, $3, $4, $5, 'seed-v62-blog', 'organization', 'organization')`,
    [
      ideaId,
      "@cinatra-ai/assets:blog-idea",
      projectId,
      "@cinatra-ai/assets:blog-project",
      JSON.stringify({
        id: ideaId,
        projectId,
        transcriptId: "seed-v62-transcript-multi-region",
        transcriptTitle: "ACME Cloud Multi-Region Launch — Engineering AMA",
        title: "Multi-region scaling: what we learned in the first 90 days",
        createdAt: now,
      }),
    ],
  );

  await q(
    `INSERT INTO cinatra.objects
       (id, type, parent_id, parent_type, data, source, owner_level, visibility)
     VALUES ($1, $2, $3, $4, $5, 'seed-v62-blog', 'organization', 'organization')`,
    [
      postId,
      "@cinatra-ai/assets:blog-post",
      ideaId,
      "@cinatra-ai/assets:blog-idea",
      JSON.stringify({
        id: postId,
        ideaId,
        projectId,
        title: "Multi-region scaling: what we learned in the first 90 days",
        excerpt:
          "How ACME Cloud sharded its control plane across three regions without a downtime window, plus three concrete pitfalls we'd avoid next time.",
        createdAt: now,
        updatedAt: now,
      }),
    ],
  );

  console.log("  created 1 blog-project + 1 blog-idea + 1 blog-post (demo).");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Canonical extension demo fixtures
//
// Seeds a small matrix of installed_extension rows so the marketplace and
// lifecycle-discovery UX has visible diverse data on a fresh dev boot. Without
// this, every lifecycle affordance is invisible: zero archived rows, zero
// locked rows, zero rows with deps, zero non-verdaccio source types — empty
// filters, no Locked / Required / GitHub / Local badges, no disabled-action
// tooltips.
//
// Idempotent (DELETE WHERE manifest_hash starts with `seed-v64-`, then INSERT).
// All rows are demo data; manifest_hash carries the seed marker.
//
// DEV-ONLY: these are intentional dev fixtures and are re-created on every seed.
// On a NON-dev / shared / prod schema the six placeholder `@cinatra-ai/demo-*`
// rows (which map to no real bundled package) should be removed via a guarded
// DELETE matching seed-marker ∩ demo-name ∩ not-bundled, preserving the two
// seed rows that point at real bundled packages.
//
// Matrix:
//   row 1: agent      / active   / verdaccio   / required-in-prod      / locked
//   row 2: skill      / active   / github      / non-required          / active
//   row 3: connector  / archived / verdaccio   / non-required          / archived
//   row 4: artifact   / active   / local       / non-required          / active
//   row 5: workflow   / active   / verdaccio   / non-required          / active
//   row 6: agent      / active   / verdaccio   / non-required, has DEP / active
//                                                (declares row 1 as required dep
//                                                to demo dep-closure block)
//   row 7: skill      / locked   / verdaccio   / required-in-prod      / locked
//                                                (system-extension demo)
//   row 8: agent      / archived / github      / non-required          / archived
//                                                (demo of github source + archived)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dashboards — owner-tier variety so /dashboards is non-empty across all
// scopes (user / team / organization). Idempotent on `dash-seed-v65-%`.
// ---------------------------------------------------------------------------

async function seedDashboards(orgMap, adminUserId) {
  console.log("Seeding dashboards…");

  // dashboards.visibility CHECK constraint: ('private' | 'owners' | 'members').
  // We map user-owned to 'private' and team/org-owned to 'members' so peers
  // in the team/org can see the dashboard.
  const ownerLevel = (level, id, orgId) => ({ level, id, orgId });
  const dashboards = [
    {
      id: "dash-seed-v65-my-research",
      name: "My research",
      description: "Personal scratchpad — recent runs, saved queries, top contacts.",
      owner: ownerLevel("user", "usr-alice-cooper", orgMap["acme-group"]),
      visibility: "private",
    },
    {
      id: "dash-seed-v65-cloud-platform-health",
      name: "Cloud Platform health",
      description: "Platform Engineering team — SLO/error-rate dashboard.",
      owner: ownerLevel("team", "team-cloud-platform", orgMap["acme-cloud"]),
      visibility: "members",
    },
    {
      id: "dash-seed-v65-hardware-launch",
      name: "Q3 Hardware launch",
      description: "Robotics Hardware team — launch readiness + outstanding tasks.",
      owner: ownerLevel("team", "team-rob-hardware", orgMap["acme-robotics"]),
      visibility: "members",
    },
    {
      id: "dash-seed-v65-acme-overview",
      name: "ACME Group overview",
      description: "Cross-org KPIs — revenue, run volume, agent activity.",
      owner: ownerLevel("organization", "org-acme-group", orgMap["acme-group"]),
      visibility: "members",
    },
    {
      id: "dash-seed-v65-cost-summary",
      name: "Cost & usage",
      description: "Token spend by provider, per-agent cost, monthly budget burn.",
      owner: ownerLevel("organization", "org-acme-group", orgMap["acme-group"]),
      visibility: "members",
    },
  ];

  for (const d of dashboards) {
    if (!d.owner.orgId) continue;
    const config = {
      sections: [
        {
          title: "Recent activity",
          kind: "timeseries",
          query: { measure: "agent_runs.count", granularity: "day", lookbackDays: 14 },
        },
        {
          title: "Top entities",
          kind: "table",
          query: { dimensions: ["contact.name"], measures: ["agent_runs.count"], limit: 10 },
        },
      ],
    };
    await q(
      `INSERT INTO cinatra.dashboards
         (id, name, description, config_json, config_version, dashboard_version,
          published_revision_number, owner_level, owner_id, organization_id,
          visibility, status, created_by, updated_by, created_at, updated_at, published_at)
       VALUES ($1, $2, $3, $4::jsonb, '1', 1, 1, $5, $6, $7, $8, 'published', $9, $9, NOW(), NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         config_json = EXCLUDED.config_json,
         updated_at = NOW(),
         updated_by = EXCLUDED.updated_by`,
      [d.id, d.name, d.description, JSON.stringify(config), d.owner.level, d.owner.id, d.owner.orgId, d.visibility, adminUserId],
    );
    // 1 revision per dashboard so the history surface is non-empty.
    await q(
      `INSERT INTO cinatra.dashboard_revisions
         (dashboard_id, revision_number, config_json, config_version, created_by, created_at)
       VALUES ($1, 1, $2::jsonb, '1', $3, NOW())
       ON CONFLICT (dashboard_id, revision_number) DO UPDATE SET
         config_json = EXCLUDED.config_json,
         created_by = EXCLUDED.created_by`,
      [d.id, JSON.stringify(config), adminUserId],
    );
  }

  console.log(`  seeded ${dashboards.length} dashboards + ${dashboards.length} revisions`);
}

// ---------------------------------------------------------------------------
// Lists — static curated lists of CRM contacts/accounts. Lists live in the
// `objects` substrate (type `@cinatra-ai/lists:list`), not a dedicated table.
// Membership: { kind: "static", memberRefs: [{ objectType, objectId }, …] }.
// Idempotent on objects.source = 'seed-v65-lists'.
// ---------------------------------------------------------------------------

async function seedLists(orgMap, adminUserId) {
  console.log("Seeding lists…");

  // Resolve a small pool of existing contact + account objects from the CRM
  // fixture so lists point at real members. If the pools are smaller than
  // needed, lists shrink gracefully.
  const contactRows = await q(
    `SELECT id FROM cinatra.objects WHERE type = '@cinatra-ai/entity-contacts:contact' ORDER BY id LIMIT 24`,
  );
  const accountRows = await q(
    `SELECT id FROM cinatra.objects WHERE type = '@cinatra-ai/entity-accounts:account' ORDER BY id LIMIT 12`,
  );
  const contactIds = contactRows.rows.map(r => r.id);
  const accountIds = accountRows.rows.map(r => r.id);
  const contactRef = (id) => ({ objectType: "@cinatra-ai/entity-contacts:contact", objectId: id });
  const accountRef = (id) => ({ objectType: "@cinatra-ai/entity-accounts:account", objectId: id });

  const orgAcme = orgMap["acme-group"] ?? "org-acme-group";
  const lists = [
    {
      id: "obj-list-seed-v65-icp-robotics",
      name: "ICP — fast-growing robotics startups",
      description: "Target accounts for the Robotics Q3 outreach play.",
      memberType: "account",
      members: accountIds.slice(0, 5).map(accountRef),
      owner: { level: "team", id: "team-rob-hardware", orgId: orgMap["acme-robotics"] ?? orgAcme },
    },
    {
      id: "obj-list-seed-v65-cloud-q3-prospects",
      name: "Top 10 Q3 cloud prospects",
      description: "Cloud platform — biggest deals in flight this quarter.",
      memberType: "account",
      members: accountIds.slice(2, 10).map(accountRef),
      owner: { level: "team", id: "team-cloud-platform", orgId: orgMap["acme-cloud"] ?? orgAcme },
    },
    {
      id: "obj-list-seed-v65-press-contacts",
      name: "Press contacts (recent)",
      description: "Journalists we briefed in the last quarter.",
      memberType: "contact",
      members: contactIds.slice(0, 8).map(contactRef),
      owner: { level: "organization", id: "org-acme-group", orgId: orgAcme },
    },
    {
      id: "obj-list-seed-v65-brand-stakeholders",
      name: "Brand refresh stakeholders",
      description: "Internal + external reviewers for the ACME Group brand refresh.",
      memberType: "contact",
      members: contactIds.slice(4, 12).map(contactRef),
      owner: { level: "user", id: "usr-alice-cooper", orgId: orgAcme },
    },
    {
      id: "obj-list-seed-v65-hardware-launch-partners",
      name: "Hardware launch partners",
      description: "Channel + integration partners coordinating around the Q3 launch.",
      memberType: "account",
      members: accountIds.slice(0, 6).map(accountRef),
      owner: { level: "team", id: "team-rob-fieldops", orgId: orgMap["acme-robotics"] ?? orgAcme },
    },
  ];

  let inserted = 0;
  for (const l of lists) {
    if (l.members.length === 0) continue;
    const data = {
      name: l.name,
      description: l.description,
      memberType: l.memberType,
      membership: { kind: "static", memberRefs: l.members },
    };
    await q(
      `INSERT INTO cinatra.objects
         (id, type, data, source, owner_level, owner_id, org_id, created_by, created_at, updated_at)
       VALUES ($1, '@cinatra-ai/lists:list', $2::jsonb, 'seed-v65-lists', $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         data = EXCLUDED.data,
         source = EXCLUDED.source,
         updated_at = NOW()`,
      [l.id, JSON.stringify(data), l.owner.level, l.owner.id, l.owner.orgId, adminUserId],
    );
    inserted += 1;
  }
  console.log(`  seeded ${inserted} lists (${contactIds.length} contacts + ${accountIds.length} accounts available as members)`);
}

// ---------------------------------------------------------------------------
// Chat threads — two fictional user-owned demo threads so the /chat surface
// renders non-empty. The real admin's chat history stays untouched — only
// `usr-*` users own seeded threads. Idempotent on id prefix `chat-seed-v65-%`.
// ---------------------------------------------------------------------------

async function seedChatThreads() {
  console.log("Seeding chat threads…");

  const threads = [
    {
      id: "chat-seed-v65-alice-outreach-angles",
      payload: {
        id: "chat-seed-v65-alice-outreach-angles",
        title: "Brainstorming Q3 outreach angles",
        ownerUserId: "usr-alice-cooper",
        orgId: "org-acme-group",
        messages: [
          { role: "user", content: "Help me brainstorm three angles for Q3 outreach to robotics startups." },
          { role: "assistant", content: "Three angles to consider: (1) safety-audit fast-track for fleets ≥100 robots, (2) firmware-rollback-as-a-service for OEMs, (3) shared spares-pool for early-stage labs. Want me to draft email templates for any of these?" },
          { role: "user", content: "The safety-audit angle. Make it punchy and 4 lines max." },
          { role: "assistant", content: "Subject: 100 robots? Skip the 6-month audit.\nHi {{contact_first_name_or_company}}, we're shipping safety audits in 2 weeks for fleets your size. One call, no consultants. Reply if you want a 20-min walkthrough." },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
    {
      id: "chat-seed-v65-leo-platform-walkthrough",
      payload: {
        id: "chat-seed-v65-leo-platform-walkthrough",
        title: "Walking through the platform",
        ownerUserId: "usr-leo-fischer",
        orgId: "org-acme-cloud",
        messages: [
          { role: "user", content: "Explain how a workflow approval gate works." },
          { role: "assistant", content: "When a workflow_task reaches an `approval` type, the engine writes a `workflow_approval` row with status `pending` and the required scope (org / team / project). The configured approver list resolves at evaluation time; once one approver decides, the row's status flips to `granted` / `rejected` / `needs_revision` and the gate releases the dependent tasks." },
          { role: "user", content: "Where do I see pending approvals as an approver?" },
          { role: "assistant", content: "Two places: the per-workflow detail page surfaces them inline on the Gantt; the dedicated `/workflows?status=active` filter sorts by approval-blocked first." },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  ];

  for (const t of threads) {
    await q(
      `INSERT INTO cinatra.chat_threads (id, payload)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`,
      [t.id, JSON.stringify(t.payload)],
    );
  }
  console.log(`  seeded ${threads.length} chat threads`);
}

// ---------------------------------------------------------------------------
// Release Workflows — 6 templates + 15 instances spanning every status
// (draft / active / paused / completed / failed / cancelled), every task
// status, and every approval status (pending / granted / rejected /
// needs_revision). Spread across all 3 ACME orgs because `/workflows`
// filters by exact `workflow.org_id` match against actor.activeOrgId — the
// admin must see workflows in every org they switch to. Idempotent: the
// wipe block at the top of wipeSeedableData deletes by `wf-seed-v65-%` and
// `wftpl-seed-v65-%` prefixes in FK-safe order.
// ---------------------------------------------------------------------------

async function seedWorkflows(orgMap, adminUserId) {
  console.log("Seeding release workflows…");

  const orgGroup = orgMap["acme-group"] ?? "org-acme-group";
  const orgRobotics = orgMap["acme-robotics"] ?? "org-acme-robotics";
  const orgCloud = orgMap["acme-cloud"] ?? "org-acme-cloud";

  const daysFromNow = (n) => new Date(Date.now() + n * 86_400_000);
  // The cascade-demo fixture derives EVERY date (target + each task window) from
  // ONE captured instant so the static planned columns equal the schedule
  // resolver's output exactly — `daysFromNow` re-reads `Date.now()` per call and
  // could drift across a millisecond boundary, breaking that equality.
  const cascadeBase = Date.now();
  const cascadeDay = (n) => new Date(cascadeBase + n * 86_400_000);

  // ── Templates ──────────────────────────────────────────────────────────
  const templates = [
    {
      id: "wftpl-seed-v65-major-product-release",
      key: "major-product-release",
      name: "Major Product Release",
      orgId: orgGroup,
      description: "8-step DAG: kickoff → eng-readiness → docs → legal-sign-off → comms-blog → comms-linkedin → launch-day → post-launch-retro.",
      definition: {
        schemaVersion: 1,
        placeholders: [{ key: "product", type: "string", required: true }],
        tasks: [
          { key: "kickoff", type: "checkpoint", title: "Release kickoff" },
          { key: "eng-readiness", type: "agent_task", title: "Engineering readiness check", agentRef: { package: "@cinatra-ai/code-reviewer-agent" }, dependsOn: [{ taskKey: "kickoff" }] },
          { key: "docs", type: "agent_task", title: "Documentation update", agentRef: { package: "@cinatra-ai/author-agent" }, dependsOn: [{ taskKey: "eng-readiness" }] },
          { key: "legal-sign-off", type: "approval", title: "Legal sign-off", requiredScope: { level: "organization" }, dependsOn: [{ taskKey: "docs" }] },
          { key: "comms-blog", type: "agent_task", title: "Launch blog draft", agentRef: { package: "@cinatra-ai/blog-pipeline-agent" }, dependsOn: [{ taskKey: "legal-sign-off" }] },
          { key: "comms-linkedin", type: "agent_task", title: "LinkedIn announcement", agentRef: { package: "@cinatra-ai/blog-linkedin-writer-agent" }, dependsOn: [{ taskKey: "comms-blog" }] },
          { key: "launch-day", type: "checkpoint", title: "Launch day", dependsOn: [{ taskKey: "comms-linkedin" }] },
          { key: "post-launch-retro", type: "manual", title: "Post-launch retro", dependsOn: [{ taskKey: "launch-day" }] },
        ],
      },
    },
    {
      id: "wftpl-seed-v65-hotfix-release",
      key: "hotfix-release",
      name: "Hotfix Release",
      orgId: orgCloud,
      description: "Fast-iteration hotfix DAG: triage → fix → patch-release → comms-update.",
      definition: {
        schemaVersion: 1,
        tasks: [
          { key: "triage", type: "checkpoint", title: "Incident triage" },
          { key: "fix", type: "agent_task", title: "Patch implementation", agentRef: { package: "@cinatra-ai/code-reviewer-agent" }, dependsOn: [{ taskKey: "triage" }] },
          { key: "patch-release", type: "checkpoint", title: "Patch release", dependsOn: [{ taskKey: "fix" }] },
          { key: "comms-update", type: "agent_task", title: "Customer update", agentRef: { package: "@cinatra-ai/author-agent" }, dependsOn: [{ taskKey: "patch-release" }] },
        ],
      },
    },
    {
      id: "wftpl-seed-v65-security-patch-release",
      key: "security-patch-release",
      name: "Security Patch Release",
      orgId: orgCloud,
      description: "CVE intake → patch → security-review → coordinated disclosure → release.",
      definition: {
        schemaVersion: 1,
        tasks: [
          { key: "cve-intake", type: "checkpoint", title: "CVE intake" },
          { key: "patch", type: "agent_task", title: "Patch", agentRef: { package: "@cinatra-ai/security-reviewer-agent" }, dependsOn: [{ taskKey: "cve-intake" }] },
          { key: "security-review", type: "approval", title: "Security review sign-off", requiredScope: { level: "organization" }, dependsOn: [{ taskKey: "patch" }] },
          { key: "disclosure", type: "manual", title: "Coordinated disclosure", dependsOn: [{ taskKey: "security-review" }] },
          { key: "release", type: "checkpoint", title: "Patch release", dependsOn: [{ taskKey: "disclosure" }] },
        ],
      },
    },
    {
      id: "wftpl-seed-v65-beta-release",
      key: "beta-release",
      name: "Beta Release",
      orgId: orgRobotics,
      description: "Beta cohort lifecycle: kickoff → beta-blog → cohort-invites → feedback-windows → GA decision.",
      definition: {
        schemaVersion: 1,
        tasks: [
          { key: "kickoff", type: "checkpoint", title: "Beta kickoff" },
          { key: "beta-blog", type: "agent_task", title: "Beta announcement", agentRef: { package: "@cinatra-ai/blog-pipeline-agent" }, dependsOn: [{ taskKey: "kickoff" }] },
          { key: "cohort-invites", type: "agent_task", title: "Invite beta cohort", agentRef: { package: "@cinatra-ai/email-outreach-agent" }, dependsOn: [{ taskKey: "beta-blog" }] },
          { key: "feedback-windows", type: "manual", title: "Collect feedback (2-week window)", dependsOn: [{ taskKey: "cohort-invites" }] },
          { key: "ga-decision", type: "manual", title: "GA / extend decision", dependsOn: [{ taskKey: "feedback-windows" }] },
        ],
      },
    },
    {
      id: "wftpl-seed-v65-marketing-campaign-approval",
      key: "marketing-campaign-approval",
      name: "Marketing Campaign Approval",
      orgId: orgGroup,
      description: "Marketing creative → legal-sign-off → exec-sign-off → publish.",
      definition: {
        schemaVersion: 1,
        tasks: [
          { key: "brief", type: "checkpoint", title: "Campaign brief" },
          { key: "creative-draft", type: "agent_task", title: "Creative draft", agentRef: { package: "@cinatra-ai/blog-linkedin-writer-agent" }, dependsOn: [{ taskKey: "brief" }] },
          { key: "legal-sign-off", type: "approval", title: "Legal sign-off", requiredScope: { level: "organization" }, dependsOn: [{ taskKey: "creative-draft" }] },
          { key: "exec-sign-off", type: "approval", title: "Exec sign-off", requiredScope: { level: "organization" }, dependsOn: [{ taskKey: "legal-sign-off" }] },
          { key: "publish", type: "checkpoint", title: "Publish", dependsOn: [{ taskKey: "exec-sign-off" }] },
        ],
      },
    },
    {
      id: "wftpl-seed-v65-compliance-review",
      key: "compliance-review",
      name: "Quarterly Compliance Review",
      orgId: orgGroup,
      description: "Scope → controls audit → remediation → exec-sign-off → file.",
      definition: {
        schemaVersion: 1,
        tasks: [
          { key: "scope", type: "checkpoint", title: "Scope definition" },
          { key: "controls-audit", type: "agent_task", title: "Controls audit", agentRef: { package: "@cinatra-ai/security-reviewer-agent" }, dependsOn: [{ taskKey: "scope" }] },
          { key: "remediation", type: "manual", title: "Remediation tasks", dependsOn: [{ taskKey: "controls-audit" }] },
          { key: "exec-sign-off", type: "approval", title: "Exec sign-off", requiredScope: { level: "organization" }, dependsOn: [{ taskKey: "remediation" }] },
          { key: "file", type: "checkpoint", title: "File compliance report", dependsOn: [{ taskKey: "exec-sign-off" }] },
        ],
      },
    },
  ];

  for (const t of templates) {
    await q(
      `INSERT INTO cinatra.workflow_template
         (id, key, version, name, description, definition, owner_level, owner_id, org_id, visibility, created_by, created_at, updated_at)
       VALUES ($1, $2, 1, $3, $4, $5::jsonb, 'organization', $6, $6, 'organization', $7, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         definition = EXCLUDED.definition,
         updated_at = NOW()`,
      [t.id, t.key, t.name, t.description, JSON.stringify(t.definition), t.orgId, adminUserId],
    );
  }

  // ── Instance helper ────────────────────────────────────────────────────
  // Inserts a workflow + its tasks + dependencies + (optional) attempts +
  // approvals + events + gates + artifacts. Idempotency is owned by the
  // wipe block at the top of wipeSeedableData (DELETE by prefix); inserts
  // here are unconditional.
  async function insertWorkflow(wf) {
    const {
      id, name, product, status, targetAt, sourceTemplateId, orgId,
      tasks, dependencies = [], attempts = [], approvals = [], events = [],
      gates = [], artifacts = [],
    } = wf;
    await q(
      `INSERT INTO cinatra.workflow
         (id, source_template_id, source_template_version, name, product,
          target_at_utc, target_tz, status, owner_level, owner_id, org_id,
          spec_version, lock_version, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'UTC', $7, 'organization', $8, $8, 1, 1, $9, NOW(), NOW())`,
      [id, sourceTemplateId ?? null, sourceTemplateId ? 1 : null, name, product, targetAt, status, orgId, adminUserId],
    );
    const taskIdByKey = new Map();
    for (const t of tasks) {
      const taskId = `${id}-task-${t.key}`;
      taskIdByKey.set(t.key, taskId);
      await q(
        `INSERT INTO cinatra.workflow_task
           (id, workflow_id, key, type, title, status,
            agent_package, agent_ref,
            planned_start_utc, planned_end_utc, due_at_utc,
            actual_start_utc, actual_end_utc, schedule, anchor, lock_version,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, 1, NOW(), NOW())`,
        [
          taskId, id, t.key, t.type, t.title, t.status,
          t.agentPackage ?? null,
          t.agentRef ? JSON.stringify(t.agentRef) : null,
          // Pass `start` and/or `end` per task to model a multi-day span (SVAR
          // renders as a real Gantt bar). Default keeps the old point-in-time
          // behavior: planned_start = planned_end = due (SVAR milestone diamond).
          t.start ?? t.due ?? null,
          t.end ?? t.due ?? null,
          t.due ?? null,
          t.actualStart ?? null,
          t.actualEnd ?? null,
          // Relative `schedule` jsonb makes a target-date move cascade this task
          // (offset from the anchor) instead of collapsing it to the target.
          // The denormalized `anchor` column mirrors insertSpecRows so the
          // resolver/cascade read it without re-parsing the schedule.
          t.schedule ? JSON.stringify(t.schedule) : null,
          t.schedule?.mode === "relative"
            ? JSON.stringify({ anchor: t.schedule.anchor, point: t.schedule.anchorPoint ?? "due" })
            : null,
        ],
      );
    }
    // Two-phase parent_task_id write: every row exists now, so
    // resolve `parent` keys → ids and UPDATE; doing this in the INSERT would
    // FK-violate whenever a child appears before its parent in the fixture.
    for (const t of tasks) {
      if (!t.parent) continue;
      const parentId = taskIdByKey.get(t.parent);
      if (!parentId) continue;
      await q(
        `UPDATE cinatra.workflow_task SET parent_task_id = $1 WHERE id = $2`,
        [parentId, taskIdByKey.get(t.key)],
      );
    }
    for (const d of dependencies) {
      await q(
        `INSERT INTO cinatra.workflow_dependency
           (id, workflow_id, task_id, depends_on_task_id, outcome)
         VALUES ($1, $2, $3, $4, 'success')`,
        [`${id}-dep-${d.from}-${d.to}`, id, taskIdByKey.get(d.to), taskIdByKey.get(d.from)],
      );
    }
    for (const g of gates) {
      // workflow_gate.state ∈ {pending, passed, blocked, not_required}.
      await q(
        `INSERT INTO cinatra.workflow_gate
           (id, workflow_id, task_id, gate_kind, state, reason, evaluated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [`${id}-gate-${g.taskKey}-${g.kind}`, id, taskIdByKey.get(g.taskKey), g.kind, g.state, g.reason ?? null],
      );
    }
    for (const a of attempts) {
      await q(
        `INSERT INTO cinatra.workflow_task_attempt
           (id, workflow_id, task_id, attempt_no, idempotency_key, status,
            started_at, completed_at, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          `${id}-att-${a.taskKey}-${a.attemptNo}`,
          id, taskIdByKey.get(a.taskKey), a.attemptNo,
          `${id}:${a.taskKey}:${a.attemptNo}`,
          a.status, a.startedAt ?? null, a.completedAt ?? null,
          a.error ? JSON.stringify(a.error) : null,
        ],
      );
    }
    for (const ap of approvals) {
      // notification_state.solicitedAt encodes that the reconciler has
      // OPENED the approval (timing + deps satisfied → approver list
      // notified). The UI + decision CAS treat `pending + solicitedAt`
      // as actionable. Right pattern:
      //   - Decided rows (granted / rejected / needs_revision) were
      //     necessarily opened first → ALWAYS stamp.
      //   - Pending rows: stamp ONLY when the fixture deliberately
      //     models a deliberately-open pending (upstream deps satisfied,
      //     approver awaiting). Set `solicitedAt: true` (or a Date) in
      //     the fixture literal. Pending rows behind blocked deps must
      //     omit solicitedAt — otherwise they look prematurely actionable.
      const decided = ap.status !== "pending";
      const explicit = ap.solicitedAt;
      const shouldStamp = decided || Boolean(explicit);
      let notificationState = null;
      if (shouldStamp) {
        const stampAt = explicit instanceof Date
          ? explicit.toISOString()
          : (ap.decidedAt instanceof Date ? ap.decidedAt.toISOString() : new Date().toISOString());
        notificationState = { solicitedAt: stampAt };
      }
      await q(
        `INSERT INTO cinatra.workflow_approval
           (id, workflow_id, task_id, required_scope, status,
            notification_state, decided_by, decided_at, reason)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9)`,
        [
          `${id}-apr-${ap.taskKey}`, id, taskIdByKey.get(ap.taskKey),
          JSON.stringify(ap.requiredScope), ap.status,
          notificationState ? JSON.stringify(notificationState) : null,
          ap.decidedBy ?? null, ap.decidedAt ?? null, ap.reason ?? null,
        ],
      );
    }
    for (const ar of artifacts) {
      await q(
        `INSERT INTO cinatra.workflow_artifact
           (id, workflow_id, task_id, kind, ref, version, pinned)
         VALUES ($1, $2, $3, $4, $5, 1, true)`,
        [`${id}-art-${ar.taskKey}-${ar.kind}`, id, taskIdByKey.get(ar.taskKey), ar.kind, ar.ref],
      );
    }
    for (const e of events) {
      await q(
        `INSERT INTO cinatra.workflow_event
           (id, workflow_id, task_key, kind, source, actor_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          `${id}-evt-${e.kind}-${e.taskKey ?? "wf"}-${e.at.getTime()}`,
          id, e.taskKey ?? null, e.kind, e.source, adminUserId, e.at,
        ],
      );
    }
  }

  // ── Instances ──────────────────────────────────────────────────────────
  // 17 instances spread across the three ACME orgs. Status coverage:
  //   active (7), completed (3), draft (3), failed (2), cancelled (1),
  //   paused (1) — every status surfaced.
  // Approval coverage: pending, granted, rejected, needs_revision — all four.
  // Task-status coverage: idle, scheduled, running, succeeded, failed,
  // cancelled, skipped, pending_approval — all surfaced.
  const instances = [
    // ── Major Product Release (group) ───────────────────────────────────
    { id: "wf-seed-v65-major-release-draft-q1", name: "Q1 Platform Launch (planning)", product: "ACME Cloud", status: "draft",
      targetAt: daysFromNow(75), orgId: orgGroup, sourceTemplateId: "wftpl-seed-v65-major-product-release",
      tasks: [
        // Mix: 2 milestones (kickoff, launch) bookend 3 span bars so the Gantt
        // shows real-shape variety on the user's primary repro workflow.
        { key: "kickoff", type: "checkpoint", title: "Release kickoff", status: "idle", due: daysFromNow(60) },
        { key: "eng-readiness", type: "agent_task", title: "Engineering readiness check", status: "idle",
          start: daysFromNow(60), end: daysFromNow(63), due: daysFromNow(63),
          agentPackage: "@cinatra-ai/code-reviewer-agent", agentRef: { package: "@cinatra-ai/code-reviewer-agent" } },
        { key: "docs", type: "agent_task", title: "Documentation update", status: "idle",
          start: daysFromNow(63), end: daysFromNow(68), due: daysFromNow(68),
          agentPackage: "@cinatra-ai/author-agent", agentRef: { package: "@cinatra-ai/author-agent" } },
        { key: "legal-sign-off", type: "approval", title: "Legal sign-off", status: "idle",
          start: daysFromNow(68), end: daysFromNow(70), due: daysFromNow(70) },
        { key: "launch-day", type: "checkpoint", title: "Launch day", status: "idle", due: daysFromNow(75) },
      ],
      dependencies: [
        { from: "kickoff", to: "eng-readiness" }, { from: "eng-readiness", to: "docs" },
        { from: "docs", to: "legal-sign-off" }, { from: "legal-sign-off", to: "launch-day" },
      ],
      gates: [{ taskKey: "kickoff", kind: "dependency", state: "pending" }],
      events: [{ kind: "workflow_created", source: "ui", at: daysFromNow(-1) }],
    },
    // Dedicated mixed-shapes demo: 3 point milestones + 4 span bars covering
    // all 6 task types (checkpoint, agent_task, manual, notification, approval,
    // wait). Draft so the user can drag-test span bars and milestones side by
    // side. Linear dep chain.
    { id: "wf-seed-v65-major-release-draft-mixed-gantt", name: "Demo: Mixed Gantt Shapes",
      product: "ACME Platform", status: "draft",
      targetAt: daysFromNow(30), orgId: orgGroup,
      sourceTemplateId: "wftpl-seed-v65-major-product-release",
      tasks: [
        { key: "kickoff", type: "checkpoint", title: "Kickoff (milestone)", status: "idle",
          due: daysFromNow(1) },
        { key: "design", type: "agent_task", title: "Design review (5d span)", status: "idle",
          start: daysFromNow(2), end: daysFromNow(7), due: daysFromNow(7),
          agentPackage: "@cinatra-ai/code-reviewer-agent",
          agentRef: { package: "@cinatra-ai/code-reviewer-agent" } },
        { key: "build", type: "manual", title: "Build implementation (10d span)", status: "idle",
          start: daysFromNow(8), end: daysFromNow(18), due: daysFromNow(18) },
        { key: "beta-notice", type: "notification", title: "Beta notice window (3d span)", status: "idle",
          start: daysFromNow(19), end: daysFromNow(22), due: daysFromNow(22) },
        { key: "exec-sign", type: "approval", title: "Exec sign-off (milestone)", status: "idle",
          due: daysFromNow(24) },
        { key: "soak", type: "wait", title: "Soak period (4d span)", status: "idle",
          start: daysFromNow(25), end: daysFromNow(29), due: daysFromNow(29) },
        { key: "launch", type: "checkpoint", title: "Launch day (milestone)", status: "idle",
          due: daysFromNow(30) },
      ],
      dependencies: [
        { from: "kickoff", to: "design" },
        { from: "design", to: "build" },
        { from: "build", to: "beta-notice" },
        { from: "beta-notice", to: "exec-sign" },
        { from: "exec-sign", to: "soak" },
        { from: "soak", to: "launch" },
      ],
      gates: [{ taskKey: "kickoff", kind: "dependency", state: "pending" }],
      events: [{ kind: "workflow_created", source: "ui", at: daysFromNow(-1) }],
    },
    // Dedicated target-date CASCADE demo: every task is RELATIVE-scheduled to the
    // target so moving the release date in the Gantt fans the whole plan out
    // (each task shifts by its own offset) instead of collapsing onto the target
    // — the behavior an unscheduled task would (wrongly) show. Milestones use the
    // default `due` anchor (no duration) so they stay directly drag-editable AND
    // cascade. The 4 span bars carry `anchorPoint:"end"`+`durationIso8601`, which
    // the drag path rejects (`unsupported_in_slice`): here they move via the
    // target-date cascade or chat, NOT direct drag — drag-test span bars on the
    // "Mixed Gantt Shapes" fixture above. Dates derive from one `cascadeBase`
    // instant so the static planned columns match the resolver output exactly.
    { id: "wf-seed-v65-major-release-draft-cascade", name: "Demo: Release Cascade",
      product: "ACME Platform", status: "draft",
      targetAt: cascadeDay(30), orgId: orgGroup,
      sourceTemplateId: "wftpl-seed-v65-major-product-release",
      tasks: [
        { key: "kickoff", type: "checkpoint", title: "Kickoff (milestone)", status: "idle",
          due: cascadeDay(1),
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P29D", direction: "before" } },
        { key: "design", type: "agent_task", title: "Design review (5d span)", status: "idle",
          start: cascadeDay(2), end: cascadeDay(7), due: cascadeDay(7),
          agentPackage: "@cinatra-ai/code-reviewer-agent",
          agentRef: { package: "@cinatra-ai/code-reviewer-agent" },
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P23D", direction: "before", anchorPoint: "end", durationIso8601: "P5D" } },
        { key: "build", type: "manual", title: "Build implementation (10d span)", status: "idle",
          start: cascadeDay(8), end: cascadeDay(18), due: cascadeDay(18),
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P12D", direction: "before", anchorPoint: "end", durationIso8601: "P10D" } },
        { key: "beta-notice", type: "notification", title: "Beta notice window (3d span)", status: "idle",
          start: cascadeDay(19), end: cascadeDay(22), due: cascadeDay(22),
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P8D", direction: "before", anchorPoint: "end", durationIso8601: "P3D" } },
        { key: "exec-sign", type: "approval", title: "Exec sign-off (milestone)", status: "idle",
          due: cascadeDay(24),
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P6D", direction: "before" } },
        { key: "soak", type: "wait", title: "Soak period (4d span)", status: "idle",
          start: cascadeDay(25), end: cascadeDay(29), due: cascadeDay(29),
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P1D", direction: "before", anchorPoint: "end", durationIso8601: "P4D" } },
        { key: "launch", type: "checkpoint", title: "Launch day (milestone)", status: "idle",
          due: cascadeDay(30),
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P0D", direction: "before" } },
      ],
      dependencies: [
        { from: "kickoff", to: "design" },
        { from: "design", to: "build" },
        { from: "build", to: "beta-notice" },
        { from: "beta-notice", to: "exec-sign" },
        { from: "exec-sign", to: "soak" },
        { from: "soak", to: "launch" },
      ],
      gates: [{ taskKey: "kickoff", kind: "dependency", state: "pending" }],
      events: [{ kind: "workflow_created", source: "ui", at: cascadeDay(-1) }],
    },
    // Hierarchical demo — one summary parent ("summary") rolling up 3 leaf
    // children (design, build, ship). Reviewers see SVAR's rollup bar +
    // collapse/expand. DRAFT-only — `validateStart` rejects hierarchical
    // specs with HIERARCHY_NOT_RUNNABLE (executing summary parents is
    // future scope). The leaf children carry relative schedules
    // anchored to target so a target move ALSO demonstrates hierarchy + cascade
    // together; the parent's window auto-derives from min(child.start) /
    // max(child.end) / max(child.due). The parent task carries no schedule —
    // validation now rejects own-schedule/pinned on parents.
    { id: "wf-seed-v65-major-release-draft-hierarchy", name: "Demo: Hierarchical Release",
      product: "ACME Platform", status: "draft",
      targetAt: daysFromNow(30), orgId: orgGroup,
      sourceTemplateId: "wftpl-seed-v65-major-product-release",
      tasks: [
        // Parent window is min(child.start) / max(child.end) / max(child.due)
        // = (design.start=day 2, ship.due=day 30, ship.due=day 30). The seed
        // path bypasses resolveSchedule, so write the derived dates directly
        // (the live spec/writer path computes this from the children via the
        // resolver's parent-pass — see resolveSchedule in
        // packages/workflows/src/schedule/resolver.ts).
        { key: "summary", type: "checkpoint", title: "Summary", status: "idle",
          start: daysFromNow(2), end: daysFromNow(30), due: daysFromNow(30) },
        { key: "design", type: "agent_task", title: "Design", status: "idle",
          parent: "summary",
          start: daysFromNow(2), end: daysFromNow(7), due: daysFromNow(7),
          agentPackage: "@cinatra-ai/code-reviewer-agent",
          agentRef: { package: "@cinatra-ai/code-reviewer-agent" },
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P23D", direction: "before", anchorPoint: "end", durationIso8601: "P5D" } },
        { key: "build", type: "manual", title: "Build", status: "idle",
          parent: "summary",
          start: daysFromNow(8), end: daysFromNow(18), due: daysFromNow(18),
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P12D", direction: "before", anchorPoint: "end", durationIso8601: "P10D" } },
        { key: "ship", type: "checkpoint", title: "Ship", status: "idle",
          parent: "summary",
          due: daysFromNow(30),
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P0D", direction: "before" } },
      ],
      dependencies: [
        { from: "design", to: "build" },
        { from: "build", to: "ship" },
      ],
      gates: [{ taskKey: "design", kind: "dependency", state: "pending" }],
      events: [{ kind: "workflow_created", source: "ui", at: daysFromNow(-1) }],
    },
    { id: "wf-seed-v65-major-release-active-q4", name: "ACME 2.0 Q4 Launch", product: "ACME Platform", status: "active",
      targetAt: daysFromNow(21), orgId: orgGroup, sourceTemplateId: "wftpl-seed-v65-major-product-release",
      tasks: [
        { key: "kickoff", type: "checkpoint", title: "Release kickoff", status: "succeeded", due: daysFromNow(-7), actualStart: daysFromNow(-7), actualEnd: daysFromNow(-7) },
        { key: "eng-readiness", type: "agent_task", title: "Engineering readiness check", status: "succeeded", due: daysFromNow(-4), actualStart: daysFromNow(-5), actualEnd: daysFromNow(-4), agentPackage: "@cinatra-ai/code-reviewer-agent", agentRef: { package: "@cinatra-ai/code-reviewer-agent" } },
        { key: "docs", type: "agent_task", title: "Documentation update", status: "running", due: daysFromNow(7), actualStart: daysFromNow(-1), agentPackage: "@cinatra-ai/author-agent", agentRef: { package: "@cinatra-ai/author-agent" } },
        { key: "legal-sign-off", type: "approval", title: "Legal sign-off", status: "pending_approval", due: daysFromNow(14) },
        { key: "launch-day", type: "checkpoint", title: "Launch day", status: "idle", due: daysFromNow(21) },
      ],
      dependencies: [
        { from: "kickoff", to: "eng-readiness" }, { from: "eng-readiness", to: "docs" },
        { from: "docs", to: "legal-sign-off" }, { from: "legal-sign-off", to: "launch-day" },
      ],
      attempts: [
        { taskKey: "kickoff", attemptNo: 1, status: "succeeded", startedAt: daysFromNow(-7), completedAt: daysFromNow(-7) },
        { taskKey: "eng-readiness", attemptNo: 1, status: "succeeded", startedAt: daysFromNow(-5), completedAt: daysFromNow(-4) },
        { taskKey: "docs", attemptNo: 1, status: "running", startedAt: daysFromNow(-1) },
      ],
      approvals: [{ taskKey: "legal-sign-off", requiredScope: { level: "organization" }, status: "pending" }],
      gates: [
        { taskKey: "legal-sign-off", kind: "dependency", state: "blocked", reason: "Waiting on docs completion" },
        { taskKey: "legal-sign-off", kind: "approval", state: "pending", reason: "Awaiting org-scope approver" },
        { taskKey: "launch-day", kind: "dependency", state: "pending" },
      ],
      events: [
        { kind: "workflow_started", source: "lifecycle", at: daysFromNow(-7) },
        { kind: "task_succeeded", source: "reconciler", taskKey: "kickoff", at: daysFromNow(-7) },
        { kind: "task_succeeded", source: "reconciler", taskKey: "eng-readiness", at: daysFromNow(-4) },
        { kind: "task_dispatched", source: "reconciler", taskKey: "docs", at: daysFromNow(-1) },
      ],
    },
    { id: "wf-seed-v65-major-release-paused-mvp", name: "Q3 Platform Cutover", product: "ACME Platform", status: "paused",
      targetAt: daysFromNow(14), orgId: orgGroup, sourceTemplateId: "wftpl-seed-v65-major-product-release",
      tasks: [
        { key: "kickoff", type: "checkpoint", title: "Release kickoff", status: "succeeded", due: daysFromNow(-3), actualStart: daysFromNow(-3), actualEnd: daysFromNow(-3) },
        { key: "eng-readiness", type: "agent_task", title: "Engineering readiness check", status: "scheduled", due: daysFromNow(2), agentPackage: "@cinatra-ai/code-reviewer-agent", agentRef: { package: "@cinatra-ai/code-reviewer-agent" } },
        { key: "launch-day", type: "checkpoint", title: "Launch day", status: "idle", due: daysFromNow(14) },
      ],
      dependencies: [{ from: "kickoff", to: "eng-readiness" }, { from: "eng-readiness", to: "launch-day" }],
      attempts: [{ taskKey: "kickoff", attemptNo: 1, status: "succeeded", startedAt: daysFromNow(-3), completedAt: daysFromNow(-3) }],
      gates: [{ taskKey: "eng-readiness", kind: "dependency", state: "blocked", reason: "Workflow paused — operator-initiated" }],
      events: [
        { kind: "workflow_started", source: "lifecycle", at: daysFromNow(-3) },
        { kind: "task_succeeded", source: "reconciler", taskKey: "kickoff", at: daysFromNow(-3) },
        { kind: "workflow_paused", source: "lifecycle", at: daysFromNow(-1) },
      ],
    },
    { id: "wf-seed-v65-major-release-completed-h2", name: "H2 Platform Release", product: "ACME Platform", status: "completed",
      targetAt: daysFromNow(-14), orgId: orgGroup, sourceTemplateId: "wftpl-seed-v65-major-product-release",
      tasks: [
        { key: "kickoff", type: "checkpoint", title: "Release kickoff", status: "succeeded", due: daysFromNow(-60), actualStart: daysFromNow(-60), actualEnd: daysFromNow(-60) },
        { key: "eng-readiness", type: "agent_task", title: "Engineering readiness check", status: "succeeded", due: daysFromNow(-50), actualStart: daysFromNow(-51), actualEnd: daysFromNow(-50), agentPackage: "@cinatra-ai/code-reviewer-agent", agentRef: { package: "@cinatra-ai/code-reviewer-agent" } },
        { key: "legal-sign-off", type: "approval", title: "Legal sign-off", status: "succeeded", due: daysFromNow(-30), actualStart: daysFromNow(-32), actualEnd: daysFromNow(-30) },
        { key: "launch-day", type: "checkpoint", title: "Launch day", status: "succeeded", due: daysFromNow(-14), actualStart: daysFromNow(-14), actualEnd: daysFromNow(-14) },
        { key: "post-launch-retro", type: "manual", title: "Post-launch retro", status: "succeeded", due: daysFromNow(-7), actualStart: daysFromNow(-7), actualEnd: daysFromNow(-7) },
      ],
      dependencies: [
        { from: "kickoff", to: "eng-readiness" }, { from: "eng-readiness", to: "legal-sign-off" },
        { from: "legal-sign-off", to: "launch-day" }, { from: "launch-day", to: "post-launch-retro" },
      ],
      attempts: [
        { taskKey: "kickoff", attemptNo: 1, status: "succeeded", startedAt: daysFromNow(-60), completedAt: daysFromNow(-60) },
        { taskKey: "eng-readiness", attemptNo: 1, status: "succeeded", startedAt: daysFromNow(-51), completedAt: daysFromNow(-50) },
      ],
      approvals: [{ taskKey: "legal-sign-off", requiredScope: { level: "organization" }, status: "granted", decidedBy: "usr-alice-cooper", decidedAt: daysFromNow(-30), reason: "Approved without redline." }],
      artifacts: [
        { taskKey: "launch-day", kind: "url", ref: "https://acme-cloud.example/blog/h2-release-notes" },
        { taskKey: "post-launch-retro", kind: "document", ref: "doc://retro/h2-2026" },
      ],
      gates: [{ taskKey: "post-launch-retro", kind: "dependency", state: "passed" }],
      events: [
        { kind: "workflow_started", source: "lifecycle", at: daysFromNow(-60) },
        { kind: "workflow_completed", source: "lifecycle", at: daysFromNow(-7) },
      ],
    },
    { id: "wf-seed-v65-major-release-failed-q2", name: "Q2 Rollback Release", product: "ACME Cloud", status: "failed",
      targetAt: daysFromNow(-30), orgId: orgGroup, sourceTemplateId: "wftpl-seed-v65-major-product-release",
      tasks: [
        { key: "kickoff", type: "checkpoint", title: "Release kickoff", status: "succeeded", due: daysFromNow(-45), actualStart: daysFromNow(-45), actualEnd: daysFromNow(-45) },
        { key: "eng-readiness", type: "agent_task", title: "Engineering readiness check", status: "failed", due: daysFromNow(-40), actualStart: daysFromNow(-42), actualEnd: daysFromNow(-40), agentPackage: "@cinatra-ai/code-reviewer-agent", agentRef: { package: "@cinatra-ai/code-reviewer-agent" } },
        { key: "launch-day", type: "checkpoint", title: "Launch day", status: "cancelled", due: daysFromNow(-30) },
      ],
      dependencies: [{ from: "kickoff", to: "eng-readiness" }, { from: "eng-readiness", to: "launch-day" }],
      attempts: [
        { taskKey: "kickoff", attemptNo: 1, status: "succeeded", startedAt: daysFromNow(-45), completedAt: daysFromNow(-45) },
        { taskKey: "eng-readiness", attemptNo: 1, status: "failed", startedAt: daysFromNow(-42), completedAt: daysFromNow(-40), error: { code: "readiness_check_failed", message: "3 P1 issues outstanding" } },
        { taskKey: "eng-readiness", attemptNo: 2, status: "failed", startedAt: daysFromNow(-41), completedAt: daysFromNow(-40), error: { code: "readiness_check_failed", message: "Retry: still 2 P1 issues outstanding" } },
      ],
      gates: [{ taskKey: "launch-day", kind: "dependency", state: "blocked", reason: "Upstream task failed" }],
      events: [
        { kind: "workflow_started", source: "lifecycle", at: daysFromNow(-45) },
        { kind: "task_failed", source: "reconciler", taskKey: "eng-readiness", at: daysFromNow(-40) },
        { kind: "workflow_failed", source: "lifecycle", at: daysFromNow(-40) },
      ],
    },
    { id: "wf-seed-v65-major-release-cancelled-shift", name: "Roadmap-shift Cancelled Release", product: "ACME Platform", status: "cancelled",
      targetAt: daysFromNow(45), orgId: orgGroup, sourceTemplateId: "wftpl-seed-v65-major-product-release",
      tasks: [
        { key: "kickoff", type: "checkpoint", title: "Release kickoff", status: "succeeded", due: daysFromNow(-2), actualStart: daysFromNow(-2), actualEnd: daysFromNow(-2) },
        { key: "eng-readiness", type: "agent_task", title: "Engineering readiness check", status: "cancelled", due: daysFromNow(15), agentPackage: "@cinatra-ai/code-reviewer-agent", agentRef: { package: "@cinatra-ai/code-reviewer-agent" } },
        { key: "launch-day", type: "checkpoint", title: "Launch day", status: "cancelled", due: daysFromNow(45) },
      ],
      dependencies: [{ from: "kickoff", to: "eng-readiness" }, { from: "eng-readiness", to: "launch-day" }],
      events: [
        { kind: "workflow_started", source: "lifecycle", at: daysFromNow(-2) },
        { kind: "workflow_cancelled", source: "lifecycle", at: daysFromNow(-1) },
      ],
    },
    // ── Hotfix Release (cloud) ──────────────────────────────────────────
    { id: "wf-seed-v65-hotfix-active-7-3-2", name: "Hotfix 7.3.2 — cache eviction", product: "ACME Cloud", status: "active",
      targetAt: daysFromNow(2), orgId: orgCloud, sourceTemplateId: "wftpl-seed-v65-hotfix-release",
      tasks: [
        { key: "triage", type: "checkpoint", title: "Incident triage", status: "succeeded", due: daysFromNow(-1), actualStart: daysFromNow(-1), actualEnd: daysFromNow(-1) },
        { key: "fix", type: "agent_task", title: "Patch implementation", status: "running", due: daysFromNow(1), actualStart: daysFromNow(0), agentPackage: "@cinatra-ai/code-reviewer-agent", agentRef: { package: "@cinatra-ai/code-reviewer-agent" } },
        { key: "patch-release", type: "checkpoint", title: "Patch release", status: "idle", due: daysFromNow(2) },
        { key: "comms-update", type: "agent_task", title: "Customer update", status: "idle", due: daysFromNow(2), agentPackage: "@cinatra-ai/author-agent", agentRef: { package: "@cinatra-ai/author-agent" } },
      ],
      dependencies: [
        { from: "triage", to: "fix" }, { from: "fix", to: "patch-release" }, { from: "patch-release", to: "comms-update" },
      ],
      attempts: [
        { taskKey: "triage", attemptNo: 1, status: "succeeded", startedAt: daysFromNow(-1), completedAt: daysFromNow(-1) },
        { taskKey: "fix", attemptNo: 1, status: "running", startedAt: daysFromNow(0) },
      ],
      gates: [{ taskKey: "patch-release", kind: "dependency", state: "pending" }],
      events: [
        { kind: "workflow_started", source: "lifecycle", at: daysFromNow(-1) },
        { kind: "task_dispatched", source: "reconciler", taskKey: "fix", at: daysFromNow(0) },
      ],
    },
    { id: "wf-seed-v65-hotfix-completed-7-3-1", name: "Hotfix 7.3.1 — bucket auth", product: "ACME Cloud", status: "completed",
      targetAt: daysFromNow(-3), orgId: orgCloud, sourceTemplateId: "wftpl-seed-v65-hotfix-release",
      tasks: [
        { key: "triage", type: "checkpoint", title: "Incident triage", status: "succeeded", due: daysFromNow(-5), actualStart: daysFromNow(-5), actualEnd: daysFromNow(-5) },
        { key: "fix", type: "agent_task", title: "Patch implementation", status: "succeeded", due: daysFromNow(-4), actualStart: daysFromNow(-5), actualEnd: daysFromNow(-4), agentPackage: "@cinatra-ai/code-reviewer-agent", agentRef: { package: "@cinatra-ai/code-reviewer-agent" } },
        { key: "patch-release", type: "checkpoint", title: "Patch release", status: "succeeded", due: daysFromNow(-3), actualStart: daysFromNow(-3), actualEnd: daysFromNow(-3) },
        { key: "comms-update", type: "agent_task", title: "Customer update", status: "succeeded", due: daysFromNow(-3), actualStart: daysFromNow(-3), actualEnd: daysFromNow(-3), agentPackage: "@cinatra-ai/author-agent", agentRef: { package: "@cinatra-ai/author-agent" } },
      ],
      dependencies: [{ from: "triage", to: "fix" }, { from: "fix", to: "patch-release" }, { from: "patch-release", to: "comms-update" }],
      artifacts: [{ taskKey: "comms-update", kind: "url", ref: "https://acme-cloud.example/incident/7-3-1-postmortem" }],
      events: [
        { kind: "workflow_started", source: "lifecycle", at: daysFromNow(-5) },
        { kind: "workflow_completed", source: "lifecycle", at: daysFromNow(-3) },
      ],
    },
    // ── Security Patch Release (cloud) ──────────────────────────────────
    { id: "wf-seed-v65-security-active-cve-2026-1117", name: "CVE-2026-1117 patch", product: "ACME Cloud", status: "active",
      targetAt: daysFromNow(5), orgId: orgCloud, sourceTemplateId: "wftpl-seed-v65-security-patch-release",
      tasks: [
        { key: "cve-intake", type: "checkpoint", title: "CVE intake", status: "succeeded", due: daysFromNow(-3), actualStart: daysFromNow(-3), actualEnd: daysFromNow(-3) },
        { key: "patch", type: "agent_task", title: "Patch", status: "succeeded", due: daysFromNow(-1), actualStart: daysFromNow(-2), actualEnd: daysFromNow(-1), agentPackage: "@cinatra-ai/security-reviewer-agent", agentRef: { package: "@cinatra-ai/security-reviewer-agent" } },
        { key: "security-review", type: "approval", title: "Security review sign-off", status: "succeeded", due: daysFromNow(0), actualStart: daysFromNow(0), actualEnd: daysFromNow(0) },
        { key: "disclosure", type: "manual", title: "Coordinated disclosure", status: "running", due: daysFromNow(3), actualStart: daysFromNow(0) },
        { key: "release", type: "checkpoint", title: "Patch release", status: "idle", due: daysFromNow(5) },
      ],
      dependencies: [
        { from: "cve-intake", to: "patch" }, { from: "patch", to: "security-review" },
        { from: "security-review", to: "disclosure" }, { from: "disclosure", to: "release" },
      ],
      approvals: [{ taskKey: "security-review", requiredScope: { level: "organization" }, status: "granted", decidedBy: "usr-elena-rossi", decidedAt: daysFromNow(0), reason: "Patch validated; coordinated disclosure approved." }],
      gates: [{ taskKey: "release", kind: "dependency", state: "pending" }],
      events: [{ kind: "workflow_started", source: "lifecycle", at: daysFromNow(-3) }],
    },
    { id: "wf-seed-v65-security-pending-cve-2026-1240", name: "CVE-2026-1240 patch", product: "ACME Cloud", status: "active",
      targetAt: daysFromNow(7), orgId: orgCloud, sourceTemplateId: "wftpl-seed-v65-security-patch-release",
      tasks: [
        { key: "cve-intake", type: "checkpoint", title: "CVE intake", status: "succeeded", due: daysFromNow(-2), actualStart: daysFromNow(-2), actualEnd: daysFromNow(-2) },
        { key: "patch", type: "agent_task", title: "Patch", status: "succeeded", due: daysFromNow(0), actualStart: daysFromNow(-1), actualEnd: daysFromNow(0), agentPackage: "@cinatra-ai/security-reviewer-agent", agentRef: { package: "@cinatra-ai/security-reviewer-agent" } },
        { key: "security-review", type: "approval", title: "Security review sign-off", status: "pending_approval", due: daysFromNow(2) },
        { key: "release", type: "checkpoint", title: "Patch release", status: "idle", due: daysFromNow(7) },
      ],
      dependencies: [{ from: "cve-intake", to: "patch" }, { from: "patch", to: "security-review" }, { from: "security-review", to: "release" }],
      // Deliberately-open pending approval: upstream `patch` is `succeeded`
      // and the approver list has been notified. solicitedAt=true makes
      // this approval visible + decidable in the approvals UI.
      approvals: [{ taskKey: "security-review", requiredScope: { level: "organization" }, status: "pending", solicitedAt: true }],
      gates: [{ taskKey: "security-review", kind: "approval", state: "pending", reason: "Awaiting approver decision" }],
      events: [{ kind: "workflow_started", source: "lifecycle", at: daysFromNow(-2) }],
    },
    { id: "wf-seed-v65-security-rejected-cve-2026-0901", name: "CVE-2026-0901 patch (rejected)", product: "ACME Cloud", status: "failed",
      targetAt: daysFromNow(-7), orgId: orgCloud, sourceTemplateId: "wftpl-seed-v65-security-patch-release",
      tasks: [
        { key: "cve-intake", type: "checkpoint", title: "CVE intake", status: "succeeded", due: daysFromNow(-14), actualStart: daysFromNow(-14), actualEnd: daysFromNow(-14) },
        { key: "patch", type: "agent_task", title: "Patch", status: "succeeded", due: daysFromNow(-10), actualStart: daysFromNow(-12), actualEnd: daysFromNow(-10), agentPackage: "@cinatra-ai/security-reviewer-agent", agentRef: { package: "@cinatra-ai/security-reviewer-agent" } },
        { key: "security-review", type: "approval", title: "Security review sign-off", status: "failed", due: daysFromNow(-8), actualStart: daysFromNow(-9), actualEnd: daysFromNow(-8) },
        { key: "release", type: "checkpoint", title: "Patch release", status: "cancelled", due: daysFromNow(-7) },
      ],
      dependencies: [{ from: "cve-intake", to: "patch" }, { from: "patch", to: "security-review" }, { from: "security-review", to: "release" }],
      approvals: [{ taskKey: "security-review", requiredScope: { level: "organization" }, status: "rejected", decidedBy: "usr-elena-rossi", decidedAt: daysFromNow(-8), reason: "Disclosure timing unacceptable for OEM partners. Patch refactor required before re-review." }],
      events: [{ kind: "workflow_started", source: "lifecycle", at: daysFromNow(-14) }, { kind: "workflow_failed", source: "lifecycle", at: daysFromNow(-8) }],
    },
    // ── Beta Release (robotics) ─────────────────────────────────────────
    { id: "wf-seed-v65-beta-active-rover-v3", name: "Rover v3 beta", product: "ACME Robotics", status: "active",
      targetAt: daysFromNow(30), orgId: orgRobotics, sourceTemplateId: "wftpl-seed-v65-beta-release",
      tasks: [
        { key: "kickoff", type: "checkpoint", title: "Beta kickoff", status: "succeeded", due: daysFromNow(-10), actualStart: daysFromNow(-10), actualEnd: daysFromNow(-10) },
        { key: "beta-blog", type: "agent_task", title: "Beta announcement", status: "succeeded", due: daysFromNow(-7), actualStart: daysFromNow(-8), actualEnd: daysFromNow(-7), agentPackage: "@cinatra-ai/blog-pipeline-agent", agentRef: { package: "@cinatra-ai/blog-pipeline-agent" } },
        { key: "cohort-invites", type: "agent_task", title: "Invite beta cohort", status: "succeeded", due: daysFromNow(-5), actualStart: daysFromNow(-6), actualEnd: daysFromNow(-5), agentPackage: "@cinatra-ai/email-outreach-agent", agentRef: { package: "@cinatra-ai/email-outreach-agent" } },
        { key: "feedback-windows", type: "manual", title: "Collect feedback (2-week window)", status: "running", due: daysFromNow(9), actualStart: daysFromNow(-5) },
        { key: "ga-decision", type: "manual", title: "GA / extend decision", status: "idle", due: daysFromNow(30) },
      ],
      dependencies: [
        { from: "kickoff", to: "beta-blog" }, { from: "beta-blog", to: "cohort-invites" },
        { from: "cohort-invites", to: "feedback-windows" }, { from: "feedback-windows", to: "ga-decision" },
      ],
      artifacts: [{ taskKey: "beta-blog", kind: "url", ref: "https://acme-robotics.example/blog/rover-v3-beta" }],
      gates: [{ taskKey: "ga-decision", kind: "dependency", state: "blocked", reason: "Awaiting feedback window close" }],
      events: [{ kind: "workflow_started", source: "lifecycle", at: daysFromNow(-10) }],
    },
    { id: "wf-seed-v65-beta-completed-rover-v2", name: "Rover v2 beta (shipped to GA)", product: "ACME Robotics", status: "completed",
      targetAt: daysFromNow(-21), orgId: orgRobotics, sourceTemplateId: "wftpl-seed-v65-beta-release",
      tasks: [
        { key: "kickoff", type: "checkpoint", title: "Beta kickoff", status: "succeeded", due: daysFromNow(-90), actualStart: daysFromNow(-90), actualEnd: daysFromNow(-90) },
        { key: "beta-blog", type: "agent_task", title: "Beta announcement", status: "succeeded", due: daysFromNow(-85), actualStart: daysFromNow(-86), actualEnd: daysFromNow(-85), agentPackage: "@cinatra-ai/blog-pipeline-agent", agentRef: { package: "@cinatra-ai/blog-pipeline-agent" } },
        { key: "cohort-invites", type: "agent_task", title: "Invite beta cohort", status: "succeeded", due: daysFromNow(-80), actualStart: daysFromNow(-82), actualEnd: daysFromNow(-80), agentPackage: "@cinatra-ai/email-outreach-agent", agentRef: { package: "@cinatra-ai/email-outreach-agent" } },
        { key: "feedback-windows", type: "manual", title: "Collect feedback (2-week window)", status: "succeeded", due: daysFromNow(-60), actualStart: daysFromNow(-80), actualEnd: daysFromNow(-60) },
        { key: "ga-decision", type: "manual", title: "GA / extend decision", status: "succeeded", due: daysFromNow(-21), actualStart: daysFromNow(-21), actualEnd: daysFromNow(-21) },
      ],
      dependencies: [
        { from: "kickoff", to: "beta-blog" }, { from: "beta-blog", to: "cohort-invites" },
        { from: "cohort-invites", to: "feedback-windows" }, { from: "feedback-windows", to: "ga-decision" },
      ],
      artifacts: [
        { taskKey: "beta-blog", kind: "url", ref: "https://acme-robotics.example/blog/rover-v2-beta" },
        { taskKey: "ga-decision", kind: "document", ref: "doc://ga-decisions/rover-v2" },
      ],
      events: [{ kind: "workflow_completed", source: "lifecycle", at: daysFromNow(-21) }],
    },
    // ── Marketing Campaign Approval (group) ─────────────────────────────
    { id: "wf-seed-v65-marketing-needs-revision-q4", name: "Q4 brand campaign — Holiday", product: "ACME Group", status: "active",
      targetAt: daysFromNow(28), orgId: orgGroup, sourceTemplateId: "wftpl-seed-v65-marketing-campaign-approval",
      tasks: [
        { key: "brief", type: "checkpoint", title: "Campaign brief", status: "succeeded", due: daysFromNow(-7), actualStart: daysFromNow(-7), actualEnd: daysFromNow(-7) },
        { key: "creative-draft", type: "agent_task", title: "Creative draft", status: "succeeded", due: daysFromNow(-3), actualStart: daysFromNow(-5), actualEnd: daysFromNow(-3), agentPackage: "@cinatra-ai/blog-linkedin-writer-agent", agentRef: { package: "@cinatra-ai/blog-linkedin-writer-agent" } },
        { key: "legal-sign-off", type: "approval", title: "Legal sign-off", status: "running", due: daysFromNow(2) },
        { key: "exec-sign-off", type: "approval", title: "Exec sign-off", status: "idle", due: daysFromNow(7) },
        { key: "publish", type: "checkpoint", title: "Publish", status: "idle", due: daysFromNow(28) },
      ],
      dependencies: [
        { from: "brief", to: "creative-draft" }, { from: "creative-draft", to: "legal-sign-off" },
        { from: "legal-sign-off", to: "exec-sign-off" }, { from: "exec-sign-off", to: "publish" },
      ],
      approvals: [
        { taskKey: "legal-sign-off", requiredScope: { level: "organization" }, status: "needs_revision", decidedBy: "usr-carla-mendes", decidedAt: daysFromNow(-1), reason: "Trademark phrasing — line 3 needs a rework before re-submission." },
        { taskKey: "exec-sign-off", requiredScope: { level: "organization" }, status: "pending" },
      ],
      gates: [{ taskKey: "legal-sign-off", kind: "approval", state: "blocked", reason: "Decision: needs_revision" }],
      events: [{ kind: "workflow_started", source: "lifecycle", at: daysFromNow(-7) }],
    },
    // ── Compliance Review (group) ────────────────────────────────────────
    { id: "wf-seed-v65-compliance-active-q4-soc2", name: "Q4 SOC2 review", product: "ACME Group", status: "active",
      targetAt: daysFromNow(30), orgId: orgGroup, sourceTemplateId: "wftpl-seed-v65-compliance-review",
      tasks: [
        { key: "scope", type: "checkpoint", title: "Scope definition", status: "succeeded", due: daysFromNow(-14), actualStart: daysFromNow(-14), actualEnd: daysFromNow(-14) },
        { key: "controls-audit", type: "agent_task", title: "Controls audit", status: "succeeded", due: daysFromNow(-7), actualStart: daysFromNow(-10), actualEnd: daysFromNow(-7), agentPackage: "@cinatra-ai/security-reviewer-agent", agentRef: { package: "@cinatra-ai/security-reviewer-agent" } },
        { key: "remediation", type: "manual", title: "Remediation tasks", status: "running", due: daysFromNow(14), actualStart: daysFromNow(-7) },
        { key: "exec-sign-off", type: "approval", title: "Exec sign-off", status: "idle", due: daysFromNow(21) },
        { key: "file", type: "checkpoint", title: "File compliance report", status: "idle", due: daysFromNow(30) },
      ],
      dependencies: [
        { from: "scope", to: "controls-audit" }, { from: "controls-audit", to: "remediation" },
        { from: "remediation", to: "exec-sign-off" }, { from: "exec-sign-off", to: "file" },
      ],
      gates: [{ taskKey: "exec-sign-off", kind: "dependency", state: "blocked", reason: "Remediation in progress" }],
      events: [{ kind: "workflow_started", source: "lifecycle", at: daysFromNow(-14) }],
    },
  ];

  for (const wf of instances) {
    await insertWorkflow(wf);
  }
  console.log(`  seeded ${templates.length} workflow_templates + ${instances.length} workflows across ${new Set(instances.map(i => i.orgId)).size} orgs`);
}

// ---------------------------------------------------------------------------
async function seedV64CanonicalDemo(orgMap) {
  console.log("Seeding canonical-extension demo fixtures (cinatra.installed_extension)…");

  // Idempotent wipe by seed marker (manifest_hash prefix).
  await q(`DELETE FROM cinatra.installed_extension WHERE manifest_hash LIKE 'seed-v64-%'`);

  const orgAcme = orgMap["acme-group"] ?? "org-acme-group";
  const PLATFORM_SENTINEL = "__platform__";

  // Helper to build canonical row tuples.
  const rows = [
    {
      id: "iext_seed-v64-01",
      pkg: "@cinatra-ai/code-reviewer-agent",
      ownerLevel: "platform",
      ownerId: PLATFORM_SENTINEL,
      orgId: null,
      kind: "agent",
      status: "locked",
      source: { type: "verdaccio", registryUrl: "http://localhost:4873", packageName: "@cinatra-ai/code-reviewer-agent", version: "1.2.3", integrity: "sha512-seed-v64-01" },
      requiredInProd: true,
      deps: [],
    },
    {
      id: "iext_seed-v64-02",
      pkg: "@cinatra-ai/demo-research-skill",
      ownerLevel: "organization",
      ownerId: orgAcme,
      orgId: orgAcme,
      kind: "skill",
      status: "active",
      source: { type: "github", repo: "acme-demo.invalid/demo-research-skill", ref: "v0.3.1", resolvedSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" },
      requiredInProd: false,
      deps: [],
    },
    {
      id: "iext_seed-v64-03",
      pkg: "@cinatra-ai/demo-legacy-connector",
      ownerLevel: "organization",
      ownerId: orgAcme,
      orgId: orgAcme,
      kind: "connector",
      status: "archived",
      source: { type: "verdaccio", registryUrl: "http://localhost:4873", packageName: "@cinatra-ai/demo-legacy-connector", version: "0.9.0", integrity: "sha512-seed-v64-03" },
      requiredInProd: false,
      deps: [],
    },
    {
      id: "iext_seed-v64-04",
      pkg: "@cinatra-ai/demo-local-artifact",
      ownerLevel: "organization",
      ownerId: orgAcme,
      orgId: orgAcme,
      kind: "artifact",
      status: "active",
      source: { type: "local", path: "/opt/cinatra/extensions/demo-local-artifact", resolvedCommitOrTreeHash: "f0e1d2c3b4a5968778695a4b3c2d1e0f12345678" },
      requiredInProd: false,
      deps: [],
    },
    {
      id: "iext_seed-v64-05",
      pkg: "@cinatra-ai/demo-launch-workflow",
      ownerLevel: "organization",
      ownerId: orgAcme,
      orgId: orgAcme,
      kind: "workflow",
      status: "active",
      source: { type: "verdaccio", registryUrl: "http://localhost:4873", packageName: "@cinatra-ai/demo-launch-workflow", version: "1.0.0", integrity: "sha512-seed-v64-05" },
      requiredInProd: false,
      deps: [],
    },
    {
      id: "iext_seed-v64-06",
      pkg: "@cinatra-ai/demo-dependent-agent",
      ownerLevel: "organization",
      ownerId: orgAcme,
      orgId: orgAcme,
      kind: "agent",
      status: "active",
      source: { type: "verdaccio", registryUrl: "http://localhost:4873", packageName: "@cinatra-ai/demo-dependent-agent", version: "0.4.0", integrity: "sha512-seed-v64-06" },
      requiredInProd: false,
      // Declares a REQUIRED runtime dep on row 1 — exercises the
      // assertCanonicalArchiveClosure block when an admin tries to archive
      // the code-reviewer-agent: this dependent makes that archive refuse.
      deps: [{ packageName: "@cinatra-ai/code-reviewer-agent", edgeType: "runtime", versionConstraint: { kind: "semver-range", range: "^1.0.0" }, requirement: "required" }],
    },
    {
      id: "iext_seed-v64-07",
      pkg: "@cinatra-ai/assistant-skills",
      ownerLevel: "platform",
      ownerId: PLATFORM_SENTINEL,
      orgId: null,
      kind: "skill",
      status: "locked",
      source: { type: "verdaccio", registryUrl: "http://localhost:4873", packageName: "@cinatra-ai/assistant-skills", version: "0.2.1", integrity: "sha512-seed-v64-07" },
      requiredInProd: true,
      deps: [],
    },
    {
      id: "iext_seed-v64-08",
      pkg: "@cinatra-ai/demo-archived-from-github",
      ownerLevel: "organization",
      ownerId: orgAcme,
      orgId: orgAcme,
      kind: "agent",
      status: "archived",
      source: { type: "github", repo: "acme-demo.invalid/demo-archived", ref: "v0.1.0", resolvedSha: "1122334455667788990011223344556677889900" },
      requiredInProd: false,
      deps: [],
    },
  ];

  let inserted = 0;
  for (const r of rows) {
    await q(
      `INSERT INTO cinatra.installed_extension
         (id, package_name, owner_level, owner_id, organization_id, kind, status,
          source, required_in_prod, dependencies, manifest_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11)
       ON CONFLICT DO NOTHING`,
      [
        r.id,
        r.pkg,
        r.ownerLevel,
        r.ownerId,
        r.orgId,
        r.kind,
        r.status,
        JSON.stringify(r.source),
        r.requiredInProd,
        JSON.stringify(r.deps),
        `seed-v64-${r.id.split("-").pop()}`,
      ],
    );
    inserted++;
  }
  console.log(`  installed_extension demo rows: ${inserted} (3 statuses × 3 source types × 5 kinds + 1 dep edge)`);
}

// ---------------------------------------------------------------------------
// User 1 active-org default. /workflows + /teams (and other surfaces) scope by
// exact `session.activeOrganizationId` match. Better Auth auto-provisions a
// "Default" org on first signup (the user's first membership / home org).
//
// Point User 1's active org at Default (their home org). The org-acme-* /workflows
// + /teams demo data is one org-switch away via the switcher (acme-group /
// acme-cloud / acme-robotics / acme-studios).
//
// NOTE: `pnpm seed` does NOT create org-scoped CRM account/contact OBJECTS in any
// org — `seedCrmData` writes the legacy `cinatra.startups` table, while /entities/*
// reads `cinatra.objects`. /entities/* + data-safety are populated only where
// app-created data already lives, not by a fresh seed.
// ---------------------------------------------------------------------------

async function seedUser1ActiveOrg(adminUserId) {
  // Resolve the auto-provisioned "Default" org for User 1. Its id is dynamic per
  // fresh DB (Better Auth mints it on first signup), so resolve by slug + membership
  // rather than hardcoding (slug='default' matches the setup/wipe invariant).
  const orgRes = await q(
    `SELECT o.id FROM public.organization o
       JOIN public.member m ON m."organizationId" = o.id
      WHERE m."userId" = $1 AND o.slug = 'default'
      LIMIT 1`,
    [adminUserId],
  );
  const targetOrgId = orgRes.rows[0]?.id;
  if (!targetOrgId) {
    console.warn("  no 'Default' org membership for User 1 — leaving active org unchanged");
    return;
  }
  console.log(`Setting User 1's session active org to Default (${targetOrgId})…`);
  const r = await q(
    `UPDATE public.session SET "activeOrganizationId" = $1 WHERE "userId" = $2`,
    [targetOrgId, adminUserId],
  );
  console.log(`  updated ${r.rowCount} session(s) -> activeOrganizationId=${targetOrgId} (Default)`);
}

// ---------------------------------------------------------------------------
// Post-seed distribution audit. Prints what User 1 will actually see when
// they land on Default + when they switch via the org switcher. This
// is a sanity check on the fixture shape, not a CI gate.
// ---------------------------------------------------------------------------

async function reportFixtureDistribution(adminUserId) {
  console.log("");
  console.log("=== Fixture distribution (what User 1 sees per org) ===");
  const wf = await q(
    `SELECT org_id, COUNT(*)::int AS c FROM cinatra.workflow
       WHERE id LIKE 'wf-seed-v65-%' GROUP BY org_id ORDER BY c DESC`,
  );
  console.log("workflows by org:");
  for (const row of wf.rows) console.log(`  ${row.org_id}: ${row.c}`);
  const sess = await q(
    `SELECT DISTINCT "activeOrganizationId" FROM public.session WHERE "userId" = $1`,
    [adminUserId],
  );
  const activeOrgs = sess.rows.map((r) => r.activeOrganizationId).filter(Boolean);
  console.log(`User 1 active org(s): ${activeOrgs.length === 0 ? "(none)" : activeOrgs.join(", ")}`);
}

async function main() {
  console.log("=== Cinatra Demo Seed (ACME Group) ===\n");

  const admin = await findAdminUser();
  if (!admin) {
    console.error("No platform admin user found.");
    console.error("Register the first user via the app (it becomes the initial admin automatically),");
    console.error("then re-run this seed. The seed will not touch the database until an admin exists.");
    await pool.end();
    process.exit(0);
  }
  console.log(`Using admin user (User 1): ${admin.email}\n`);

  const protectedIds = await listProtectedUserIds();
  await wipeSeedableData(protectedIds);

  const orgMap = await seedOrganizations();
  await seedUsers(orgMap, admin.id);
  await seedTeams(orgMap, admin.id);
  await seedProjects(orgMap, admin.id);
  await seedRbacGrants(orgMap, admin.id);
  await seedCrmData();
  await seedCampaignTypes();
  await seedCanonicalBlogFixtures();
  await seedV64CanonicalDemo(orgMap);
  await seedDashboards(orgMap, admin.id);
  await seedLists(orgMap, admin.id);
  await seedChatThreads();
  await seedWorkflows(orgMap, admin.id);
  await seedUser1ActiveOrg(admin.id);

  await reportFixtureDistribution(admin.id);

  await pool.end();
  console.log("\n=== Seed complete ===");
  console.log("");
  console.log("Note: the seed leaves `cinatra.agent_templates` empty by design — real");
  console.log("agents register from `agents/<vendor>/<slug>/cinatra/oas.json` on Next.js");
  console.log("boot; restart `pnpm dev` to populate them. The seed wires two fictional");
  console.log("demo `chat_threads` so `/chat` is non-empty; User 1's own chat history");
  console.log("is left untouched. User 1's active org is set to `Default` (their home");
  console.log("org); use the org switcher for the org-acme-* /workflows + /teams demo.");
}

main().catch(err => {
  console.error("Seed failed:", err);
  pool.end();
  process.exit(1);
});
