/* test-ball.js — headless verification of the soccer ball's movement.
 * Run with: node test-ball.js  (uses the locally installed three package)   */
import * as THREE from 'three';
import { SoccerBall } from './js/ball.js';

const scene = new THREE.Scene();
const ARENA = { rx: 10.4, rz: 6.0 };
const ball = new SoccerBall(scene, ARENA);
const target = new THREE.Vector3();
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
};
const DT = 1 / 60;

// 1) Reaches a far cursor target (settles within a reasonable time).
target.set(9, 0.85, 5);
for (let i = 0; i < 60 * 10; i++) ball.update(DT, target);
{
  const d = Math.hypot(target.x - ball.pos.x, target.z - ball.pos.z);
  check('reaches far cursor target', d < 0.15, `residual=${d.toFixed(3)}`);
}

// 2) Never teleports: track max per-frame displacement while chasing.
let maxStep = 0;
const corners = [[-10, -5.5], [10, 5.5], [-10, 5.5], [10, -5.5], [0, 0]];
for (const [cx, cz] of corners) {
  target.set(cx, 0.85, cz);
  const from = ball.pos.clone();
  for (let i = 0; i < 240; i++) {
    ball.update(DT, target);
    maxStep = Math.max(maxStep, ball.pos.distanceTo(from));
    from.copy(ball.pos);
  }
}
check('never teleports (max step/frame)', maxStep < 0.25, `max=${maxStep.toFixed(3)}`);

// 3) True rolling: with a constant displacement per frame, the rotation
//    per frame must equal displacement/radius about the axis
//    perpendicular to travel (kept under 2π so the quaternion encodes
//    the full net rotation). Displacement-driven: feed the roller the
//    same movement the integration produces.
ball.pos.set(0, 0.85, 0);
ball.vel.set(0, 0, 0); ball.vy = 0; ball._hopTimer = 5;
const q0 = ball.mesh.quaternion.clone();
const step = 0.1, dtRoll = 0.1, frames = 20;
for (let i = 0; i < 80; i++) {          // warm up: let ω converge first
  ball._prevPos.copy(ball.pos);
  ball.pos.x += step;
  ball._rollFromDisplacement(dtRoll);
}
const qWarm = ball.mesh.quaternion.clone();
for (let i = 0; i < frames; i++) {      // measured frames (ω now converged)
  ball._prevPos.copy(ball.pos);
  ball.pos.x += step;
  ball._rollFromDisplacement(dtRoll);
}
// Moving +x ⇒ rolling axis is −z; expected angle = distance / radius.
const expected = (step * frames) / 0.85;
const qRel = ball.mesh.quaternion.clone().multiply(qWarm.clone().invert());
const angle = 2 * Math.acos(Math.min(1, Math.abs(qRel.w)));
const sinHalf = Math.sqrt(1 - qRel.w * qRel.w);
const axisErr = Math.abs(qRel.z / sinHalf + 1); // ≈ 0 when axis = (0,0,−1)
check('rolls exactly with travel (angle = dist/r)', Math.abs(angle - expected) < 1e-6,
  `rotated=${angle.toFixed(4)} rad, expected=${expected.toFixed(4)} rad`);
check('rolls about the correct axis (−z for +x travel)', axisErr < 1e-6, `axisErr=${axisErr.toExponential(2)}`);

// 3b) Frame-rate independence: the same total displacement split over
//     half-size steps at double the rate rotates the ball identically.
ball.mesh.quaternion.copy(qWarm);
ball.pos.set(0, 0.85, 0);
const step2 = step / 2, dt2 = dtRoll / 2;
for (let i = 0; i < frames * 2; i++) {
  ball._prevPos.copy(ball.pos);
  ball.pos.x += step2;
  ball._rollFromDisplacement(dt2);
}
const qRel2 = ball.mesh.quaternion.clone().multiply(qWarm.clone().invert());
const angle2 = 2 * Math.acos(Math.min(1, Math.abs(qRel2.w)));
check('rolling is frame-rate independent', Math.abs(angle2 - expected) < 1e-6,
  `60fps=${expected.toFixed(4)}, 120fps=${angle2.toFixed(4)} rad`);

// 3c) Settling: when displacement stops, ω decays and the spin stops
//     smoothly (no perpetual rolling, no snap).
for (let i = 0; i < 120; i++) {
  ball._prevPos.copy(ball.pos);         // no movement at all
  ball._rollFromDisplacement(dtRoll);
}
check('spin settles when the ball stops', ball._angVel.length() < 0.01,
  `|ω|=${ball._angVel.length().toExponential(2)} rad/s`);

// 4) Stays inside the arena under chaotic chasing.
let inside = true;
for (let i = 0; i < 60 * 20; i++) {
  target.set((Math.random() * 2 - 1) * 10.4, 0.85, (Math.random() * 2 - 1) * 6);
  ball.update(DT, target);
  if (Math.abs(ball.pos.x) > ARENA.rx + 1e-6 || Math.abs(ball.pos.z) > ARENA.rz + 1e-6) { inside = false; break; }
}
check('stays inside arena (chaos test)', inside);

// 5) Settles when the cursor stops: speed decays.
target.set(ball.pos.x, 0.85, ball.pos.z);
for (let i = 0; i < 60 * 4; i++) ball.update(DT, target);
check('settles when cursor stops', Math.hypot(ball.vel.x, ball.vel.z) < 0.55,
  `speed=${Math.hypot(ball.vel.x, ball.vel.z).toFixed(3)}`);

// 6) Values stay finite.
check('state stays finite',
  Number.isFinite(ball.pos.x + ball.pos.y + ball.pos.z + ball.vel.x + ball.vel.z + ball.vy));

// 7) Ball rests exactly on the ground (y == radius) when idle.
for (let i = 0; i < 120; i++) ball.update(DT, target);
check('rests on ground plane', Math.abs(ball.pos.y - 0.85) < 1e-6, `y=${ball.pos.y.toFixed(4)}`);

// 8) Geometry sanity: has vertex colors and non-zero triangles.
const geo = ball.mesh.geometry;
check('geometry has per-face vertex colors', !!geo.attributes.color && geo.attributes.color.count === geo.attributes.position.count);
check('geometry has plenty of faces', geo.attributes.position.count > 2000, `verts=${geo.attributes.position.count}`);

console.log(failed === 0 ? '\nALL BALL TESTS PASSED' : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
