/* ------------------------------------------------------------------
 * input.js — Pointer tracking and cursor → world conversion.
 *
 * Responsibility
 *   - Track the mouse/pointer anywhere on the screen.
 *   - Convert 2D screen coordinates into the 3D floor point under the
 *     cursor, derived ENTIRELY from the live camera viewport. There are
 *     no artificial bounds: the visible white area IS the play area.
 *
 * How the mapping works (and why it covers the whole viewport):
 *   1. Cursor pixel → normalized device coordinates (-1..1).
 *   2. THREE.Raycaster.setFromCamera() casts a ray through that pixel
 *      using the camera's projection (position, orientation, fov, aspect).
 *   3. The ray is intersected with the floor plane (y = 0).
 *
 * The camera is pitched ~35° down with a 40° vertical fov, so even the
 * topmost viewport ray is 15° below the horizon — EVERY ray through the
 * screen strikes the floor. Bottom edge = floor near the camera, top
 * edge = floor far toward the horizon, left/right = the sides. The
 * intersection therefore spans the entire visible white area, edge to
 * edge and corner to corner, with no clamping of any kind.
 *
 * Cost: a single ray/plane computation per frame. Objects are
 * allocated once and reused, so nothing is created inside the loop.
------------------------------------------------------------------- */
import * as THREE from 'three';

// The floor plane the ball rolls on (y = 0). One instance, reused.
const FLOOR_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

export class PointerTracker {
  /** @param {THREE.Camera} camera The live camera (projection + pose). */
  constructor(camera) {
    this.camera = camera;

    // Reused temporaries — never allocate per frame.
    this._ndc = new THREE.Vector2();
    // Raycaster.setFromCamera() maps NDC → a world ray through the pixel
    // (THREE.Ray itself has no such method).
    this._raycaster = new THREE.Raycaster();

    /** World-space chase target (y always 0). Public, mutated in place. */
    this.target = new THREE.Vector3();

    // Inactive until the first pointer event; the ball then keeps its
    // last target and settles.
    this._active = false;

    window.addEventListener('pointermove', (e) => this._onMove(e));
    window.addEventListener('pointerdown', (e) => this._onMove(e));
    window.addEventListener('pointerenter', (e) => this._onMove(e));
  }

  _onMove(e) {
    // Normalized device coordinates: -1..1 across the live viewport.
    this._ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
    this._ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
    this._active = true;
  }

  /**
   * Recompute the world target from the latest pointer position.
   * Called once per frame right before the ball update.
   *
   * target = Ray(cursor) ∩ Floor(y = 0), unclamped.
   *
   * Because the camera's projection is used live, this automatically
   * stays correct through window resizes and aspect-ratio changes —
   * whatever portion of the floor the viewport shows, the ball can
   * reach the exact point under the cursor.
   */
  update() {
    if (!this._active) return; // keep last target — ball settles.

    // Ray through the cursor pixel, from the camera's current projection.
    this._raycaster.setFromCamera(this._ndc, this.camera);
    const dir = this._raycaster.ray.direction;
    const org = this._raycaster.ray.origin;

    // A downward ray always meets the floor. (Guard for rays parallel to
    // or above the horizon: they cannot reach y = 0, so keep the last
    // target. Our fixed camera never produces them.)
    if (dir.y >= -1e-6) return;

    // Exact intersection with y = 0: solve org.y + dir.y·t = 0.
    const t = -org.y / dir.y;
    this.target.set(org.x + dir.x * t, 0, org.z + dir.z * t);
  }
}