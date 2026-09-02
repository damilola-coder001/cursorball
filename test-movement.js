/* ------------------------------------------------------------------
 * test-movement.js — headless verification of the caterpillar's
 * movement system.
 *
 * Runs without a browser or GPU. It verifies the core promises of the
 * experiment:
 *   1. The head actually reaches the cursor's world target.
 *   2. The head never teleports (no per-frame jumps).
 *   3. The head never turns instantly (smooth yaw, limited step/frame).
 *   4. The tail reacts last (lags behind the head during a turn).
 *   5. Consecutive segments keep an exact, constant spacing.
 *   6. Every position stays finite (no NaN blow-ups over time).
 *
 * Run with:  npm test
------------------------------------------------------------------- */
import * as THREE from 'three';
import { Caterpillar } from './js/caterpillar.js';

// ---- Minimal DOM stub so the creature's shadow blob works in Node ----
globalThis.document = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      createRadialGradient: () => ({ addColorStop: () => {} }),
      fillRect: () => {},
      fill: () => {},
      fillStyle: '',
    }),
  }),
};

// Mock scene: only needs add() from the creature's side.
const scene = { add: () => {} };
const cat = new Caterpillar(scene);

const DT = 1 / 60; // fixed 60 Hz frame time (browser clamps to 0.05 max)
const PASS = [];
const FAIL = [];

function check(name, ok, detail = '') {
  (ok ? PASS : FAIL).push(name);
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Run `frames` updates toward a target; returns final head position. */
function sprint(targetX, targetZ, frames) {
  const t = new THREE.Vector3(targetX, 0, targetZ);
  for (let i = 0; i < frames; i++) cat.update(DT, t);
  return cat._pos.clone();
}

console.log('\n=== 1. Head reaches the cursor target (no teleport) ===\n');
{
  const start = cat._pos.clone();

  // Sprint across the whole arena toward a far target, measuring the
  // biggest single-frame displacement along the way.
  const t = new THREE.Vector3(6, 0, 0);
  let maxStep = 0;
  let end;
  for (let i = 0; i < 900; i++) {
    const before = cat._pos.clone();
    cat.update(DT, t);
    maxStep = Math.max(maxStep, before.distanceTo(cat._pos));
  }
  end = cat._pos.clone();
  const dist = Math.hypot(end.x - 6, end.z);

  check('head reaches the far cursor target', dist < 0.6, `residual ${dist.toFixed(3)}`);
  check('never jumps more than one crawl step per frame', maxStep < 0.35, `max step ${maxStep.toFixed(3)}`);
  check('head actually travelled', end.distanceTo(start) > 4);
}

console.log('\n=== 2. Smooth turning (no instant rotation) ===\n');
{
  // Re-settle at the origin, then chase a target in the opposite direction.
  sprint(0, 0, 900);
  const t = new THREE.Vector3(-8, 0, 0);
  let maxTurn = 0;
  for (let i = 0; i < 240; i++) {
    const prevYaw = cat._yaw; // snapshot BEFORE the step
    cat.update(DT, t);
    const d = Math.abs(cat._yaw - prevYaw);
    maxTurn = Math.max(maxTurn, (d * 180) / Math.PI);
  }
  // Even for a full 180° reversal, per-frame rotation must stay smooth.
  // turnRate ≈ 5.5 + speed·1.6 rad/s → typically < 12°/frame at 60 Hz.
  check('max yaw change per frame stays smooth', maxTurn < 25 && maxTurn > 0.5,
    `max ${maxTurn.toFixed(1)}°/frame`);
}

console.log('\n=== 3. Tail reacts last (delay propagates down the body) ===\n');
{
  // Lay out straight heading +X, fully settled.
  sprint(0, 0, 900);
  const initialYaw = cat._yaw;

  // Teleport the cursor perpendicular (90° turn) and watch the response.
  const t = new THREE.Vector3(0, 0, 6);
  let maxHeadTurn = 0;
  let maxTailTurn = 0;
  for (let i = 0; i < 30; i++) { // 0.5 s
    const headYawBefore = cat._yaw;
    const tailDirBefore = tailDir(cat);
    cat.update(DT, t);
    maxHeadTurn = Math.max(maxHeadTurn, angleDiff(headYawBefore, cat._yaw) / DT);
    maxTailTurn = Math.max(maxTailTurn, angleDiff(tailDirBefore, tailDir(cat)) / DT);
  }

  // The tail's heading changes slower than the head's — it reacts last.
  check('head turns faster than the tail', maxHeadTurn > maxTailTurn,
    `head ${maxHeadTurn.toFixed(2)} rad/s vs tail ${maxTailTurn.toFixed(2)} rad/s`);
  check('tail still carries some of the original heading after 0.5 s',
    angleDiff(initialYaw, tailDir(cat)) < angleDiff(initialYaw, cat._yaw),
    `tail ${(angleDiff(initialYaw, tailDir(cat)) * 180 / Math.PI).toFixed(0)}° vs head ${(angleDiff(initialYaw, cat._yaw) * 180 / Math.PI).toFixed(0)}°`);

  // And during the turn the body must visibly bend: the straight-line
  // chord from head to tail must dip clearly below the real body length.
  // (Watched at its peak inside the 0.5 s window.)
  sprint(0, 0, 400); // re-straighten after the heading measurements
  let minRatio = 1;
  for (let i = 0; i < 30; i++) { // run the 90° turn, sampling curvature
    cat.update(DT, t);
    const b = cat._bone;
    const arc = cat._pos.distanceTo(b[0].pos) + b[0].pos.distanceTo(b[1].pos)
              + b[1].pos.distanceTo(b[2].pos) + b[2].pos.distanceTo(b[3].pos);
    const chord = cat._pos.distanceTo(b[3].pos);
    if (arc > 1e-6) minRatio = Math.min(minRatio, chord / arc);
  }
  check('body forms a curved S (chord < arc) during the turn', minRatio < 0.98,
    `min chord/arc ${minRatio.toFixed(3)}`);
}

/** Angle from a → b in radians, wrapped to the shortest arc. */
function angleDiff(a, b) {
  return Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
}

/** Heading (radians) of the last body segment from its direction of travel. */
function tailDir(cat) {
  const b = cat._bone;
  const n = b.length;
  const dx = b[n - 1].pos.x - b[n - 2].pos.x;
  const dz = b[n - 1].pos.z - b[n - 2].pos.z;
  return Math.atan2(dx, dz);
}

console.log('\n=== 4. Segment spacing is exact and consistent ===\n');
{
  sprint(3, 4, 240);
  const spacing = cat._spacingFor(0);
  let worst = 0;
  let prevPos = cat._pos;
  for (let i = 0; i < cat.segments.length; i++) {
    const bone = cat._bone[i].pos;
    const d = Math.hypot(bone.x - prevPos.x, bone.z - prevPos.z);
    worst = Math.max(worst, Math.abs(d - (i === 0 ? cat._spacingFor(-1) : spacing)));
    prevPos = bone;
  }
  check('all consecutive segments maintain spacing', worst < 0.15, `worst deviation ${worst.toFixed(3)}`);
}

console.log('\n=== 5. Long-run stability (everything stays finite) ===\n');
{
  // Chase a chaotic cursor path — the harshest case.
  const t = new THREE.Vector3();
  let finite = true;
  for (let i = 0; i < 2000; i++) {
    const ang = i * 0.05;
    const rad = 4 + 3 * Math.sin(i * 0.012);
    t.set(Math.cos(ang) * rad, 0, Math.sin(ang) * rad * 1.2);
    cat.update(DT, t);
    const head = cat._pos;
    if (![head.x, head.y, head.z, cat._yaw].every(Number.isFinite)) { finite = false; break; }
    for (const s of cat.segments) {
      if (![s.position.x, s.position.y, s.position.z].every(Number.isFinite)) {
        finite = false; break;
      }
    }
    if (!finite) break;
  }
  check('2000 frames of chaotic chasing stay finite', finite);
}

console.log('\n=== 6. Overshoot-free settling at the target ===\n');
{
  sprint(-5, -3, 800); // get close to a target...
  sprint(-5, -3, 600); // ...and keep chasing it while it does not move
  const sp = Math.hypot(cat._vel.x, cat._vel.z);
  check('speed decays to a gentle crawl when the cursor stops', sp < 1.2, `speed ${sp.toFixed(3)}`);
}

console.log(`\nResults: ${PASS.length} passed, ${FAIL.length} failed\n`);
if (FAIL.length) {
  console.log('Failed:', FAIL.join(', '));
  process.exit(1);
}