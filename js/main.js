/* ------------------------------------------------------------------
 * main.js — application bootstrap.
 *
 * Responsibilities:
 *   Renderer / scene / camera
 *   Studio lighting + soft shadows
 *   Ground plane (shadow catcher)
 *   Pointer → world target (js/input.js)
 *   Living ball              (js/ball.js)
 *   Responsive resize + requestAnimationFrame loop
 *
 * The page intentionally contains nothing else: no UI, no text.
------------------------------------------------------------------- */
import * as THREE from 'three';
import { PointerTracker } from './input.js';
import { SoccerBall } from './ball.js';

// ---- Renderer --------------------------------------------------------
const renderer = new THREE.WebGLRenderer({
  antialias: true, // MSAA for a premium, clean look
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // crisp on HiDPI, fast on 4K
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap; // soft, natural shadows
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; // filmic rolloff keeps whites pure
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

// ---- Scene & camera --------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff); // pure white environment

const camera = new THREE.PerspectiveCamera(
  40,                       // fov
  window.innerWidth / window.innerHeight,
  0.1,
  120
);
// Slightly elevated, angled view so the 3D shape reads clearly.
camera.position.set(0, 10.8, 15.0);
camera.lookAt(0, 0.3, 0);

// ---- Lighting: soft studio rig ---------------------------------------
// Hemisphere ambient → even, shadow-free base light.
const hemi = new THREE.HemisphereLight(0xffffff, 0xf2f2f2, 0.75);
scene.add(hemi);

// Large key light → the creature's soft cast shadow.
const key = new THREE.DirectionalLight(0xffffff, 2.6);
key.position.set(9, 14, 8);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 1;
key.shadow.camera.far = 60;
const d = 15;
key.shadow.camera.left = -d;
key.shadow.camera.right = d;
key.shadow.camera.top = d;
key.shadow.camera.bottom = -d;
key.shadow.bias = -0.0005;
key.shadow.normalBias = 0.02;
key.shadow.radius = 6; // additional softness
scene.add(key);
scene.add(key.target);

// Gentle fill from the opposite side → rounds out the black form.
const fill = new THREE.DirectionalLight(0xffffff, 0.55);
fill.position.set(-8, 6, -6);
scene.add(fill);

// ---- Ground ----------------------------------------------------------
// Large floor; it also slides with the camera focus each frame, so the
// white world is effectively endless.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(500, 500),
  new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ---- Entities ---------------------------------------------------------
// Huge safety walls (never reached — chase targets are bounded).
const ball = new SoccerBall(scene, { rx: 200, rz: 200 });

// Cursor → world target. Derived entirely from the live camera viewport:
// ray through the cursor pixel ∩ floor plane (y = 0), unclamped. The
// camera looks down at the floor, so every screen point — edges and
// corners included — maps to the exact visible floor spot under the
// cursor. The ball can therefore reach the entire white area.
const pointer = new PointerTracker(camera);

// ---- Key light follow --------------------------------------------------
// The camera stays FIXED (predictable framing), but the key light rides
// with the ball so its soft shadow always stays inside the shadow-camera
// frustum and remains crisp, even 35 units from the origin.
function followLight() {
  key.position.set(ball.pos.x + 9, 14, ball.pos.z + 8);
  key.target.position.set(ball.pos.x, 0, ball.pos.z);
}

// ---- Responsive resize ------------------------------------------------
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  // No arena to refit: the cursor target is derived from the live
  // camera projection, so the follow self-adjusts to any aspect ratio.
}
window.addEventListener('resize', onResize);

// ---- Animation loop ----------------------------------------------------
const clock = new THREE.Clock();

function tick() {
  requestAnimationFrame(tick);

  // Clamp dt so a backgrounded-tab catch-up never makes the caterpillar
  // lurch forward in a single frame.
  const dt = Math.min(clock.getDelta(), 0.05);

  // Convert the current cursor position into a world target each frame.
  pointer.update();

  // The ball reacts to the cursor; behaviour lives entirely in ball.js
  // (spring chase + true rolling + hops).
  ball.update(dt, pointer.target);

  // Keep the key light (and its shadow frustum) with the ball.
  followLight();

  renderer.render(scene, camera);
}
tick();