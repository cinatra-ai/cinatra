"use client";

import { useEffect, useRef } from "react";
import "./dancing-robot.css";

// ---------------------------------------------------------------------------
// Constants — ported verbatim from the source HTML
// ---------------------------------------------------------------------------

const MODES = [
  "",
  "breakdance",
  "disco",
  "robot",
  "moonwalk",
  "floss",
  "salsa",
  "twist",
  "ymca",
  "vogue",
  "tango",
  "charleston",
  "hattip",
  "float",
  "jump",
  "lasso",
  "kickline",
  "handjive",
  "sway",
  "monster",
  "conduct",
  "disassemble",
] as const;

const HOLD_MS = 7000;
const HOLD_OVERRIDES: Partial<Record<(typeof MODES)[number], number>> = { float: 16000 };
const TWEEN_MS = 800;

const PARTS = [
  ".g-rig",
  ".g-hips",
  ".g-torso",
  ".g-head",
  ".g-hat",
  ".g-arm-l",
  ".g-arm-r",
  ".g-leg-l",
  ".g-leg-r",
  ".g-foot-r",
  ".g-hand-wave",
] as const;

// REST object — copied verbatim from the source HTML, do not edit values.
const REST: Record<string, Record<string, string>> = {
  "": {
    ".g-hips": "translateX(-6px) rotate(-1.5deg)",
    ".g-torso": "rotate(2deg)",
    ".g-head": "rotate(-3deg)",
    ".g-hat": "rotate(-4deg)",
    ".g-arm-l": "rotate(8deg)",
    ".g-arm-r": "rotate(-8deg)",
    ".g-leg-l": "none",
    ".g-leg-r": "none",
    ".g-foot-r": "none",
    ".g-hand-wave": "rotate(-18deg)",
  },
  breakdance: {
    ".g-hips": "translateX(-8px) rotate(-4deg)",
    ".g-torso": "rotate(0deg)",
    ".g-head": "rotate(-2deg)",
    ".g-hat": "rotate(0deg)",
    ".g-arm-l": "rotate(40deg)",
    ".g-arm-r": "rotate(-40deg)",
    ".g-leg-l": "none",
    ".g-leg-r": "none",
    ".g-foot-r": "none",
    ".g-hand-wave": "none",
  },
  disco: {
    ".g-hips": "translateX(-4px) translateY(-2px) rotate(-3deg)",
    ".g-torso": "rotate(-3deg) translateY(-1px)",
    ".g-head": "rotate(8deg)",
    ".g-hat": "rotate(-6deg)",
    ".g-arm-l": "rotate(-130deg) translate(2px,-8px)",
    ".g-arm-r": "rotate(-45deg) translate(2px,4px)",
    ".g-leg-l": "rotate(-6deg) translate(-2px,0)",
    ".g-leg-r": "rotate(8deg) translate(2px,-2px)",
    ".g-foot-r": "none",
    ".g-hand-wave": "none",
  },
  robot: {
    ".g-hips": "none",
    ".g-torso": "none",
    ".g-head": "rotate(-12deg)",
    ".g-hat": "none",
    ".g-arm-l": "rotate(-90deg)",
    ".g-arm-r": "none",
    ".g-leg-l": "none",
    ".g-leg-r": "none",
    ".g-foot-r": "none",
    ".g-hand-wave": "none",
  },
  moonwalk: {
    ".g-hips": "rotate(-6deg)",
    ".g-torso": "rotate(8deg)",
    ".g-head": "rotate(-4deg)",
    ".g-hat": "rotate(-10deg)",
    ".g-arm-l": "rotate(20deg)",
    ".g-arm-r": "rotate(-35deg) translate(-2px,-2px)",
    ".g-leg-l": "translateX(8px)",
    ".g-leg-r": "translateX(8px)",
    ".g-foot-r": "none",
    ".g-hand-wave": "none",
  },
  floss: {
    ".g-hips": "translateX(-6px) rotate(-3deg)",
    ".g-torso": "rotate(3deg)",
    ".g-head": "rotate(-2deg)",
    ".g-hat": "rotate(-4deg)",
    ".g-arm-l": "rotate(-30deg) translate(8px,0)",
    ".g-arm-r": "rotate(-40deg) translate(8px,0)",
    ".g-leg-l": "none",
    ".g-leg-r": "none",
    ".g-foot-r": "none",
    ".g-hand-wave": "none",
  },
  salsa: {
    ".g-hips": "translateX(-8px) rotate(-6deg)",
    ".g-torso": "rotate(4deg) translateY(-1px)",
    ".g-head": "rotate(-4deg)",
    ".g-hat": "none",
    ".g-arm-l": "rotate(-30deg) translate(2px,-4px)",
    ".g-arm-r": "rotate(30deg) translate(-2px,2px)",
    ".g-leg-l": "rotate(-3deg) translateX(-2px)",
    ".g-leg-r": "rotate(6deg) translateX(2px)",
    ".g-foot-r": "none",
    ".g-hand-wave": "none",
  },
  twist: {
    ".g-hips": "rotate(-8deg) translateY(2px)",
    ".g-torso": "rotate(6deg)",
    ".g-head": "rotate(-3deg)",
    ".g-hat": "none",
    ".g-arm-l": "rotate(-50deg) translate(4px,-2px)",
    ".g-arm-r": "rotate(50deg) translate(-4px,-2px)",
    ".g-leg-l": "rotate(-10deg)",
    ".g-leg-r": "rotate(10deg)",
    ".g-foot-r": "none",
    ".g-hand-wave": "none",
  },
  ymca: {
    ".g-hips": "none",
    ".g-torso": "none",
    ".g-head": "none",
    ".g-hat": "none",
    ".g-arm-l": "rotate(0deg)",
    ".g-arm-r": "rotate(0deg)",
    ".g-leg-l": "none",
    ".g-leg-r": "none",
    ".g-foot-r": "none",
    ".g-hand-wave": "none",
  },
  vogue: {
    ".g-hips": "translateX(-4px) rotate(-3deg)",
    ".g-torso": "rotate(-2deg)",
    ".g-head": "rotate(8deg)",
    ".g-hat": "none",
    ".g-arm-l": "rotate(0deg)",
    ".g-arm-r": "rotate(0deg)",
    ".g-leg-l": "none",
    ".g-leg-r": "none",
    ".g-foot-r": "none",
    ".g-hand-wave": "none",
  },
  tango: {
    ".g-hips": "translateX(-4px) rotate(-2deg)",
    ".g-torso": "rotate(2deg)",
    ".g-head": "rotate(-12deg)",
    ".g-hat": "none",
    ".g-arm-l": "rotate(-110deg) translate(8px,-12px)",
    ".g-arm-r": "rotate(110deg) translate(-8px,-12px)",
    ".g-leg-l": "rotate(-3deg)",
    ".g-leg-r": "rotate(3deg)",
    ".g-foot-r": "none",
    ".g-hand-wave": "none",
  },
  charleston: {
    ".g-hips": "translateY(-2px) rotate(-2deg)",
    ".g-torso": "rotate(2deg)",
    ".g-head": "rotate(-4deg) translateY(-1px)",
    ".g-hat": "none",
    ".g-arm-l": "rotate(-50deg) translate(0,-4px)",
    ".g-arm-r": "rotate(50deg) translate(0,-4px)",
    ".g-leg-l": "rotate(-12deg) translateX(6px)",
    ".g-leg-r": "rotate(12deg) translateX(-6px)",
    ".g-foot-r": "none",
    ".g-hand-wave": "none",
  },
  hattip: {
    ".g-hips": "none",
    ".g-torso": "none",
    ".g-head": "rotate(0)",
    ".g-hat": "rotate(0) translate(0,0)",
    ".g-arm-l": "rotate(8deg)",
    ".g-arm-r": "rotate(0deg) translate(0,0)",
    ".g-leg-l": "none",
    ".g-leg-r": "none",
    ".g-foot-r": "none",
    ".g-hand-wave": "none",
  },
  float: {
    ".g-rig": "translate(0,0) rotate(0deg)",
    ".g-hips": "translateY(0) rotate(0)",
    ".g-torso": "rotate(0)",
    ".g-head": "rotate(-2deg)",
    ".g-hat": "none",
    ".g-arm-l": "rotate(-80deg)",
    ".g-arm-r": "rotate(80deg)",
    ".g-leg-l": "rotate(-4deg) translateY(0)",
    ".g-leg-r": "rotate(4deg) translateY(0)",
    ".g-foot-r": "none",
    ".g-hand-wave": "none",
  },
  jump: {
    ".g-hips": "translateY(0)",
    ".g-torso": "none",
    ".g-head": "none",
    ".g-hat": "none",
    ".g-arm-l": "rotate(0deg)",
    ".g-arm-r": "rotate(0deg)",
    ".g-leg-l": "rotate(0) translateX(0)",
    ".g-leg-r": "rotate(0) translateX(0)",
    ".g-foot-r": "none",
    ".g-hand-wave": "none",
  },
  lasso: {
    ".g-hips": "translateX(-4px) rotate(-2deg)",
    ".g-torso": "rotate(2deg)",
    ".g-head": "rotate(-6deg)",
    ".g-hat": "none",
    ".g-arm-l": "rotate(20deg)",
    ".g-arm-r": "rotate(-180deg) translate(-12px,-30px)",
    ".g-leg-l": "rotate(0)",
    ".g-leg-r": "rotate(0)",
    ".g-foot-r": "none",
    ".g-hand-wave": "none",
  },
  kickline: {
    ".g-hips": "rotate(0)",
    ".g-torso": "rotate(0)",
    ".g-head": "rotate(0)",
    ".g-hat": "none",
    ".g-arm-l": "rotate(-95deg)",
    ".g-arm-r": "rotate(95deg)",
    ".g-leg-l": "rotate(0) translateY(0)",
    ".g-leg-r": "rotate(0) translateY(0)",
    ".g-foot-r": "none",
    ".g-hand-wave": "none",
  },
  handjive: {
    ".g-hips": "translateX(-2px) rotate(-1deg)",
    ".g-torso": "rotate(2deg)",
    ".g-head": "rotate(-3deg)",
    ".g-hat": "none",
    ".g-arm-l": "rotate(-40deg) translate(20px,-2px)",
    ".g-arm-r": "rotate(40deg) translate(-20px,8px)",
    ".g-leg-l": "none",
    ".g-leg-r": "none",
    ".g-foot-r": "none",
    ".g-hand-wave": "none",
  },
  sway: {
    ".g-hips": "translateX(-10px) rotate(-4deg)",
    ".g-torso": "rotate(3deg)",
    ".g-head": "rotate(-4deg)",
    ".g-hat": "none",
    ".g-arm-l": "rotate(-12deg)",
    ".g-arm-r": "rotate(12deg)",
    ".g-leg-l": "rotate(-4deg) translateX(-2px)",
    ".g-leg-r": "rotate(4deg) translateX(2px)",
    ".g-foot-r": "none",
    ".g-hand-wave": "none",
  },
  monster: {
    ".g-hips": "translateY(0)",
    ".g-torso": "rotate(0)",
    ".g-head": "rotate(0)",
    ".g-hat": "none",
    ".g-arm-l": "rotate(-92deg) translate(20px,0)",
    ".g-arm-r": "rotate(92deg) translate(-20px,0)",
    ".g-leg-l": "rotate(-12deg) translateX(-2px)",
    ".g-leg-r": "rotate(12deg) translateX(2px)",
    ".g-foot-r": "none",
    ".g-hand-wave": "none",
  },
  conduct: {
    ".g-hips": "rotate(0)",
    ".g-torso": "rotate(-1deg)",
    ".g-head": "rotate(-3deg)",
    ".g-hat": "none",
    ".g-arm-l": "rotate(-50deg) translate(8px,4px)",
    ".g-arm-r": "rotate(20deg) translate(-4px,8px)",
    ".g-leg-l": "none",
    ".g-leg-r": "none",
    ".g-foot-r": "none",
    ".g-hand-wave": "none",
  },
  disassemble: {
    ".g-hips": "translateY(0) rotate(0)",
    ".g-torso": "rotate(0)",
    ".g-head": "translate(0,0) rotate(0)",
    ".g-hat": "translate(0,0) rotate(0)",
    ".g-arm-l": "rotate(0deg) translate(0,0)",
    ".g-arm-r": "rotate(0deg) translate(0,0)",
    ".g-leg-l": "rotate(0deg) translate(0,0)",
    ".g-leg-r": "rotate(0deg) translate(0,0)",
    ".g-foot-r": "none",
    ".g-hand-wave": "none",
  },
};


// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * DancingRobot — a self-contained, decorative SVG animation that auto-cycles
 * through 12 dance modes (idle + 11 named dances). All class toggles and
 * querySelector calls are scoped to a `useRef`-d container div so the styles
 * never leak outside the component.
 */
export function DancingRobot() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    let timer: number | null = null;
    let i = 0;
    let needleStep = 0;
    let needleAngle = -135;

    function advanceNeedle() {
      const needle = root!.querySelector(".g-needle") as SVGGElement | null;
      if (!needle) return;
      needleStep = (needleStep + 1) % MODES.length;
      const span = 270;
      const startAngle = -135;
      const fromAngle = needleAngle;
      const toAngle = startAngle + (needleStep * span) / MODES.length;
      needleAngle = toAngle;
      const dur = 1200;
      const t0 = performance.now();
      const ease = (t: number) => {
        const c1 = 1.70158, c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
      };
      function step(now: number) {
        const t = Math.min(1, (now - t0) / dur);
        const a = fromAngle + (toAngle - fromAngle) * ease(t);
        needle!.setAttribute("transform", `rotate(${a.toFixed(2)} 0 40)`);
        if (t < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }

    requestAnimationFrame(() => {
      const needle = root!.querySelector(".g-needle") as SVGGElement | null;
      if (needle) needle.setAttribute("transform", "rotate(-135 0 40)");
    });

    function swapMode(nextIdx: number) {
      const fromKey = MODES[i];
      const toKey = MODES[nextIdx];
      const targets = REST[toKey] ?? {};

      // Sample mid-animation transforms BEFORE suppressing CSS animations so we
      // capture wherever the dance was, not the snapped keyframe-0 position.
      const samples = PARTS.map((sel) => {
        const el = root!.querySelector(sel) as SVGGraphicsElement | null;
        if (!el) return null;
        const t = getComputedStyle(el).transform;
        return { el, from: t && t !== "none" ? t : "none", to: targets[sel] ?? "none" };
      }).filter((s): s is NonNullable<typeof s> => s !== null);

      root!.classList.add("tweening");
      if (fromKey) root!.classList.remove(fromKey);
      i = nextIdx;

      const tweens: Animation[] = [];
      for (const { el, from, to } of samples) {
        try {
          tweens.push(
            el.animate(
              [{ transform: from }, { transform: to }],
              { duration: TWEEN_MS, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" },
            ),
          );
        } catch {
          // ignore — WAAPI unavailable
        }
      }

      // Add new class first so CSS animations are ready, then drop tweening so
      // they take over, then cancel WAAPI overrides.
      Promise.all(tweens.map((t) => t.finished.catch(() => {}))).then(() => {
        if (toKey) root!.classList.add(toKey);
        root!.classList.remove("tweening");
        tweens.forEach((t) => t.cancel());
      });
    }

    function tick() {
      swapMode((i + 1) % MODES.length);
      advanceNeedle();
      const hold = HOLD_OVERRIDES[MODES[i]] ?? HOLD_MS;
      timer = window.setTimeout(tick, hold + TWEEN_MS);
    }
    function start() {
      stop();
      const hold = HOLD_OVERRIDES[MODES[i]] ?? HOLD_MS;
      timer = window.setTimeout(tick, hold + TWEEN_MS);
    }
    function stop() {
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
    }

    start();

    const onVis = () => {
      if (document.hidden) {
        stop();
      } else {
        start();
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      document.removeEventListener("visibilitychange", onVis);
      stop();
      root.classList.remove("tweening");
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="dancing-robot w-[315px]"
      style={{ aspectRatio: "800/1000" }}
      aria-hidden="true"
    >
      <svg viewBox="-200 -380 800 1000" width="315" xmlns="http://www.w3.org/2000/svg">
        <g transform="translate(200 320)">
          <g className="g-rig">
          <g className="g-hips">
            {/* LEGS */}
            <g transform="translate(-22 0)">
              <g className="g-leg-l">
                <rect
                  x="-9"
                  y="0"
                  width="18"
                  height="56"
                  rx="3"
                  fill="none"
                  stroke="var(--ink)"
                  strokeWidth="6"
                />
                <circle cx="0" cy="28" r="4" fill="var(--ink)" />
                <path d="M-14 56 L14 56 L18 64 L-12 64 Z" fill="var(--ink)" />
              </g>
            </g>
            <g transform="translate(22 0)">
              <g className="g-leg-r">
                <rect
                  x="-9"
                  y="0"
                  width="18"
                  height="56"
                  rx="3"
                  fill="none"
                  stroke="var(--ink)"
                  strokeWidth="6"
                />
                <circle cx="0" cy="28" r="4" fill="var(--ink)" />
                <g transform="translate(0 56)">
                  <g className="g-foot-r">
                    <path d="M-14 0 L14 0 L18 8 L-12 8 Z" fill="var(--ink)" />
                  </g>
                </g>
              </g>
            </g>
            {/* TORSO */}
            <g className="g-torso">
              {/* Body */}
              <g transform="translate(0 -90)">
                <path
                  d="M-50 0 L-50 76 Q-50 86 -40 86 L40 86 Q50 86 50 76 L50 0 Q50 -8 42 -8 L-42 -8 Q-50 -8 -50 0 Z"
                  fill="none"
                  stroke="var(--ink)"
                  strokeWidth="6"
                  strokeLinejoin="round"
                />
                {/* Bowtie */}
                <path
                  d="M-14 4 L-2 -2 L-2 14 L-14 8 Z M14 4 L2 -2 L2 14 L14 8 Z"
                  fill="var(--ink)"
                />
                <circle cx="0" cy="6" r="3" fill="var(--ink)" />
                {/* Chest dial */}
                <circle cx="0" cy="40" r="14" fill="none" stroke="var(--ink)" strokeWidth="4" />
                <circle cx="0" cy="40" r="2" fill="var(--ink)" />
                <g className="g-needle" transform="rotate(-135 0 40)">
                  <line
                    x1="0"
                    y1="40"
                    x2="0"
                    y2="28"
                    stroke="var(--ink)"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                </g>
                {/* Rivets */}
                <circle cx="-44" cy="20" r="2" fill="var(--ink)" />
                <circle cx="-44" cy="60" r="2" fill="var(--ink)" />
                <circle cx="44" cy="20" r="2" fill="var(--ink)" />
                <circle cx="44" cy="60" r="2" fill="var(--ink)" />
              </g>
              {/* HEAD */}
              <g transform="translate(0 -90)">
                <g className="g-head">
                  <g transform="translate(0 -70)">
                    {/* Head box */}
                    <path
                      d="M-44 -30 Q-44 -42 -34 -42 L34 -42 Q44 -42 44 -30 L44 30 Q44 42 34 42 L-34 42 Q-44 42 -44 30 Z"
                      fill="none"
                      stroke="var(--ink)"
                      strokeWidth="6"
                      strokeLinejoin="round"
                    />
                    {/* Ear vents */}
                    <g stroke="var(--ink)" strokeWidth="4" strokeLinecap="round">
                      <line x1="-44" y1="-6" x2="-50" y2="-6" />
                      <line x1="-44" y1="2" x2="-50" y2="2" />
                      <line x1="-44" y1="10" x2="-50" y2="10" />
                      <line x1="44" y1="-6" x2="50" y2="-6" />
                      <line x1="44" y1="2" x2="50" y2="2" />
                      <line x1="44" y1="10" x2="50" y2="10" />
                    </g>
                    {/* Eyes */}
                    <g className="eye">
                      <circle cx="-16" cy="-8" r="6" fill="var(--ink)" />
                      <circle cx="-14" cy="-10" r="1.5" fill="var(--paper)" />
                    </g>
                    <g className="eye">
                      <circle cx="16" cy="-8" r="6" fill="var(--ink)" />
                      <circle cx="18" cy="-10" r="1.5" fill="var(--paper)" />
                    </g>
                    {/* Cheek bolts */}
                    <circle cx="-30" cy="14" r="2.5" fill="var(--ink)" />
                    <circle cx="30" cy="14" r="2.5" fill="var(--ink)" />
                    {/* Mouth */}
                    <g transform="translate(0 18)">
                      <rect
                        x="-14"
                        y="-6"
                        width="28"
                        height="12"
                        rx="2"
                        fill="none"
                        stroke="var(--ink)"
                        strokeWidth="3"
                      />
                      <g className="mouth">
                        <rect x="-10" y="-3" width="4" height="6" fill="var(--ink)" />
                        <rect x="-3" y="-3" width="4" height="6" fill="var(--ink)" />
                        <rect x="4" y="-3" width="4" height="6" fill="var(--ink)" />
                      </g>
                    </g>
                    {/* FEDORA HAT */}
                    <g transform="translate(-46 -106)">
                      <g className="g-hat">
                        <g transform="rotate(-3) scale(0.32) translate(-256 -222)">
                          {/* Brim */}
                          <path
                            d="M72 214 C 72 200 96 190 130 188 C 168 186 196 200 256 210 C 316 220 358 214 400 200 C 426 192 440 196 440 208 C 440 222 420 234 388 242 C 340 254 288 256 256 256 C 202 256 132 248 100 238 C 80 232 72 224 72 214 Z"
                            fill="var(--fedora)"
                          />
                          {/* Crown */}
                          <path
                            d="M146 188 C 150 130 176 86 212 72 C 226 66 240 64 252 64 C 262 64 270 70 268 80 L 264 100 C 272 88 288 82 300 82 C 332 82 356 118 362 188 Z"
                            fill="var(--fedora)"
                          />
                        </g>
                      </g>
                    </g>
                  </g>
                </g>
              </g>
              {/* LEFT ARM */}
              <g transform="translate(-50 -82)">
                <g className="g-arm-l">
                  <rect
                    x="-22"
                    y="0"
                    width="22"
                    height="50"
                    rx="11"
                    fill="var(--paper)"
                    stroke="var(--ink)"
                    strokeWidth="6"
                  />
                  <circle
                    cx="-11"
                    cy="58"
                    r="9"
                    fill="var(--paper)"
                    stroke="var(--ink)"
                    strokeWidth="5"
                  />
                  <circle cx="-11" cy="58" r="2" fill="var(--ink)" />
                </g>
              </g>
              {/* RIGHT ARM */}
              <g transform="translate(50 -82)">
                <g className="g-arm-r">
                  <rect
                    x="0"
                    y="0"
                    width="22"
                    height="50"
                    rx="11"
                    fill="var(--paper)"
                    stroke="var(--ink)"
                    strokeWidth="6"
                  />
                  <circle cx="11" cy="58" r="9" fill="var(--paper)" stroke="var(--ink)" strokeWidth="5" />
                  <circle cx="11" cy="58" r="2" fill="var(--ink)" />
                </g>
              </g>
            </g>
          </g>
          </g>
        </g>
      </svg>
    </div>
  );
}
