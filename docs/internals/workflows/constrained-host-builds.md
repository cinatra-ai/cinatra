# Building cinatra on a memory-constrained host

`pnpm build` (and the `next build` inside `docker build`) is the heaviest thing
this repository does. On a small builder it does not slow down — it dies. This
page documents the two env knobs the checkout exposes for that situation, what
each one actually binds, and — just as important — the levers that look like
remedies and, measured, did not deliver one.

Read the second half before you spend an afternoon on this. The headline result
is that **on a ~6 GB builder nothing tested here produced a successful build**,
on either bundler. The floor below says how big a builder actually has to be.

---

## Minimum builder memory: 16 GiB

**Give the build at least 16 GiB** — 16 GiB *available to the build*, which on a
laptop is not the same thing as 16 GiB of RAM. The number that decides your
outcome is the smallest of: the Docker Desktop / colima VM's memory setting, a
`docker run --memory` cap, the CI runner's RAM, or — building from a checkout —
the machine's total RAM minus whatever the desktop session is already holding. A
16 GiB laptop whose Docker VM is set to 8 GiB is an 8 GiB builder.

`scripts/next-build.mjs` reads the ceiling on that before it launches Next — the
cgroup cap when the build is capped, `os.totalmem()` otherwise. (A ceiling, not
"free memory": it cannot know what else on the machine is going to want some.)
Under the floor it prints a loud banner naming what you have, what the floor is,
and what to do — and then **builds anyway**. It is a warning, never a gate; see
below.

### Where the number comes from

Five cold builds on the #2630 harness — the repository `Dockerfile` truncated
immediately before its `pnpm build`, built as an image, then one fresh container
per run (cold, no `.next` carried over, one at a time, `CI=true`,
`/usr/bin/time -v`). Swap was disabled for every run by setting `--memory-swap`
equal to `--memory`, so each row is a hard ceiling with no cushion. Host:
Apple Silicon, 24 GiB, 14 CPUs, Docker Desktop VM raised to 17.5 GiB for the
runs. "Cores" is the container's `--cpuset-cpus`; "workers" is the page-data
fan-out Next announced. "Peak RSS" is GNU time's *Maximum resident set size* —
the largest single process. "Peak tree" is the container's own cgroup charge,
sampled every 3 s.

| # | `--memory` | cores | workers | outcome | peak RSS | peak tree | wall |
|---|---|---|---|---|---|---|---|
| 1 | 9 GiB | 14 | — | `SIGKILL` during compile | 8.78 GiB | — | 0:57 |
| 2 | 12 GiB | 14 | — | `SIGKILL` during compile | 11.74 GiB | — | 1:18 |
| 3 | 16 GiB | 14 | 13 | compiled in 2.0 min, then `SIGKILL` collecting page data | 14.73 GiB | 16.00 GiB | 2:41 |
| 4 | 16 GiB | 4 | 13 | compiled in 2.6 min, then `SIGKILL` collecting page data | 14.19 GiB | 15.84 GiB | 2:50 |
| **5** | **16 GiB** | **4** | **3** | **COMPLETED** (exit 0) | **14.35 GiB** | **15.51 GiB** | **3:41** |

Row 5 is the validated floor, and it is the first **uncensored** measurement
anyone has taken of this build. Every earlier number in this document, and every
number in cinatra#2607 and cinatra#2633, came from a process that was reaped —
those tell you a build did not fit, never how large it would have grown. This one
finished, so 14.35 GiB is the real peak of the largest single process and
15.51 GiB is the real peak of the whole tree.

Row 5 reached its 3 workers by setting `CINATRA_BUILD_CPUS=3` on top of the
4-CPU pin. That is not a tuning trick papering over the floor: on a real 4-core
builder Next defaults to exactly 3, and rows 3–4 are why the pin alone is not
enough to reproduce one (see below). Read row 5 as "a 4-core, 16 GiB builder",
emulated on a 14-core host.

### The argument for 16 and not something smaller

- **Every bound below 16 GiB that was tried died.** 9 GiB and 12 GiB were both
  reaped during compile, and in each case the largest process had grown to within
  3 % of the whole cap — the build takes whatever it is given until it either
  finishes or runs out, so those peaks are censored lower bounds and not
  requirements.
- **16 GiB is genuinely close to the line, not a comfortable round number.** The
  completing run peaked at 15.51 GiB of a 16 GiB cap: about 500 MiB of margin.
  Anything else resident inside that budget eats it. This is why the floor is
  stated as memory *available to the build* rather than machine RAM — the OS,
  your editor and every other container sit outside the number, and if they sit
  inside it you are below the floor without knowing it.
- **It is the smallest bound tested that completed — not a proven minimum, and
  not a guarantee.** Nothing between 12 and 16 GiB was tried, so the true minimum
  is somewhere in that interval; and 16 GiB was itself killed twice on this host
  before the worker fan-out came down. Both halves of that are in the next
  subsection.

### Memory and cores are not independent

Rows 3, 4 and 5 are the same build at the same 16 GiB cap, and they isolate one
variable at a time:

- **3 → 4** changes only the CPU pin (14 cores to 4). Both were killed, in the
  same phase, at nearly the same peak.
- **4 → 5** changes only the page-data worker count (13 to 3). That one
  completed.

The reason is worker fan-out:

- **Compile** (Turbopack, native) parallelises across the CPUs it can see; a
  `--cpuset-cpus` cap does bound it (the 4-core run reports 331–359 % CPU) and it
  passed at 16 GiB on both 14 and 4 cores.
- **Page-data collection and static generation** run in `(cores - 1)` separate
  Node worker processes, each with its own heap. Next sizes that from
  `os.cpus().length`, **which a `--cpuset-cpus` or `--cpus` cap does not
  change** — the 4-CPU-pinned run still announced "Collecting page data using 13
  workers" and was killed there. Only `experimental.cpus` bounds it, which is
  what `CINATRA_BUILD_CPUS` sets.

So on a builder with many cores, 16 GiB is not automatically enough: give it more
memory, or set `CINATRA_BUILD_CPUS` to bound the fan-out. The completing run used
`CINATRA_BUILD_CPUS=3` together with a 4-CPU pin, which is exactly the shape a
real 4-core builder has by default.

This also **retires the "not proven" caveat** that the `CINATRA_BUILD_CPUS`
section below carries: on the ~6 GB profile the build never reached the worker
phase, so the knob could not be tested. At 16 GiB it does reach that phase, and
there the knob is decisive.

### Why it warns instead of failing

The floor is the smallest size at which a build was measured to **complete**. It
is not a proof that everything below it fails. Every run above had swap disabled
on purpose, to get a hard ceiling — and `build-image.yml` deliberately adds up to
12 GB of swap to its ~15.8 GB runner for exactly this class of problem, so a
builder under the floor with swap is plausibly fine. (That the swap is what makes
CI succeed is the workflow's stated rationale, not something measured here.) A
smaller module graph would clear it too. Turning the floor into a gate would
refuse builds this evidence cannot condemn, and would break every builder that is
quietly succeeding on swap today. So the preflight is loud and non-fatal, on
stderr, printed before anything expensive starts.

### What the preflight actually reads

`os.totalmem()` on its own would be a lie in the case that matters most. It calls
`sysinfo(2)`, which is not cgroup-aware, so **inside a container it reports the
host's memory** — and every build this repository ships runs in a container
(`docker build`, the preview image, CI). The preflight therefore reads the cgroup
limit that governs its own process: it takes the cgroup path from
`/proc/self/cgroup` and reads `memory.max` (v2) or `memory/memory.limit_in_bytes`
(v1) along that path *and its ancestors*, keeping the tightest — because with
docker's default private cgroup namespace the path is `/` and the root file is
the answer, while a nested runner or a systemd slice puts the real cap on a
parent. cgroup v2's `max` and cgroup v1's ~9.2e18 page-counter sentinel are read
as "uncapped", a readable v2 hierarchy is authoritative (no fall-through to a v1
file that may not govern the process), and every read is guarded so a surprising
cgroupfs can never throw into a build. It then reports the smaller of the cap and
the machine total, naming which one it used.

### Honest limits of this measurement

- **n = 1 at the floor.** One completing run, not a distribution.
- **The floor is a ceiling on memory, not a measure of free memory.** The
  preflight compares the cap with the floor; it cannot see what else on the
  machine intends to allocate.
- **linux/arm64.** Measured on Apple Silicon; the matrix further down is x86_64.
  Turbopack's native allocator is not obliged to behave identically on both.
- **16 GiB is the smallest bound *tested* that completed, not the smallest that
  can.** Nothing between 12 and 16 GiB was tried, so the true minimum lies
  somewhere in that interval. 16 GiB is the honest floor to publish because it is
  the one with a completing build behind it.
- **Swap disabled throughout.** A builder with swap can be under this floor and
  still finish.

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
It is **not** a remedy for the failure documented below, because on the ~6 GB
profile the build dies during compilation, before that phase is reached (rows 10
and 14 of the matrix). Treat it as a lever for a builder that gets past compile,
not as a remedy for one that does not.

On a builder that *does* get past compile, cinatra#2633 measured it as decisive:
at a 16 GiB cap the default 13-worker fan-out was killed and a 3-worker one
completed. See "Memory and cores are not independent" above — and note that
`--cpuset-cpus` / `--cpus` do **not** bound that fan-out, because Next sizes it
from `os.cpus().length`.

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

1. **Give the builder more memory.** **16 GiB available to the build** is the
   measured floor — see "Minimum builder memory" at the top of this page for the
   four runs it rests on, including the one that completed. An earlier revision
   of this page suggested "~8 GB is the floor to try"; that was a guess made from
   host-censored numbers and it was **wrong by roughly half**, which is exactly
   the error a completing build was needed to correct.
2. **Or give it swap.** A build that is bounded — this one is — completes
   through swap. `build-image.yml`'s "Add CI build swap" step is the worked
   example.
3. **Or do not build locally at all.** Pull the released image.

### If you are re-measuring

Redo the whole table; do not trust a single row. Each run must be cold (fresh
container, no `.next`), one at a time, with `/usr/bin/time -v` around the real
`pnpm build` inside the image. Record what else was resident on the host — 455 MB
of neighbours is 10 % of this budget, and the margins here are thinner than that.
