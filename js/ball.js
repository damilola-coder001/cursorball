/* ball.js — a black-and-white soccer ball that chases the cursor.
 *
 * Geometry: a subdivided icosahedron whose faces are colored by a Voronoi
 * partition — faces nearest one of the 12 icosahedron VERTICES become black
 * pentagon panels, the rest stay white. Real 3D panel edges, no textures.
 *
 * Movement:
 *   1) critically-damped spring chase toward the cursor world point;
 *   2) rolling: driven by the ball's ACTUAL displacement each frame
 *      (previousPosition → currentPosition), ω = (up × v) / r — exact
 *      no-slip rolling, delta-time aware, with angular-inertia easing so
 *      direction changes transition smoothly and the spin settles when
 *      the ball stops (never snaps, never lags the movement);
 *   3) playful hops: at high chase speed it pops off the ground and lands
 *      under gravity with restitution;
 *   4) soft arena walls keep it on the visible floor.
 *
 * All scratch vectors/quaternions are reused — zero allocation per frame.
 * ------------------------------------------------------------------- */
import * as THREE from 'three';

const BALL_RADIUS = 0.85;
const SPHERE_DETAIL = 5;          // 20*6^2 = 720 faces — smooth silhouette
const GOLD = (1 + Math.sqrt(5)) / 2;

// Chase tuning (per second).
const SPRING_K = 10.0;                          // stiffness — keeps up with the cursor
const SPRING_DAMP = 2 * Math.sqrt(SPRING_K);    // critical damping — no overshoot
const MAX_SPEED = 13.0;                         // top speed — snappy, never a warp

// Rolling tuning.
const ROLL_SMOOTH = 14.0;         // angular inertia: higher = tighter to motion.
                                  // ~1/14 s time constant — smooth direction
                                  // transitions, yet no visible slip/lag.

// Hop tuning.
const GRAVITY = 16.0;
const HOP_START = 4.6;            // speed that triggers a hop (fast flicks only)
const HOP_COOLDOWN = 0.9;         // seconds between hops
const HOP_IMPULSE = 0.9;
const RESTITUTION = 0.35;         // landing bounce energy kept

// Fallback arena; main.js overrides with aspect-aware bounds.
const DEFAULT_ARENA = { rx: 10.4, rz: 6.0 };

/* Build the icosahedron's 12 vertex directions (pentagon centers) and 20
 * face-center directions (hexagon centers) for the Voronoi partition. */
function buildAnchors() {
  const raw = [];
  const a = 1, b = GOLD;
  for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
    raw.push([0, sa * a, sb * b], [sa * a, sb * b, 0], [sb * b, 0, sa * a]);
  }
  const verts = raw.map(v => new THREE.Vector3(...v).normalize());
  const faces = [];
  for (let i = 0; i < verts.length; i++)
    for (let j = i + 1; j < verts.length; j++)
      for (let k = j + 1; k < verts.length; k++) {
        const A = verts[i], B = verts[j], C = verts[k];
        const edge = Math.min(A.distanceTo(B), B.distanceTo(C), C.distanceTo(A)) + 1e-4;
        if (A.distanceTo(B) <= edge && B.distanceTo(C) <= edge && C.distanceTo(A) <= edge)
          faces.push(new THREE.Vector3().addVectors(A, B).add(C).normalize());
      }
  return { verts, faces };
}

function nearestDist(p, list) {
  let best = Infinity;
  for (const q of list) { const d = 1 - p.dot(q); if (d < best) best = d; }
  return best;
}

function buildBallGeometry() {
  // PolyhedronGeometry is already non-indexed — positions are per-face, so
  // painting per-vertex colors gives crisp panel edges automatically.
  const geo = new THREE.IcosahedronGeometry(BALL_RADIUS, SPHERE_DETAIL);
  const { verts, faces } = buildAnchors();
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Vector3(), WHITE = [1, 1, 1], BLACK = [0.02, 0.02, 0.02];
  const centroid = new THREE.Vector3();
  for (let f = 0; f < pos.count; f += 3) { // one color per triangular panel
    centroid.set(0, 0, 0);
    for (let v = 0; v < 3; v++)
      centroid.add(c.fromBufferAttribute(pos, f + v).clone().normalize());
    centroid.normalize().multiplyScalar(3); // scale ↑ separates ties cleanly
    const col = nearestDist(centroid, verts) <= nearestDist(centroid, faces) ? BLACK : WHITE;
    for (let v = 0; v < 3; v++) colors.set(col, (f + v) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}


export class SoccerBall {
  constructor(scene, arena = DEFAULT_ARENA) {
    this._arena = arena;

    // -- Visuals: white ball with black pentagon panels, soft shadow ------
    this.group = new THREE.Group();
    this.mesh = new THREE.Mesh(
      buildBallGeometry(),
      new THREE.MeshStandardMaterial({
        vertexColors: true,   // panel colors come from the geometry
        roughness: 0.42,      // matte-ish leather sheen, no reflections
        metalness: 0.0,
      })
    );
    this.mesh.castShadow = true;
    this.group.add(this.mesh);
    scene.add(this.group);

    // -- State -------------------------------------------------------------
    this.pos = new THREE.Vector3(0, BALL_RADIUS, 0); // rests on the ground
    this.vel = new THREE.Vector3();                  // in-plane velocity
    this.vy = 0;                                     // hop vertical velocity
    this._hopTimer = 0;

    // Rolling state: last frame's position (for exact displacement) and a
    // smoothed world-space angular velocity (rad/s) that gives the spin
    // its angular inertia — direction changes transition smoothly.
    this._prevPos = new THREE.Vector3().copy(this.pos);
    this._angVel = new THREE.Vector3();
    this._desOmega = new THREE.Vector3();

    // Scratch objects (reused every frame — no allocation in the loop).
    this._axis = new THREE.Vector3();
    this._spin = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);

    this._applyTransform();
  }

  /* Rolling: derive the physically correct angular velocity from the ball's
   * ACTUAL displacement this frame (previousPosition → currentPosition),
   * then ease the spin toward it with angular inertia.
   *
   *   displacement (dx, dz)  →  ω = (up × v) / r,  v = displacement / dt
   *   (up × (dx,0,dz)) = (dz, 0, −dx)  → axis ⟂ travel, in the ground plane
   *
   * Because the rotation is driven by where the ball REALLY went (after
   * walls, bounces, dt spikes — everything), it can never lag behind the
   * movement, and the easing only smooths direction/speed transitions —
   * it never snaps. When the ball stops, ω decays to zero smoothly. */
  _rollFromDisplacement(dt) {
    if (dt < 1e-6) return;

    // Actual horizontal displacement this frame.
    const dx = this.pos.x - this._prevPos.x;
    const dz = this.pos.z - this._prevPos.z;

    // Desired angular velocity for perfect no-slip rolling.
    const inv = 1 / (BALL_RADIUS * dt);
    this._desOmega.set(dz * inv, 0, -dx * inv);

    // Angular inertia: exponentially ease the spin toward the desired
    // value (frame-rate independent: factor depends on dt, not fps).
    const k = 1 - Math.exp(-ROLL_SMOOTH * dt);
    this._angVel.lerp(this._desOmega, k);

    // Apply this frame's rotation: |ω| radians about the ω axis.
    const mag = this._angVel.length();
    if (mag < 1e-6) return;
    this._axis.copy(this._angVel).multiplyScalar(1 / mag);
    this._spin.setFromAxisAngle(this._axis, mag * dt);
    this.mesh.quaternion.premultiply(this._spin); // world-space rotation
  }

  _applyTransform() {
    this.group.position.copy(this.pos);
  }

  /* One simulation step toward the cursor's ground position. */
  update(dt, target) {
    this._hopTimer = Math.max(0, this._hopTimer - dt);
    this._prevPos.copy(this.pos); // remember where this frame started

    // 1) Critically-damped spring: acceleration pulls to the target, drag
    //    bleeds velocity. Smooth accel AND smooth settle — no teleporting.
    const ax = (target.x - this.pos.x) * SPRING_K - this.vel.x * SPRING_DAMP;
    const az = (target.z - this.pos.z) * SPRING_K - this.vel.z * SPRING_DAMP;
    this.vel.x += ax * dt;
    this.vel.z += az * dt;

    // Speed cap — a fast flick becomes a sprint, never a warp.
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (sp > MAX_SPEED) {
      const k = MAX_SPEED / sp;
      this.vel.x *= k;
      this.vel.z *= k;
    }

    // 2) Hop: at high chase speed pop off the ground (with a cooldown).
    if (this._hopTimer === 0 && this.vy === 0 && sp > HOP_START) {
      this.vy = HOP_IMPULSE;
      this._hopTimer = HOP_COOLDOWN;
    }

    // 3) Integrate.
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    if (this.vy !== 0 || this.pos.y > BALL_RADIUS) {
      this.vy -= GRAVITY * dt;
      this.pos.y += this.vy * dt;
      if (this.pos.y <= BALL_RADIUS) {       // land (small bounce, then rest)
        this.pos.y = BALL_RADIUS;
        this.vy = Math.abs(this.vy) > 1.2 ? -this.vy * RESTITUTION : 0;
      }
    } else {
      this.pos.y = BALL_RADIUS;
    }

    // 4) Soft arena walls — reflect velocity so it never leaves the view.
    const { rx, rz } = this._arena;
    if (Math.abs(this.pos.x) > rx) {
      this.pos.x = Math.sign(this.pos.x) * rx;
      this.vel.x *= -0.5;
    }
    if (Math.abs(this.pos.z) > rz) {
      this.pos.z = Math.sign(this.pos.z) * rz;
      this.vel.z *= -0.5;
    }

    // 5) Rolling from the actual displacement of this frame, with
    //    angular inertia so the spin eases through direction changes
    //    and settles smoothly when the ball stops.
    this._rollFromDisplacement(dt);
    this._applyTransform();
  }
}
