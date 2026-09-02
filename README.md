# Soccer Ball — Cursor-Following 3D Experiment

A minimal interactive 3D art experiment: a black-and-white soccer ball that
rolls after your mouse anywhere on the screen. Pure white background, soft
studio shadows, physical rolling, playful hops on fast flicks.

Built with plain HTML, CSS, and JavaScript using **Three.js** (r162) — no
frameworks, no build step, no backend.

## Run it

Because the app uses ES modules (an import map loads Three.js from a CDN),
you need to serve the folder over HTTP:

```powershell
# from this folder
python -m http.server 8000
# or: npx serve .
```

Then open <http://localhost:8000> and move your mouse. Done.

## What it does

- **Cursor → world:** every frame the mouse pixel is converted to a ground
  point using a ray through the camera's projection, intersected with the
  floor plane (y = 0). No artificial bounds — the ball can reach the whole
  visible white area, including all edges and corners.
- **Chase:** a critically damped spring pulls the ball's horizontal position
  toward the cursor point (natural acceleration, gentle settle, speed cap).
- **Rolling:** the spin is driven by the ball's *actual* displacement each
  frame (`ω = (up × v) / r`) with angular-inertia easing, so direction
  changes transition smoothly and the spin settles when the ball stops.
- **Hops:** at high chase speed the ball pops off the ground and lands under
  gravity with restitution.
- **Visuals:** geometry-only soccer-ball coloring (subdivided icosahedron,
  vertex-colored pentagons), soft PCF shadows, ACES tone mapping, HiDPI
  rendering, responsive resize.

## Project structure

```
index.html          Page shell + Three.js import map (CDN)
style.css           Pure-white full-screen stage
js/main.js          App bootstrap: renderer, scene, camera, lights,
                    ground, key-light follow, animation loop, resize
js/input.js         Pointer tracking + cursor → world conversion
js/ball.js          Soccer ball: geometry, chase spring, rolling, hops
test-ball.js        Headless movement/rolling verification (node test-ball.js)
test-edge.js        Headless whole-screen follow verification (node test-edge.js)
test-reversal.js    Headless smooth direction-reversal check
```

## Tests

The movement system is verified headlessly against the real Three.js math:

```powershell
npm install     # installs three locally (only used by the test scripts)
node test-ball.js
node test-edge.js
node test-reversal.js
```

## License

MIT