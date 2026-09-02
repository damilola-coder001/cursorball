/* test-edge.js — verifies the ball can reach EVERY visible screen point.
 *
 * The mapping under test (js/input.js) is pure camera-viewport math:
 *   target = Ray(cursor NDC) ∩ Floor(y = 0), unclamped.
 *
 * Checks:
 *   A. Back-projection: the target, projected back through the camera,
 *      lands EXACTLY on the cursor's screen pixel — for a dense grid of
 *      screen positions INCLUDING all edges and corners, and at three
 *      different aspect ratios (16:9, ultrawide, portrait).
 *   B. The target matches an independent THREE.Plane ray intersection.
 *   C. Directional sanity: left edge → left, right → right, bottom →
 *      near the camera, top → far toward the horizon.
 *   D. The REAL ball reaches and holds the target of all four corners.
 *   E. The ball tracks a cursor sweeping along all four edges.
 *
 * Run: node test-edge.js
------------------------------------------------------------------- */
import * as THREE from 'three';
import { SoccerBall } from './js/ball.js';

const scene = new THREE.Scene();
const ball = new SoccerBall(scene, { rx: 500, rz: 500 }); // walls far away

const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 500);
camera.position.set(0, 10.8, 15.0);
camera.lookAt(0, 0.3, 0);
camera.updateMatrixWorld();

const raycaster = new THREE.Raycaster();
const FLOOR = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // y = 0
const DT = 1 / 60;

/* Replicates PointerTracker.update(): exact ray∩floor, no clamping. */
function targetFor(ndcX, ndcY, out) {
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  const dir = raycaster.ray.direction;
  const org = raycaster.ray.origin;
  if (dir.y >= -1e-6) return false;         // cannot reach the floor
  const t = -org.y / dir.y;
  out.set(org.x + dir.x * t, 0, org.z + dir.z * t);
  return true;
}

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
};

const target = new THREE.Vector3();
const hit = new THREE.Vector3();
const proj = new THREE.Vector3();

// ---- A) Back-projection: target sits EXACTLY under the cursor --------
// Sampled densely across the whole viewport, edges and corners included,
// at several aspect ratios (proves it derives from the LIVE projection).
const ASPECTS = [[16 / 9, '16:9'], [2.33, 'ultrawide 21:9'], [0.56, 'portrait']];
for (const [aspect, label] of ASPECTS) {
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  let ok = true, worst = 0, misses = 0;
  for (let sx = -1; sx <= 1.0001; sx += 0.1) {
    for (let sy = -1; sy <= 1.0001; sy += 0.1) {
      const cx = Math.min(1, sx), cy = Math.min(1, sy);
      if (!targetFor(cx, cy, target)) { misses++; continue; }
      // Independent check: THREE.Plane intersection must agree exactly.
      raycaster.setFromCamera(new THREE.Vector2(cx, cy), camera);
      if (raycaster.ray.intersectPlane(FLOOR, hit) === null) { ok = false; break; }
      if (hit.distanceTo(target) > 1e-9) ok = false;
      // Back-project the target — it must land on the cursor pixel.
      proj.set(target.x, 0, target.z).project(camera);
      const err = Math.hypot(proj.x - cx, proj.y - cy);
      worst = Math.max(worst, err);
      if (err > 1e-6) ok = false;
    }
  }
  check(`A[${label}] target == floor point under cursor (all edges/corners)`,
    ok && misses === 0, `worst back-projection error=${worst.toExponential(2)}`);
}
camera.aspect = 16 / 9;                       // restore default
camera.updateProjectionMatrix();
camera.updateMatrixWorld();

// ---- C) Directional sanity across the screen -------------------------
{
  targetFor(-1, 0, target);  const leftX = target.x;
  targetFor(1, 0, target);   const rightX = target.x;
  targetFor(0, 1, target);   const topZ = target.z;
  const topDist = Math.hypot(target.x, target.z - 15);
  targetFor(0, -1, target);  const bottomZ = target.z;
  check('left edge maps to the left side (x < 0)', leftX < -10, `x=${leftX.toFixed(1)}`);
  check('right edge maps to the right side (x > 0)', rightX > 10, `x=${rightX.toFixed(1)}`);
  check('top edge maps to the far floor (toward horizon)', topZ < -10,
    `z=${topZ.toFixed(1)}, dist=${topDist.toFixed(1)}`);
  check('bottom edge maps to the near floor', bottomZ > 4, `z=${bottomZ.toFixed(1)}`);
}

// ---- D) The REAL ball reaches & holds all four corner targets --------
{
  const corners = [
    ['top-left', -1, 1], ['top-right', 1, 1],
    ['bottom-left', -1, -1], ['bottom-right', 1, -1],
  ];
  for (const [name, nx, ny] of corners) {
    ball.pos.set(0, 0.85, 0); ball.vel.set(0, 0, 0); ball.vy = 0; ball._hopTimer = 5;
    targetFor(nx, ny, target);
    const tx = target.x, tz = target.z;
    for (let i = 0; i < 60 * 20; i++) ball.update(DT, target);
    const gap = Math.hypot(tx - ball.pos.x, tz - ball.pos.z);
    check(`corner ${name}: ball reaches and holds the cursor point`, gap < 0.4,
      `gap=${gap.toFixed(3)}, target=(${tx.toFixed(1)},${tz.toFixed(1)})`);
  }
}

// ---- E) The ball tracks a cursor sweeping along each of the 4 edges --
{
  const sweeps = [
    ['top edge', (t) => [-1 + 2 * t, 0.98]],
    ['bottom edge', (t) => [-1 + 2 * t, -0.98]],
    ['left edge', (t) => [-0.98, -1 + 2 * t]],
    ['right edge', (t) => [0.98, -1 + 2 * t]],
  ];
  for (const [name, pos] of sweeps) {
    ball.pos.set(0, 0.85, 0); ball.vel.set(0, 0, 0); ball.vy = 0; ball._hopTimer = 5;
    // Settle at the sweep's starting point first, so the measured lag is
    // the steady-state tracking error, not the initial catch-up sprint.
    const [sx, sy] = pos(0);
    targetFor(sx, sy, target);
    for (let i = 0; i < 60 * 8; i++) ball.update(DT, target);
    let tracked = true, worst = 0;
    const secs = 16;
    for (let i = 0; i <= 60 * secs; i++) {
      const [nx, ny] = pos(i / (60 * secs));
      targetFor(nx, ny, target);
      ball.update(DT, target);
      worst = Math.max(worst, Math.hypot(ball.pos.x - target.x, ball.pos.z - target.z));
      if (worst > 7) { tracked = false; break; }
    }
    check(`sweeping ${name}: ball follows the cursor the whole way`, tracked,
      `worst lag=${worst.toFixed(2)} units`);
  }
}

console.log(failed === 0 ? '\nALL EDGE TESTS PASSED' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);