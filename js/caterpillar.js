/* ------------------------------------------------------------------
 * caterpillar.js — an uncanny crawling creature.
 *
 * A minimalist skeletal thing drawn entirely from thin black lines on
 * clean white. Four distinct body segments — ring-shaped "ribs" of
 * slightly different sizes and orientations — hang along a thin spine,
 * each one carried by a pair of long articulated legs. The head is a
 * small ring with a forward snout and two thin antennae; a spike caps
 * the tail. Nothing is rounded or friendly; the proportions (large
 * mid-body rib, small head, long thin limbs) + the stilted gait give
 * it a quietly eerie character, like an abstract insect drawn in ink.
 *
 * Movement layers:
 *
 *   1) HEAD DYNAMICS — critically damped spring toward the cursor.
 *      accel = (target - pos) * SPRING - vel * DAMPING
 *      Natural acceleration, gentle deceleration, no snapping. A small
 *      constant "creep" keeps it advancing even on a motionless mouse,
 *      which makes the creature feel alive rather than parked.
 *
 *   2) SEGMENTED FOLLOW CHAIN (head leads, tail reacts last).
 *      Each body node eases toward a point `spacing` behind the node in
 *      front (1 - exp(-rate·dt)) then snaps to the exact distance.
 *      Direction changes ripple down the body as a smooth curve.
 *
 *   3) FOOT GAIT (proper stepping, not sliding).
 *      Each leg plant phase is offset along the body. While a foot is
 *      "planted" it is pinned in world space and the body walks past
 *      it; then the leg swings forward with a lift in one quick step.
 *      The result is a slow, deliberate, slightly disconcerting gait.
 *
 *   4) POSTURE WAVE.
 *      A phase wave arches the mid-body up, gives each rib a small
 *      bob/twist per segment, and lets the antennae sway — the body
 *      "breathes" even when idle.
 *
 * All computation reuses scratch vectors; nothing is allocated in the
 * per-frame path.
------------------------------------------------------------------- */
import * as THREE from 'three';

const NODE_COUNT = 4;                        // four distinct body segments

// Per-segment design: ring radius, rest height, wave amplitude,
// twist (roll about the spine), pitch (lean), optional second rib.
const SEG_DESIGN = [
  { r: 0.30, restY: 0.34, amp: 0.9, twist: -0.25, pitch: 0.02, collar: false },
  { r: 0.38, restY: 0.44, amp: 1.7, twist:  0.12, pitch: -0.05, collar: true  },
  { r: 0.33, restY: 0.38, amp: 1.5, twist: -0.10, pitch:  0.06, collar: false },
  { r: 0.22, restY: 0.27, amp: 0.7, twist:  0.35, pitch: -0.08, collar: false },
];

// Default arena; main.js overrides it with aspect-aware bounds.
const PLAY_ARENA = { rx: 10.4, rz: 6.0 };

// Head spring tuning (per second).
const SPRING_K = 6.5;                        // stiffness — eagerness to hunt
const SPRING_DAMP = 2 * Math.sqrt(SPRING_K); // critical damping → no overshoot
const MAX_SPEED = 5.4;                       // top crawl speed
const MIN_CREEP = 0.45;                      // always creeps forward, however small

// Follow-chain tuning.
const FOLLOW_RATE = 9.5;                     // how eagerly each node chases the one before
const BASE_SPACING = 0.9;                    // centre-to-centre distance between nodes
const HEAD_GAP = 0.72;                       // head → first rib gap

// Posture waveform.
const WAVE_FREQ = 1.15;                      // gait angular frequency
const BOB_AMP = 0.085;                       // vertical arch/bob scale
const SWAY_AMP = 0.05;                       // lateral body sway scale
const HEAD_LIFT = 0.34;                      // resting head height
const HEAD_BOB = 0.06;                       // head lift peak
// Gait stepping.
const STRIDE = 0.55;                         // forward reach of a swinging foot
const STEP_LIFT = 0.09;                      // foot lift mid-swing
export class Caterpillar {
  /**
   * @param {THREE.Scene} scene    Scene to attach the creature to.
   * @param {Object}      arena    Head-clamping ellipse { rx, rz }.
   */
  constructor(scene, arena = PLAY_ARENA) {
    this.scene = scene;
    this._arena = arena;

    // Uniform ink-black material for every line and limb.
    this._material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x070707),
      roughness: 0.42,
      metalness: 0.0,
    });

    // Shared rod geometry (axis = +Y, length 1 — scaled per-pose).
    this._geomThin = new THREE.CylinderGeometry(0.016, 0.016, 1, 8);   // legs, antennae, spike
    this._geomSpine = new THREE.CylinderGeometry(0.026, 0.026, 1, 10); // spine rods

    // Reusable scratch (never allocated in the per-frame path).
    this._yAxis = new THREE.Vector3(0, 1, 0);
    this._va = new THREE.Vector3();
    this._vb = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._eul = new THREE.Euler(0, 0, 0, 'YXZ'); // yaw → pitch → roll
    this._headVis = new THREE.Vector3();

    // ---- State ---------------------------------------------------------
    this._pos = new THREE.Vector3();        // head world position (x, z on ground)
    this._vel = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._yaw = Math.PI / 2;                // facing +X at start
    this._forward = new THREE.Vector3(1, 0, 0);
    this._phase = 0;                        // posture/gait phase
    this._activity = 0.2;
    this._headPitch = 0;                    // head nod (driven by speed)
    this._foll = { x: 0, z: 0, fx: 1, fz: 0 }; // reused follow-chain accumulator

    // Follow-chain node positions.
    this._bone = [];
    for (let i = 0; i < NODE_COUNT; i++) {
      this._bone.push({ pos: new THREE.Vector3(), tmp: new THREE.Vector3() });
    }
    // Lay the creature out straight along +X, head near the origin.
    for (let i = 0; i < NODE_COUNT; i++) {
      this._bone[i].pos.set(-HEAD_GAP - i * BASE_SPACING, 0, 0);
    }

    // ---- Head: small ring + cone snout + two antennae ------------------
    this.head = this._makeRing(0.16, 0.018);
    scene.add(this.head);
    this.snout = this._addRod('thin');
    this.snout.geometry = new THREE.CylinderGeometry(0.0, 0.05, 0.22, 8); // nose cone
    scene.add(this.snout);
    this.antennae = [this._addRod('thin'), this._addRod('thin')];
    for (const a of this.antennae) scene.add(a);

    // ---- Body: four rib segments + spine rods + tail spike -------------
    this.segments = [];
    for (let i = 0; i < NODE_COUNT; i++) {
      const d = SEG_DESIGN[i];
      const seg = {
        position: new THREE.Vector3(),   // visual centre of this rib
        dir: new THREE.Vector3(1, 0, 0),
        lat: new THREE.Vector3(0, 0, 1),
        design: d,
        rings: [],
        rod: null,
      };
      seg.ring = this._makeRing(d.r, 0.026);
      scene.add(seg.ring);
      seg.rings.push(seg.ring);
      // The large mid segment gets a second, slightly twisted rib.
      if (d.collar) {
        const collar = this._makeRing(d.r * 0.94, 0.022);
        scene.add(collar);
        seg.rings.push(collar);
      }
      seg.rod = this._addRod('spine'); // spine rod to the node in front
      scene.add(seg.rod);
      this.segments.push(seg);
    }
    this.tail = this.segments[NODE_COUNT - 1];

    // Tail spike (small stinger).
    this.tailSpike = this._addRod('thin');
    this.tailSpike.geometry = new THREE.CylinderGeometry(0.0, 0.028, 0.5, 8);
    scene.add(this.tailSpike);

    // ---- Legs: one pair per segment ------------------------------------
    this.legs = [];
    for (let i = 0; i < NODE_COUNT; i++) {
      for (const side of [1, -1]) {
        this.legs.push(this._makeLeg(i, side, i * 1.35 + (side === 1 ? 0 : Math.PI)));
      }
    }

    // Soft ground shadow blob under the body centre.
    this.blob = this._makeShadowBlob();
    scene.add(this.blob);
    this._blobTarget = new THREE.Vector3();
    this._blobPos = new THREE.Vector3(0, 0.012, -1);

    // Initial pose.
    this._poseVisuals();
    this._poseLegs();
  } // end constructor
    /* ---- Builders -------------------------------------------------------- */

  _makeRing(radius, tube) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 10, 24), this._material);
    ring.rotation.order = 'YXZ';
    ring.castShadow = true;
    return ring;
  }

  _addRod(type) {
    const mesh = new THREE.Mesh(
      type === 'spine' ? this._geomSpine : this._geomThin,
      this._material
    );
    mesh.castShadow = true;
    return mesh;
  }

  _makeLeg(nodeIndex, side, phase) {
    const seg = this.segments[nodeIndex];
    const leg = {
      node: nodeIndex,
      side,
      phase,
      swinging: false,
      hip: new THREE.Vector3(),
      hipGround: new THREE.Vector3(),
      knee: new THREE.Vector3(),
      foot: new THREE.Vector3(),
      planted: new THREE.Vector3(),
      upper: this._addRod('thin'),
      lower: this._addRod('thin'),
      footMesh: this._makeFoot(),
    };
    this.scene.add(leg.upper);
    this.scene.add(leg.lower);
    this.scene.add(leg.footMesh);
    // Spawn planted on the ground, under the rib and out to its side.
    const r = seg.design.r;
    leg.planted.set(this._bone[nodeIndex].pos.x - 0.2, 0, side * r * 1.35);
    leg.foot.copy(leg.planted);
    return leg;
  }

  _makeFoot() {
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.033, 8, 6), this._material);
    foot.scale.y = 0.7;
    foot.castShadow = true;
    return foot;
  }

  /** Orient rod `mesh` from world point `a` to `b`. Geometry length is 1. */
  _setRod(mesh, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-6) return;
    this._va.set(dx, dy, dz).multiplyScalar(1 / len);
    mesh.position.set((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
    mesh.quaternion.setFromUnitVectors(this._yAxis, this._va);
    mesh.scale.y = len;
  }

  _makeShadowBlob() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.5)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.2)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.10 })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.012;
    mesh.scale.set(6.5, 6.5, 1);
    mesh.renderOrder = -1;
    return mesh;
  }

  /** Per-node spacing; `index` -1 = the head→first-rib gap (slightly wider). */
  _spacingFor(index) {
    if (index === -1) return HEAD_GAP;
    const w = Math.sin(this._phase - index * 0.9);
    return BASE_SPACING * (1.0 + 0.05 * w - 0.02);
  }

  /* ---- Posing --------------------------------------------------------- */

  /**
   * Place ribs, spine, head, snout and antennae from the current state.
   * The follow-chain node positions live in this._bone[i].pos; the
   * posture wave only offsets the *visual* positions.
   */
  _poseVisuals() {
    const act = this._activity;
    const ph = this._phase;

    // ---- Head first (spine rods reference its visual position) ---------
    this._headVis.set(
      this._pos.x,
      HEAD_LIFT + Math.sin(ph) * HEAD_BOB * act,
      this._pos.z
    );
    const hy = Math.atan2(this._forward.x, this._forward.z);
    const hp = this._headPitch + Math.sin(ph) * 0.06 * act;
    this.head.rotation.set(hp, hy, Math.sin(ph * 0.6) * 0.12 * act);
    this.head.position.copy(this._headVis);

    // Cone snout pointing just ahead of the ring.
    this._va.set(this._forward.x * 0.2, 0.02, this._forward.z * 0.2).add(this._headVis);
    this._setRod(this.snout, this._headVis, this._va);

    // Antennae: rotated by the head pose, swaying with the gait.
    this._eul.set(hp, hy, 0);
    this._q.setFromEuler(this._eul);
    for (let s = 0; s < 2; s++) {
      const side = s === 0 ? 1 : -1;
      const sw = Math.sin(ph * 1.2 + s * 2.1) * 0.12 * (0.3 + act);
      this._va.set(0.3, 0.06 + sw * 0.2, side * 0.16 + sw * 0.5).applyQuaternion(this._q).add(this._headVis);
      this._vb.set(0, 0.05, 0).add(this._headVis);
      this._setRod(this.antennae[s], this._vb, this._va);
    }

    // ---- Body segments -------------------------------------------------
    for (let i = 0; i < NODE_COUNT; i++) {
      const seg = this.segments[i];
      const bone = this._bone[i];

      // Body direction at this node (toward the one in front).
      const prev = i === 0 ? this._pos : this._bone[i - 1].pos;
      let dx = bone.pos.x - prev.x, dz = bone.pos.z - prev.z;
      const dl = Math.hypot(dx, dz) || 1e-6;
      dx /= dl; dz /= dl;
      seg.dir.set(dx, 0, dz);
      seg.lat.set(-dz, 0, dx);

      // Posture: bob + lateral sway, amplitude shaped per segment.
      // Ribs never dip below the floor (clamped to just above ground).
      const wave = ph - i * 0.9;
      const bob = Math.sin(wave) * seg.design.amp * BOB_AMP * act;
      const sway = Math.sin(wave + 1.4) * SWAY_AMP * act;
      const minY = seg.design.r * 1.0;   // lowest the ring centre may go
      seg.position.set(
        bone.pos.x + seg.lat.x * sway,
        Math.max(seg.design.restY + bob, minY),
        bone.pos.z + seg.lat.z * sway
      );

      // Ribs: yaw along the body, pitch (lean), roll (twist).
      const yaw = Math.atan2(dx, dz);
      const pitch = seg.design.pitch + Math.sin(wave) * 0.10 * act;
      const rollMain = seg.design.twist + Math.sin(ph * 0.5 + i * 1.3) * 0.09 * act;
      for (let r = 0; r < seg.rings.length; r++) {
        const ring = seg.rings[r];
        ring.position.copy(seg.position);
        // Second rib gets its own twist.
        const roll = r === 1 ? seg.design.twist + 1.25 + Math.sin(wave) * 0.06 * act : rollMain;
        ring.rotation.set(pitch, yaw, roll);
      }

      // Spine rod: from the node in front to this rib.
      const a = i === 0 ? this._headVis : this.segments[i - 1].position;
      this._setRod(seg.rod, a, seg.position);
    }

    // ---- Tail spike: short stinger pointing back and up -----------------
    const tail = this.tail;
    this._va.copy(tail.position);
    this._vb.set(
      tail.position.x - tail.dir.x * 0.34,
      tail.position.y + 0.14,
      tail.position.z - tail.dir.z * 0.34
    );
    this._setRod(this.tailSpike, this._va, this._vb);
  }

  /**
   * Foot gait + inverse kinematics.
   *
   * Each leg cycles from a planted stance (pinned exactly in world space
   * while the body glides past it) through a quick forward swing with a
   * small lift. Phases are staggered down the body so the feet step in
   * sequence — a slow, deliberate, slightly unsettling insect gait.
   */
  _poseLegs() {
    const act = 0.4 + this._activity * 0.9;

    for (const leg of this.legs) {
      const seg = this.segments[leg.node];
      const r = seg.design.r;

      // Hip: lower rim of the rib, out to the leg's side.
      leg.hip.set(
        seg.position.x + seg.lat.x * leg.side * r * 0.96,
        seg.position.y - r * 0.82,
        seg.position.z + seg.lat.z * leg.side * r * 0.96
      );

      // ---- Gait state ---------------------------------------------------
      const wave = this._phase - leg.node * 0.9;
      const sg = Math.sin(wave + leg.phase);     // -1..1
      const swing = (sg + 1) * 0.5;              // 0..1
      const hipGround = leg.hipGround.set(leg.hip.x, 0, leg.hip.z);

      if (swing > 0.7 && !leg.swinging) {
        leg.swinging = true;
      } else if (swing < 0.3 && leg.swinging) {
        leg.swinging = false;           // land: pin the foot where it is
        leg.planted.copy(leg.foot);
        leg.planted.y = 0;
      }

      if (leg.swinging) {
        // Quick step forward, lifting mid-swing.
        const p = Math.min(1, Math.max(0, (swing - 0.3) / 0.4));
        const lift = Math.sin(p * Math.PI) * STEP_LIFT * act;
        const tx = hipGround.x + this._forward.x * STRIDE + seg.lat.x * leg.side * 0.15;
        const tz = hipGround.z + this._forward.z * STRIDE + seg.lat.z * leg.side * 0.15;
        leg.foot.set(
          leg.planted.x + (tx - leg.planted.x) * p,
          lift,
          leg.planted.z + (tz - leg.planted.z) * p
        );
      } else {
        leg.foot.copy(leg.planted);
        leg.foot.y = 0;
      }

      // ---- Two-rod IK: hip → knee → foot --------------------------------
      const kx = (leg.hip.x + leg.foot.x) * 0.5 + seg.lat.x * leg.side * 0.1;
      const ky = (leg.hip.y + leg.foot.y) * 0.5 + 0.02;
      const kz = (leg.hip.z + leg.foot.z) * 0.5 + seg.lat.z * leg.side * 0.1;
      leg.knee.set(kx, ky, kz);
      this._setRod(leg.upper, leg.hip, leg.knee);
      this._setRod(leg.lower, leg.knee, leg.foot);
      leg.footMesh.position.set(leg.foot.x, leg.foot.y + 0.03, leg.foot.z);
      leg.footMesh.rotation.y = Math.atan2(seg.dir.x, seg.dir.z);
    }
  }

  /* ---- Public: chase the cursor -------------------------------------- */

  /**
   * Advance the simulation by `dt` seconds.
   * @param {number}        dt       Frame time, already clamped.
   * @param {THREE.Vector3} target   World-space cursor target on the ground.
   */
  update(dt, target) {
    this._target.copy(target);

    // ---- 1) Head spring dynamics --------------------------------------
    const sx = this._target.x - this._pos.x;
    const sz = this._target.z - this._pos.z;
    const distHead = Math.hypot(sx, sz);

    const ax = sx * SPRING_K - this._vel.x * SPRING_DAMP;
    const az = sz * SPRING_K - this._vel.z * SPRING_DAMP;
    this._vel.x += ax * dt;
    this._vel.z += az * dt;

    // Keep creeping even on tiny mouse movements — it never goes fully inert.
    if (distHead > 0.08) {
      const ux = sx / distHead, uz = sz / distHead;
      const fwd = this._forward.dot(this._vel) * 0.2;
      const need = MIN_CREEP - fwd;
      if (need > 0) {
        const push = MIN_CREEP * Math.min(1, dt * 40);
        this._vel.x += ux * push;
        this._vel.z += uz * push;
      }
    }

    // Speed cap so fast mouse flicks read as a sprint, not a teleport.
    const speed = Math.hypot(this._vel.x, this._vel.z);
    if (speed > MAX_SPEED) {
      const s = MAX_SPEED / speed;
      this._vel.x *= s;
      this._vel.z *= s;
    }

    this._pos.x += this._vel.x * dt;
    this._pos.z += this._vel.z * dt;

    // Soft wall at the edge of the visible arena.
    const nxh = this._pos.x / this._arena.rx;
    const nzh = this._pos.z / this._arena.rz;
    const nd = nxh * nxh + nzh * nzh;
    if (nd > 1) {
      const s = 1 / Math.sqrt(nd);
      this._pos.x *= s;
      this._pos.z *= s;
      const out = this._vel.x * nxh + this._vel.z * nzh;
      if (out > 0) {
        this._vel.x -= out * nxh;
        this._vel.z -= out * nzh;
      }
    }

    // ---- 2) Heading: gradual, never instant ----------------------------
    let desiredYaw = this._yaw;
    if (speed > 0.12) {
      desiredYaw = Math.atan2(this._vel.x, this._vel.z);
    }
    let diff = desiredYaw - this._yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const turnRate = 5.5 + speed * 1.6;
    this._yaw += diff * Math.min(1, turnRate * dt);
    this._forward.set(Math.sin(this._yaw), 0, Math.cos(this._yaw));

    // Head nods into the direction it is being pulled.
    this._headPitch = THREE.MathUtils.clamp(speed * 0.05 - 0.04, -0.35, 0.25);

    // ---- 3) Segmented follow chain -------------------------------------
    // Each node eases toward a point `spacing` behind the node in front,
    // then snaps to the exact distance. The head turns first and the
    // tail reacts last — smooth curvature, never a rigid stick.
    const prev = this._foll; // reused scratch
    prev.x = this._pos.x;
    prev.z = this._pos.z;
    prev.fx = this._forward.x;
    prev.fz = this._forward.z;

    for (let i = 0; i < NODE_COUNT; i++) {
      const bone = this._bone[i];
      // First rib uses the wider head gap, the rest use the body spacing.
      const spc = this._spacingFor(i === 0 ? -1 : i);

      const a = bone.tmp;
      a.set(prev.x - prev.fx * spc, 0, prev.z - prev.fz * spc);

      const k = 1 - Math.exp(-FOLLOW_RATE * dt);
      bone.pos.x += (a.x - bone.pos.x) * k;
      bone.pos.z += (a.z - bone.pos.z) * k;

      const ox = bone.pos.x - prev.x, oz = bone.pos.z - prev.z;
      const od = Math.hypot(ox, oz);
      if (od > 1e-6) {
        const s = spc / od;
        bone.pos.x = prev.x + ox * s;
        bone.pos.z = prev.z + oz * s;
      } else {
        bone.pos.x = prev.x - prev.fx * spc;
        bone.pos.z = prev.z - prev.fz * spc;
      }

      prev.fx = bone.pos.x - prev.x;
      prev.fz = bone.pos.z - prev.z;
      const fl = Math.hypot(prev.fx, prev.fz) || 1e-6;
      prev.fx /= fl; prev.fz /= fl;
      prev.x = bone.pos.x; prev.z = bone.pos.z;
    }

    // ---- 4) Posture phase & activity -----------------------------------
    // Activity ~1 when sprinting, ~0.12 while resting — always alive.
    this._activity = THREE.MathUtils.clamp(speed / 3.0, 0, 1) * 0.88 + 0.12;
    this._phase += dt * (WAVE_FREQ * 1.9 + speed * 1.05);

    // ---- 5) Apply to visible geometry ----------------------------------
    this._poseVisuals();
    this._poseLegs();

    // ---- 6) Shadow blob glides under the body --------------------------
    const midX = (this._pos.x + this.tail.position.x) * 0.5;
    const midZ = (this._pos.z + this.tail.position.z) * 0.5;
    this._blobTarget.set(midX, 0.012, midZ);
    this._blobPos.lerp(this._blobTarget, 1 - Math.exp(-8 * dt));
    this.blob.position.copy(this._blobPos);
  }
}