# SUPERMINE ADVENTURE — Architecture & Working Contract

**Read this fully before touching anything.**

This document is the merge of the two that came before it: the engine contract
that SUPERMINE was built on, and the adventure-mode contract that was layered on
top. There is only one game here now, so there is only one document.

What is gone from both, deliberately: the multi-agent file-ownership tables and
the parallel-work freeze rules. They were scheduling instructions for a build
that is finished. Every *technical* clause they carried — the event contract,
the reused-payload rule, the particle-system notes, the performance budget, the
load and init order, the levels-as-maps contract, the seal truths — is below.

---

## 0. Ground rules

| Rule | Detail |
|---|---|
| No build step | Plain HTML/CSS/JS. Open `index.html` from `file://` and it runs. |
| No libraries | No npm, no CDN, no fonts, no images. Everything procedural. |
| Classic scripts only | **Never** use `import`/`export` or `type="module"` — ES modules are blocked on `file://`. |
| One global | Everything hangs off `SM`. Each file starts with `var SM = SM \|\| {};` and assigns `SM.<module> = (function(){...})();` |

### World orientation (memorise this)

```
                      -y   = UP, towards the surface
                       ^
        -x  <----------+---------->  +x
                       v
                      +y   = DOWN, deeper
```

* Depth in metres is `(y - ADV.MINE_CEILING_Y) * ADV.METERS_PER_UNIT`, clamped at 0.
* **There is no gravity.** This is a top-down excavation view. Loose material is
  slowed by per-material drag and stopped by collisions, never by falling. Every
  material's `friction`/`restitution` is tuned for that, which is *why* movement
  is direct 2D drive: the machine crawls where the stick points and stops when
  the stick centres. It is a tracked digger chewing through material that closes
  around it, not a jetpack. Sell it in the **feel** — weight, inertia, the hull
  grinding to a halt against rock it cannot cut.

---

## 1. What the game is

You own a **company**: cash, a day counter, a machine, and mining rights.

The loop: **Prepare → Enter → Explore → Drill → Fill → Push or run → Escape →
Sell → Upgrade → Unlock.**

* You **drive** — free 2D movement on a translucent joystick, or WASD/arrows.
* You pick a **mine** from a world map, buy **fuel**, and descend.
* You fill a **cargo hold** that has volume, not just value.
* You **come back up** and sell, or you strand and lose the load.
* You **upgrade the machine** in a workshop, and the upgrades change what you
  can reach, not just what the numbers say.

The feeling being chased, in one sentence: *coming up with a full hold should
feel good, and deciding whether to go deeper should be genuinely difficult.*

---

## 2. Module map & load order

`index.html` loads these as classic scripts, in this order. Load order only
guarantees that the objects **exist** — every cross-reference happens at
*runtime*, inside `init()`/`update()`/`render()`, so the circular references
between (say) camera and vehicle are fine.

| # | File | Module | Role |
|---|---|---|---|
| 1 | `js/config.js` | `SM.config` | frozen constant table, incl. `SM.config.ADV` |
| 2 | `js/events.js` | `SM.events` | synchronous pub/sub |
| 3 | `js/materials.js` | `SM.materials` | the material table |
| 4 | `js/input.js` | `SM.input` | keyboard + the stick, one movement vector |
| 5 | `js/camera.js` | `SM.camera` | follow, framing, shake — and the density solve |
| 6 | `js/particles.js` | `SM.particles` | **the engine.** pooled physics + rendering |
| 7 | `js/vehicle.js` | `SM.vehicle` | the machine: drive, drill, geometry |
| 8 | `js/effects.js` | `SM.effects` | spectacle layer + the headlight composite |
| 9 | `js/sound.js` | `SM.sound` | procedural WebAudio |
| 10 | `js/ui.js` | `SM.ui` | the title gate, the layout switch, the PWA |
| 11 | `js/mines.js` | `SM.mines` | mine catalogue, layer tables, prices, volumes |
| 12 | `js/rig.js` | `SM.rig` | eight part categories, tiers, prices, derived stats |
| 13 | `js/save.js` | `SM.save` | three slots in localStorage, per-mine tunnels |
| 14 | `js/advterrain.js` | `SM.advterrain` | deterministic geology, the sparse carve store, 2D streaming |
| 15 | `js/scanner.js` | `SM.scanner` | ore signatures through rock |
| 16 | `js/joystick.js` | `SM.joystick` | the translucent thumbstick |
| 17 | `js/advhud.js` | `SM.advhud` | in-mine gauges, the pause card |
| 18 | `js/advui.js` | `SM.advui` | slots, world map, workshop, prep, results |
| 19 | `js/adv.js` | `SM.adv` | the state machine and the ledger |
| 20 | `js/main.js` | `SM.main` | boots the game |

Two stylesheets, both required: `style.css` is the base layer (palette,
`.sm-panel`, `.sm-btn`, `.sm-cell`, `.sm-stripe`, the title overlay, every
`--sm-*` custom property) and `style-adventure.css` is everything above it.

---

## 3. Call order — the contract `main.js` enforces

### `SM.main.init()` (once, on DOMContentLoaded)

```
input.init(canvas)
particles.init()
camera.init()
mines.init(); rig.init(); save.init()   <- pure data, before anything asks
resize()                                <- viewport known before terrain reads bounds
vehicle.init()
effects.init(); sound.init()
ui.init()                               <- WIPES #ui-root; must precede the
                                           modules that append to it
advterrain.init(); scanner.init(); joystick.init()
advhud.init(); advui.init()
adv.init()                              <- LAST: opening a state must reach a
                                           fully-built world and screen stack
```

Two ordering facts that are contract, not preference:

1. **`mines → rig → save`.** `save.js` validates a loaded slot against the
   catalogues; an unknown mine id or part key must not boot a company into an
   inconsistent state.
2. **`ui.init()` wipes `#ui-root`.** `joystick.js`, `advhud.js` and `advui.js`
   each append to it. Anything that wipes the root after they have built erases
   the whole interface.

### One fixed simulation step (60 Hz, `dt = 1/60`)

```
input.update(dt)
adv.update(dt)          <- the run director: fuel, cargo, heat, state
advterrain.update(dt)   <- stream rock in ahead / recycle behind
vehicle.update(dt)      <- drive, drill, push state into particles
particles.update(dt)    <- integrate, rebuild hash, relax, sleep
camera.update(dt)
effects.update(dt)
sound.update(dt)
ui.update(dt)
advhud.update(dt)
```

Why this order: terrain must generate before the drill reaches it; the vehicle
cuts *before* particles integrate so debris moves on the same step it is created
(no one-frame stall on impact); the camera follows the final vehicle position;
effects, sound and the HUD only ever react to what already happened.

`SM.advterrain.update()` also drives `SM.scanner.update()`, with a `stepId`
token that makes a duplicate call from anywhere else a no-op.

### Render (once per animation frame)

```
ctx.setTransform(dpr,0,0,dpr,0,0)        base transform, CSS pixels
fill background
save(); camera.applyTransform(ctx)       -> world space
    advterrain.render(ctx)               bedrock box, rock, strata, the doors
    particles.render(ctx)                the field + debris
    vehicle.render(ctx)                  the machine
    effects.render(ctx)                  dust / sparks / rings / popups
    adv.renderWorld(ctx)                 LAST — see below
restore()                                -> screen space
vignette
```

`SM.adv.renderWorld(ctx)` is the single world-space hook the campaign gets, and
it must call, in this order:

```
scanner.render(ctx)          ore arrows out of the machine
effects.renderDarkness(ctx)  the headlight composite
advterrain.renderLit(ctx)    the EMISSIVE pass
```

`renderLit` runs **after** the darkness because a lit sign is a light source,
not lit geometry — drawn before it, the lift's red level boards were crushed to
black at starter lights.

### The three simulation gates

`main.js` holds the fixed step by **zeroing the accumulator**, never by skipping
the step loop. A paused minute banks nothing, so the first frame after a resume
steps exactly once instead of paying out sixty seconds of backlog and
teleporting the rig across the map. The three holders:

| Gate | Held while |
|---|---|
| `started` | the player has not made a first gesture yet |
| `paused` | the pause card is up (`SM.main.setPaused`) |
| `SM.adv.holdsSim()` | `state !== 'mine'` — every meta screen **and** the title |

**The world keeps RENDERING behind all three.** That is what puts the mine
behind the workshop, held on the exact frame you left it.

`holdsSim()` covering the title (`'off'`) is the one thing that changed when the
second mode went away: there is nothing under the title gate but an empty pool,
so a descent is the only state that simulates. Every module can therefore assume
"update() runs ⇒ we are in a mine".

### `SM.main.restart()`

Delegates to `SM.adv.restart()` while a company is live (re-descending means
rebuilding the mine from its saved seed and carve store with the loadout the
player paid for, none of which `main.js` knows about). Otherwise it is the
campaign being closed back to the title: unpause, then empty the world
(`vehicle`, `camera`, `particles`, `advterrain`, `effects`, `sound`, `input`),
then emit `run:reset`.

---

## 4. Public API reference

Only the members listed here are contract. Anything else you find in the source
is internal.

### `SM.events` — synchronous pub/sub

```js
SM.events.on(name, fn)      // returns an unsubscribe function
SM.events.off(name, fn)
SM.events.once(name, fn)
SM.events.emit(name, payload)
SM.events.clear([name])
SM.events.count(name)
```

* Handlers run **synchronously inside `emit()`**. A handler that throws is
  caught and logged; it never breaks the frame.
* **Payload objects are REUSED** by the hot emitters. Read what you need
  immediately. Never stash the payload object, never push it into an array.

### `SM.config` — frozen constant table

Read freely. Coupled values to be aware of:

* `MAX_SPEED * FIXED_DT` **must stay below `GRID_CELL`** (currently 15 < 23) or
  the 3×3 neighbourhood scan can miss contacts.
* `SPRITE_MAX_RADIUS * 2` **must stay ≤ `GRID_CELL`** (currently 22 ≤ 23).

`SM.config.ADV` is the shared block every module is tuned against:

```
METERS_PER_UNIT 0.1     MINE_CEILING_Y 0        MINE_HALF_WIDTH 2600 (RETIRED)
SPACING 21              SOLID_BUDGET 5200       STREAM_MARGIN 240
CAM_ZOOM 0.80           EXIT_RADIUS 200
SAVE_KEY / SAVE_SLOTS 3 / SAVE_VERSION 2
```

`SAVE_KEY` is `'supermine.adventure.v1'` and **must not change** — it is the
same key every previous build wrote, so an existing company is FOUND rather than
orphaned. `SAVE_VERSION` says what shape it is in once found; **v1 records are
migrated, not dropped** — company, cash, day, rig, rights, bought levels, rails
and dumped piles all survive and only the TUNNELS are lost (§7b).

**`MINE_HALF_WIDTH` IS NO LONGER A BOUND.** A level map is unbounded east, west
and south (§7). The constant survives because this table is frozen, and it has
exactly one live use left: `advterrain`'s `RATE_REF_W` (5200), the width every
shipped `pocketRate`/`cavernRate` in `mines.js` was measured against. Keeping it
fixed is what makes those numbers go on meaning what they meant.

`config.js` still carries a handful of constants nothing reads any more (the old
lane geometry, the level/upgrade block). They are harmless and the table is
frozen; leave them.

### `SM.materials` — data table

```js
SM.materials.list          // array, indexed by the Uint8 stored per particle
SM.materials.breakStyles   // {crumble, fracture, burst, shatter} presets
SM.materials.count
SM.materials.get(index) / getById('gold') / indexOf('gold')
SM.materials.applyWorldDensity(spacing, baseSpacing)
SM.materials.getDensityScale() / getDensitySpacing()
```

**Never reorder or delete entries in `list` — append only.** Indices are baked
into the particle arrays, the sprite atlases and every save file's carve store.

### `SM.input`

```js
SM.input.init(canvas) / update(dt) / reset()
SM.input.noteGesture()            // canonical "the player touched something"
SM.input.consumeFirstGesture()    // true exactly once
SM.input.setStick(x, y) / clearStick() / isStickActive()
SM.input.getMove()                // REUSED {x, y, mag} — never stash it
SM.input.getMoveX() / getMoveY() / getMoveMag()
```

W/A/S/D and all four arrows feed the same vector, diagonals are normalised, and
the **keyboard wins over the stick** while a key is held so a stuck stick can
never lock the player out. Emits `input:firstgesture`, `input:restart` (R),
`input:mutetoggle` (M).

### `SM.camera`

```js
SM.camera.init() / update(dt) / reset() / setViewport(w, h)
SM.camera.applyTransform(ctx)
SM.camera.shake(strength)        // ADDITIVE — discrete events only
SM.camera.shakeFloor(strength)   // RAISES to a level — for repeating sources
SM.camera.punch(a)               // zoom transient; positive punches IN
SM.camera.getZoom() / getScale() / getX() / getY() / getTrauma()
SM.camera.getViewBounds()        // REUSED {minX,minY,maxX,maxY}
SM.camera.worldToScreen(x,y) / screenToWorld(x,y)   // REUSED {x,y}
SM.camera.getWorldSpacing() / getMaxViewHeight()
```

Two things about this module that are easy to get wrong:

1. **The zoom is a constant, then a fit.** `ADV.CAM_ZOOM` is what the light
   radius, the streaming window and the joystick scale are all tuned against, so
   the camera has no opinion about it. The portrait fit and the per-level fill
   floor are applied to `scale`, *not* to `zoom` — routing them through zoom
   would be clamped back, and would also flip `particles.js`'s `LOW_DETAIL_ZOOM`
   switch on exactly the devices that most want the detail.
2. **`solveWorldDensity()` is not framing code any more, and must stay.** It
   runs once from the module body (before `particles.init()` bakes its caches)
   and hands a grid pitch to `SM.materials.applyWorldDensity()`, which rewrites
   `value` and `hardness` on every material. **The economy and the rock hardness
   are priced on that call.** Its arithmetic is phrased in the old lane's terms
   because that is what it was measured against. Do not "tidy" it — re-deriving
   it silently repays every mine in the game.

`getViewBounds()` returns a **reused object** — `advterrain.js` and
`particles.js` both call it every frame for culling and streaming. Do not cache
the reference across frames.

### `SM.particles` — the heart of the game

```js
// lifecycle
SM.particles.init() / reset() / update(dt) / render(ctx)

// spawning
SM.particles.spawnSolid(x, y, matIndex [, radius])   // -> slot index or -1
SM.particles.spawnLoose(x, y, matIndex, vx, vy, radius [, value])

// interaction
SM.particles.damageSolidInRect(minX, minY, maxX, maxY, damage, originX, originY)
SM.particles.queryRect(minX, minY, maxX, maxY, fn)   // fn(index) per overlap
SM.particles.explode(x, y, radius, damage, force)
SM.particles.collectInRadius(x, y, radius)
SM.particles.rebuildGrid()

// plumbing pushed in by the vehicle every step
SM.particles.setCollectorTarget(x, y, radius) / clearCollectorTarget()
SM.particles.setVehicleBody(cx, cy, halfW, halfH, vx, vy) / clearVehicleBody()

// streaming
SM.particles.despawnBehind(y) / despawnAhead(y)
SM.particles.despawnOutsideRect(minX, minY, maxX, maxY, keepLoose)

// introspection
SM.particles.getStats()          // REUSED {active, solid, loose, collected, free}
SM.particles.getActiveCount() / getLooseCount() / getSolidCount() / getCapacity()
SM.particles.FREE / SOLID / LOOSE / COLLECTED
SM.particles.data                // READ-ONLY typed arrays
```

`damageSolidInRect()` returns a **reused object**:

```js
{ broken,      // deposits destroyed this call
  damaged,     // deposits touched this call
  resistance,  // summed hardness of material that SURVIVED -> drives slowdown
  value }      // currency value of what broke
```

`SM.particles.data` is **read-only**. Writing to those typed arrays bypasses the
pool bookkeeping and will corrupt the simulation.

### `SM.vehicle`

```js
SM.vehicle.init() / reset() / update(dt) / render(ctx [, showroom])
SM.vehicle.renderPreview(ctx, cx, cy, scale, rot)   // the workshop portrait

// STABLE GETTERS — other modules depend on these; do not rename or change units
SM.vehicle.getX() / getY()
SM.vehicle.getWidth()           // full lateral span
SM.vehicle.getSpeed()           // world units / second
SM.vehicle.getMiningPower()     // hardness points removed per second
SM.vehicle.getCollectRadius() / getBladeWidth() / getBladeFrontY()
SM.vehicle.getLateralSpeed() / getResistance() / getPartLevel(name)
SM.vehicle.parkInLift()
SM.vehicle.beginDoorGlide(out) / setDoorGlide(p) / endDoorGlide() / isDoorGliding()

// the run
SM.vehicle.getHeading()         // radians; 0 = -y, straight up the screen
SM.vehicle.getDrillX() / getDrillY()    // the BIT, not the hull centre
SM.vehicle.getVelX() / getVelY()        // the real 2D velocity
SM.vehicle.isStalled() / isCutting() / getBlockedMat() / getLoad()
SM.vehicle.getDriveBurnRate() / getTravelGear()
SM.vehicle.parkAtDoor()
```

The facing unit vector is `(sin h, -cos h)`.

**`render(ctx, showroom)` — the second argument is the WORKSHOP asking.** The
world pass draws nothing while the machine is in the lift and fades it across
the doorway; the workshop's canvas calls the same function and must get the
machine regardless, flat, with no heading and no bank. `js/advui.js`'s
`drawRig()` is the only caller that passes `true`. Without it, opening the
workshop from inside the lift paints a shop floor with nothing standing on it.

**THE HARDNESS CAP IS A REFUSAL, NOT A SLOW GRIND.** Material whose live
`hardness` is above `SM.rig.getHardnessCap()` takes **zero** damage from this
machine — it is a wall until the drill is upgraded, and the workshop sells the
fix. Two mechanisms in `js/vehicle.js` make that true, and both are needed:

1. **The stall.** The cut box is pre-scanned and the whole cut refused when a
   wall is in the way (the bit is sitting on over-cap rock, or enough of what
   lies in the path is over-cap). That is the gate the player *feels*: the
   machine grinds to a halt, sparks come straight back off the face, and it
   says so.
2. **The box never reaches past the first thing it cannot cut.** A vein at the
   shoulder of the box does not trip the stall — and `damageSolidInRect()`
   damages every SOLID in a rect with no way to skip a material, so until this
   was added it chipped over-cap deposits anyway. The pre-scan now also trims
   each of the four sides of the damage rect back off the nearest over-cap
   deposit on that side. **Below the cap the trim is inert** (all four extents
   stay at infinity and the rect is the rect it always was), which is why
   ordinary cutting is unchanged. The hull's janitor box gets its own scan for
   the same reason.

Whichever materials sit above the cap is `js/materials.js` and `js/rig.js`'s
business; both numbers are read **live**, every step, so the mechanic is correct
whatever the balance pass lands on.

**The morph survives, and it is not upgrade-gate machinery.**
`bladeWidthTarget` / `bodyWidthTarget` and the per-part `deploy[]` unfold are how
a workshop purchase lands on the machine: `syncRig()` writes the new targets and
zeroes the deploy timers, `animateMorph()` eases them home with an overshoot.
`depOf()` reads them **settled** whenever `SM.adv.isDriving()` is false, because
the fixed step is held on the workshop screen and reading `deploy[]` raw would
draw the machine you just paid for permanently half-built on the one screen
whose whole job is showing it to you.

### `SM.effects`

```js
SM.effects.init() / reset() / update(dt) / render(ctx)
SM.effects.dust / sparks / sparksDir / chips / smoke / glint / streak
SM.effects.ring / shock / flash / popup / burst
SM.effects.refuse(x, y, matIndex, normX, normY, big)   // the bit BOUNCING OFF
SM.effects.screenFlash(strength, r, g, b)
SM.effects.getCount()
SM.effects.renderDarkness(ctx)   // called ONLY from SM.adv.renderWorld()
```

All shake lives in `camera.js`; `effects.js` deliberately never calls
`camera.shake()`.

### `SM.sound`

```js
SM.sound.init() / update(dt) / reset()
SM.sound.play(name)   // 'break' 'crunch' 'hit' 'impact' 'clank'
                      // 'refuse' 'collect' 'sparkle' 'ui'
SM.sound.setMuted(b) / toggleMute() / isMuted() / isReady() / getBedLevel()
```

Subscribes to `game:paused` and ducks the engine and grinder **buses** to zero,
then back on resume. Those two are the only nodes that keep sounding without
`update()` feeding them. Ducking the buses rather than master is what keeps the
menu audible — its own `'ui'` blips still go out through `sfxBus`.

### `SM.ui`

```js
SM.ui.init() / reset() / update(dt)
SM.ui.showTitle() / leaveAdventure()   // SM.adv.close() calls the latter
SM.ui.isTitleUp() / getRoot()
```

Three jobs and no more: the **title gate**, the **layout switch**
(`applyCompact()` publishes `sm-compact` / `sm-tiny` / `sm-portrait` on
`#ui-root`, and the entire phone layout hangs off those three classes — nothing
else sets them), and the **PWA** registration with its opt-in UPDATE READY
button. `#ui-root` also gets `sm-adv` here, permanently.

**The splash screen hook is `buildTitle()` in `js/ui.js`.** It carries a TODO
block naming the three things that must survive whatever replaces it.

### `SM.adv` — the state machine and the ledger

The only module that moves money. See the file header for the full surface; the
load-bearing parts:

```js
SM.adv.isActive() / isInMine() / isDriving() / holdsSim() / getState()
SM.adv.open() / close() / restart() / update(dt) / renderWorld(ctx)
SM.adv.startCompany(i) / openMap() / openGarage() / selectMine(id) / enterMine(id, L)
SM.adv.isMapUnlocked() / getMapNotice() / clearMapNotice()   // §7d
SM.adv.closeShop() / isShopHold()      // the workshop, opened from the lift
SM.adv.getFuel/getFuelCap/getCargo/getCargoCap/getCargoPct/getHeat/getIntegrity
SM.adv.getCash/getDay/getDepthM/getManifest/fragValue(matIndex)
SM.adv.burnFuel(n) / addHeat(n) / damage(n, source) / offerCargo(matIndex)
SM.adv.getPiles() / dump() / consumePile(i)
SM.adv.buyRights/buyFuel/buyPart/buyRepair/buyLevel/sell
SM.adv.getLevels() / getLevel() / rideTo(L) / getBoardable()
SM.adv.isInLift() / isInTransit() / exitLift()
SM.adv.sellAtDoor() / refuelAtDoor() / getDoorFuelQuote() / leaveToMap()
```

`open()` is called from the title gate; `close()` unloads the mine, restores the
title and empties the world.

### `SM.main`

```js
SM.main.restart() / setPaused(b) / isPaused()
SM.main.getFps() / getStepMs()
SM.main.getCanvas() / getContext()
SM.main.getViewportWidth() / getViewportHeight()
SM.main.isRunning()
```

`setPaused()` fires `game:paused` **on change only**, refuses a pause behind the
title gate, and returns the RESULTING state so a caller can tell an accepted
pause from a refused one on the spot.

---

## 5. Event contract

Payload shapes are exact. Anything that can fire more than a few times a second
**must reuse its payload object**.

### Engine events (hot)

| Event | Payload | Emitted by | Frequency |
|---|---|---|---|
| `material:hit` | `{material, matIndex, x, y, intensity:0..1}` | particles | ≤3 / step (rate limited) |
| `material:destroyed` | `{material, matIndex, x, y, value}` | particles | **up to ~150 / step** |
| `resource:collected` | `{material, matIndex, x, y, value}` | particles | **up to ~30 / step** |
| `impact:heavy` | `{strength:0..1, x, y}` | particles | ≤1 / step |

### Everything else

| Event | Payload | Emitted by |
|---|---|---|
| `adv:state` | `{state, prev}` | adv |
| `adv:entered` | `{mineId, depth, level}` | adv |
| `adv:extracted` | `{gross, cargo, depthM, reason}` | adv |
| `adv:stranded` | `{reason, depthM, lost}` | adv |
| `adv:sold` | — | adv |
| `adv:cash` | `{cash, delta, reason}` | adv |
| `adv:fuellow` | `{pct}` | adv |
| `adv:cargofull` | `null` | adv |
| `adv:dumped` | `{matIndex, units, x, y}` | adv |
| `adv:rig` | `{partKey, tier}` | adv |
| `adv:rights` | `{mineId, price}` | adv |
| `adv:day` | `{day}` | adv |
| `adv:heat` | `{pct}` | adv |
| `adv:damage` | `{integrity, source}` | adv |
| `lift:bought` / `lift:ride` | see adv.js | adv |
| `lift:unlocked` | `{level, price, mineId}` — the progression gate opened on that level. Fires ONCE per rung, ever | adv |
| `map:unlocked` | `{mineId, levels}` — THE FIELD OPENED: the starter mine is fully bought, so the world map and every route to it exist from here. Fires ONCE per company, ever | adv |
| `lift:docking` / `lift:entered` / `lift:undocking` / `lift:exited` | `{level, reason}` — see adv.js | adv |
| `rail:bought` / `rail:deposit` / `rail:fuel` | see adv.js (dormant) | adv |
| `drill:blocked` | `{x, y, matIndex, hardness, cap, seal}` — HEARTBEAT: still stuck. Re-fires while the grind lasts | vehicle |
| `drill:toohard` | `{x, y, matIndex, hardness, cap, seal}` — THE ANNOUNCEMENT: one per contact EPISODE, never twice for the same material inside the quiet period, plus one repeat if a single grind runs past it. `seal` distinguishes the level boundary (no drill ever cuts it) from a cap refusal (the workshop sells the fix). The HUD banner, the clank and the bounce sparks all hang off this one emitter | vehicle |
| `scan:contact` | `{matIndex, dist, bearing}` | scanner |
| `mine:layer` | `{name, depthM}` | advterrain |
| `mine:lode` | see advterrain.js | advterrain |
| `game:paused` | `{paused}` | main |
| `run:reset` | `null` | main |
| `input:firstgesture` / `input:restart` / `input:mutetoggle` | `null` | input, ui |
| `sound:muted` | `boolean` | sound |

### Two hard rules for handlers

1. **Payload objects are reused.** `material:destroyed` fires with the *same
   object* every time. Read the fields you need inside the handler and let it
   go. Storing the reference means holding a value that mutates under you.
2. **`material:destroyed` and `resource:collected` are hot.** At full tilt that
   is ~5 000 handler invocations per second, each. Anything in those handlers
   must be O(1) and allocation-free, and any spawning must come out of a
   **per-step budget** (see `FX_BUDGET_PER_STEP` in `effects.js` for the
   pattern). Do not `console.log`, do not build strings, do not allocate.

New events are fine. Namespace them `noun:verb`.

---

## 6. The particle system — what it can already do

`js/particles.js` is material-agnostic and should be treated as frozen.

### Storage & pooling

Struct-of-arrays over pre-allocated typed arrays, capacity `PARTICLE_CAPACITY`
(7 500). Three O(1) swap-remove index lists:

* `freeStack` — the object pool.
* `activeList` — every live particle (grid build, despawn, render).
* `dynList` — **only** `LOOSE` + `COLLECTED`. The dense static field never enters
  the physics loop, so simulation cost tracks debris count (~200), not total
  count (~5 000). **This is the single most important performance property of
  the engine.**

### Spatial hash — and the limit it puts on the world

Uniform grid, `GRID_COLS × GRID_ROWS` (128×256) cells of `GRID_CELL` (23) world
units, indexed with a bitmask so it tiles infinitely as the world scrolls — no
allocation, no re-indexing. Rebuilt once per step from a head/next linked list.

**THE LIMIT ON THE LIVE WINDOW IS THE SPATIAL HASH, NOT THE POOL.** The bitmask
wraps at `GRID_COLS × GRID_CELL` = **2944** units in x and
`GRID_ROWS × GRID_CELL` = **5888** in y. Two live particles further apart than
that alias into the same hash cell and collision detection corrupts
**silently**, with no error to trace. `advterrain.js` clamps the live extent to
**2800 × 5600** for exactly that reason, and the clamp covers loose debris too —
a heap dumped 3000 units away would otherwise stay live and break the hash on
its own. Measured peak live extent in play: 2778 × 1896.

Widening a *mine* is cheap; widening the *window* past those numbers means
raising `GRID_COLS`.

### States

| State | Behaviour |
|---|---|
| `SOLID` | Embedded terrain. Never integrated, never moves. Accumulates cutter damage against `material.hardness`. |
| `LOOSE` | Tumbling debris. Integrated, collides with solids and other debris, sleeps when settled. |
| `COLLECTED` | Flying to the collector. Collision ghost, homing only. |

### Sleeping

A `LOOSE` particle under `SLEEP_SPEED` for `SLEEP_TIME` sleeps: velocity zeroed,
integration and relaxation skipped. It **stays in the grid** so it is still an
obstacle, and any awake particle that pushes into it wakes it.

### Collision

3 relaxation passes of positional correction per step; velocity response
(restitution, mass-weighted by `density`) on the first pass only — applying it
every pass injects energy and makes piles boil. Solids are infinite mass.

### Collection feel — the two non-obvious bits

1. **`COLLECT_DELAY` (0.34 s)** — fresh debris is *immune to the magnet* while it
   erupts and tumbles. Without this the collector swallows fragments the instant
   they spawn and destruction reads as "tiles vanishing" instead of "ground
   erupting". Older settled debris has no immunity, so driving past a pile
   vacuums it up.
2. **Homing is STEERING, not force.** Each step a desired velocity is computed
   and the real velocity is lerped toward it, with a decaying tangential term for
   a curved arc. A naive "accelerate toward the target" implementation makes
   particles **orbit the collector forever and never arrive** — this was a real
   bug found in testing.

### Rendering

Per-material pre-baked sprite atlases: `SPRITE_SIZE_STEPS(8) ×
SPRITE_SHADE_STEPS(3)` rows by `SPRITE_ROT_STEPS(8)` baked rotation columns, so
the renderer never calls `ctx.rotate()`. Solids are bucketed by material so we
hammer one atlas at a time; debris draws last so it always reads on top. Damaged
deposits switch to the brightest shade row — free "cracking" feedback with zero
extra draw calls. Below `LOW_DETAIL_ZOOM` it falls back to colour-batched
`fillRect`.

Particle radii are **quantised** to the atlas size buckets at spawn, so physics
radius always matches the drawn sprite exactly.

**Sprite atlases are rebuilt only in `particles.init()`.** Changing material
colours at runtime will not take effect.

---

## 7. LEVELS AS ENDLESS MAPS — the contract

**The model:** each level is ITS OWN MAP, conceptually stacked; the lift is the
ONLY way between levels. A level map is **UNBOUNDED east, west and SOUTH**. The
only boundary anywhere in the game is the **bedrock CEILING just north of that
level's lift** — one wall, and it is absolute. **FUEL is what stops a run, not
rock.** The lift is BIG CLOSED DOORS at the map's TOP-CENTRE: approach → they
open → **drive in → the lift docks you** → the door menu (SELL / REFUEL / level
list / MAP). Surface is UI only. L1 comes with the mining rights. Stranding drops
the hold as a pile on that level. Levels can be hopped freely mid-run, hold
intact.

**The realisation:** a level is not a y-band any more — it is a whole coordinate
space of its own, distinguished by `genSeed = h3(mineSeed, S_LEVEL, k)`. That is
what makes the levels-as-maps contract true *by construction* rather than by
enforcement: you cannot dig from level 1's map into level 2's because level 2 is
not there. Its geology is a different hash of the same coordinates and only the
lift crosses. Absolute `(genSeed, cellX, cellY)` determinism, the emissive
`renderLit` pass, 2D streaming and the hash clamps are all UNCHANGED.

**Depth is ABSOLUTE everywhere.** A level's lift sits at that level's catalogue
depth in world y, so level 3's board reads 300 m and a kilometre south of it
reads 1300 m. The HUD gauge, the depth ruler and the red board on the doors all
read the same number, and so does `adv.getDepthM()`.

**ONE STRATUM PER LEVEL, FOREVER.** A level map does not descend through the
layer table: it is the one stratum `mines.levelSpawnOf()` names, at every depth,
south forever — country rock, hardness, heat and ore lottery alike. What changes
within a map is a deliberate WHISPER (see §7a); what changes between maps is the
whole table, and that is the progression axis.

### THE SEAL TRUTHS (measured — do not relearn)

* **The carve store BEATS the generator** (single consult, `generateRowStrip`,
  before `cellMaterialAt`) — the ceiling rows therefore need an explicit
  *seal-beats-store* test, or an old tunnel punches a player-shaped hole in the
  one wall in the game.
* **Tier-5 drills CUT bedrock** (cap 34 > 26). The seal GUARANTEE is the
  **vehicle position clamp**, not the rock. Ceiling bedrock is the visual. The
  seal also heals: a tier-5 rig can bite it, but `markDestroyed` refuses ceiling
  cells, so bites never enter the store and regenerate on recycle. Measured on
  the current build: a maxed rig driving north for 25 seconds stops exactly
  `ADV_CEIL_MARGIN` (40 units) below `lvlTopY` with zero carved cells in the
  ceiling rows.

### 7a. WHAT A LEVEL PURCHASE BUYS — the spawn ladder

Owner's rule, verbatim: *"the spawn percentage stays fixed in level 1 — well
maybe it gets a little better as you drill south. But in the end, for better
hauls you have to BUY lower levels in the lift and move on from there."*

* **BETWEEN LEVELS** — the real axis. Each level owns a FIXED ore table
  (`mines.levelSpawnOf(mine, k).weights`). Deeper is richer in both senses: the
  cheap bulk shrinks as a share AND minerals that do not exist higher up start
  appearing. Old Creek measures $11.87 → $26.15 → $74.61 per unit of hold.
* **WITHIN A LEVEL** — a whisper, and it is capped so that digging south can
  never substitute for buying down. Each material's weight is scaled by
  `1 + drift_i * g`, `g = min(SOUTH_DRIFT_CAP, metresSouth/100 * SOUTH_PER_100M)`
  — +3% of relative share per 100 m, plateauing 1000 m south. Measured worth
  ~+11% of dollars-per-unit against a 2.1x step for a purchase.
* **ANCIENT DEBRIS IS NOT AN ORE WEIGHT.** A pocket picks ONE material for the
  whole blob, so a weight of even 0.05 means "one pocket in two thousand is
  forty deposits of the richest material in the game" — a slot machine, not a
  discovery. It is its own structure family (`gatherDebris`), a tight scatter of
  2-4 deposits, priced per level through `debrisRate`.
* **MOTHERLODES ARE LANDMARKS, AND THEIR RATE IS SIZE-SENSITIVE.** A lode paints
  ~2 100 cells of its own mineral between shell and halo. The old default
  (`0.42` on every mine's deepest layer) was written for a finite band; on an
  endless map it made Old Creek L3's emerald 35.6% of all ore against a 4.7%
  table share. The ladder now targets one rolled lode per ~90 M units², plus one
  GUARANTEED lode a couple of hundred metres south of every level's own lift.

### 7b. THE SPARSE CARVE STORE

The whole-mine carve mask is gone: it was one byte per cell of a finite box and
there is no box any more. `js/advterrain.js` keeps 32×32-cell chunks of one BIT
per cell, keyed `(level, chunkX, chunkY)`, allocated only when something inside
one is dug. `markDestroyed` keeps a one-entry chunk cache, so the hot path
(~150 calls/step) is three integer compares, a shift and a byte write.

The save seam is `advterrain.exportCarve()` / `importCarve(desc)` and
`save.encodeCarve(desc)` / `save.decodeCarve(str)`. Wire format `"2S,<n>,<body>"`;
a v1 mask string is REJECTED, not mis-parsed. **MEASURED: ~34-58 characters per
touched chunk**, ~33 KB per hour of continuous novel driving. A scripted
expedition that dug 88 132 cells across 377 chunks wrote a 22 430-character save
record.

### 7c. THE PROGRESSION GATE — the next level does not exist until it is earned

**Owner's rule:** the option to buy the next level down is **not visible at all**
until the player has (a) banked some real hauls out of the level they are on and
(b) can afford it. No purchase row, no price, no greyed-out tease. When both
halves first come true a small **instruction box** appears in the lift saying
they may now buy another level down — once, ever, per rung.

```
level k+1 is revealed  <=>  qualifying hauls from level k >= HAULS_TO_REVEAL (3)
                       AND  cash >= price(level k+1)
```

* **A qualifying haul is a banked sale carrying >= `HAUL_MIN_HOLD` (0.35) of the
  hold, by VOLUME.** Volume because that is what the word means and because it
  cannot be farmed — selling one unit repeatedly is 2% of a hold and never
  counts. The money half of the gate is the affordability test.
* **Reveal is a ONE-WAY DOOR.** If the cash later dips under the price the row
  stays and greys, exactly like every other purchase in the game. Re-hiding it
  would flicker on the commonest action at the doors (buying fuel) and would
  retract a promise the instruction box just made.
* **The unowned TAIL hides with its head.** A list that hid L2 and still showed
  L3 as SEALED would have a hole in it, and a hole teases louder than the row it
  replaced. So unowned levels appear only once the gate opens on the next one.
* **It is enforced in `buyLevel()`, not just drawn.** A stale panel or a console
  poke cannot spend the ledger early.
* **Persisted per mine** as `hauls` (counts per level) and `taught` (how deep the
  notice has been shown) — see `js/save.js`. Both migrate to 0, so an existing
  company simply re-earns the current rung; nothing it paid for is lost.
* Owned by `js/adv.js`; `js/advhud.js` (the lift menu) and `js/advui.js` (the
  prep screen) both read `offered` off the level entries and neither re-derives
  the rule.

### 7d. THE MAP IS EARNED — a new company starts at PREPARE DESCENT

**Owner's rule:** *"when you start a new game I do not want to start at the map —
I would like to start at PREPARE DESCENT — and I would like for the map to be
available only after you have unlocked at least 3 levels in the starter mine."*

`startCompany()` therefore lands on **prep**, not on the map: it calls
`selectMine(firstMineId())`, which establishes everything the map used to
establish on the way through (mine in context, lift table, default level). A
fresh record already carries the starter mine's rights (`save.freshRecord()`),
so nothing else is granted.

```
mapUnlocked  <=>  ownedLevels(starter) >= 3 (or every level it has, if fewer)
             OR   rights held in any mine whose price > 0
```

* **DERIVED, NEVER STORED.** No new save field and no migration: ownership is
  already persisted and already validated, so an existing company is correct the
  moment it loads. The second clause keeps old saves sane — a company that bought
  Red Ridge and never finished Old Creek keeps its map.
* **`openMap()` REFUSES while it is false**, enforced exactly as the progression
  gate is. It is the only door: the other two verbs keep their semantics and
  change only their destination. `backToMap()` and `leaveToMap()` (which still
  banks anything aboard) land on **prep** while the map is locked.
* **Pre-unlock, prep is the home screen** and its footer says so: WORKSHOP moves
  onto it (the workshop door has always lived on whichever screen is home) and
  BACK becomes **TITLE SCREEN**. Post-unlock both revert and BACK means the map
  again. The garage's and the results screen's map plates relabel to PREPARE
  DESCENT rather than hiding, so no screen can become a dead end.
* **The notice is one-time by construction.** `mapTaught` is seeded from the same
  derived answer at `startCompany()`, so a company that already qualifies at load
  is never nagged, and `checkMapUnlock()` can only fire on the transition. The
  fact that persists is the level purchase, written and flushed by `buyLevel()`
  before the box is armed. `getUnlockNotice()`'s twin is `getMapNotice()`, shown
  as a second gold box in the lift (`js/advhud.js`) and as a toast if the
  purchase was made on the prep screen instead.

### The interface

```
mines.levelsOf(id)   level k = layer k (1-based; L1 = first layer, owned with the
                     rights). Entry:
                     {i, name, depthTopM, depthBotM, price, endless, widthU:0}
                     depthBotM == depthTopM and endless is true: a level has ONE
                     depth (its lift) and no width to sell
mines.levelSpawnOf(id, k)  the resolved spawn record advterrain generates from
mines.levelEconomyOf(id, k)  what a level is WORTH — for the pricing pass
advterrain.beginLevel(mineDef, L)   activate level L: genSeed re-keyed, ore
                     buckets rebuilt, ceiling spawned, door chamber carved at
                     (x=0, ceiling), guaranteed motherlode re-placed below it
advterrain.getLevelBounds()   REUSED {level, topY, botY, halfW, openX, openBot}.
                     botY and halfW are **Infinity** — every clamp in the codebase
                     is a compare, and a compare against Infinity is simply false,
                     so an unvisited consumer degrades to "no clamp on that side"
                     rather than to a wrong one. topY is the ONE real bound
advterrain.getDoorX() / getDoorY()   door centre. The door-open animation is
                     advterrain's own, driven by machine proximity; no event —
                     EXCEPT while adv.js is docking or undocking, when it takes
                     the leaves over through setDoorHold(v) (v<0 releases)
advterrain.inDoorInterior(x, y)      the chamber behind the door line — the
                     single geometric source of truth for BEING inside
advterrain.inDoorThreshold(x, y)     ...and for STARTING to go in: the same
                     column, DOOR_CATCH further out. This is what adv.js polls
advterrain.getDoorFade(x, y)         the machine's alpha across the doorway;
                     reaches 0 before the cage's park, not at the door line
adv.getLevels()      LIVE level entries plus owned:bool and offered:bool — the
                     latter is THE PROGRESSION GATE (§7c) and is what a painter
                     reads to decide whether a purchase row may exist at all
adv.getLevel()       current level index (1-based)
adv.isLevelOffered(i)  the same answer as a question. True for exactly one level
adv.getUnlockNotice()  REUSED {level, name, price} the one-time instruction box
                     is waiting on, else null; clearUnlockNotice() takes it
adv.haulsFrom(id, L) / adv.getHaulsNeeded()   the gate's haul counter
adv.rideTo(L)        mid-run, hold intact: beginLevel + camera.reset +
                     lift:ride {from,to}, then UNDOCKS at the far end
adv.getBoardable()   current level index while inside the door circle
                     (EXIT_RADIUS about the door), else -1
adv.isInLift()       the machine is IN the cage: hidden, undriveable, MENU UP.
                     Set by the DOCKING manoeuvre, not by geometry. False for
                     the whole of both manoeuvres and false on arrival
adv.isInTransit()    the lift has the machine and the player does not
adv.exitLift()       (= dismissing the menu) start the UNDOCKING; control comes
                     back ~1.1 s later at the park below the doors
adv.openGarage()     from the lift menu, MID-RUN: the workshop over a live
                     expedition. Returns false unless the machine is actually in
                     the cage and no manoeuvre is running
adv.closeShop()      ...and back to the lift menu, NOT to the map
adv.isShopHold()     true while that is the case
adv.sellAtDoor()     banks hold + secured, rolls the day (the door IS surface
                     access). The results screen remains for STRAND only
adv.leaveToMap()     teardown -> map state
vehicle.parkAtDoor() set down just below the doors, heading down; the CEILING
                     clamp from getLevelBounds() is the seal guarantee, and it is
                     the only position clamp left in the game
vehicle.parkInLift() ...and its mirror, ADV_DOCK_Y INSIDE them — where the cage
                     holds the machine while the menu is up
vehicle.beginDoorGlide(out) / setDoorGlide(p) / endDoorGlide() / isDoorGliding()
                     the scripted path. adv.js owns the clock, vehicle.js owns
                     the shape, advterrain.js owns the leaves — one number each
vehicle.render       draws NO machine while isInLift(), and fades it across the
                     doorway before that. Doors slide closed behind an occupied
                     lift; interior light in the seam
```

**ENTERING AND LEAVING ARE MANOEUVRES, NOT FLAGS.** Driving at the doors does not
put you in the lift; it hands the machine to the lift, which then drives it in
(~0.67 s, still drawn, fading as the doorway swallows it), shuts the leaves
behind it from 55% of that drive, and only THEN hides it and opens the menu —
about 0.87 s end to end. Dismissing the menu runs the mirror: the leaves part
(0.38 s), the machine rolls out to the park (~0.73 s), control returns.

**THE WORKSHOP IS ON THE LIFT MENU, AND OPENING IT DOES NOT END THE RUN.**
SELL / REFUEL / **WORKSHOP** is the trade row; the third plate steps into the
same `'garage'` state the surface uses, with `shopHold` set. `holdsSim()` is
`state !== 'mine'`, so the world freezes and keeps rendering exactly as it does
under any other meta screen, and *nothing* is torn down — hold, tank, day, level,
carve store and machine position are all module state that no screen transition
touches. `closeShop()` goes back to the **lift menu**, not the map.

Five verbs are refused while `shopHold` is set, because every one of them means
"start something else" and would act on a run that is still live:
`buyFuel` (fills the between-runs tank, which is 0 and gets overwritten),
`selectMine` (rewrites the ground under the run), `enterMine` (a fresh descent
over a live one, with no teardown: the hold dies and the carve store is
re-imported stale), `openMap` (a zombie run), and `buyLevel`'s `runLevel = i`
(teleports the run's map while the machine stands still).

`closeShop()` **re-snapshots `fuelCap` / `cargoCap` / `heatCap`**, which
`enterMine()` otherwise takes once per descent — without it a tank bought in the
lift reads at its old size for the rest of the expedition, gauge, quote and fill
ceiling alike. **A bigger tank keeps the LITRES, not the percentage**: `fuel` is
untouched, so the gauge drops and the REFUEL plate next door is the answer.

**AND YOU ARRIVE OUTSIDE.** A descent and a ride both set the machine down IN
the cage with the doors shut and then UNDOCK it, so a run opens — and a ride
lands — with the doors opening, the machine driving out, and no menu at all. The
menu is what ENTERING looks like. (Both used to arrive inside with the menu up,
which meant every descent began with a panel to dismiss and every ride ended by
re-asking the question the player had just answered.)

While either manoeuvre runs the player has no control, the machine burns no
fuel, and **the dry-tank strand timer is held** — the grace is 1.8 s and a
manoeuvre is over half of it, so a player who limps into the doorway on fumes
must not be stranded by the rescue that is already happening.

### Shipped amendments (verified)

* Levels are **1-BASED EVERYWHERE**; there is no level 0. L1 is in the catalogue
  at price 0. `getLevels()` entries also carry `depthM` (= `depthTopM`) and `y`.
* Stored `levels` keeps its v1.8 meaning (**PURCHASED** count);
  `ownedLevels()` = purchased + 1. A v1.8 record loses nothing.
* In-mine refuel is `adv.refuelAtDoor()` (+ `getDoorFuelQuote()`). `buyFuel()`
  refuses in-run by design and fills the tank, not the run.
* `leaveToMap()` **banks anything aboard** on the way out — walking out of your
  own doorway must not destroy ore. `sellAtDoor()` refuses an empty sale so a day
  cannot be rolled for free. `escape()` survives, working, called by nothing.
* You cannot strand INSIDE the lift, nor DURING a docking or an undocking (the
  dry timer pauses for all three).
* v1 saves load: company / cash / day / rig / rights / bought levels / rails /
  dumped piles all intact. TUNNELS DO NOT — v1's flat carve mask described a
  finite box and there is no honest mapping onto the sparse per-level store
  (§7b). Accepted and deliberate: a fabricated mapping would put solid rock
  inside workings the player remembers digging.

**RAILS ARE DORMANT.** The rails layer (checkpoint purchase / refuel / deposit /
secured, in `adv`/`mines`/`save`) stays on disk untouched — zero UI wiring,
no-ops with an empty ledger. When rails return they run east AND west from the
central door of a level map — which is now genuinely unbounded in both
directions, so `CP_PER_LEVEL` is no longer bounded by the mine's width and
`mines.js` design note 4d's margin arithmetic against `MINE_HALF_WIDTH` is
obsolete. Checkpoint rows sit on the **door's row**, not the ceiling (which is
inside the seal).

---

## 8. Performance budget — non-negotiable

The engine's cost is **rasterisation**, not physics.

* **Resident solids ≤ `ADV.SOLID_BUDGET` (5200).** Trim **every** edge
  (`despawnOutsideRect`, both axes); players drive back up as well as down.
  Watch `SM.particles.getStats().free` and keep the `DEBRIS_RESERVE` discipline:
  the graceful failure is "streaming pauses", never "pool exhausted".
* **THE WINDOW IS ALWAYS FULL NOW, AND THAT IS NEW.** While levels were thin
  y-bands the window was clamped to the band, so a shallow level held ~2 000
  solids and half the screen was bedrock. An endless map fills the whole window:
  measured 4 026 resident on Old Creek L1 where the band build held 1 966, and a
  peak of 5 198 against the 5 200 budget on a 9 000 m descent. The budget holds —
  `generateRowStrip`'s `canAfford` is a hard cap and `adaptBudget` never had to
  stay trimmed — but **every level is now as expensive to render as the deepest
  one used to be.** Measured against the band build on the same machine, at equal
  geometry frame rate is unchanged; the mode pays ~13% of frame rate for ~105%
  more rock on screen.
* **The darkness composite is full-screen blending.** One radial gradient and one
  fill, not a per-particle lighting pass. If it costs more than a couple of
  milliseconds it is wrong. The gradient is baked at the origin and the *context*
  is translated, so it is rebuilt only when the light radius changes.
* **No DOM work in the fixed step.** `advhud.update()` and `ui.update()` are both
  called from inside the fixed step and can run several times per rendered frame.
  Guard every write with a "did the string change?" check and never read a layout
  property. Touching `textContent` unconditionally forces layout ~180 times a
  second.
* **The scanner probes on a cycle, not every step.**
* **Target: 60 fps on a mid-range phone**, 120 in headless Chrome, zero console
  errors across a full expedition and a clean return to the title.

If frame rate becomes a problem, the lever is *blended pixels* (sprite cell
margins, glow halo size, particle count, DPR cap) — not the physics.

---

## 9. Known rough edges & traps

1. **`spanOf()` over-reports width with a grinder fitted.** `grinders` is a live
   `SM.rig` flag, but the machine draws shoulder cutters tucked inside the
   reamer rather than the old outrigger discs — so a fitted grinder inflates
   `getWidth()` by the outrigger formula while the silhouette stays put. Left as
   it was rather than quietly re-tuned, because `getWidth()` feeds camera
   framing, dust spread and collision span. Flagged for the balance pass.
2. **`terrain.js`'s power-up blocks are gone** and so is anything that read them.
   The mine places no pickups; `timecell` and `boostcell` are still in the
   material table (append-only rule) but nothing generates them.
3. **Sound is procedural WebAudio only**, unlocked on the first gesture. Voice
   count and per-name rate limits exist because `material:destroyed` is so hot —
   keep equivalents if you replace the internals.
4. **Screen shake saturates easily.** `impact:heavy` can fire several times a
   second while drilling dense rock. Use `shakeFloor()` for anything repeating
   and `shake()` only for discrete moments.
5. **`style.css` still carries the old time-attack HUD rules** (score strip,
   countdown, upgrade rail, summary card, high-score table). Nothing builds that
   DOM any more, so they are inert. They were left because the base layer above
   them — panels, buttons, cells, the title overlay — is load-bearing and shared,
   and because the branding pass is likely to rework this file anyway.
6. **`config.js` keeps a few now-unused constants** (lane geometry, gate carve
   depth, the level/upgrade block). The table is frozen; unused numbers cost
   nothing.

---

## 10. Verifying a change

1. `node --check` every file in `js/`.
2. Grep for references to anything you removed. Zero live references may remain.
3. **Run it.** `python3 -m http.server 8000`, then drive a full expedition:
   title → slot → new company → map → buy rights → prep → descend → drill → fill
   the hold → back to the doors → sell → workshop → buy an upgrade → descend
   again. Confirm the tunnels you dug are still there.
4. Check the console. Zero errors.

Prioritise **feel over feature count**. A short expedition that is tense,
readable and satisfying beats a complete feature list that plays like a
spreadsheet. If you run short on time, cut scope — never cut polish on what you
do ship.
