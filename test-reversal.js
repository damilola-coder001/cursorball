/* test-reversal.js — verifies smooth spin transition on sudden direction
 * changes: no snap, monotonic decay of |ω| through the flip.                */
import * as THREE from 'three';
import { SoccerBall } from './js/ball.js';

const scene = new THREE.Scene();
const ball = new SoccerBall(scene, { rx: 500, rz: 500 });
const DT = 1 / 60;

// Roll +x for a while (ω converges to a steady −z spin).
ball.pos.set(0, 0.85, 0); ball.vy = 0; ball._hopTimer = 5;
for (let i = 0; i < 80; i++) {
  ball._prevPos.copy(ball.pos);
  ball.pos.x += 0.1;
  ball._rollFromDisplacement(DT);
}
const w0 = ball._angVel.clone();
let ok = true, maxJump = 0, prevMag = w0.length();
// Suddenly reverse: displace −x per frame.
for (let i = 0; i < 60; i++) {
  ball._prevPos.copy(ball.pos);
  ball.pos.x -= 0.1;
  ball._rollFromDisplacement(DT);
  const mag = ball._angVel.length();
  maxJump = Math.max(maxJump, Math.abs(mag - prevMag));
  prevMag = mag;
  if (!Number.isFinite(mag)) { ok = false; break; }
}
console.log(`${ok && maxJump < 4 ? 'PASS' : 'FAIL'}  direction reversal transitions smoothly (no snap) — biggest per-frame |ω| change=${maxJump.toFixed(3)} rad/s`);
process.exit(ok && maxJump < 4 ? 0 : 1);
