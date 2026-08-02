# Apex Horizon

An open-world arcade-sim racing game for the browser, inspired by Forza Horizon.
Built with **Three.js** (rendering) and **Rapier** (physics), with every asset —
terrain, road, cars, textures, and audio — generated procedurally at runtime.

> There is also an **Unreal Engine 5.8 port** of this game in [`unreal/ApexHorizon`](unreal/ApexHorizon) —
> same circuit, same cars, same AI, rendered with Lumen, virtual shadow maps and TSR.
> See [its README](unreal/ApexHorizon/README.md) for what carried over and what did not.

![circuit](https://img.shields.io/badge/circuit-4.68%20km-29e0a8) ![cars](https://img.shields.io/badge/cars-5-14b6ff) ![assets](https://img.shields.io/badge/binary%20assets-0-ffc94a)

---

## Running it

```bash
npm install
```

```bash
npm run dev
```

Then open **http://127.0.0.1:5173**. First load builds the world (~3 s of work);
after that everything is resident.

For a production build:

```bash
npm run build && npm run preview
```

Requires a WebGL2 browser (Chrome, Edge, Firefox, Safari 16+). Click or press a
key once at the menu to let the browser start audio.

---

## Controls

| Action | Keyboard | Controller |
| --- | --- | --- |
| Throttle | `W` / `↑` | RT |
| Brake / reverse | `S` / `↓` | LT |
| Steer | `A` `D` / `←` `→` | Left stick |
| Handbrake | `Space` | A / ✕ |
| Shift up / down (manual box) | `E` / `Q` | RB / LB |
| Change camera | `C` | Y / △ |
| Look back | `B` | R3 |
| Reset to track | `R` | X / □ |
| Headlights | `L` | — |
| Horn | `H` | D-pad ↑ |
| Photo / free camera | `F` | — |
| Pause | `Esc` / `P` | Start |

Menus accept mouse, keyboard (`↑↓`, `Enter`, `Esc`) and controller.

---

## What's in it

**Modes** — Free Roam, Race Event (up to 9 AI rivals, 1–12 laps), Time Trial,
Garage, Settings. Full loop: menu → event setup → countdown → race → results →
restart / free roam / menu.

**The world** — a 2.4 × 2.4 km island with a 4.68 km circuit running through
countryside, a city grid, a tied-arch bridge over a river gorge, and a bored
tunnel through a hillside. Terrain, roads, kerbs, sidewalks, barriers, buildings,
trees and street furniture are all generated from a seeded RNG, so the world is
identical every run.

**Cars** — five vehicles with genuinely different characters: a FWD hot hatch, a
RWD grand tourer, an AWD rally SUV, an AWD hypercar and a RWD GT3 racer. Each has
its own torque curve, gear ratios, drivetrain, aero, suspension rates and body
shape.

**Garage** — paint (16 presets + custom colour, four finishes, racing stripes),
four rim styles with rim/caliper colours, four tyre compounds, seven tuning
sliders (final drive, downforce, brake bias, ride height, front/rear ARB, steering
lock) and six upgrade paths. Everything shows on the car in the showroom
immediately and carries into the race. Progress and credits persist in
`localStorage`.

**Weather & time** — clear, overcast, rain and fog; dawn / noon / sunset / night,
optionally advancing during the race. Wet tarmac genuinely cuts grip and changes
how the car behaves.

---

## How it works

### Physics

Cars use Rapier's `DynamicRayCastVehicleController` — a real raycast-vehicle with
per-wheel suspension springs, dampers and a friction circle. On top of that,
`src/physics/Vehicle.js` adds:

- an rpm/torque-curve engine with turbo spool, a rev limiter and engine braking
- a 6/7-speed gearbox with automatic or manual shifting and a clutch-cut on shift
- brakes with front/rear bias, plus **ABS** and **traction control** that act on
  real per-wheel longitudinal slip derived from wheel rotation
- Ackermann steering geometry and speed-sensitive steering rate
- anti-roll bars driven by actual suspension deflection
- aerodynamic drag and downforce
- surface-aware tyre grip: tarmac, shoulder and off-road each have their own
  friction coefficient and rolling resistance, modulated by weather and compound

Physics runs on a fixed 120 Hz substep independent of the render rate.

Two Rapier-specific details worth knowing, both documented in the source: a
positive `engine_force` drives the chassis along its local **−Z**, and `addForce`
is **persistent** until `resetForces()` — aero and anti-roll forces must be
cleared every substep or they compound into a phantom brake.

### AI

Rivals drive the same `Vehicle` class the player does — same physics, same grip,
same collisions. There is no rubber-banding and no scripted path. Each driver runs:

- pure-pursuit steering onto a pre-computed racing line (curvature-derived
  out-in-out offsets)
- a lookahead braking solver that scans 240 m ahead and takes the lowest reachable
  speed, rescaled to that car's own tyre grip and top speed
- lateral negotiation: pick the side with more room to overtake, match pace rather
  than punt when boxed in, leave room when side-by-side
- per-driver skill, aggression, brake point and occasional imperfection
- a stuck-recovery reverse, backed by a no-progress watchdog that lifts a
  hopelessly wedged car back onto the racing line

### Rendering

- procedural sky with atmospheric scattering, driving a PMREM probe that lights
  the scene and reflects in the car paint
- **camera motion blur by depth re-projection** — world position is reconstructed
  from the depth buffer and projected with the previous frame's view-projection
  matrix, giving true rotational and translational blur
- exposure is applied *before* bloom so the bloom threshold stays meaningful as
  the sky brightness changes with weather and time of day
- physically-based car paint (clearcoat, metallic flake, pearl iridescence),
  tinted glass, glowing brake discs, working headlights with real spot beams
- ring-buffered tyre marks, GPU particle system for smoke/dust/spray/sparks,
  instanced rain, and mesh deformation where the body is hit

### Audio

Everything is synthesised with the Web Audio API — there are no sound files. The
engine is an additive stack of six harmonics of the firing frequency through a
waveshaper and a load-tracking lowpass, plus intake noise and a turbo whistle.
Tyre screech, gravel, wind, road rumble and rain are filtered noise; impacts are a
transient burst plus a detuned metallic ring. The three nearest rivals get their
own panned engine voices.

---

## Project layout

```
src/
  main.js              entry point
  core/                math, input (keyboard + gamepad), persisted settings
  data/                car catalogue, track control points
  physics/             Rapier world, Vehicle (drivetrain, tyres, aero, damage)
  world/               spline, terrain, road builder, props, world assembly
  render/              renderer + post FX, materials, procedural textures,
                       environment/weather, car models, particles & skid marks
  game/                Game loop, Race director, AI, cameras, showroom
  ui/                  HUD (tacho, minimap, standings), menus, garage, settings
  audio/               procedural audio engine
```

---

## Performance

Four quality presets (Low → Ultra) control render scale, shadows, bloom, motion
blur, SMAA, anisotropy, particle budget, tyre marks and prop density. Anything
that can change at runtime does so without rebuilding the world. Enable the
performance overlay under **Settings → Graphics** to see fps, draw calls and
triangle count.

Reasonable defaults target 60 fps at 1440×810 on integrated graphics at *Medium*,
and on a discrete GPU at *High*.
