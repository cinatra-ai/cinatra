# Building cinatra on a memory-constrained host

`pnpm build` (and the `next build` inside `docker build`) is the heaviest thing
this repository does. On a small builder it does not slow down — it dies. This
page documents the two env knobs the checkout exposes for that situation, what
each one actually binds, and — just as important — the levers that look like
remedies and, measured, did not deliver one.

Read the second half before you spend an afternoon on this. The headline result
is that **on a ~6 GB builder nothing tested here produced a successful build**,
on either bundler.

---

## The knobs

Both are read from the environment, both are declared as `ARG`s in the
`Dockerfile` so `docker build --build-arg …` reaches them, and both are
**unset by default**. An unset build runs the same `next build` argv against
the same resolved config as before these knobs existed (proof below). One thing
does change unconditionally: `pnpm build` now goes through a small Node
launcher, so Next runs with an extra parent process. Same build, not the same
process tree.

| env var | accepted values | what it sets |
|---|---|---|
| `CINATRA_BUILD_BUNDLER` | `turbopack`, `webpack` (unset ⇒ Next's default, Turbopack) | the `next build` bundler flag |
| `CINATRA_BUILD_CPUS` | integer `1`–`256` (unset ⇒ Next's default) | `experimental.cpus` — the build's worker count |

Values are matched case-insensitively after trimming; an empty value means
unset (a docker `ARG X=` forwards an empty string, not an absent variable).
Anything else fails the build immediately, with the accepted values named — a
value that is silently ignored is worse than no knob.

**What `CINATRA_BUILD_CPUS` is and is not.** It sets `experimental.cpus`, which
Next uses for the build's page-data / static-generation workers — each one a
whole extra Node process with its own heap. It is a real control for that phase.
It is **not** proven against the failure documented below, because on this
profile the build dies during compilation, before that phase is reached (rows 10
and 14 of the matrix). Treat it as a lever for a builder that gets past compile,
not as a remedy for one that does not.

They compose with the heap ceiling that already existed:

| env var | accepted values | what it sets |
|---|---|---|
| `NODE_OPTIONS` | e.g. `--max-old-space-size=3584` (`ARG`, default `--max-old-space-size=4096`) | V8's old-space limit (cinatra#2606) |

### From a checkout

```bash
CINATRA_BUILD_BUNDLER=webpack CINATRA_BUILD_CPUS=2 pnpm build
```

### From `docker build`

```bash
docker build \
  --build-arg CINATRA_BUILD_BUNDLER=webpack \
  --build-arg CINATRA_BUILD_CPUS=2 \
  --build-arg NODE_OPTIONS=--max-old-space-size=3584 \
  -t cinatra .
```

Docker drops an **unconsumed** `--build-arg` with only a warning, so a knob the
`Dockerfile` does not declare looks set while doing nothing. That is why every
knob here has an `ARG` line, and why a unit test asserts each one is both
declared and forwarded to the `pnpm build` step.

### Why the bundler knob is a script and not a config value

`next.config.ts` cannot select the bundler. Next 16.2 resolves it in
`next/dist/lib/bundler.js#parseBundlerArgs`, from CLI flags and private test env
vars only, *before* the config is loaded. So `pnpm build` runs
`scripts/next-build.mjs`, which translates the env var into the `next build`
flag and then runs Next's own entry point under the same Node. With the knob
unset the argv is exactly `build` and nothing extra is printed.

### Proof that an unset build is unchanged

The resolved Next config for `phase-production-build` was dumped inside the
image twice — once with the pre-#2607 `next.config.ts` bind-mounted over the
patched one, once with the patched file and every knob unset — and compared:

```
79f0f272b0a3f1894d993af3fb7d3bff8e5c5c92ec730be79a0a0a64732cd63c  cfg-prepatch.json
79f0f272b0a3f1894d993af3fb7d3bff8e5c5c92ec730be79a0a0a64732cd63c  cfg-patched-unset.json
```

Identical, 29,346 bytes each (functions stringified rather than dropped, so
nothing hides in a `headers()`/`redirects()` closure). On the command side,
`resolveNextArgs({}, [])` is `["build"]` — pinned by a unit test — so `pnpm
build` still runs exactly `next build`, with the launcher as its parent.

The launcher was then run end to end on the same profile with every knob unset:
same phase, same failure, peak RSS 4,926,868 KB — inside the run-to-run spread
of rows 1–2 — and the kill still surfaced correctly (`Command terminated by
signal 9`, `docker run` exit 137). The launcher re-raises the child's signal on
itself rather than translating it, so a reaped build is never reported to CI as
an ordinary non-zero exit.

---

## What the knobs are actually for

They do not make a too-small builder big enough. What the bundler knob buys is a
build whose failure is **in a place a lever can reach**:

- **Turbopack** (the default) fails on **native** memory, and none of the Next
  16.2.10 controls tested here bounded it — see the matrix below. The process
  grows until something reaps it, and all you are told is exit code 137, which
  names a `SIGKILL` and not its cause.
- **webpack** fails on the **V8 heap**, with an explicit
  `FATAL ERROR: … JavaScript heap out of memory` and a GC trace naming the
  ceiling it hit. `NODE_OPTIONS` moves that ceiling. It is a diagnosable,
  steerable failure — and if your host has the headroom, a clearable one.

So on a constrained host: switch to `webpack` first, then tune `NODE_OPTIONS`.
If the build reports a heap limit, you are heap-bound and the number can move.
If it reports exit 137, you are host-bound and no knob in this repository will
help you.

---

## The measured matrix

**Profile** — the one cinatra-cli#210's E2E used: x86_64 (Intel i9-9880H, 16 GB
host), Docker inside a colima VM of **5922 MB / 6 CPU**, no swap. About 455 MB
of that VM was held by unrelated containers, leaving ~4.9 GB available to the
build.

**Method** — the image was built from this checkout up to (but not including)
the `pnpm build` step, then every row below ran `/usr/bin/time -v pnpm build`
inside a **fresh container off that same image** — cold, no `.next` carried
over, one run at a time. `CI=true` (so the redundant in-build `tsc` is skipped,
matching the CI and preview image path). "Peak RSS" is GNU time's *Maximum
resident set size*, which is the high-water mark of the **largest single
process** in the tree — not the simultaneous total of the tree. It is the number
cinatra-cli#216's harness recorded, kept here for comparability.

One caveat that applies to every killed row: these are **host-censored**
measurements. A process reaped at the host ceiling tells you it did not fit; it
does not tell you how large it would have grown. So the rows below establish
what did NOT clear the wall, not the true peak of any configuration.

| # | bundler | `NODE_OPTIONS` heap | other | wall | peak RSS (KB) | outcome |
|---|---|---|---|---|---|---|
| 1 | turbopack | 4096 | *(pre-patch tree — today's build)* | 0:46 | **4,897,564** | `SIGKILL` (137) |
| 2 | turbopack | 4096 | *(patched tree, all knobs unset)* | 2:33 | **4,962,084** | `SIGKILL` (137) |
| 3 | turbopack | 4096 | `turbopackMemoryLimit` 2048 MB | 1:48 | 4,968,492 | `SIGKILL` (137) |
| 4 | turbopack | 4096 | `turbopackMemoryLimit` 512 MB | 1:25 | 4,981,120 | `SIGKILL` (137) |
| 5 | turbopack | 4096 | `turbopackMemoryLimit` 2048 MB + `turbopackFileSystemCacheForBuild` | 1:22 | 4,944,824 | `SIGKILL` (137) |
| 6 | turbopack | 4096 | container `--cpus=2` | 1:52 | 4,946,952 | `SIGKILL` (137) |
| 7 | turbopack | 4096 | `RAYON_NUM_THREADS=2` | 0:41 | 4,961,236 | `SIGKILL` (137) |
| 8 | turbopack | 4096 | `NEXT_TURBOPACK_USE_WORKER=0` | 1:39 | 4,912,640 | `SIGKILL` (137) |
| 9 | turbopack | **2048** | — | 1:19 | 4,941,712 | `SIGKILL` (137) |
| 10 | turbopack | 4096 | `CINATRA_BUILD_CPUS=1` | 2:02 | 4,924,968 | `SIGKILL` (137) |
| 11 | webpack | 4096 | — | 5:17 | 4,957,920 | build worker `SIGKILL` |
| 12 | webpack | **3072** | — | 4:31 | 4,040,680 | **JS heap OOM** |
| 13 | webpack | **3072** | `webpackMemoryOptimizations` + `NEXT_WEBPACK_PARALLELISM=1` | 15:26 | 4,394,576 | **JS heap OOM** |
| 14 | webpack | **3584** | `CINATRA_BUILD_CPUS=2` | 5:37 | 4,604,984 | **JS heap OOM** |
| 15 | webpack | **3840** | `webpackMemoryOptimizations` + `CINATRA_BUILD_CPUS=2` | 6:54 | 4,690,980 | **JS heap OOM** |

### How to read it

- **Rows 1–2 are the wall.** Today's build, with nothing set, is reaped by the
  kernel at ~4.9 GB about a minute into "Creating an optimized production
  build". This is the failure class cinatra-cli#210 reported, reproduced here —
  same phase, same kill. (Time-to-death varies run to run, 0:46 to 2:33, which is
  what you would expect of a race against a host ceiling.)
- **Rows 3–10: none of the tested controls changed the Turbopack outcome.**
  Every run was reaped, and every peak landed in a 1.4 % band (4.90–4.98 GB)
  whether the memory limit was 512 MB, 2048 MB or absent, whether the container
  had 6 CPUs or 2, whether rayon was pinned to 2 threads, whether the build ran
  in a worker or in-process, and whether V8's heap was capped at 4 GB or 2 GB.
  Because the runs were censored at the host ceiling, the honest statement is
  that none of these controls **prevented the failure** — not that none of them
  changed anything at all. `experimental.turbopackMemoryLimit` is the one worth
  naming: it is the option that looks like the remedy, and across 512 MB, 2048 MB
  and 2048 MB-with-persistent-caching it did not move the outcome by a second or
  a megabyte you could act on. That is why this checkout deliberately does not
  expose it as a knob.
- **Rows 11–15: webpack fails differently, and honestly.** Capping the heap
  keeps total RSS under the host ceiling (row 12: 4.04 GB) but the build then
  exhausts the heap instead. Raising the heap raises RSS almost one-for-one
  (3072 → 4.04 GB, 3584 → 4.60 GB, 3840 → 4.69 GB, 4096 → 4.96 GB = reaped), so
  no heap ceiling tested left a usable window: webpack still wanted more than
  3.84 GB of heap, and 3.84 GB of heap already cost 4.69 GB of RSS against
  ~4.9 GB of headroom. The exact heap webpack needs is unknown — every run that
  could have told us was killed — but it is above every value that fits here.
  `experimental.webpackMemoryOptimizations` and `NEXT_WEBPACK_PARALLELISM=1`
  bought a lot of *time* (row 13 ran 15 minutes before dying) but not the
  ceiling.
- **cinatra-cli#210's `--webpack` `RangeError` did not reproduce** on
  16.2.10. The webpack path builds; it runs out of memory. That is a different —
  and better — failure than the one recorded there.

### The conclusion

**No knob in this repository cleared the wall on a ~6 GB / 6-CPU builder, and
none of the untaken Next options tried alongside them did either.** On the
evidence here this app's production build wants more memory than that profile
has on both bundler paths; the knobs redistribute the requirement rather than
shrink it. That is a negative result about this profile and this Next version,
established by 15 cold runs — not a proof that no such setting can exist.

That is consistent with how CI builds it: `build-image.yml` runs the image build
on a 4-vCPU / ~16 GB runner and *also* adds up to 12 GB of swap for exactly this
reason, noting that a bounded build "peaked at ~33 G total on the PRE-fix tree".
The remedy for a 6 GB builder is memory or swap, not configuration.

### What to do instead, today

1. **Give the builder more memory.** ~8 GB of RAM available to the build is the
   floor to try; the CI profile (16 GB + swap) is what is known to work.
2. **Or give it swap.** A build that is bounded — this one is — completes
   through swap. `build-image.yml`'s "Add CI build swap" step is the worked
   example.
3. **Or do not build locally at all.** Pull the released image.

### If you are re-measuring

Redo the whole table; do not trust a single row. Each run must be cold (fresh
container, no `.next`), one at a time, with `/usr/bin/time -v` around the real
`pnpm build` inside the image. Record what else was resident on the host — 455 MB
of neighbours is 10 % of this budget, and the margins here are thinner than that.
