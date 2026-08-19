/* =============================================================================
 * SUPERMINE ADVENTURE — js/advterrain.js
 * -----------------------------------------------------------------------------
 * THE UNDERGROUND. Generates one mine from its seed and its layer table, streams
 * it around the machine, and remembers every hole the player has ever dug in it.
 *
 * ---------------------------------------------------------------------------
 * THE THREE HARD CONSTRAINTS, AND HOW THIS FILE ANSWERS THEM
 *
 * 1. GENERATION IS POSITIONALLY DETERMINISTIC.
 *    Adventure mode lets the player drive back UP, so a band streams out and
 *    streams in again and what comes back has to be identical. There is
 *    therefore NO RNG STREAM IN THIS FILE — not one call to Math.random() on
 *    any path that decides what a cell contains. Every decision is a pure
 *    function of (mineSeed, cellX, cellY) routed through h3()/hv(), and every
 *    structure — seam, pocket, cavern, old drift, motherlode — is derived from
 *    the hash of its own STRUCTURE-CELL INDEX, so it exists at the same place
 *    with the same shape whether you meet it going down or coming back up.
 *
 *    The invariants that make that true, in order of how easy they are to
 *    break by accident:
 *      * The generation grid is anchored to the MINE, not to the machine:
 *        cell (cx, cy) is always the same patch of rock. See cellXOf/cellYOf.
 *      * Jitter is hashed, not rolled. A deposit's offset inside its cell is
 *        hv(S_JX/S_JY, cx, cy), so it lands in the same spot every time — and
 *        because |jitter| < SP/2 the position ROUND-TRIPS: floor() recovers the
 *        exact cell it came from, which is what lets the carve mask key off a
 *        destroyed particle's world position.
 *      * prepareRow() gathers structures from a candidate set derived only from
 *        the row's y, in a fixed order. Nothing carries over between rows.
 *      * Anything cosmetic and per-particle (sprite rotation, shade) is
 *        particles.js's own Math.random() and is deliberately NOT part of the
 *        contract. Material identity is; which of three shade rows it drew is
 *        not.
 *
 * 2. THE CARVE STORE IS WHAT MAKES TUNNELS REAL, AND IT IS SPARSE.
 *    It used to be one flat byte per generation cell for the whole mine, which
 *    was the right answer while a mine was a finite box (247 x 1745 = 421 KB for
 *    the deepest one). A LEVEL MAP IS ENDLESS NOW — east, west and south — so
 *    there is no box to size an array against, and an array sized for the reach
 *    of a full tank would be mostly zeros forever.
 *
 *    So: A SPARSE MAP OF 32x32-CELL CHUNKS, one BIT per cell, keyed by
 *    (level, chunkX, chunkY) and allocated only when something in that chunk is
 *    actually dug. A chunk is 128 bytes and covers 672 x 672 world units.
 *
 *    THE HOT PATH IS STILL O(1) AND ALLOCATION-FREE. `material:destroyed` fires
 *    up to ~150 times per step, and a cutter works one small rectangle of rock,
 *    so consecutive marks land in the SAME chunk almost every time: markDestroyed
 *    keeps a one-entry cache of the last chunk and its byte array, and a hit is
 *    three integer compares, a shift, an or, and a byte write. A miss is one
 *    Map.get on a packed numeric key — no string built, nothing allocated —
 *    and only the very first mark in a chunk allocates (128 bytes).
 *
 *    Generation skips marked cells. Without it, driving back through your own
 *    tunnel re-fills it with solid rock. js/save.js encodes the touched chunks
 *    between sessions; the seam is exportCarve() / importCarve() and it
 *    round-trips exactly. MEASURED cost: ~70 characters per touched chunk, which
 *    is about 33 KB per hour of continuous novel driving.
 *
 * 3. THE POOL IS 7500 AND THE WINDOW IS A 2D RECTANGLE OF CELLS.
 *    The world is unbounded in three directions — far more than any screen shows
 *    and far more than the pool could hold — so the resident set is a RECTANGLE
 *    in BOTH axes, sized from the camera's view plus ADV.STREAM_MARGIN and
 *    clamped by SOLID_BUDGET. Everything outside it is freed with
 *    particles.despawnOutsideRect(). Three things make that safe:
 *
 *      * THE CUTS LAND ON EXACT CELL BOUNDARIES. A row boundary was always
 *        clean (|jitterY| < SP/2). A COLUMN boundary is only clean if the
 *        stagger and the x-jitter together stay inside half a cell, which is
 *        why STAGGER + JITTER_X < 0.5 is an invariant of this file and why the
 *        two jitters are separate constants. Cutting anywhere else would leave
 *        part of a strip alive and the refill would regenerate it on top of its
 *        own survivors, at double density.
 *      * ALL FOUR EDGES ARE TRIMMED. Players drive back up AND sideways.
 *      * THE LIVE EXTENT NEVER REACHES THE SPATIAL HASH'S WRAP. particles.js
 *        indexes a 128 x 256 grid of 23-unit cells with a bitmask, so it tiles
 *        every 2944 units in x and 5888 in y; two world cells that far apart
 *        alias to the same hash cell and collision detection silently
 *        corrupts. WIN_MAX_W / WIN_MAX_H (2800 x 5600) bound the window, and
 *        the KEEP rect that bounds loose debris (see trimTo) is clamped to the
 *        same box, so nothing live is ever 2944 units from anything else live.
 *
 *    Streaming refuses to run a strip when the pool is tight, so the graceful
 *    failure is "streaming pauses", never "pool exhausted", and the window
 *    self-trims (see `trim`) if resident solids ever cross the budget.
 *
 * ---------------------------------------------------------------------------
 * THE GEOLOGY, IN THE ORDER THE GENERATOR ASKS THE QUESTIONS
 *
 *   THE CEILING     THE ONE WALL IN THE GAME. A level map is endless east, west
 *                   and south (ARCHITECTURE.md §7); the only rock a machine can
 *                   ever be stopped by is the bedrock cap just NORTH of that
 *                   level's lift. Its rows are spawned as bedrock by a test that
 *                   runs BEFORE the carve store is consulted. That order is the
 *                   whole point — an old save's tunnel through what is now the
 *                   ceiling would otherwise punch a player-shaped hole in it.
 *   THE DOORS       the one piece of geology that is not geology: a chamber
 *                   carved at the map's TOP CENTRE (x = 0) with the lift's big
 *                   closed double doors in its back wall, worklights, and the
 *                   red level board beside them. It is INFRASTRUCTURE — carved
 *                   by the generator from the active level and never written into
 *                   the carve store, so it exists on a level nobody has visited
 *                   and moves with the map on a ride.
 *   MOTHERLODE      the money shot. A big natural cavern whose far WALL is
 *                   lined with a thick shell of the best ore on the level.
 *                   Every level has exactly one guaranteed one below its lift,
 *                   plus a hashed chance of more out in the field. The approach
 *                   is readable: HALO STRINGERS of the same ore thicken in the
 *                   country rock as you close in, the background carries a
 *                   faint bloom of its colour through the rock, and the
 *                   scanner sees it long before the drill does.
 *   ANCIENT DEBRIS  the rare find, and the only thing in the world that is an
 *                   EVENT rather than a formation: a tight scatter of two to four
 *                   deposits of the richest material in the game, on its own
 *                   sparse grid at a rate js/mines.js states per LEVEL. It is
 *                   deliberately NOT an ore-lottery weight — see that file's
 *                   design note 4e for why a weight would be a slot machine.
 *   CAVERNS         open voids with spoil on the floor, sometimes mineralised.
 *                   Somewhere for the eye to go, and free metres of travel.
 *   OLD WORKINGS    abandoned timbered drifts and winzes. They reward exploring
 *                   SIDEWAYS: an open drift costs no drilling and almost no
 *                   fuel, so finding one is finding a road.
 *   POCKETS         ore lenses. Blobs, with eroded rims, never lone blocks.
 *   SEAMS           ore beds that follow the strata, pinching and swelling
 *                   along their length the way a real seam does.
 *   STRATA          the country rock, in BEDS. A layer is not one material, it
 *                   is two or three interbedded ones on a warped pitch, and
 *                   the background render draws the same warped boundaries the
 *                   generator used — so a wall genuinely reads as strata.
 *
 * ---------------------------------------------------------------------------
 * A LEVEL IS ONE STRATUM, FOREVER, AND THAT IS THE PROGRESSION
 *
 *   The owner's rule: "the spawn percentage stays fixed in level 1 — well maybe
 *   it gets a little better as you drill south. But in the end, for better hauls
 *   you have to BUY lower levels in the lift and move on from there."
 *
 *   So a level map does NOT descend through the layer table. It is ONE stratum —
 *   the one js/mines.js's levelSpawnOf() hands over — and it is that stratum
 *   everywhere on the map, at every depth, to the south forever. Country rock,
 *   hardness, heat and the ore lottery all come from that one record.
 *
 *   The only thing that changes within a map is a WHISPER: the ore weights drift
 *   very slightly toward the money as you work south, and the pocket rate rises
 *   with them. It is quantised into ORE_BUCKETS tables baked once per level, so
 *   the generator never allocates and two visits to the same rock always agree.
 *   js/mines.js owns the size of it (design note 4e); this file owns none of it.
 *
 *   THE LEVEL IS PART OF THE GENERATION KEY. genSeed folds the level index into
 *   the mine seed, so level 2's map is a different world from level 1's rather
 *   than a continuation of it — which is what makes "you cannot dig from one
 *   level's map into another's" true by construction: the other level is not in
 *   this coordinate space at all.
 *
 * WHAT js/mines.js HAS TO SUPPLY, AND WHAT IS OPTIONAL
 *   levelSpawnOf(mine, k) is the whole contract, and it fills in every optional
 *   field itself, so a layer table that only has the required fields still
 *   produces a full arc from soft rich topsoil to barren deep rock with
 *   motherlodes in it. This file feature-detects it and falls back to reading a
 *   layer table directly, which is what keeps it testable on its own.
 *   `pocketRate` and `cavernRate` are per GENERATED BAND as mines.js states
 *   them — BAND_HEIGHT tall and RATE_REF_W wide — and perCell() converts.
 *
 * NOTE ON hardnessScale: particles.js bakes a deposit's hp from the MATERIAL
 * TABLE at spawn and `SM.particles.data` is read-only, so a per-layer hardness
 * multiplier cannot be applied to the particle. It is honoured the only way it
 * honestly can be — by biasing bed selection toward the harder rock in the
 * layer (see buildBeds) — and it is also exposed verbatim on layerAtY() so
 * js/vehicle.js can factor it into drill progress if Agent 1 wants it.
 *
 * EVENTS EMITTED
 *   mine:layer  {name, depthM}            crossing into a new layer
 *   mine:lode   {x, y, matIndex, dist}    first approach to a motherlode
 *   Both payloads are REUSED objects. Read what you need inside the handler.
 * ========================================================================== */

var SM = SM || {};

SM.advterrain = (function () {
  'use strict';

  /* ======================================================================
   * ----- tunables -----
   * =================================================================== */

  var A = SM.config.ADV;
  var C = SM.config;

  /* --- the generation grid -------------------------------------------
   * SP is SM.config.ADV's (shared, frozen). Everything below is derived from it
   * so nothing has to be re-tuned if it moves.
   *
   * THE GRID IS UNBOUNDED IN BOTH AXES NOW. cellXOf/cellYOf are Math.floor of a
   * signed quantity and every hash is Math.imul-based, so a negative or a very
   * large cell index is as ordinary as any other. There is no `cols`, no `rows`
   * and no origin corner any more — cell (0, 0) sits at the mine's centre line
   * on the surface row, and the world runs out from it in every direction.
   *
   * ADV.MINE_HALF_WIDTH IS RETIRED AS A BOUND. It survives in config.js (that
   * table is frozen) and as RATE_REF_W below, which is the ONE thing it is still
   * good for: every shipped `pocketRate` and `cavernRate` in js/mines.js was
   * measured as "expected structures per band, where a band is BAND_HEIGHT tall
   * and the whole mine wide", so keeping that width as a fixed reference is what
   * makes those numbers go on meaning what they meant. */
  var SP = A.SPACING;                 // 21 — cell pitch, also the carve pitch
  var RATE_REF_W = 5200;              // the width mines.js quoted its rates at

  /* JITTER — how far a deposit may wander inside its own cell, as a fraction
   * of SP. Both axes MUST stay < 0.5 or a deposit crosses into the neighbouring
   * cell and markDestroyed() carves the wrong hole.
   *
   * THE X BUDGET IS SHARED WITH THE STAGGER, AND THAT IS WHAT MAKES A COLUMN
   * BOUNDARY A LEGAL DESPAWN CUT. A deposit of column cx sits at
   *     x0 + (cx + 0.5)*SP  +- STAGGER*SP  +- JITTER_X*SP
   * so it stays strictly inside the pure column slab [x0+cx*SP, x0+(cx+1)*SP]
   * exactly while STAGGER + JITTER_X < 0.5. At 0.24 + 0.22 = 0.46 there are
   * 0.04*SP (0.84 units) of clearance on each side of every column boundary,
   * which is what lets trimTo() cut on colEdgeX() and know it took ALL of one
   * column and NONE of the next. Y has no stagger, so it keeps the full 0.30.
   * Raise either of these and the 2D window starts double-generating the
   * strips at its own edges. */
  var JITTER = 0.30;   // y jitter (no stagger to share the budget with)
  var JITTER_X = 0.22; // x jitter; STAGGER + JITTER_X must stay < 0.5
  var STAGGER = 0.24;  // rows alternate +-this*SP laterally: a hex-ish packing
                       // that stops the field reading as graph paper. Kept
                       // symmetric (not the classic 0/+0.5) so neither wall
                       // gets a repeating gap on alternate rows.
  var RAD_GAIN = SP / 19.0;   // deposits grow with the coarser adventure pitch
                              // so the ground still closes up. particles.js
                              // clamps to SPRITE_MAX_RADIUS (11) for us.

  /* --- the streamed window -------------------------------------------- */
  var DEBRIS_RESERVE = 700;    // pool slots always kept free for live debris
  var FILL_ESTIMATE = 0.99;    // fraction of cells that produce a deposit.
                               // MEASURED, per layer, over the whole shipped
                               // catalogue: 0.79 in the barren deep floors,
                               // 0.89 where caverns and drifts punch holes,
                               // and 0.96-0.98 in solid granite and obsidian.
                               // The number that matters is the WORST case, so
                               // this is near 1: erring high only costs slab
                               // height, which the headlight hides, while
                               // erring low overshoots SOLID_BUDGET and makes
                               // the adaptive trim do work it should not have
                               // to. At 0.94 the peak measured 5275 against a
                               // 5200 budget; at 0.99 it stays under.
  var BUDGET_EASE = 0.99;      // start trimming at this fraction of the budget.
                               // generateStrip() is the HARD cap and cannot be
                               // crossed; this is only there to stop the window
                               // sitting against that cap and losing a strip at
                               // one edge every few steps, so it wants to be
                               // close to 1 — trimming early just throws away
                               // window nobody asked for.
  var WINDOW_MIN_HALF = 380;   // never stream a window smaller than this, on
                               // either axis, whatever the budget says
  var WINDOW_BIAS = 0.45;      // how far off centre the camera may drag the
                               // window, as a fraction of its half-extent, per
                               // axis. The machine can therefore never leave
                               // its own terrain.

  /* THE HASH-ALIAS CEILING. particles.js wraps its spatial hash every
   * GRID_COLS*GRID_CELL = 2944 units in x and GRID_ROWS*GRID_CELL = 5888 in y.
   * Two live particles that far apart share a hash cell and collide with each
   * other at a distance. These bound the KEEP rect (trimTo), which is the
   * outermost thing that can hold a live particle, so they are the real
   * guarantee — not just a window size. 5% of margin under the wrap. */
  var WIN_MAX_W = 2800;
  var WIN_MAX_H = 5600;

  /* Loose debris — and dumped-cargo heaps, which ARE loose particles — is spared
   * inside this much slack around the solid window, and freed outside it. Ore
   * you are standing next to is your property; ore a screen away has been
   * abandoned, and the pile system already knows how to bring an abandoned heap
   * back (releasePilesOutside -> plUp = 0 -> spawnReadyPiles). Freeing it is
   * also what stops one dumped heap 4000 units away from aliasing into the
   * machine's own hash cells. */
  var LOOSE_KEEP_PAD = 360;

  var CELLS_PER_STEP = 560;    // generation budget per step while playing. One
                               // edge strip is ~60-90 cells, so this is 6-9
                               // strips = 126-190 world units of edge advance
                               // per step against a machine that moves ~4.
  var DESPAWN_INTERVAL = 5;    // sweep the active list every N steps
  var TRIM_MIN = 0.55;         // hard floor on the adaptive window shrink
  var TRIM_DOWN = 0.02;        // per-step shrink while over budget
  var TRIM_UP = 0.004;         // per-step recovery once back under

  /* --- LEVELS AS ENDLESS MAPS: THE CEILING, THE DOORS -------------------
   * ARCHITECTURE.md §7. Each level is ITS OWN MAP. The map is UNBOUNDED east,
   * west and south; the ONE boundary anywhere in the game is the bedrock ceiling
   * just north of that level's lift. Fuel is what stops the player, not rock.
   *
   * A LEVEL IS NOT A Y-BAND ANY MORE, it is a whole coordinate space of its own,
   * distinguished by genSeed (see setLevel). That is what makes the levels-as-maps
   * contract true without any rock enforcing it: you cannot dig from level 1's map
   * into level 2's because level 2 is not there — its geology is a different hash
   * of the same coordinates, reachable only by riding the lift. It is also what
   * lets the carve store be keyed on (level, chunkX, chunkY) and stay sparse.
   *
   * THE LIFT SITS AT THAT LEVEL'S CATALOGUE DEPTH, in ABSOLUTE y, and depth is
   * reported absolutely everywhere — the HUD gauge, the depth ruler, the red board
   * on the doors. So level 3's lift reads 300 m and a kilometre south of it reads
   * 1300 m, which is the only reading under which those three agree with each
   * other and with js/adv.js's depthM (see ARCHITECTURE.md §0).
   * ------------------------------------------------------------------ */

  /* THE CEILING IS COUNTED IN CELLS, NOT IN WORLD UNITS, and that is what makes
   * it exact. A border expressed as "y < top + 105" has to be tested against a
   * deposit's JITTERED position and lands mid-row; a border expressed as "the
   * first five ROWS of the map" is an integer compare, is decided before any
   * position is computed, and coincides EXACTLY with the streaming clamp — the
   * outermost resident row of a level IS its ceiling. It is also what lets
   * markDestroyed() refuse a ceiling cell in one integer compare.
   *
   * FIVE CELLS (105 units), up from the three the four-sided seal used. It is the
   * only wall left in the world, so it has to read as a deliberate edge rather
   * than as a line — five cells is about a third of the machine's own length and
   * is unmistakable at every camera scale this mode uses. The cut box is clipped
   * in js/vehicle.js so it is never chewed, and it does not need to be thick
   * enough to survive a tier-5 bit — see THE SEAL TRUTHS in ARCHITECTURE.md §7. */
  var SEAL_ROWS = 5;

  /* --- THE DOOR CHAMBER, AND WHY IT IS THIS SIZE -----------------------
   * The lift is BIG CLOSED DOORS at the band's top centre, in the back wall of
   * an excavated chamber — the mouth chamber's descendant, squared off into a
   * room the way the old station rooms were, and symmetric now, because a level's
   * lift is in the middle of its map and the workings run both ways from it.
   *
   * EVERY NUMBER HERE IS SET BY THE MACHINE, NOT BY TASTE, and the failure mode
   * if they are not is the one ELEV_INSET documented at length before it: a
   * maxed rig parked half inside rock, or parked outside the boarding circle it
   * arrived to use. The rig that matters is the biggest one the workshop sells —
   * advRadius() 438.7, i.e. 79 units of chassis and 360 of ore bed behind it.
   *
   *   the chamber is 800 TALL (2 * DOOR_RY) because the machine has to fit in it
   *   TWICE OVER: parked below the threshold facing down (438.7 of ore bed
   *   trailing UP behind it) and then driven UP INTO the doorway, which is the
   *   owner's refinement — entering the lift is a manoeuvre, not a keypress. Park
   *   at ceiling + 600 leaves the tail 162 clear of the ceiling and the bit 69
   *   clear of the floor. The manoeuvre itself starts 16 units above that park
   *   (DOOR_CATCH) and ends at ceiling + 410, the cage's own park — by which
   *   point the machine is at alpha 0, so the ore bed hanging past the chamber
   *   floor from there is not something that can be on screen.
   *   it is 1280 WIDE (2 * DOOR_HW) so the whole EXIT_RADIUS boarding circle, and
   *   the hull at any heading inside it, is in the excavation.
   *   the DOORS are 470 x 430, wider than the widest hull and taller than the
   *   machine is long: they have to read as something the machine could drive
   *   into, because that is exactly what riding the lift now is.
   *
   * AND THE THRESHOLD IS WHAT getDoorY() PUBLISHES, not the leaves' centre. The
   * boarding circle (ADV.EXIT_RADIUS) and vehicle.js's park are both measured from
   * it, because the place you stand to use a lift is its doorstep — measuring from
   * the middle of the leaves instead would put the park 295 units out and hand
   * js/adv.js a machine that arrives at a door it cannot board.
   * ------------------------------------------------------------------ */
  var DOOR_HW = 640;           // chamber half-width
  var DOOR_RY = 400;           // chamber half-height
  var DOOR_W = 470;            // the door opening, full width
  var DOOR_H = 430;            // ...and its height
  var DOOR_TOP = 100;          // the lintel, below the chamber ceiling
  var DOOR_BULK = 440;         // half-width of the steel bulkhead they sit in
  var DOOR_JAMB = 26;          // the frame's own thickness
  /* THE INTERIOR — the box that means YOU ARE IN THE LIFT.
   *
   * Inset from the opening on all four sides, and the bottom inset is the one that
   * matters: the machine parks 116 units BELOW it, so being in the lift is
   * something the player did on purpose and can never be something that happened
   * to them while arriving. js/adv.js's isInLift() is this test and nothing else,
   * so the geometry has exactly one owner. */
  var DOOR_IN_PAD_X = 70;      // ...from each jamb
  var DOOR_IN_TOP = 30;        // ...below the lintel
  var DOOR_IN_BOT = 46;        // ...above the threshold
  /* THE CATCH — where the DOORWAY TAKES THE MACHINE OFF THE PLAYER.
   *
   * The interior box above is the answer to "is the machine IN the lift". It is
   * not the answer to "has the machine started to go in", and the difference is
   * the whole of js/adv.js's docking manoeuvre: at the interior line the machine
   * is ALREADY at alpha 0 (see DOOR_FADE_H below — the two lines are 100 units
   * apart by construction), so a takeover that began there would have nothing
   * left to show and would read as the hard cut it is meant to replace.
   *
   * So the catch line is DOOR_CATCH further out, and it is set OUTSIDE the fade's
   * own outer edge (DOOR_FADE_DEEP below) rather than on it: the 40 units between
   * the two are a stretch where the machine is being driven by the lift and is
   * still FULLY DRAWN, which is the frame that says "it is going IN" more clearly
   * than any part of the move that follows it. The rest of the drive is the fade,
   * and the fade is what says "it has gone in".
   *
   * THE PARK IS 16 UNITS OUTSIDE THIS LINE (js/vehicle.js's ADV_SPAWN_Y, 70 below
   * the doorstep, against a catch at 54). That is the margin that keeps a machine
   * which has just rolled out from being caught again before it has moved — and
   * it does not need to be bigger, because the roll-out leaves it stopped and
   * FACING DOWN: reaching the catch again means deliberately turning round and
   * driving at the doors, which is exactly the input that should dock you. */
  var DOOR_CATCH = 100;
  /* AND THE MACHINE SINKS IN RATHER THAN POPPING OUT OF EXISTENCE.
   *
   * The machine is about 560 units long (121 of bit ahead of centre, 438.7 of ore
   * bed behind it) and the doorway is 430 tall, so there is NO position at which
   * the whole machine is inside the opening — whatever line "inside" is drawn at,
   * a few hundred units of ore bed is still hanging out of the door on the frame
   * it disappears. Screenshotted, that is exactly the pop it sounds like.
   *
   * So 100 units of the way in are a FADE, and js/vehicle.js multiplies the
   * machine's alpha by getDoorFade(). By the time the lift has finished parking
   * the machine, alpha is already 0 — so "nothing is drawn while in the lift"
   * stays strictly true AND nothing vanishes. It is also the cheapest possible
   * version: one globalAlpha on a transform that was already being built.
   * DOOR_FADE_DEEP below is where the ramp ends and why it is not the same line
   * the interior box is drawn at any more.
   *
   * FADE_X is the lateral ramp, so a machine driving PAST the doorway on its way
   * somewhere else does not flicker as it crosses the door's x range. */
  var DOOR_FADE_H = 100;
  var DOOR_FADE_X = 90;
  /* HOW FAR PAST THE INTERIOR LINE THE FADE FINISHES.
   *
   * It used to finish exactly ON that line, because the line was where the
   * machine stopped existing: cross it and js/vehicle.js drew nothing, so alpha
   * had to be zero by then and there was nowhere further to put it.
   *
   * The docking manoeuvre moved the vanishing point. Being in the lift is now a
   * flag the manoeuvre sets when it has finished PARKING the machine, deeper in
   * (js/vehicle.js's ADV_DOCK_Y), so there are 74 more units of travel to spend
   * and the ramp is no longer pinned to the line. Spending 40 of them buys the
   * one thing the manoeuvre exists for: a stretch at the start of the drive-in
   * where the machine is FULLY DRAWN and unmistakably moving into the doorway,
   * rather than one that begins dissolving on the frame control is taken. Alpha
   * still reaches 0 well before the machine is parked, so "nothing is drawn while
   * in the lift" is as strictly true as it was.
   *
   * MEASURED against the leaves, because they are the other thing moving: at the
   * frame the doors begin to close the machine is at ~50% and 34 units of clear
   * air either side of the nearest leaf edge; it is at zero by the time they are
   * a sixth shut. The machine is drawn OVER the panels (geometry pass, then the
   * vehicle), so any overlap would read as driving in FRONT of a closing door —
   * this is the number that keeps that from ever being on screen. */
  var DOOR_FADE_DEEP = 40;
  /* PROXIMITY OPENS THEM, and the ramp is not decoration: a door that snapped
   * would read as a trigger, and the whole point of putting the lift in the
   * world is that walking up to it is a physical act. NEAR is a little outside
   * ADV.EXIT_RADIUS (200) so they are fully open by the time adv.js will let the
   * player board, and FAR is about a screen away at this mode's zoom. */
  var DOOR_NEAR = 250;
  var DOOR_FAR = 1000;
  var DOOR_LERP = 3.4;         // e-folds/sec of the open/close ramp
  /* AND THEY SHUT AGAIN ONCE YOU ARE INSIDE, which is the owner's shot: a closed
   * lift with the machine in it. The same ramp runs backwards, so the leaves
   * visibly travel across the machine's last frames rather than blinking shut. */
  var DOOR_SHUT_LERP = 2.6;
  /* THE HEAD OVERLAY — how the doorway gets IN FRONT of the machine.
   *
   * The threshold plate and the lintel beam are re-drawn in the EMISSIVE pass,
   * which runs after the vehicle, so during the transit frames the machine sinks
   * BEHIND the structure instead of sliding over a picture of it. Alpha ramps with
   * proximity for one specific reason: that pass is not darkened, so an overlay
   * drawn from across the level would be a bar of lit steel floating in the black.
   * By NEAR the machine's own headlight (380 at the cheapest tier) already covers
   * the whole chamber, so the overlay and the geometry underneath it match. */
  var HEAD_FAR = 620;
  var HEAD_NEAR = 340;
  /* WHERE THE RED BOARD HANGS: hard against the west jamb, at head height.
   *
   * NOT ABOVE THE DOORS, and that is forced. The board is drawn in the EMISSIVE
   * pass (renderLit, after effects.renderDarkness) which is also after the
   * vehicle, so anything the board overlaps it draws ON TOP OF. The parked
   * machine's ore bed reaches 438 units up from the park, i.e. to within 62 of
   * the chamber ceiling on the door's own centre line — there is no height above
   * the lintel that is not behind the machine. Beside the frame there is: the
   * hull is 150 half-wide and the jamb is at 230, so a board hung outboard of
   * that is never covered, and it is where a level indicator is bolted anyway. */
  var BOARD_GAP = 22;          // between the west jamb and the board's east edge
  var BOARD_RISE = 34;         // the board's top, below the chamber ceiling

  /* --- structure grids -----------------------------------------------
   * Every structure family owns a grid of cells; a cell either contains one
   * structure or does not, decided by one hash of its integer index. That is
   * the whole determinism story: no seeding order, no lookahead, no pruning.
   * ------------------------------------------------------------------ */
  var BAND_REF = C.BAND_HEIGHT;      // 90 — the "band" mines.js states rates in

  var POCKET_W = 300, POCKET_H = 240;
  var POCKET_MIN_R = 46, POCKET_MAX_R = 128;
  var POCKET_BIG = 0.16;             // chance a pocket is a big lens instead
  var POCKET_BIG_R = 210;

  var CAVERN_W = 620, CAVERN_H = 520;
  var CAVERN_MIN_R = 105, CAVERN_MAX_R = 235;
  var CAVERN_MINERAL = 0.30;         // chance a cavern's wall carries ore
  var CAVERN_SHELL = [1.14, 1.34];   // squared-t range of a mineralised shell
  var RUBBLE_FLOOR = 0.42;           // spoil density on a cavern floor

  /* MOTHERLODES AND OLD WORKINGS ARE ON A 2D GRID, NOT A LADDER.
   * Both used to own one candidate per vertical block, placed anywhere across
   * the shaft — which was right when the shaft was 1760 wide, i.e. about one
   * candidate wide. In an ENDLESS map that ladder is simply meaningless: there
   * is no width to spread one candidate across. So both grids have an X pitch,
   * sized at the ORIGINAL shaft width, and the field tiles outward forever at
   * that density. This is the same areal-density-invariance perCell() gives
   * pockets and caverns, and it is what makes driving east for ten minutes feel
   * like the same mine rather than like running out of world. */
  var LODE_W = 1760;                 // one motherlode slot per 176 m across
  var LODE_H = 1500;                 // ...and per 150 m of depth
  var LODE_RX = [190, 330];
  var LODE_RY = [140, 250];
  var LODE_SHELL = [1.40, 1.72];     // the glittering wall, as squared-t
  var HALO_T = 3.4;                  // stringers reach this far out (in t)
  var HALO_MAX = 0.22;               // stringer density at the shell wall
  var LODE_ANNOUNCE = 760;           // world units at which `mine:lode` fires
  /* EVERY LEVEL GETS ONE GUARANTEED MOTHERLODE, near its own lift, and that is a
   * change forced by the geometry: the guarantee used to be "one per mine, in the
   * lowest 20-140 m of its stated depth", which was a promise about a BOTTOM. An
   * endless map has no bottom, so the promise is re-cut as one about the LIFT —
   * drive south from where you arrive and there is one waiting.
   *
   * It sits GLD_DEPTH_U below the ceiling (plus a hashed spread) and within
   * GLD_X of the centre line the doors are on, because it is the payoff for
   * committing to a direction and a headline formation 2400 units off to one side
   * is not a reward, it is a lottery. Rolled lodes are free to be anywhere. */
  var GLD_DEPTH_U = 3200;            // ~320 m south of the lift... (was 1900:
                                     // at ~200 m the headline lode was a doorstep
                                     // find — the owner hit silver "way too
                                     // quickly". It should cost a committed drive.)
  var GLD_SPREAD_U = 2400;           // ...plus up to this much again, hashed
  var GLD_X = 1150;

  /* ANCIENT DEBRIS — the rare find (js/mines.js design note 4e).
   *
   * ITS OWN STRUCTURE FAMILY, NOT AN ORE WEIGHT. A pocket picks one material for
   * the whole blob, so an 'ancient' entry in the lottery means "one pocket in two
   * thousand is forty deposits of the richest material in the game": a slot
   * machine, not a discovery. A debris scatter is a handful of cells in a tight
   * cluster — findable, scannable as its own contact, bounded in payout, and
   * priced per LEVEL rather than per depth.
   *
   * The grid is coarse (220 m square) because the RATE is what makes it rare and
   * a fine grid with a tiny probability wastes a gather on every row. Cluster
   * radius is small on purpose: this is debris in the rock, not a seam, and the
   * whole cluster must fit inside one bite of a good drill so finding it and
   * taking it are the same moment. */
  var DEB_W = 2200, DEB_H = 2200;
  var DEB_R = [24, 40];              // cluster radius, world units
  var DEB_FILL = [0.55, 0.90];       // fraction of the cells inside it that take
  var DEB_MAXN = 4;                  // scratch slots per gathered row

  var DRIFT_W = 1760;                // one old-workings slot per 176 m across
  var DRIFT_H = 780;                 // ...and per 78 m of depth
  var DRIFT_MIN_W = 420, DRIFT_MAX_W = 1500;
  var DRIFT_WINZE = 0.45;            // chance a drift also sinks a winze
  var DRIFT_TIMBER_PITCH = 96;       // spacing of timber sets, for render()

  var SEAM_PITCH = 168;              // one candidate ore bed per 16.8 m
  var SEAM_WARP = 34;                // how far a seam's centre line wanders
  var SEAM_WARP_F = 0.0026;          // ...and how quickly, per world unit
  var SEAM_LENS_F = 0.0034;          // pinch-and-swell frequency along x

  var BED_PITCH = 58;                // country-rock bed thickness (base)
  var BED_WARP = 30;                 // how far a bed boundary undulates
  var BED_WARP_F = 0.0021;
  var BED_SPECK = 0.055;             // nodules of a different bed inside a bed

  /* --- THE SPARSE CARVE STORE ----------------------------------------
   * One BIT per generation cell, in 32x32-cell chunks, allocated only when
   * something inside one is actually dug. See constraint 2 in the header.
   *
   * WHY 32. A chunk covers 672 x 672 world units, which is about a third of a
   * screen at this mode's zoom, so a machine working one spot touches ONE chunk
   * for seconds at a time and markDestroyed()'s single-entry cache hits almost
   * every call. It is also exactly 128 bytes, which keeps the per-chunk RLE the
   * save codec writes short enough to be worth doing (~70 characters for a chunk
   * with a tunnel through it).
   *
   * MAX_CHUNKS IS A CEILING ON A SESSION'S HISTORY, not on the world. A chunk is
   * 451 584 square units and a machine cuts a corridor about 300 units wide, so
   * an hour of driving at 200 u/s over ground it has NEVER seen before touches
   * roughly 480 chunks. 4096 is therefore about eight and a half hours of
   * genuinely novel driving in one mine, and real play backtracks constantly. If
   * it is ever hit the store stops recording new chunks — tunnels stop
   * persisting, nothing corrupts, and getDebug().chunkFull says so. */
  var CHUNK_BITS = 5;
  var CHUNK = 1 << CHUNK_BITS;            // 32 cells per side
  var CHUNK_MASK = CHUNK - 1;
  var CHUNK_BYTES = (CHUNK * CHUNK) >> 3; // 128
  var MAX_CHUNKS = 4096;
  /* Chunk coordinates are packed into ONE number so the map can be keyed on an
   * integer instead of a built string — markDestroyed() must not allocate. The
   * bias makes negatives non-negative and the shifts are done with multiplies
   * because they exceed 32 bits; the whole key stays under 2^47, comfortably
   * inside a double's exact integer range. +-2^20 chunks is +-704 million world
   * units, which no tank in the workshop can reach. */
  var CK_BIAS = 1 << 20;
  var CK_SPAN = 1 << 21;
  var CK_LEVEL = CK_SPAN * CK_SPAN;       // 2^42

  /* --- hash salts ----------------------------------------------------
   * Odd 32-bit constants. Every independent decision gets its own salt so two
   * unrelated questions asked about the same cell can never correlate.
   * ------------------------------------------------------------------ */
  var S_JX = 0x1f83d9ab | 0, S_JY = 0x5be0cd19 | 0;
  var S_BED = 0x428a2f98 | 0, S_BEDM = 0x71374491 | 0, S_SPECK = 0xb5c0fbcf | 0;
  var S_POCK = 0xe9b5dba5 | 0, S_POCKM = 0x3956c25b | 0, S_RIM = 0x59f111f1 | 0;
  var S_CAV = 0x923f82a4 | 0, S_CAVM = 0xab1c5ed5 | 0;
  var S_LODE = 0xd807aa98 | 0, S_LODEM = 0x12835b01 | 0;
  var S_DRIFT = 0x243185be | 0, S_SEAM = 0x550c7dc3 | 0, S_SEAMM = 0x72be5d74 | 0;
  var S_HALO = 0x80deb1fe | 0, S_FLOOR = 0x9bdc06a7 | 0;
  /* THE LEVEL SALT. genSeed = h3(mineSeed, S_LEVEL, k) is what makes each level
   * its own world rather than the same rock at a different depth — see the note
   * by SEAL_ROWS for why that IS the levels-as-maps guarantee now. */
  var S_LEVEL = 0xc67178f2 | 0;
  /* THE COMPANY SALT. Folds js/save.js's per-company worldSeed into mineSeed in
   * beginMine(), so two companies dig two different Old Creeks. 0 = legacy
   * record = no fold, which is what keeps every pre-existing tunnel valid. */
  var S_WORLD = 0x51ed5eed | 0;
  var S_DEB = 0xa2bfe8a1 | 0, S_DEBC = 0x06ca6351 | 0;

  /* ================================================================== */

  /* ----- module state ------------------------------------------------
   * TWO FLAGS, NOT ONE, and the difference was a bug found in testing.
   *
   *   active  a run is live: generate, stream, and mark the carve mask.
   *   loaded  a mine's geology is RESOLVED and can still be drawn.
   *
   * endMine() clears `active` and keeps `loaded`, because adventure mode keeps
   * rendering the world behind its meta screens (ARCHITECTURE.md §3: "the world
   * still renders behind the map; time does not pass"). With one flag, the
   * frame the player was extracted on, terrain.js fell back to its CLASSIC
   * background — bedrock lane walls, classic depth ruler and a "SURFACE CUT"
   * zone banner painted across the mine, behind the extraction card. `loaded`
   * is what keeps the mine on screen until the campaign itself is closed.
   * ------------------------------------------------------------------ */
  var active = false;
  var loaded = false;
  var mineDef = null;             // the SM.mines record, or null (default profile)
  var mineStateRef = null;        // the save record's per-mine object, or null
  var mineSeed = 1337 | 0;
  /* THE GENERATION SEED OF THE ACTIVE LEVEL. Every hv() in this file goes
   * through it, so switching level switches world. Set by setLevel(). */
  var genSeed = 1337 | 0;
  /* The catalogue's stated depth. Not a bound any more — nothing ends at it —
   * but it is still what the level ladder's lift depths are cut out of, and it
   * is the honest answer to "how deep is this mine" on the map card. */
  var mineDepthM = 400;
  var layers = [];
  var deepestY = 0;

  /* ----- the generation grid ------------------------------------------
   * Unbounded. Cell (0, 0)'s top-left corner is (x0, y0); x0 is half a cell west
   * of the centre line so column 0 is CENTRED on x = 0, which is the line the
   * lift's doors and the guaranteed motherlode are both measured from. */
  var x0 = -SP * 0.5, y0 = 0;
  var carved = 0;                 // how many cells are marked, this mine

  /* ----- the streamed window -------------------------------------------
   * TWO RECTANGLES IN CELL SPACE, and the difference between them is the whole
   * streaming state machine:
   *   have*   what is GENERATED right now. Always a full rectangle: every grow
   *           step fills one complete edge strip across the other axis's current
   *           extent, so "resident" never means "resident with holes in it".
   *   want*   what the camera would like, from computeWindow().
   * The fill loop walks have -> want one strip at a time, nearest edge first;
   * the sweep trims have back to want. Because both are integer CELL rectangles
   * every despawn cut lands on an exact cell boundary — see the header.
   * ------------------------------------------------------------------ */
  var haveN = false;              // is there a resident rectangle at all?
  var haveC0 = 0, haveC1 = 0;     // resident columns, [C0, C1)
  var haveR0 = 0, haveR1 = 0;     // resident rows, [R0, R1)
  var wantC0 = 0, wantC1 = 0, wantR0 = 0, wantR1 = 0;
  var winL = 0, winR = 0, winTop = 0, winBot = 0;   // the window in world units
  var cellBudget = 5200;          // cells the pool can afford, before trim
  var trim = 1;                   // adaptive shrink, 1 = full budget
  var sweepTick = 0;
  var peakSolid = 0, lowFree = 1e9;
  var peakWinW = 0, peakWinH = 0; // measured window extent, for the hash audit
  var peakLiveW = 0, peakLiveH = 0;

  /* ----- THE ACTIVE LEVEL: the band, the seal and the doors -------------
   * `bands` is the whole ladder for the loaded mine, shallowest first, resolved
   * once in beginMine() from js/mines.js's levelsOf() and FEATURE-DETECTED —
   * until that table is re-cut to state bands, they are synthesised from the
   * layer table so this file is correct and testable on its own.
   *
   * Exactly ONE of them is active at a time. bandR0/bandR1 and bandC0/bandC1 are
   * that band as an integer CELL rectangle, and everything downstream — the
   * streaming clamp, the seal test, markDestroyed()'s refusal, the render's four
   * walls — is expressed in those four numbers and nothing else, so a ride is
   * one call to setBand() and no arithmetic anywhere else.
   *
   * lvl* is the PLAYABLE VOID inside the seal, which is what getLevelBounds()
   * publishes and what js/vehicle.js and js/camera.js clamp against.
   * ------------------------------------------------------------------ */
  var bands = [];                 // [{i, name, topM}], live mine
  var bandN = 0;                  // active level index, 1-based (0 = none)
  var bandR0 = 0;                 // the map's first row — the ceiling starts here
  var bandTopY = 0;               // ...as a world y, on an exact cell line
  var lvlTopY = 0;                // the void below the ceiling: getLevelBounds()
  var needFill = false;           // a level change owes us one full re-fill
  /* THE ACTIVE LEVEL'S SPAWN RECORD (js/mines.js levelSpawnOf) resolved into the
   * shape buildLayer() produces: ONE stratum for the whole endless map, plus the
   * baked ore-weight buckets the southward whisper is quantised into. */
  var lvl = null;

  /* THE DOORS. Geometry derived from the band in setBand(); `doorOpen` is the
   * only animated state in this file and it is driven by machine proximity in
   * update(), not by an event — see DOOR_NEAR — EXCEPT while js/adv.js is docking
   * or undocking the machine, which borrows the leaves through setDoorHold()
   * because that manoeuvre is about ordering and proximity has no opinion about
   * order. `doorArt` is the red level board, baked by readoutFor() the way a
   * station's board was. */
  var doorCeilY = 0;              // the chamber's ceiling = the seal's inner face
  var doorCY = 0;                 // the chamber's centre
  var doorTopY = 0;               // the lintel
  var doorMidY = 0;               // the leaves' own centre (art only)
  var doorSillY = 0;              // the THRESHOLD — what getDoorY() publishes
  var doorY = 0;                  // = doorSillY. Named for the getter it feeds.
  var doorOpen = 0;               // 0 shut .. 1 wide open
  var doorHeld = false;           // ...and the lift, not proximity, is setting it
  var doorArt = null;
  var doorFlick = 1;              // last geometry-pass flicker, for renderLit()
  var headMix = 0;                // 0..1, the DISTANCE half of the head overlay
                                  // (the other half is the machine's own fade —
                                  // see headOcclusion(), which multiplies them)

  /* ----- focus override (diagnostics / scripted tests) ---------------- */
  var focusOn = false, focusFX = 0, focusFY = 0;

  /* ----- cached material indices -------------------------------------- */
  var M_DIRT = 0, M_STONE = 1, M_RUBBLE = 7, M_GRANITE = 8, M_BEDROCK = 0;

  /* ----- reused event payloads ---------------------------------------- */
  var evLayer = { name: '', depthM: 0 };
  var evLode = { x: 0, y: 0, matIndex: 0, dist: 0 };

  /* ======================================================================
   * HASHING — the entire source of randomness in this file
   * =================================================================== */

  /**
   * Stateless 32-bit hash of three integers. Math.imul throughout: the naive
   * `a * 374761393` overflows the 53-bit float mantissa for any a past 2^24
   * and quietly stops being a hash.
   */
  function h3(a, b, c) {
    var n = Math.imul(a | 0, 0x27d4eb2d) ^
            Math.imul(b | 0, 0x165667b1) ^
            Math.imul(c | 0, 0x9e3779b1);
    n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
    n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
    return (n ^ (n >>> 16)) >>> 0;
  }

  /**
   * Hash -> 0..1, salted and tied to the ACTIVE LEVEL's generation seed.
   *
   * `genSeed`, not `mineSeed`, and that one word is the levels-as-maps contract:
   * every structure, every jitter and every bed on level 2 is a different hash of
   * the same coordinates than it is on level 1, so the two maps genuinely are two
   * worlds rather than two windows onto one. Nothing enforces the separation
   * because nothing has to — the other level is not in this coordinate space.
   * setBand() is the only writer.
   */
  function hv(salt, a, b) { return h3(genSeed ^ salt, a, b) / 4294967296; }

  /** Smooth 1D value noise, 0..1. Used for every warp and every taper. */
  function noise1(t, salt) {
    var i0 = Math.floor(t);
    var f = t - i0;
    var a = hv(salt, i0, 0), b = hv(salt, i0 + 1, 0);
    var s = f * f * (3 - 2 * f);
    return a + (b - a) * s;
  }
  /** Same, mapped to -1..1. */
  function noise1s(t, salt) { return noise1(t, salt) * 2 - 1; }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /* ======================================================================
   * CELL <-> WORLD
   * The grid is anchored to the MINE and is UNBOUNDED in both axes. Column 0 is
   * centred on x = 0 (the lift's line) and row 0 is the surface row; every index
   * either side of those is as ordinary as any other.
   * =================================================================== */

  function buildGrid() {
    x0 = -SP * 0.5;
    y0 = A.MINE_CEILING_Y;
    // How many CELLS the pool can hold, which is what a 2D window is sized
    // against. Cells, not deposits: FILL_ESTIMATE is the conversion.
    cellBudget = A.SOLID_BUDGET / FILL_ESTIMATE;
  }

  /** Lateral offset of row `cy` — the alternating hex-ish stagger. */
  function rowStagger(cy) { return (cy & 1) ? SP * STAGGER : -SP * STAGGER; }

  /** World y of the TOP edge of row cy. The despawn lines snap to these. */
  function rowTopY(cy) { return y0 + cy * SP; }
  /** World y of the centre of row cy, before jitter. */
  function rowMidY(cy) { return y0 + (cy + 0.5) * SP; }

  /** Row containing world y. */
  function cellYOf(y) { return Math.floor((y - y0) / SP); }
  /** Column containing world x, on row cy. */
  function cellXOf(x, cy) { return Math.floor((x - rowStagger(cy) - x0) / SP); }

  /* THE TWO X MAPPINGS, AND WHY THERE ARE TWO.
   *
   * cellXOf(x, cy) answers "which cell did this DEPOSIT come from", so it has
   * to undo the row's stagger — that is what makes markDestroyed() carve the
   * hole the player actually drilled.
   *
   * colEdgeX(cx) / colOfX(x) answer "where is the boundary between column cx-1
   * and column cx", which must be the SAME LINE on every row or a despawn cut
   * could not separate two columns cleanly on all of them at once. That line is
   * the un-staggered lattice, and STAGGER + JITTER_X < 0.5 is precisely the
   * condition that every deposit of column cx lies strictly between
   * colEdgeX(cx) and colEdgeX(cx + 1) whatever its row parity. */
  function colEdgeX(cx) { return x0 + cx * SP; }
  function colOfX(x) { return Math.floor((x - x0) / SP); }

  /* ======================================================================
   * THE SPARSE CARVE STORE
   * ---------------------------------------------------------------------
   * PERSIST ONLY THE SEEN PATH. A level map is endless, so the old flat byte
   * array — one byte per cell of a finite mine — has nothing to be sized
   * against. What is finite is what the player has actually DUG, so that is what
   * is stored: 32x32-cell chunks of one bit per cell, keyed on
   * (level, chunkX, chunkY), allocated the first time anything inside one breaks
   * and never allocated again.
   *
   * FOUR PARALLEL ARRAYS AND A Map, rather than a Map of objects: the arrays are
   * what the save codec walks (in insertion order, which is stable), and the Map
   * exists only to answer "do I already have this chunk" in O(1) without
   * building a string. Chunks are never removed while a mine is loaded — a
   * tunnel does not un-dig itself — so an index handed out here stays valid.
   * =================================================================== */

  var chunkIx = null;             // Map<packedKey, index into the arrays below>
  var chunkKey = null;            // Float64Array(MAX_CHUNKS) — the packed key
  var chunkLv = null;             // Int32Array — level
  var chunkCX = null, chunkCY = null;   // Int32Array — chunk coordinates
  var chunkData = null;           // Array of Uint8Array(CHUNK_BYTES)
  var chunkN = 0;
  var chunkFull = false;          // the ceiling was hit; see MAX_CHUNKS

  /* THE SINGLE-ENTRY CACHE. A cutter works one small rectangle of rock, so the
   * next mark is in the same chunk as the last one almost every time. These four
   * make that case three integer compares and no lookup at all. */
  var ccLv = -1, ccCX = 0, ccCY = 0, ccData = null;

  function allocCarve() {
    if (!chunkKey) {
      chunkIx = new Map();
      chunkKey = new Float64Array(MAX_CHUNKS);
      chunkLv = new Int32Array(MAX_CHUNKS);
      chunkCX = new Int32Array(MAX_CHUNKS);
      chunkCY = new Int32Array(MAX_CHUNKS);
      chunkData = new Array(MAX_CHUNKS);
    } else {
      chunkIx.clear();
    }
    chunkN = 0;
    chunkFull = false;
    carved = 0;
    ccLv = -1; ccData = null;
  }

  /** Pack (level, chunkX, chunkY) into one exact integer. See CK_BIAS. */
  function packKey(lv, cx, cy) {
    return lv * CK_LEVEL + (cy + CK_BIAS) * CK_SPAN + (cx + CK_BIAS);
  }

  /**
   * The chunk holding (level, cx, cy), creating it if `make`. -> Uint8Array or
   * null. NOT on the hottest path — markDestroyed's cache is — but still
   * allocation-free unless a chunk is genuinely new.
   */
  function chunkFor(lv, ccx, ccy, make) {
    var k = packKey(lv, ccx, ccy);
    var i = chunkIx.get(k);
    if (i !== undefined) return chunkData[i];
    if (!make) return null;
    if (chunkN >= MAX_CHUNKS) { chunkFull = true; return null; }
    i = chunkN++;
    chunkKey[i] = k;
    chunkLv[i] = lv; chunkCX[i] = ccx; chunkCY[i] = ccy;
    chunkData[i] = new Uint8Array(CHUNK_BYTES);
    chunkIx.set(k, i);
    return chunkData[i];
  }

  /**
   * Mark the cell containing (x, y) as dug out.
   *
   * HOT PATH: `material:destroyed` fires up to ~150 times per step. Integer
   * maths, a cached chunk, one bit set. No allocation, no strings, no events.
   *
   * IT REFUSES A CEILING CELL, and that is not belt-and-braces: the store is the
   * mine's whole history and it is saved, so one ceiling bit written by a tier-5
   * bit that got a shot at the border would be a permanent hole in the ONE wall
   * in the game — in a save file, in every future session. The generator already
   * refuses to read the store there (see generateRowStrip), so this is the second
   * of the two locks, and it is the cheap one: one integer compare.
   */
  function markDestroyed(x, y) {
    if (!active || !chunkIx) return;
    var cy = Math.floor((y - y0) / SP);
    if (cy < bandR0 + SEAL_ROWS) return;
    var cx = Math.floor((x - ((cy & 1) ? SP * STAGGER : -SP * STAGGER) - x0) / SP);
    var ccx = cx >> CHUNK_BITS, ccy = cy >> CHUNK_BITS;
    /* THE FAR EDGE OF THE ADDRESSABLE WORLD. Beyond +-CK_BIAS chunks the packed
     * key would wrap and one tunnel would be recorded on top of another, which is
     * the one failure mode of a sparse store that is worse than not having one.
     * So it FAILS SAFE: past that line nothing is recorded, tunnels stop
     * persisting, and nothing anywhere is corrupted. It is 704 million world
     * units — forty days of driving one direction at full speed — so this is a
     * guarantee about arithmetic, not a gameplay limit. */
    if (ccx <= -CK_BIAS || ccx >= CK_BIAS || ccy <= -CK_BIAS || ccy >= CK_BIAS) return;
    var d;
    if (ccLv === bandN && ccCX === ccx && ccCY === ccy) {
      d = ccData;
    } else {
      d = chunkFor(bandN, ccx, ccy, true);
      if (!d) return;
      ccLv = bandN; ccCX = ccx; ccCY = ccy; ccData = d;
    }
    var bit = ((cy & CHUNK_MASK) << CHUNK_BITS) | (cx & CHUNK_MASK);
    var byte = bit >> 3, m = 1 << (bit & 7);
    if (d[byte] & m) return;
    d[byte] |= m;
    carved++;
  }

  /** Is the cell (cx, cy) of the ACTIVE level dug out? Generation's question. */
  function carvedCell(cx, cy) {
    if (!chunkIx) return false;
    var ccx = cx >> CHUNK_BITS, ccy = cy >> CHUNK_BITS;
    var d;
    if (ccLv === bandN && ccCX === ccx && ccCY === ccy) d = ccData;
    else {
      d = chunkFor(bandN, ccx, ccy, false);
      if (!d) return false;
      ccLv = bandN; ccCX = ccx; ccCY = ccy; ccData = d;
    }
    var bit = ((cy & CHUNK_MASK) << CHUNK_BITS) | (cx & CHUNK_MASK);
    return (d[bit >> 3] & (1 << (bit & 7))) !== 0;
  }

  /** ...and the world-space form, for the scanner. */
  function isCarved(x, y) {
    if (!chunkIx) return false;
    var cy = cellYOf(y);
    return carvedCell(cellXOf(x, cy), cy);
  }

  /* THE SAVE SEAM. js/save.js owns the encoding and this module owns the store,
   * exactly as it was for the flat mask — only the shape crossing the seam
   * changed. The descriptor is REUSED and its typed arrays are the LIVE ones, so
   * the encoder must read it and let it go. */
  var carveOut = { count: 0, level: null, cx: null, cy: null, data: null,
                   chunkCells: CHUNK, chunkBytes: CHUNK_BYTES };
  function exportCarve() {
    if (!chunkIx) return null;
    carveOut.count = chunkN;
    carveOut.level = chunkLv;
    carveOut.cx = chunkCX;
    carveOut.cy = chunkCY;
    carveOut.data = chunkData;
    return carveOut;
  }

  /**
   * Adopt a decoded store. Refuses a chunk whose geometry is not ours rather
   * than reshaping it — a mis-shaped chunk would be tunnels in the wrong place,
   * which is worse than no tunnels (see js/save.js's codec note).
   */
  function importCarve(desc) {
    if (!chunkIx || !desc || !(desc.count > 0)) return false;
    if (desc.chunkCells && desc.chunkCells !== CHUNK) return false;
    var n = desc.count, i, j, d, src;
    if (n > MAX_CHUNKS) n = MAX_CHUNKS;
    for (i = 0; i < n; i++) {
      src = desc.data[i];
      if (!src || src.length !== CHUNK_BYTES) continue;
      d = chunkFor(desc.level[i] | 0, desc.cx[i] | 0, desc.cy[i] | 0, true);
      if (!d) break;
      d.set(src);
    }
    carved = 0;
    for (i = 0; i < chunkN; i++) {
      d = chunkData[i];
      for (j = 0; j < CHUNK_BYTES; j++) carved += POPCOUNT[d[j]];
    }
    ccLv = -1; ccData = null;
    return true;
  }

  /** Byte -> set bits. Built once; importCarve() is the only caller. */
  var POPCOUNT = (function () {
    var t = new Uint8Array(256);
    for (var i = 0; i < 256; i++) t[i] = (i & 1) + t[i >> 1];
    return t;
  })();

  var dimsOut = { spacing: 0, x0: 0, y0: 0, chunkCells: 0, chunkBytes: 0,
                  chunks: 0, carved: 0 };
  /** The store's geometry. js/save.js sanity-checks a decode against this. */
  function maskDims() {
    dimsOut.spacing = SP; dimsOut.x0 = x0; dimsOut.y0 = y0;
    dimsOut.chunkCells = CHUNK; dimsOut.chunkBytes = CHUNK_BYTES;
    dimsOut.chunks = chunkN; dimsOut.carved = carved;
    return dimsOut;
  }

  /* ======================================================================
   * THE ACTIVE LEVEL — the band, its seal, and its doors
   *
   * THE SEAM (ARCHITECTURE.md §7). js/mines.js states the ladder as BANDS —
   * {i, name, depthTopM, depthBotM, price, widthU} — and js/adv.js decides which
   * one the run is on and calls beginLevel(). This side of the seam does exactly
   * three things with that: resolves the table into world geometry once per mine,
   * activates one band, and publishes the playable box through getLevelBounds()
   * so js/vehicle.js and js/camera.js have ONE number each to clamp against.
   *
   * IT IS FEATURE-DETECTED, because js/mines.js is another agent's file: a table
   * without depthTopM is treated as absent and the bands are synthesised from the
   * layer table this module already has. That is not defensive decoration — it is
   * what lets this file be built and measured before the other side lands.
   *
   * NOTHING HERE IS EVER WRITTEN INTO THE CARVE MASK. Ownership and level choice
   * go in, geology comes out, no history in between — the same rule the shaft
   * used to follow, and still the reason a band met on the way down is identical
   * to the same band refilled from the side an hour later.
   * =================================================================== */

  /** Record one level. Rejects a nameless nothing rather than inventing one. */
  function pushBand(i, name, topM) {
    bands.push({ i: i, name: name || ('LEVEL ' + i), topM: topM });
  }

  /**
   * Resolve the whole ladder for the live mine, shallowest first. Called once by
   * beginMine(); a ride only ever calls setBand().
   *
   * A LEVEL IS NOW JUST A NAME AND A LIFT DEPTH. There is no width and no bottom
   * to resolve — the map runs east, west and south forever — so this table is
   * the shortest it has ever been.
   */
  function resolveBands(def) {
    bands.length = 0;
    var t = null;
    if (SM.mines && SM.mines.levelsOf) {
      try { t = SM.mines.levelsOf(def || mineDef); } catch (e) { t = null; }
    }
    var i, e;
    if (t && t.length && typeof t[0].depthTopM === 'number') {
      for (i = 0; i < t.length; i++) {
        e = t[i];
        if (!e) continue;
        pushBand(num(e.i, i + 1), e.name, num(e.depthTopM, 0));
      }
    } else {
      /* NO LEVEL TABLE. One level per layer, at that layer's top — which is the
       * same cut js/mines.js makes, so a build with either half missing plays
       * the same shape of world. */
      var src = (def && def.layers && def.layers.length) ? def.layers : DEFAULT_LAYERS;
      var from = 0;
      for (i = 0; i < src.length; i++) {
        pushBand(i + 1, src[i].name, from);
        from = num(src[i].toDepth, from);
      }
    }
    // A mine with no usable table at all is still one whole level, not a crash.
    if (!bands.length) pushBand(1, (def && def.name) || 'LEVEL 1', 0);
  }

  /**
   * ACTIVATE LEVEL L (1-based, clamped). Everything the rest of the file needs is
   * derived here and nowhere else.
   *
   * THE CEILING IS AN INTEGER CELL ROW FIRST and a world line second, and that
   * order is the whole trick: the row comes from cellYOf() and the world line is
   * read back off the lattice with rowTopY(), so the seal test, the streaming
   * clamp and the despawn cuts all land on the SAME line.
   *
   * AND THIS IS WHERE A LEVEL BECOMES A WORLD. genSeed folds the level index into
   * the mine seed before ANY geology is resolved, so buildLevel() below derives a
   * different set of structures for every level from the same coordinates. That
   * is the levels-as-maps guarantee: there is no rock between two levels because
   * there is no space between them — they are the same space, hashed differently,
   * and only the lift crosses.
   */
  function setBand(L) {
    var n = bands.length;
    if (!n) return false;
    var i = Math.floor(num(L, 1));
    if (!(i >= 1)) i = 1;
    if (i > n) i = n;
    var b = bands[i - 1];
    bandN = i;
    genSeed = h3(mineSeed, S_LEVEL, i) | 0;
    ccLv = -1; ccData = null;         // the carve cache is per level

    bandR0 = cellYOf(yOfDepth(b.topM));
    bandTopY = rowTopY(bandR0);
    // The playable void, BELOW the ceiling. This is getLevelBounds().topY.
    lvlTopY = rowTopY(bandR0 + SEAL_ROWS);

    // The stratum, its ore buckets and its guaranteed lode — all per level.
    buildLevel(i);

    /* THE DOORS, hung off the ceiling's inner face. The chamber's roof IS that
     * face, so the excavation can never eat into the border it hangs from
     * however the numbers above move. */
    doorCeilY = lvlTopY;
    doorCY = doorCeilY + DOOR_RY;
    doorTopY = doorCeilY + DOOR_TOP;
    doorSillY = doorTopY + DOOR_H;
    doorMidY = doorTopY + DOOR_H * 0.5;
    doorY = doorSillY;                 // the doorstep: see the DOOR_* note
    /* SHUT, because the cage has only just arrived and the machine is still in
     * it. js/adv.js opens a band by UNDOCKING — the leaves part, the machine
     * rolls out, and they close again behind it as it drives off — so the honest
     * starting frame is a closed door with someone behind it. (This used to open
     * at 1, from the build where a descent materialised the machine already
     * outside; nothing between here and the first step can see the difference,
     * because adv.js takes the leaves over in the same call.) */
    doorOpen = 0;
    doorHeld = false;
    /* The board quotes the DOORS' own depth rather than the level's stated one.
     * They differ by the seal and the lintel (about 5 m), and the number a sign
     * in the world shows has to agree with the DEPTH gauge standing under it —
     * which reads absolute y — not with the price list. It also means level 1's
     * board reads a depth instead of reading "-0 m". */
    doorArt = readoutFor(bandN, depthOfY(doorY), b.name, true);
    return true;
  }

  /**
   * RIDE TO A LEVEL — the only way between maps.
   *
   * Takes (mineDef, L) per the contract, and also plain (L), because the mine is
   * already loaded and the def is only ever used to re-resolve the ladder.
   *
   * IT DOES NOT REFILL HERE, DELIBERATELY. js/adv.js's order is beginLevel ->
   * parkAtDoor -> camera.reset, so a fill in this call would generate the new
   * band around the machine's OLD position and the next step would throw all of
   * it away again. So the resident set is freed (flushAll) and one full re-fill is
   * OWED (needFill): update() spends it at the parked position, through the same
   * jumped-window path a descent uses. One fill, in a frame the player is looking
   * at a transition in.
   */
  function beginLevel(a, b) {
    if (!loaded) return null;
    var L = (typeof a === 'number') ? a : b;
    var def = (a && typeof a === 'object') ? a : null;
    if (!bands.length || (def && def !== mineDef)) resolveBands(def || mineDef);
    var prev = bandN;
    if (!setBand(num(L, bandN || 1))) return null;
    /* ONLY IF THE BAND ACTUALLY MOVED. js/adv.js's descent calls beginMine() (which
     * opens on this level already) and then beginLevel() for the same level, and
     * charging that a second full fill would be paying twice for one screen. */
    if (active && bandN !== prev) {
      flushAll();
      needFill = true;
      /* A DIFFERENT WORLD DESERVES A FRESH SET OF ANNOUNCEMENTS. `annIds` holds
       * the motherlodes `mine:lode` has already fired for, and a ride makes every
       * one of them unreachable — the new level's lodes are hashed off a different
       * genSeed and are new formations, so a ride that kept the old list would
       * silently spend the twelve slots on rock nobody can visit any more. */
      annN = 0;
    }
    lastLayer = -1;                    // the stratum is re-announced on arrival
    return getLevelBounds();
  }

  /* THE PLAYABLE EXTENT, REUSED. js/vehicle.js clamps its position and CLIPS ITS
   * CUT BOX to this, and js/camera.js frames it; nothing else in the codebase
   * should ever spell a level's extent out. Null while no level is active, which
   * is a state both callers must handle — a zeroed box would pin the machine at
   * the origin, which is worse than no clamp at all.
   *
   * >> THREE OF THE FOUR NUMBERS ARE INFINITY NOW, AND THAT IS THE POINT.
   * A level map is endless east, west and south, so `botY` and `halfW` are
   * literally Infinity rather than "a very big number". Infinity is the honest
   * value AND the safe one: every clamp in the codebase is written as a compare
   * (`if (x > b.halfW)`, `if (y > b.botY)`), and a compare against Infinity is
   * simply false, so any consumer this change did not visit degrades to "no
   * clamp on that side" instead of to a wrong clamp. The two that WERE visited
   * (js/vehicle.js, js/camera.js) have had their dead sides removed outright, as
   * the amendment asked — this is the belt to that pair of braces.
   *
   * The one thing that is NOT Infinity is `topY`: the bedrock ceiling north of
   * the lift is the only boundary left in the game, and it is absolute.
   *
   * `openX` / `openBot` are the readable form of the same fact, for anything new
   * that would rather branch on a flag than on an arithmetic special case. */
  var lvlOut = { level: 0, topY: 0, botY: Infinity, halfW: Infinity,
                 openX: true, openBot: true };
  function getLevelBounds() {
    if (!bandN) return null;
    lvlOut.level = bandN;
    lvlOut.topY = lvlTopY;
    lvlOut.botY = Infinity;
    lvlOut.halfW = Infinity;
    lvlOut.openX = true;
    lvlOut.openBot = true;
    return lvlOut;
  }

  /**
   * True where the DOOR CHAMBER has removed the rock. One function, shared by the
   * generator, the scanner and the renderer so the three can never disagree about
   * where the excavation is — the same argument driftOfCell() makes.
   *
   * A SUPERELLIPSE (exponent 4), like the station rooms it replaces: square-ish
   * walls, rounded corners, full width right up to the ceiling. A circle would
   * pinch to a point at the sides and put the boarding circle's edges in rock.
   */
  function inDoorVoid(x, y) {
    if (!bandN) return false;
    if (y < doorCeilY || y > doorCY + DOOR_RY) return false;
    if (x < -DOOR_HW || x > DOOR_HW) return false;
    var dx = x / DOOR_HW, dy = (y - doorCY) / DOOR_RY;
    dx *= dx; dy *= dy;                // squaring twice keeps ^4 to multiplies
    return dx * dx + dy * dy < 1;
  }

  /**
   * IS THE MACHINE IN THE LIFT? The owner's rule: driving into the lift means
   * DISAPPEARING into it, so there has to be one unambiguous "inside", and it has
   * to be a place with a shape rather than a radius.
   *
   * THIS MODULE OWNS IT because this module carved the chamber. js/adv.js's
   * isInLift() is this test applied to the machine centre, js/vehicle.js stops
   * drawing the machine on the same answer, and the doors close on it — three
   * behaviours, one geometry, no chance of them disagreeing about the frame it
   * happened on. See DOOR_IN_* for why the box is inset, and in particular why its
   * floor is well above where the machine parks.
   */
  function inDoorInterior(x, y) {
    if (!bandN) return false;
    var hw = DOOR_W * 0.5 - DOOR_IN_PAD_X;
    if (x < -hw || x > hw) return false;
    return y > doorTopY + DOOR_IN_TOP && y < doorSillY - DOOR_IN_BOT;
  }

  /**
   * HAS THE MACHINE STARTED TO GO IN? The same column as the interior, but its
   * floor is DOOR_CATCH further out — see that tunable for why the two lines are
   * not the same line and why this one is where it is.
   *
   * js/adv.js polls this instead of inDoorInterior() to decide when to take the
   * machine off the player and DRIVE IT IN. The interior box keeps its old job
   * unchanged: it is still the one answer to "is the machine in the lift", and
   * the docking manoeuvre ends by putting the machine well inside it.
   */
  function inDoorThreshold(x, y) {
    if (!bandN) return false;
    var hw = DOOR_W * 0.5 - DOOR_IN_PAD_X;
    if (x < -hw || x > hw) return false;
    return y > doorTopY + DOOR_IN_TOP && y < doorSillY - DOOR_IN_BOT + DOOR_CATCH;
  }

  /**
   * HOW SOLID IS A MACHINE AT (x, y)? 1 out in the rock, 0 at the cage.
   *
   * The geometry lives here with the rest of the door, and js/vehicle.js just
   * multiplies — see DOOR_FADE_H for why the fade exists at all. Continuous in both
   * axes on purpose: kx is how much of the doorway the point is lined up with, ky is
   * how far short of the interior it still is, and the alpha is only pulled down by
   * the product, so nothing blinks at either boundary.
   */
  function getDoorFade(x, y) {
    if (!bandN) return 1;
    var hw = DOOR_W * 0.5 - DOOR_IN_PAD_X;
    var ax = x < 0 ? -x : x;
    var kx = clamp01((hw + DOOR_FADE_X - ax) / DOOR_FADE_X);
    var ky = clamp01((y - (doorSillY - DOOR_IN_BOT - DOOR_FADE_DEEP)) / DOOR_FADE_H);
    return 1 - kx * (1 - ky);
  }

  /**
   * HOW SOLIDLY THE DOORWAY IS DRAWN OVER THE MACHINE — the exact complement of
   * how solidly the machine itself is drawn.
   *
   * THE BUG THIS EXISTS TO KILL. The head overlay used to ride distance alone
   * (headMix), so it was at FULL strength whenever the machine was anywhere near
   * the doors — including parked outside them, and including the whole roll-out.
   * The threshold plate is a wide hazard-striped bar at the sill, and the parked
   * machine's ore bed reaches 438 units UP past it into the doorway, so the bar
   * was laid across a fully opaque machine: the hopper above it, the tracks below
   * it, the machine apparently squeezing UNDER the building's floor lip instead of
   * standing in its doorway. Owner-caught, and correct — a floor plate seen from
   * above must never be in front of a vehicle standing on it.
   *
   * WHY THE COMPLEMENT AND NOT A DIRECTION TEST. The obvious fix is "occlude only
   * while docking", or "only while the machine's centre is inside the sill". Both
   * are a switch, and a switch on a bar this wide POPS: the machine crosses the
   * sill at 86% opacity, so the plate would snap from fully over to fully under on
   * one frame, in the middle of a move whose whole purpose is to have no seams.
   *
   * Tying the overlay to `1 - getDoorFade(machine)` instead makes the two exactly
   * conjugate — the doorway closes over the machine precisely as fast as the
   * machine dissolves into it, their alphas sum to 1 at every position, and the
   * question "which is in front" simply stops having a wrong answer. It needs no
   * state, no direction and no knowledge that a manoeuvre is running, so it is
   * right going in, coming out, parked, and for a machine that never enters at all.
   *
   * `headMix` still multiplies it: that is the distance guard the emissive pass
   * needs (this runs after the darkness composite, so an overlay drawn from across
   * the level would be a bar of lit steel floating in the black). See HEAD_FAR.
   */
  function headOcclusion() {
    return headMix * (1 - getDoorFade(focusX(), focusY()));
  }

  /** Is the MACHINE in there? Feature-detected: js/adv.js's flag is authoritative
   *  once it exists (it owns the run state and may hold the machine in the lift
   *  through a menu), and the geometry test is the fallback that keeps this file
   *  correct and testable on its own. */
  function machineInLift() {
    if (SM.adv && typeof SM.adv.isInLift === 'function') {
      var v = SM.adv.isInLift();
      if (typeof v === 'boolean') return v;
    }
    return inDoorInterior(focusX(), focusY());
  }

  /**
   * THE DOORS OPEN BECAUSE YOU DROVE UP TO THEM, AND SHUT BECAUSE YOU DROVE IN.
   *
   * No event, no arming, no state machine: the distance from the machine to the
   * doorstep, ramped, with the ramp inverted once the machine is inside. It is
   * this module's own animation because this module is the only one that knows
   * where the doors are, and it is a RAMP rather than a threshold because a door
   * that snapped would read as a trigger firing instead of as a mechanism working.
   *
   * `headMix` rides the same distance, and it is HALF of how solidly the doorway's
   * own structure is re-drawn over the machine in the emissive pass — the distance
   * half, which keeps a lit bar of steel off the screen from across the level. The
   * other half is the machine's own fade, and headOcclusion() is where the two
   * meet. See HEAD_FAR.
   */
  function animateDoor(dt) {
    if (!bandN) return;
    var dx = focusX(), dy = focusY() - doorY;
    var d = Math.sqrt(dx * dx + dy * dy);
    /* PROXIMITY IS THE DEFAULT, NOT THE ONLY DRIVER. While js/adv.js is docking
     * or undocking the machine it drives the leaves itself, because the ORDER of
     * those two moves is the whole point of them — the doors must finish closing
     * BEHIND a machine that has already driven in, and finish opening BEFORE one
     * rolls out. A distance ramp cannot express "after"; it only knows "near".
     * See setDoorHold(). */
    if (!doorHeld) {
      var inside = machineInLift();
      var t = inside ? 0 : clamp01((DOOR_FAR - d) / (DOOR_FAR - DOOR_NEAR));
      var rate = inside ? DOOR_SHUT_LERP : DOOR_LERP;
      doorOpen += (t - doorOpen) * (1 - Math.exp(-rate * dt));
    }
    var h = clamp01((HEAD_FAR - d) / (HEAD_FAR - HEAD_NEAR));
    headMix += (h - headMix) * (1 - Math.exp(-6 * dt));
  }

  /**
   * HAND THE LEAVES TO THE LIFT, or take them back.
   *
   * `v` in 0..1 pins doorOpen to it and suspends the proximity ramp; anything
   * else (null, -1) releases them. The holder is expected to hand over a value
   * that STARTS at whatever the doors were already showing and to walk it from
   * there, which is why this assigns rather than lerps: two easings stacked on
   * one number is how a door ends up arriving late for its own animation.
   *
   * Releasing is safe at any value because the ramp resumes from wherever it is
   * left — js/adv.js releases at each end of a transition, where the proximity
   * answer and the held value already agree, so nothing jumps.
   */
  function setDoorHold(v) {
    if (typeof v !== 'number' || !(v >= 0)) { doorHeld = false; return; }
    doorHeld = true;
    doorOpen = clamp01(v);
  }

  /* ======================================================================
   * MATERIALS AND LAYER TABLES
   * =================================================================== */

  /* The ids this generator places. js/mines.js prices and sizes cargo against
   * exactly these strings, so they are listed once, here, and nowhere else. */
  var MAT_IDS = [
    'clay', 'coal', 'copper', 'sandstone', 'limestone',
    'silver', 'platinum', 'uranium', 'ancient', 'bedrock'
  ];

  function resolveMaterials() {
    var mm = SM.materials;
    M_DIRT = mm.indexOf('dirt');
    M_STONE = mm.indexOf('stone');
    M_RUBBLE = mm.indexOf('rubble');
    M_GRANITE = mm.indexOf('granite');
    M_BEDROCK = mm.indexOf('bedrock');
  }

  function matIdx(id, fallback) {
    var m = id ? SM.materials.getById(id) : null;
    if (m) return m.index;
    if (fallback) {
      var f = SM.materials.getById(fallback);
      if (f) return f.index;
    }
    return M_STONE;
  }

  function num(v, dflt) { return (typeof v === 'number' && isFinite(v)) ? v : dflt; }

  /**
   * THE DEFAULT PROFILE. Used whenever SM.mines has nothing to say — during the
   * parallel build (its stub returns null), for a mine whose record has no
   * layer table, and as the shape of the arc every authored mine should follow:
   *
   *   soft, cheap and generous at the top  ->  hard, barren and enormous at the
   *   bottom. The last layer's pocketRate is a fifth of the first's and its ore
   *   lottery is nearly worthless, which is exactly what makes breaking into an
   *   'ancient' lode down there land the way it should.
   */
  var DEFAULT_LAYERS = [
    { toDepth: 30, name: 'TOPSOIL', fill: 'dirt', beds: ['dirt', 'clay'],
      weights: { coal: 6, copper: 1 },
      pocketRate: 0.95, cavernRate: 0.05, seamRate: 0.40, driftRate: 0.40,
      hardnessScale: 1.0, heat: 0 },
    { toDepth: 90, name: 'CLAY BEDS', fill: 'clay', beds: ['clay', 'sandstone', 'dirt'],
      weights: { coal: 8, copper: 3, iron: 2 },
      pocketRate: 0.85, cavernRate: 0.09, seamRate: 0.42, driftRate: 0.36,
      hardnessScale: 1.0, heat: 0 },
    { toDepth: 180, name: 'SANDSTONE', fill: 'sandstone',
      beds: ['sandstone', 'limestone', 'clay'],
      weights: { copper: 6, iron: 4, coal: 3, silver: 1 },
      pocketRate: 0.70, cavernRate: 0.12, seamRate: 0.32, driftRate: 0.26,
      hardnessScale: 1.05, heat: 0.05 },
    { toDepth: 300, name: 'LIMESTONE', fill: 'limestone',
      beds: ['limestone', 'sandstone', 'stone'],
      weights: { silver: 5, copper: 3, gold: 2 },
      pocketRate: 0.55, cavernRate: 0.20, seamRate: 0.24, driftRate: 0.16,
      lodeRate: 0.018, hardnessScale: 1.15, heat: 0.15 },
    { toDepth: 460, name: 'GRANITE', fill: 'granite', beds: ['granite', 'stone'],
      weights: { gold: 5, platinum: 2, uranium: 2, silver: 2 },
      pocketRate: 0.32, cavernRate: 0.11, seamRate: 0.14, driftRate: 0.07,
      lodeRate: 0.030, hardnessScale: 1.3, heat: 0.35 },
    { toDepth: 1e9, name: 'THE DEEP', fill: 'obsidian',
      beds: ['obsidian', 'granite', 'bedrock'],
      weights: { platinum: 4, uranium: 4, gold: 2 },
      pocketRate: 0.18, cavernRate: 0.08, seamRate: 0.06, driftRate: 0.02,
      lodeRate: 0.045, lode: 'ancient', hardnessScale: 1.5, heat: 0.7 }
  ];

  /** {a:6, b:2} -> flat weighted table. Unknown ids resolve to stone. */
  function buildWeights(obj) {
    var keys = [], k;
    if (obj) for (k in obj) if (obj.hasOwnProperty(k) && obj[k] > 0) keys.push(k);
    if (!keys.length) return null;
    var w = { n: keys.length, mats: new Int32Array(keys.length),
              cum: new Float32Array(keys.length), tot: 0 };
    for (var i = 0; i < keys.length; i++) {
      w.mats[i] = matIdx(keys[i], 'stone');
      w.tot += obj[keys[i]];
      w.cum[i] = w.tot;
    }
    return w;
  }

  function pickWeighted(w, u) {
    if (!w) return M_STONE;
    var r = u * w.tot;
    for (var i = 0; i < w.n; i++) if (r < w.cum[i]) return w.mats[i];
    return w.mats[w.n - 1];
  }

  function richestOre(w) {
    if (!w) return M_STONE;
    var best = w.mats[0], bv = -1;
    for (var i = 0; i < w.n; i++) {
      var v = SM.materials.get(w.mats[i]).baseValue;
      if (v > bv) { bv = v; best = w.mats[i]; }
    }
    return best;
  }

  /**
   * The COUNTRY ROCK of a layer, as a weighted table of two or three beds.
   * The declared `fill` always dominates; the accents are what make a bed
   * boundary visible. `hardnessScale` is spent here (see the header note):
   * above 1 it re-weights the table toward the harder beds, which is the only
   * lever on toughness this module actually owns.
   */
  function buildBeds(src, L) {
    var ids = (src.beds && src.beds.length) ? src.beds : null;
    var obj = {};
    if (ids) {
      // First entry is the dominant bed; the rest share the remainder.
      for (var i = 0; i < ids.length; i++) obj[ids[i]] = (i === 0) ? 6 : 2;
    } else {
      obj[src.fill || 'stone'] = 6;
      // No beds authored: pair the fill with a plausible partner so the layer
      // still has strata instead of being one flat colour.
      var partner = BED_PARTNER[src.fill] || 'stone';
      if (partner !== src.fill) obj[partner] = 2;
    }
    var w = buildWeights(obj);
    if (!w) return null;
    // Re-weight by hardness if the layer asked to be tougher than its rock.
    var hs = num(src.hardnessScale, 1);
    if (hs > 1.01 && w.n > 1) {
      var tot = 0, raw = new Float32Array(w.n), prev = 0;
      for (var j = 0; j < w.n; j++) {
        var base = w.cum[j] - prev; prev = w.cum[j];
        var hard = SM.materials.get(w.mats[j]).baseHardness + 0.5;
        raw[j] = base * Math.pow(hard, (hs - 1) * 1.6);
        tot += raw[j];
        w.cum[j] = tot;
      }
      w.tot = tot;
    }
    return w;
  }

  /** Plausible interbed partners, so an un-authored layer still has strata. */
  var BED_PARTNER = {
    dirt: 'clay', clay: 'sandstone', sandstone: 'limestone',
    limestone: 'sandstone', stone: 'limestone', granite: 'stone',
    obsidian: 'granite', bedrock: 'obsidian'
  };

  /**
   * mines.js states pocketRate and cavernRate as "expected per generated
   * band", where a band is BAND_REF tall and RATE_REF_W wide. Convert to a
   * probability per structure cell of the given size.
   *
   * RATE_REF_W IS A UNIT, NOT A BOUND — it is the width those rates were
   * measured at, kept fixed so an endless map generates at the same areal
   * density the finite one did. See the note by SP.
   */
  function perCell(rate, cw, ch, dflt) {
    var r = num(rate, dflt);
    if (!(r > 0)) return 0;
    var cellsPerBand = (RATE_REF_W / cw) * (BAND_REF / ch);
    if (!(cellsPerBand > 0)) return 0;
    var p = r / cellsPerBand;
    return p > 0.85 ? 0.85 : p;
  }

  /**
   * Resolve ONE stratum into the record the generator uses. `k` is 1-based and
   * only reaches the arithmetic through `f`, the "how deep is this level in the
   * ladder" fraction every optional rate defaults off — which is what gives an
   * under-specified layer table the soft-rich-to-hard-barren arc for free.
   *
   * `sp` is js/mines.js's levelSpawnOf() record when it exists; `s` is the raw
   * layer object, which is all this file ever had before and is still the
   * fallback that keeps it testable on its own.
   */
  function buildLayer(k, n, s, sp) {
    var f = (n <= 1) ? 1 : (k - 1) / (n - 1);
    var L = {};
    L.idx = k - 1;
    L.name = (sp && sp.name) || s.name || ('LAYER ' + k);
    L.fill = matIdx((sp && sp.fill) || s.fill, 'stone');
    L.beds = buildBeds({ beds: (sp && sp.beds) || s.beds,
                         fill: (sp && sp.fill) || s.fill,
                         hardnessScale: sp ? sp.hardnessScale : s.hardnessScale }, L);
    L.pocketP = perCell(pick(sp, s, 'pocketRate'), POCKET_W, POCKET_H, 0.9 - 0.7 * f);
    L.cavernP = perCell(pick(sp, s, 'cavernRate'), CAVERN_W, CAVERN_H, 0.06 + 0.10 * f);
    L.seamP = num(pick(sp, s, 'seamRate'), 0.38 - 0.26 * f);
    L.driftP = num(pick(sp, s, 'driftRate'), 0.42 - 0.36 * f);
    /* THE MOTHERLODE RATE, AND WHY THE DEFAULT MOVED.
     *
     * It was `f < 0.55 ? 0 : (f-0.55)/0.45 * 0.42`, which put 0.42 on the deepest
     * LAYER of every mine — one motherlode per 6.3 million square units. That was
     * right when the deepest layer was the last two hundred metres of a finite
     * mine and the whole point was for the bottom to be spectacular.
     *
     * A level is an ENDLESS MAP now, so 0.42 means that density forever, and
     * MEASURED it is not a landmark, it is scenery: a lode paints about 2 100
     * cells of its own mineral between its shell and its halo, so at 0.42 the
     * emerald motherlodes of Old Creek's level 3 were 35.6% of all the ore on the
     * level against a stated table share of 4.7%, and doubled what a hold out of
     * it was worth against the price the level is sold at.
     *
     * The new ladder targets one ROLLED lode per ~90 million square units, which
     * is about one every four expeditions at this mode's window width, and puts
     * them at roughly a tenth of a level's ore. Every level also has one
     * GUARANTEED lode a couple of hundred metres south of its own lift, which is
     * the one every player finds, so "rare" here never means "never". */
    L.lodeP = num(pick(sp, s, 'lodeRate'), f < 0.4 ? 0 : (f - 0.4) / 0.6 * 0.045);
    L.bedPitch = num((sp && sp.bedPitch) || s.bedPitch,
                     BED_PITCH * (0.78 + h3(mineSeed ^ S_BED, k, 5) / 4294967296 * 0.55));
    L.hardnessScale = num(sp ? sp.hardnessScale : s.hardnessScale, 1);
    L.heat = num(sp ? sp.heat : s.heat, 0);
    L.vug = num(pick(sp, s, 'vugChance'), 0.16 - 0.10 * f);
    /* THE ANCIENT DEBRIS RATE, per structure cell. Its grid is coarse, so this
     * is a small probability on a rare gather rather than a rare probability on
     * a common one. */
    L.debP = perCell(sp ? sp.debrisRate : 0, DEB_W, DEB_H, 0);
    L.debMat = matIdx((sp && sp.debrisMat) || 'ancient', 'starcore');
    L.debCells = num(sp ? sp.debrisCells : 0, 3);
    return L;
  }

  /** mines.js's value if it stated one (>= 0), else the layer's, else undefined. */
  function pick(sp, s, key) {
    if (sp && typeof sp[key] === 'number' && sp[key] >= 0) return sp[key];
    return s ? s[key] : undefined;
  }

  /**
   * Resolve the whole ladder once per mine. Every entry is a LEVEL's stratum
   * now, not a depth range: `toY` is gone because a level does not end.
   */
  function buildLayers(def) {
    layers.length = 0;
    var src = (def && def.layers && def.layers.length) ? def.layers : DEFAULT_LAYERS;
    var n = src.length;
    for (var i = 0; i < n; i++) {
      var sp = null;
      if (SM.mines && SM.mines.levelSpawnOf && def) {
        try { sp = SM.mines.levelSpawnOf(def, i + 1); } catch (e) { sp = null; }
      }
      layers.push(buildLayer(i + 1, n, src[i] || {}, sp));
    }
  }

  /* THE WHOLE MAP IS ONE STRATUM. These two used to walk a depth ladder; there
   * is no ladder inside a level any more (js/mines.js design note 4e), so they
   * answer the ACTIVE level's layer at every y and only fall back to the depth
   * lookup when nothing is active — which is what keeps getLayers()/layerAtY()
   * meaningful for a caller asking between runs. */
  function layerIndexAtY(y) {
    if (bandN) return bandN - 1 < layers.length ? bandN - 1 : layers.length - 1;
    return 0;
  }
  function layerAtY(y) {
    if (!layers.length) return null;
    if (lvl) return lvl;
    return layers[layerIndexAtY(y)];
  }

  /* ======================================================================
   * THE SOUTHWARD WHISPER — baked, never computed per cell
   * ---------------------------------------------------------------------
   * js/mines.js owns HOW MUCH the ore table drifts as the player works south
   * (design note 4e); this owns making that free to ask about. The drift is
   * quantised into ORE_BUCKETS weighted tables built once per level, so
   * cellMaterialAt() and probeAll() both resolve a structure's table with one
   * multiply, one floor and an array index — no allocation, and byte-identical
   * whichever direction the streamer arrives from.
   *
   * TWO VISITS TO THE SAME ROCK MUST AGREE, which is why the bucket is a
   * function of the structure's own y and nothing else. It is deliberately NOT a
   * function of the machine's depth: that would make the same pocket contain
   * different ore depending on where you were standing when it streamed in.
   * =================================================================== */
  var ORE_BUCKETS = 12;
  var oreTab = [];                // ORE_BUCKETS weighted tables, richest last
  var oreDens = new Float32Array(ORE_BUCKETS);   // ...and the density multiplier
  var driftCapM = 1000;           // metres south at which the whisper plateaus
  var driftW = {};                // scratch, reused by buildLevel only
  var rawW = {};                  // scratch copy for the undrifted branch — the
                                  // layer's own weights object must never be
                                  // mutated (rawWeightsOfLevel returns it live)

  /* ----- THE DOORSTEP RULE ---------------------------------------------
   * The level's premium ore does not sit at the lift's feet. The ore lottery's
   * headline entries (value >= NEARLIFT_FRAC of the table's best) fade in over
   * the first NEARLIFT_M south of the lift, from NEARLIFT_FLOOR at the door row
   * to full strength past the ramp. Owner-reported: with silver at 2.25% of ore
   * and whole pockets rolling one material, "almost literally the first chunk I
   * drilled was silver" — and the scanner headlines the best contact in range,
   * so any doorstep silver WILL be found. The cheap ore is untouched, the
   * pocket rate is untouched, and the deep game never sees this at all.
   * Ancient debris is deliberately exempt: it is the designed jackpot, and its
   * own per-level rarity already prices a doorstep miracle.
   * ------------------------------------------------------------------ */
  var NEARLIFT_M = 260;           // metres south over which premium ore fades in
  var NEARLIFT_FLOOR = 0.06;      // premium weight multiplier at the door row
  var NEARLIFT_FRAC = 0.8;        // premium = value >= this frac of the table max

  function nearLiftDamp(obj, mSouth) {
    if (!obj || mSouth >= NEARLIFT_M) return obj;
    var id, v, maxV = 0;
    for (id in obj) {
      if (!obj.hasOwnProperty(id)) continue;
      v = SM.materials.get(matIdx(id, 'stone')).value || 0;
      if (v > maxV) maxV = v;
    }
    if (!(maxV > 0)) return obj;
    var t = mSouth > 0 ? mSouth / NEARLIFT_M : 0;
    var f = NEARLIFT_FLOOR + (1 - NEARLIFT_FLOOR) * t;
    for (id in obj) {
      if (!obj.hasOwnProperty(id)) continue;
      v = SM.materials.get(matIdx(id, 'stone')).value || 0;
      if (v >= maxV * NEARLIFT_FRAC) obj[id] *= f;
    }
    return obj;
  }

  /** 0..1 along the whisper, from a world y. Clamped, so a bucket is always valid. */
  function driftT(y) {
    if (!(driftCapM > 0)) return 0;
    var m = (y - lvlTopY) * A.METERS_PER_UNIT;
    if (!(m > 0)) return 0;
    var t = m / driftCapM;
    return t > 1 ? 1 : t;
  }
  function bucketOf(y) {
    var b = Math.floor(driftT(y) * ORE_BUCKETS);
    if (b < 0) b = 0;
    if (b >= ORE_BUCKETS) b = ORE_BUCKETS - 1;
    return b;
  }
  /** The ore lottery in force at world y. Never null once a level is active. */
  function oresAt(y) { return oreTab[bucketOf(y)] || (lvl ? lvl.ores : null); }
  /** ...and the ore-density multiplier there, for pocket and seam rates. */
  function densAt(y) { return oreDens[bucketOf(y)] || 1; }

  /**
   * ACTIVATE ONE LEVEL'S GEOLOGY. Called from setBand() before anything reads a
   * structure, and it is the only place `lvl`, the buckets and the guaranteed
   * motherlode are written.
   */
  function buildLevel(k) {
    lvl = layers.length ? layers[(k - 1 < layers.length) ? k - 1 : layers.length - 1]
                        : null;
    oreTab.length = 0;

    var sp = null;
    if (SM.mines && SM.mines.levelSpawnOf && mineDef) {
      try { sp = SM.mines.levelSpawnOf(mineDef, k); } catch (e) { sp = null; }
    }
    var dr = (SM.mines && SM.mines.getSouthDrift) ? SM.mines.getSouthDrift() : null;
    var cap = dr ? num(dr.cap, 0) : 0;
    var densK = dr ? num(dr.density, 0) : 0;
    driftCapM = (dr && dr.fullM > 0) ? dr.fullM : 1;

    var i, g, mS, id;
    for (i = 0; i < ORE_BUCKETS; i++) {
      /* The bucket's REPRESENTATIVE g is its midpoint, so the quantisation error
       * is half a bucket either way rather than a whole one at the top. */
      g = cap * ((i + 0.5) / ORE_BUCKETS);
      /* The same midpoint in METRES, for the doorstep rule — the buckets are
       * already keyed by south distance, so near-lift damping is free here.
       * GUARD: with a degenerate drift range (stub catalogue -> driftCapM 1) the
       * last bucket represents the entire endless south, and damping it would
       * suppress premium ore forever. No resolution, no rule. */
      mS = (driftCapM >= NEARLIFT_M)
        ? driftCapM * ((i + 0.5) / ORE_BUCKETS)
        : NEARLIFT_M;
      if (sp && SM.mines.driftedWeights) {
        SM.mines.driftedWeights(sp, g, driftW);
        oreTab.push(buildWeights(nearLiftDamp(driftW, mS)));
      } else {
        // No spawn table (a stub catalogue, or the default profile): the layer's
        // own weights, undrifted. The world still works; it just never whispers.
        // Copied into scratch first — the layer's object is live, and the
        // doorstep rule must not be baked into it permanently.
        var raw = rawWeightsOfLevel(k);
        for (id in rawW) { if (rawW.hasOwnProperty(id)) delete rawW[id]; }
        if (raw) for (id in raw) { if (raw.hasOwnProperty(id)) rawW[id] = raw[id]; }
        oreTab.push(buildWeights(nearLiftDamp(rawW, mS)));
      }
      oreDens[i] = 1 + densK * g;
    }
    if (lvl) lvl.ores = oreTab[0];

    /* THE LEVEL'S HEADLINE FORMATION. `lode` names it when js/mines.js has an
     * opinion; otherwise it is the best ore the level's own table carries. */
    if (lvl) {
      lvl.lodeMat = (sp && sp.lode) ? matIdx(sp.lode, 'silver')
                                    : richestOre(oreTab[ORE_BUCKETS - 1]);
    }
    buildGuaranteedLode();
  }

  /** The undrifted weights of level k, straight off the layer table. */
  function rawWeightsOfLevel(k) {
    var src = (mineDef && mineDef.layers && mineDef.layers.length)
      ? mineDef.layers : DEFAULT_LAYERS;
    var j = k - 1;
    if (j < 0) j = 0;
    if (j >= src.length) j = src.length - 1;
    return src[j] ? src[j].weights : null;
  }

  /* ======================================================================
   * PER-ROW STRUCTURE CONTEXT
   *
   * Structures are gathered ONCE per row and cached in these flat arrays, then
   * ~83 deposits share the result — the same trick classic terrain.js uses in
   * prepareRow(), for the same reason. A blob's index in the list is stable
   * within a row, and every hash keyed off a blob uses the blob's own id (a
   * hash of its structure-cell index) rather than that list index, so nothing
   * here depends on gather ORDER for anything but priority.
   *
   * PRIORITY is the list order: motherlodes are pushed first, then caverns,
   * then pockets, and cellMaterialAt() returns on the first hit. Old workings
   * are checked between caverns and pockets — an old drift through an ore
   * pocket means the ore was taken out a century ago, which is the truth we
   * want, and it also stops a drift being blocked by geology it predates.
   * =================================================================== */
  var K_LODE = 0, K_CAVERN = 1, K_POCKET = 2, K_DEBRIS = 3;

  // Sized for the widest strip a 2D window generates (a full window-wide row),
  // with headroom: a rich shallow level can put a dozen pockets and a couple of
  // caverns across one row, and a dropped blob would be a formation the scanner
  // reports and the rock does not contain.
  var BLOB_MAX = 64;
  var bbX = new Float32Array(BLOB_MAX);
  var bbY = new Float32Array(BLOB_MAX);
  var bbRX = new Float32Array(BLOB_MAX);
  var bbRY = new Float32Array(BLOB_MAX);
  var bbMat = new Int32Array(BLOB_MAX);     // shell/lens material, -1 = plain void
  var bbShell = new Float32Array(BLOB_MAX); // squared-t out to which it acts
  var bbKind = new Uint8Array(BLOB_MAX);
  var bbId = new Int32Array(BLOB_MAX);      // stable per-structure hash
  var bbN = 0;

  var HALO_MAXN = 16;
  var hlX = new Float32Array(HALO_MAXN);
  var hlY = new Float32Array(HALO_MAXN);
  var hlRX = new Float32Array(HALO_MAXN);
  var hlRY = new Float32Array(HALO_MAXN);
  var hlMat = new Int32Array(HALO_MAXN);
  var hlN = 0;

  var DRIFT_MAXN = 24;      // drifts AND winzes take a slot; a wide mine has
                            // several old workings side by side on one row
  var drX0 = new Float32Array(DRIFT_MAXN);
  var drX1 = new Float32Array(DRIFT_MAXN);
  var drY0 = new Float32Array(DRIFT_MAXN);
  var drY1 = new Float32Array(DRIFT_MAXN);
  var drId = new Int32Array(DRIFT_MAXN);
  var drN = 0;

  var seamOn = false, seamJ = 0, seamCy = 0, seamHalf = 0,
      seamMat = 0, seamPinch = 0.4;

  /* THE STRIP'S X SPAN, and why every gather is filtered against it.
   *
   * The lists above are capped, and a cap that can be REACHED would break
   * positional determinism: which structures got dropped would depend on how
   * wide the strip being filled happened to be, so the same cell could resolve
   * differently when refilled from the side instead of from above.
   *
   * Two things together make that impossible. Every push is filtered by x
   * overlap with the strip, so the list only ever holds structures that can
   * actually touch the cells being filled — a handful, not a mine's worth. And
   * the caps are then set far above that handful. (Everything a wide gather
   * admits and a narrow one does not is geometrically rejected per cell anyway,
   * and both iterate in the same ascending grid order, so a non-saturated list
   * gives byte-identical results either way. That is the whole argument.)
   * ------------------------------------------------------------------ */
  var gxA = 0, gxB = 0;

  function pushBlob(x, y, rx, ry, m, shell, kind, id) {
    if (bbN >= BLOB_MAX) return;
    var reach = rx * Math.sqrt(shell);
    if (x + reach < gxA || x - reach > gxB) return;
    bbX[bbN] = x; bbY[bbN] = y; bbRX[bbN] = rx; bbRY[bbN] = ry;
    bbMat[bbN] = m; bbShell[bbN] = shell; bbKind[bbN] = kind; bbId[bbN] = id;
    bbN++;
  }

  /* ----- motherlodes -------------------------------------------------
   * THE MONEY SHOT. A big cavern with a thick ore shell lining its wall, so
   * the moment of breaking through reads as "the wall collapses into a huge
   * natural cavern, and across the cavern wall is an enormous glittering
   * mineral vein" and not as "a bigger ore pocket".
   *
   * EVERY LEVEL gets exactly ONE guaranteed lode, placed deterministically a
   * couple of hundred metres SOUTH OF ITS OWN LIFT — the reward for committing to
   * a direction is never a coin flip. The rest of the map then rolls for more on
   * the LODE_W x LODE_H lattice, which tiles outward forever, so a level that is
   * worked hard keeps producing them at a steady areal density.
   * ------------------------------------------------------------------ */

  /** Fill the lode scratch slots for grid cell (i, j). -> true if one exists. */
  var lodeX = 0, lodeY = 0, lodeRX = 0, lodeRY = 0, lodeMat = 0, lodeShell = 0, lodeId = 0;

  function lodeOfCell(i, j) {
    if (!lvl || lvl.lodeP <= 0) return false;
    var yc = (j + 0.5) * LODE_H + (hv(S_LODE, i * 71 + 1, j) - 0.5) * LODE_H * 0.7;
    if (yc < lvlTopY) return false;         // north of the ceiling: no world there
    if (hv(S_LODE, i * 71 + 2, j) >= lvl.lodeP) return false;
    return describeLode(i, j, yc, 1.0, false);
  }

  /**
   * Resolve one motherlode into the scratch slots.
   * `centred` is the guaranteed lode: it is placed near the LEVEL'S CENTRE LINE
   * (see GLD_X), which is also the line the doors are on, because it is the
   * payoff for driving south rather than for wandering. Rolled lodes are anchored
   * to their own lattice cell and are free to be anywhere at all — there are no
   * walls to pull them inside any more, which is two clamps and a reject that
   * this function no longer needs.
   */
  function describeLode(i, j, yc, scale, centred) {
    if (!lvl) return false;
    lodeId = h3(genSeed ^ S_LODE, i * 71 + 7, j) | 0;
    lodeRX = lerp(LODE_RX[0], LODE_RX[1], hv(S_LODE, i * 71 + 3, j)) * scale;
    lodeRY = lerp(LODE_RY[0], LODE_RY[1], hv(S_LODE, i * 71 + 4, j)) * scale;
    var u = hv(S_LODE, i * 71 + 5, j);
    lodeX = centred ? (u * 2 - 1) * GLD_X : (i + u) * LODE_W;
    lodeY = yc;
    lodeShell = lerp(LODE_SHELL[0], LODE_SHELL[1], hv(S_LODE, i * 71 + 6, j));
    /* THE MATERIAL COMES FROM THE LEVEL, NOT THE DEPTH. A level is one stratum
     * everywhere on its map, so its headline formation is the same mineral at the
     * lift as it is a kilometre south — the whisper moves the ORE LOTTERY, never
     * what the mine is famous for. */
    lodeMat = lvl.lodeMat;
    return true;
  }

  /* Structure-grid cell range covering [xLo, xHi] with `pad` units of reach.
   * Every 2D structure family resolves its i-range through these two so the
   * generator, the scanner and the renderer can never disagree about which
   * cells they are looking at. */
  function cellI0(xLo, w, pad) { return Math.floor((xLo - pad) / w); }
  function cellI1(xHi, w, pad) { return Math.floor((xHi + pad) / w); }

  /** The guaranteed motherlode of the ACTIVE LEVEL. Rebuilt by buildLevel(). */
  var gldValid = false, gldX = 0, gldY = 0, gldRX = 0, gldRY = 0,
      gldMat = 0, gldShell = 0, gldId = 0;

  function buildGuaranteedLode() {
    gldValid = false;
    if (!lvl) return;
    /* SOUTH OF THIS LEVEL'S LIFT, not above the mine's floor — see GLD_DEPTH_U.
     * The old placement was measured up from a bottom that no longer exists. */
    var yc = lvlTopY + GLD_DEPTH_U + hv(S_LODE, 991, 1) * GLD_SPREAD_U;
    // A little bigger than a rolled one: this is the level's headline formation.
    if (!describeLode(0, 991, yc, 1.18, true)) return;
    gldValid = true;
    gldX = lodeX; gldY = lodeY; gldRX = lodeRX; gldRY = lodeRY;
    gldMat = lodeMat; gldShell = lodeShell; gldId = lodeId;
  }

  /**
   * Gather the lodes whose shell or halo can reach the strip being generated.
   * [gxLo, gxHi] is that strip's world x span: a 2D window generates one narrow
   * edge strip at a time, so restricting the structure scan to it is both the
   * correct answer and what keeps a wide mine's generator cheap.
   */
  function gatherLodes(ry, gxLo, gxHi) {
    hlN = 0;
    var reach = LODE_RX[1] * HALO_T;               // widest halo we can be in
    var j0 = Math.floor((ry - reach) / LODE_H);
    var j1 = Math.floor((ry + reach) / LODE_H);
    var i0 = cellI0(gxLo, LODE_W, reach + LODE_W);
    var i1 = cellI1(gxHi, LODE_W, reach + LODE_W);
    var i, j;
    for (j = j0; j <= j1; j++) {
      for (i = i0; i <= i1; i++) {
        if (!lodeOfCell(i, j)) continue;
        considerLode(ry, lodeX, lodeY, lodeRX, lodeRY, lodeMat, lodeShell, lodeId);
      }
    }
    if (gldValid) {
      considerLode(ry, gldX, gldY, gldRX, gldRY, gldMat, gldShell, gldId);
    }
  }

  function considerLode(ry, lx, ly, rx, ryd, m, shell, id) {
    var sh = Math.sqrt(shell);
    var dy = ry - ly; if (dy < 0) dy = -dy;
    if (dy <= ryd * sh + SP) {
      pushBlob(lx, ly, rx, ryd, m, shell, K_LODE, id);
    }
    // The halo reaches further than the shell — that is the whole point of it.
    if (dy <= ryd * sh * HALO_T && hlN < HALO_MAXN &&
        lx + rx * sh * HALO_T >= gxA && lx - rx * sh * HALO_T <= gxB) {
      hlX[hlN] = lx; hlY[hlN] = ly;
      hlRX[hlN] = rx * sh; hlRY[hlN] = ryd * sh;
      hlMat[hlN] = m;
      hlN++;
    }
  }

  /* ----- caverns ------------------------------------------------------
   * A STRUCTURE'S ORE COMES FROM ITS OWN CENTRE, not from the row we happen to
   * be filling. That is not a detail: probeAll() (the scanner) asks about
   * structures without any row context at all, so if the two disagreed the
   * scanner would report formations that do not exist, and miss ones that do.
   * Both paths resolve the lottery the same way — oresAt(the structure's y).
   * ------------------------------------------------------------------ */
  function gatherCaverns(ry, gxLo, gxHi) {
    if (!lvl || lvl.cavernP <= 0) return;
    var i0 = cellI0(gxLo, CAVERN_W, CAVERN_MAX_R + CAVERN_W);
    var i1 = cellI1(gxHi, CAVERN_W, CAVERN_MAX_R + CAVERN_W);
    var j0 = Math.floor((ry - CAVERN_MAX_R - SP) / CAVERN_H);
    var j1 = Math.floor((ry + CAVERN_MAX_R + SP) / CAVERN_H);
    for (var j = j0; j <= j1; j++) {
      for (var i = i0; i <= i1; i++) {
        var cyw = j * CAVERN_H + hv(S_CAV, i * 31 + 4, j) * CAVERN_H;
        if (cyw < lvlTopY) continue;
        if (hv(S_CAV, i, j) >= lvl.cavernP) continue;
        var rx = lerp(CAVERN_MIN_R, CAVERN_MAX_R, hv(S_CAV, i * 31 + 1, j));
        var ryd = rx * lerp(0.44, 0.86, hv(S_CAV, i * 31 + 2, j));
        var cxw = i * CAVERN_W + hv(S_CAV, i * 31 + 3, j) * CAVERN_W;
        var mineral = hv(S_CAVM, i, j) < CAVERN_MINERAL;
        var shell = mineral
          ? lerp(CAVERN_SHELL[0], CAVERN_SHELL[1], hv(S_CAVM, i + 7, j))
          : 1;
        var dy = ry - cyw; if (dy < 0) dy = -dy;
        if (dy > ryd * Math.sqrt(shell) + SP) continue;
        var w = oresAt(cyw);
        var m = mineral && w ? pickWeighted(w, hv(S_CAVM, i + 13, j)) : -1;
        pushBlob(cxw, cyw, rx, ryd, m, shell, K_CAVERN, h3(genSeed ^ S_CAV, i, j) | 0);
      }
    }
  }

  /* ----- ore pockets --------------------------------------------------
   * THE POCKET RATE CARRIES THE DENSITY HALF OF THE SOUTHWARD WHISPER, which is
   * why the probability is read per structure rather than once per gather: two
   * pockets a few hundred metres apart legitimately roll against different
   * numbers, and each must roll against the one at ITS OWN y or the same pocket
   * would exist or not depending on which row streamed it in.
   * ------------------------------------------------------------------ */
  function gatherPockets(ry, gxLo, gxHi) {
    if (!lvl || lvl.pocketP <= 0) return;
    var i0 = cellI0(gxLo, POCKET_W, POCKET_BIG_R + POCKET_W);
    var i1 = cellI1(gxHi, POCKET_W, POCKET_BIG_R + POCKET_W);
    var j0 = Math.floor((ry - POCKET_BIG_R - SP) / POCKET_H);
    var j1 = Math.floor((ry + POCKET_BIG_R + SP) / POCKET_H);
    for (var j = j0; j <= j1; j++) {
      for (var i = i0; i <= i1; i++) {
        var cyw = j * POCKET_H + hv(S_POCK, i * 17 + 5, j) * POCKET_H;
        if (cyw < lvlTopY) continue;
        var p = lvl.pocketP * densAt(cyw);
        if (p > 0.85) p = 0.85;
        if (hv(S_POCK, i, j) >= p) continue;
        var big = hv(S_POCK, i * 17 + 1, j) < POCKET_BIG;
        var rx = big
          ? lerp(POCKET_MAX_R, POCKET_BIG_R, hv(S_POCK, i * 17 + 2, j))
          : lerp(POCKET_MIN_R, POCKET_MAX_R, hv(S_POCK, i * 17 + 2, j));
        var ryd = rx * lerp(0.48, 0.95, hv(S_POCK, i * 17 + 3, j));
        var cxw = i * POCKET_W + hv(S_POCK, i * 17 + 4, j) * POCKET_W;
        var dy = ry - cyw; if (dy < 0) dy = -dy;
        if (dy > ryd + SP) continue;
        // A minority of pockets are VUGS — hollow, not ore. They are what stops
        // "a blob in the wall" from always meaning "money", so breaking into
        // one is a real (small) disappointment rather than a free reward.
        var vug = hv(S_POCKM, i, j) < lvl.vug;
        var m = vug ? -1 : pickWeighted(oresAt(cyw), hv(S_POCKM, i + 5, j));
        pushBlob(cxw, cyw, rx, ryd, m, 1, K_POCKET, h3(genSeed ^ S_POCK, i, j) | 0);
      }
    }
  }

  /* ----- ANCIENT DEBRIS ------------------------------------------------
   * The rare find, and the only thing in the world that is an EVENT.
   *
   * A tight scatter of the richest material in the game on its own coarse
   * lattice, at a rate js/mines.js states PER LEVEL (design note 4e). It is
   * pushed as a K_POCKET blob with its own material so that every downstream
   * path — the shell/lens test in cellMaterialAt(), the scanner's contact
   * merging, the renderer's lode bloom — treats it as the ore body it is,
   * without a single special case anywhere but here.
   *
   * `fill` is what makes it DEBRIS rather than a lens: the per-cell rim hash is
   * used to punch most of the blob back out to country rock, so what is left is
   * a handful of glittering fragments in the wall rather than a solid nugget.
   * ------------------------------------------------------------------ */
  function gatherDebris(ry, gxLo, gxHi) {
    if (!lvl || lvl.debP <= 0) return;
    var i0 = cellI0(gxLo, DEB_W, DEB_R[1] + DEB_W);
    var i1 = cellI1(gxHi, DEB_W, DEB_R[1] + DEB_W);
    var j0 = Math.floor((ry - DEB_R[1] - SP) / DEB_H);
    var j1 = Math.floor((ry + DEB_R[1] + SP) / DEB_H);
    for (var j = j0; j <= j1; j++) {
      for (var i = i0; i <= i1; i++) {
        var cyw = j * DEB_H + hv(S_DEB, i * 37 + 3, j) * DEB_H;
        if (cyw < lvlTopY) continue;
        if (hv(S_DEB, i, j) >= lvl.debP) continue;
        var r = lerp(DEB_R[0], DEB_R[1], hv(S_DEB, i * 37 + 1, j));
        var cxw = i * DEB_W + hv(S_DEB, i * 37 + 2, j) * DEB_W;
        var dy = ry - cyw; if (dy < 0) dy = -dy;
        if (dy > r + SP) continue;
        pushBlob(cxw, cyw, r, r, lvl.debMat, 1, K_DEBRIS,
                 h3(genSeed ^ S_DEBC, i, j) | 0);
      }
    }
  }

  /* ----- old workings -------------------------------------------------
   * An abandoned drift is a horizontal void with a hashed span, optionally
   * with a winze (a vertical shaft) sunk from one end. Mechanically it is a
   * ROAD: no drilling, almost no fuel, and it runs sideways, which is the only
   * reason a player would ever leave the straight line down. render() draws
   * timber sets in them so they read as somebody else's mine, not as a crack.
   * ------------------------------------------------------------------ */
  /**
   * Resolve the drift of grid cell (i, j) into the scratch slots below.
   * ONE resolver, called by the generator AND by drawTimbers(), because the two
   * agreeing is not optional: timbers painted where there is no void read as
   * timbers embedded in solid rock, and a bare drift reads as a crack.
   */
  var dfX = 0, dfY = 0, dfW = 0, dfH = 0, dfId = 0;

  function driftOfCell(i, j) {
    if (!lvl || lvl.driftP <= 0) return false;
    var yc = j * DRIFT_H + hv(S_DRIFT, i * 53 + 2, j) * DRIFT_H;
    if (yc < lvlTopY) return false;         // north of the ceiling: no world there
    if (hv(S_DRIFT, i * 53 + 1, j) >= lvl.driftP) return false;
    var w = lerp(DRIFT_MIN_W, DRIFT_MAX_W, hv(S_DRIFT, i * 53 + 4, j));
    // Anchored to the cell. There are no walls to pull it inside any more.
    dfX = (i + hv(S_DRIFT, i * 53 + 5, j)) * DRIFT_W;
    dfY = yc; dfW = w;
    dfH = SP * lerp(1.7, 3.1, hv(S_DRIFT, i * 53 + 3, j));
    dfId = h3(genSeed ^ S_DRIFT, i * 53 + 9, j) | 0;
    return true;
  }

  function gatherDrifts(ry, gxLo, gxHi) {
    drN = 0;
    var j0 = Math.floor((ry - DRIFT_H) / DRIFT_H);
    var j1 = Math.floor((ry + DRIFT_H) / DRIFT_H);
    var i0 = cellI0(gxLo, DRIFT_W, DRIFT_MAX_W + DRIFT_W);
    var i1 = cellI1(gxHi, DRIFT_W, DRIFT_MAX_W + DRIFT_W);
    for (var j = j0; j <= j1; j++) {
      for (var i = i0; i <= i1; i++) {
        if (!driftOfCell(i, j)) continue;
        var yc = dfY, h = dfH, w = dfW, cxw = dfX, id = dfId;
        // See gxA. The pad covers the winze, which straddles one END of the
        // drift and so reaches a little past its x span.
        var xr = w * 0.5 + SP * 2;
        if (cxw + xr < gxA || cxw - xr > gxB) continue;
        if (ry > yc - h * 0.5 - SP && ry < yc + h * 0.5 + SP && drN < DRIFT_MAXN) {
          drX0[drN] = cxw - w * 0.5; drX1[drN] = cxw + w * 0.5;
          drY0[drN] = yc - h * 0.5; drY1[drN] = yc + h * 0.5;
          drId[drN] = id;
          drN++;
        }
        // The winze: sunk from one end of the drift, down towards the next one.
        if (hv(S_DRIFT, i * 53 + 6, j) < DRIFT_WINZE && drN < DRIFT_MAXN) {
          var wx = (hv(S_DRIFT, i * 53 + 7, j) < 0.5) ? cxw - w * 0.5 : cxw + w * 0.5;
          var ww = SP * lerp(2.0, 3.4, hv(S_DRIFT, i * 53 + 8, j));
          var wy1 = yc + lerp(160, DRIFT_H * 0.85, hv(S_DRIFT, i * 53 + 9, j));
          if (ry > yc - SP && ry < wy1 + SP) {
            drX0[drN] = wx - ww * 0.5; drX1[drN] = wx + ww * 0.5;
            drY0[drN] = yc; drY1[drN] = wy1;
            drId[drN] = id ^ 0x5f5f5f5f;
            drN++;
          }
        }
      }
    }
  }

  /* ----- ore seams ---------------------------------------------------
   * A seam follows the strata: a thin bed of ore on the SEAM_PITCH ladder,
   * with a centre line that wanders and a thickness that pinches out to
   * nothing and swells again along its length. That lenticular shape is most
   * of what separates "a seam" from "a horizontal stripe".
   * ------------------------------------------------------------------ */
  function prepareSeam(ry) {
    seamOn = false;
    if (!lvl || lvl.seamP <= 0) return;
    var si = Math.floor(ry / SEAM_PITCH);
    for (var k = -1; k <= 1; k++) {
      var j = si + k;
      var cyc = (j + 0.18 + hv(S_SEAM, j, 101) * 0.64) * SEAM_PITCH;
      if (cyc < lvlTopY) continue;
      var w = oresAt(cyc);
      if (!w) continue;
      // Seams carry the density half of the whisper too — a level worked south
      // has more ore beds in it as well as better ones.
      var p = lvl.seamP * densAt(cyc);
      if (p > 0.9) p = 0.9;
      if (hv(S_SEAM, j, lvl.idx) >= p) continue;
      var half = SP * lerp(0.7, 2.3, hv(S_SEAM, j, 202));
      if (ry < cyc - half - SEAM_WARP - SP) continue;
      if (ry > cyc + half + SEAM_WARP + SP) continue;
      seamOn = true;
      seamJ = j;
      seamCy = cyc;
      seamHalf = half;
      seamMat = pickWeighted(w, hv(S_SEAMM, j, lvl.idx));
      seamPinch = lerp(0.30, 0.64, hv(S_SEAM, j, 303));
      return;
    }
  }

  /**
   * Gather the structures that can touch row `cy` between world x `gxLo` and
   * `gxHi`. The x range is the STRIP being filled, not the world: a column strip
   * asks about 21 units of rock and a row strip about the width of the window,
   * and the cost of the gather tracks that. In an endless map that is not an
   * optimisation any more, it is the only thing that makes the gather finite.
   */
  function prepareRow(cy, ry, L, gxLo, gxHi) {
    bbN = 0;
    gxA = gxLo; gxB = gxHi;
    gatherLodes(ry, gxLo, gxHi);
    /* DEBRIS OUTRANKS EVERYTHING BUT A MOTHERLODE. A scatter inside a coal
     * pocket has to read as the find it is, not as coal that happens to have
     * been rolled second. */
    gatherDebris(ry, gxLo, gxHi);
    gatherCaverns(ry, gxLo, gxHi);
    gatherPockets(ry, gxLo, gxHi);
    gatherDrifts(ry, gxLo, gxHi);
    prepareSeam(ry);
  }

  /* ======================================================================
   * WHAT IS AT THIS CELL?
   * -> material index, or -1 for "leave this spot empty".
   * A pure function of (mineSeed, cx, cy) and the row context prepared above.
   * =================================================================== */
  function cellMaterialAt(cx, cy, px, py, L) {
    var i, dx, dy, t;

    /* --- THE DOOR CHAMBER, at the top centre of the band ---------------
     * Cheap on the hot path, which matters: this function runs once per cell. The
     * y compare inlined here rejects everything below the chamber, which is all
     * but the top ~700 units of a level, and the call is shared with the scanner
     * and the renderer so the three can never disagree about where the excavation
     * is. THE SEAL IS NOT TESTED HERE — it beats the carve mask, so it lives one
     * level up, in generateRowStrip().
     * ---------------------------------------------------------------- */
    if (py < doorCY + DOOR_RY && py > doorCeilY &&
        px > -DOOR_HW && px < DOOR_HW && inDoorVoid(px, py)) return -1;

    /* THERE IS NO FLOOR. The mine used to end in bedrock at its stated depth and
     * this is where that was expressed; a level map runs south without limit now
     * (ARCHITECTURE.md §7), and the ONLY bedrock in the world is the ceiling —
     * which is tested one level up, in generateRowStrip(), because it has to beat
     * the carve store. Nothing replaces this branch. */

    /* --- blobs: motherlode, debris, cavern, then pocket --------------- */
    for (i = 0; i < bbN; i++) {
      dx = (px - bbX[i]) / bbRX[i];
      dy = (py - bbY[i]) / bbRY[i];
      t = dx * dx + dy * dy;
      var sh = bbShell[i];
      if (t > sh) continue;

      if (t > 1) {
        /* THE SHELL. This is the glittering wall of the cavern: an annulus of
         * ore just outside the void, ragged on its outer edge so it grades
         * back into rock instead of stopping dead. */
        var e = (t - 1) / (sh - 1);
        if (e > 0.5 && hv(S_RIM, cx ^ bbId[i], cy) < (e - 0.5) / 0.5) continue;
        return bbMat[i];
      }

      /* ANCIENT DEBRIS IS A SCATTER, NOT A LENS. Most of the blob is punched
       * back out to country rock, so what the player breaks into is a handful of
       * fragments glittering in the wall — which is what "debris" means and what
       * keeps the payout of one find bounded and legible. The fill fraction is
       * hashed per cluster, so no two look alike. */
      if (bbKind[i] === K_DEBRIS) {
        var fill = lerp(DEB_FILL[0], DEB_FILL[1],
                        (bbId[i] >>> 8 & 1023) / 1023);
        if (hv(S_DEB, cx ^ bbId[i], cy) >= fill * (1 - t * 0.55)) continue;
        return bbMat[i];
      }

      if (bbKind[i] === K_POCKET && bbMat[i] >= 0) {
        /* A SOLID ore lens, with an eroded rim so it looks weathered into the
         * rock rather than stamped on top of it. */
        if (t > 0.66 && hv(S_RIM, cx ^ bbId[i], cy) < (t - 0.66) / 0.34 * 0.8) continue;
        return bbMat[i];
      }

      /* OPEN VOID, with spoil piled on the floor. dy > 0 is the lower half:
       * +y is down, and a cavern with a clean floor looks like a bubble. */
      if (dy > 0.42 && hv(S_RIM, cx ^ bbId[i], cy + 7) < RUBBLE_FLOOR * dy) {
        return M_RUBBLE;
      }
      return -1;
    }

    /* --- old workings ------------------------------------------------- */
    for (i = 0; i < drN; i++) {
      if (px > drX0[i] && px < drX1[i] && py > drY0[i] && py < drY1[i]) {
        if (py > drY1[i] - SP && hv(S_RIM, cx ^ drId[i], cy) < 0.38) return M_RUBBLE;
        return -1;
      }
    }

    /* --- ore seam ----------------------------------------------------- */
    if (seamOn) {
      var w = noise1s(px * SEAM_WARP_F + seamJ * 7.31, S_SEAM) * SEAM_WARP;
      var d = py - (seamCy + w);
      if (d < 0) d = -d;
      var pres = noise1(px * SEAM_LENS_F + seamJ * 3.77, S_SEAMM);
      if (pres > seamPinch) {
        var swell = (pres - seamPinch) / (1 - seamPinch);
        if (d < seamHalf * swell) return seamMat;
      }
    }

    /* --- motherlode halo: the readable approach ----------------------
     * Stringers of the lode material, thickening as you close on the chamber.
     * This is the "you are getting close" signal that costs the player nothing
     * to read: it is simply in the wall in front of them, and it gets richer.
     * ---------------------------------------------------------------- */
    for (i = 0; i < hlN; i++) {
      dx = (px - hlX[i]) / hlRX[i];
      dy = (py - hlY[i]) / hlRY[i];
      var ht = Math.sqrt(dx * dx + dy * dy);
      if (ht <= 1 || ht > HALO_T) continue;
      var g = 1 - (ht - 1) / (HALO_T - 1);
      if (hv(S_HALO, cx, cy) < HALO_MAX * g * g) return hlMat[i];
    }

    /* --- country rock, in beds --------------------------------------- */
    return bedMaterial(px, py, cx, cy, L);
  }

  /**
   * THE STRATA. A layer is two or three interbedded rocks on a warped pitch.
   * render() reconstructs the SAME boundary curve (see drawStrata), so the
   * painted seam in the background lines up with the material change in the
   * deposits and a wall reads as one continuous bed rather than as texture
   * with rocks in front of it.
   */
  function bedMaterial(px, py, cx, cy, L) {
    if (!L) return M_STONE;
    var warp = noise1s(px * BED_WARP_F, S_BED + L.idx) * BED_WARP;
    var bi = Math.floor((py + warp) / L.bedPitch);
    var m = pickWeighted(L.beds, hv(S_BEDM, bi, L.idx));
    // Nodules: a small fraction of cells take a different bed's material, so
    // a bed has grain instead of being a flat fill.
    if (hv(S_SPECK, cx, cy) < BED_SPECK) {
      m = pickWeighted(L.beds, hv(S_SPECK, cx + 1013, cy));
    }
    return m;
  }

  /* ======================================================================
   * DROPPED CARGO
   *
   * A pile is cargo the player tipped out (or lost to a strand). It has to
   * come back when the band streams in again — that is what makes "I'll come
   * back for the coal" true. We take OWNERSHIP of adv.js's piles as they
   * appear (its contract is consumePile-on-respawn) and keep our own list, so
   * a pile survives the band streaming out and in repeatedly, not just once.
   * =================================================================== */
  var PILE_MAX = 64;
  var PILE_SLOTS = 12;                     // max particles one pile spawns
  /* KEEP-CLEAR. A pile must not materialise under the machine that just tipped
   * it out, because the collector would vacuum it straight back into the hold —
   * dumping the coal to make room for gold then did nothing at all. Tip it out,
   * drive off, and the heap is there on the floor behind you. Sized off the
   * live magnet radius plus a margin so it holds for every collector upgrade. */
  var PILE_CLEAR_PAD = 90;
  var PILE_NEAR = 170;                     // slot-still-belongs-to-this-pile radius

  var plX = new Float32Array(PILE_MAX);
  var plY = new Float32Array(PILE_MAX);
  var plMat = new Int32Array(PILE_MAX);
  var plUnits = new Float32Array(PILE_MAX);
  var plUp = new Uint8Array(PILE_MAX);      // 1 = currently spawned as particles
  var plPer = new Float32Array(PILE_MAX);   // cargo units per spawned particle
  var plNum = new Int32Array(PILE_MAX);     // how many particles it spawned
  var plSlot = new Int32Array(PILE_MAX * PILE_SLOTS);
  var plN = 0;

  function addPile(x, y, m, units) {
    if (plN >= PILE_MAX) return;
    plX[plN] = x; plY[plN] = y; plMat[plN] = m;
    plUnits[plN] = units > 0 ? units : 1;
    plUp[plN] = 0;
    plPer[plN] = 0;
    plNum[plN] = 0;
    plN++;
  }

  /** Swap-remove, keeping every parallel array and the slot block in step. */
  function dropPileRecord(i) {
    var last = plN - 1;
    if (i !== last) {
      plX[i] = plX[last]; plY[i] = plY[last]; plMat[i] = plMat[last];
      plUnits[i] = plUnits[last]; plUp[i] = plUp[last];
      plPer[i] = plPer[last]; plNum[i] = plNum[last];
      var a = i * PILE_SLOTS, b = last * PILE_SLOTS;
      for (var k = 0; k < PILE_SLOTS; k++) plSlot[a + k] = plSlot[b + k];
    }
    plN = last;
  }

  /**
   * A PILE IS A FINITE HEAP. Retire the record once the ore it spawned has
   * actually been picked up, and shrink it when only part of it has.
   *
   * Without this the record lived forever: every time the band streamed out and
   * back the heap respawned in full, so one dumped unit of gold was an
   * unlimited supply — dump, drive off, come back, collect, repeat. Measured at
   * roughly double payout on the first return trip alone.
   *
   * "Picked up" and "the band unloaded" look identical if you only count
   * particles, so this runs AFTER releasePilesOutside() and only inspects piles
   * still flagged `plUp` — a heap whose row has left the slab has already been
   * released and is skipped, which is what keeps it waiting on the floor.
   *
   * A slot is only still ours if it is LOOSE, carries our material and sits near
   * the heap: the pool recycles slot indices, so identity alone would count a
   * stranger's fragment as our coal. COLLECTED is deliberately NOT alive — it is
   * already flying into the hopper. A refused pickup (a full hold) leaves the
   * fragment LOOSE, so a heap you cannot carry stays exactly where it is.
   */
  function retireTakenPiles() {
    if (!plN) return;
    var d = SM.particles.data;
    var LOOSE = SM.particles.LOOSE;
    var near2 = PILE_NEAR * PILE_NEAR;

    /* ORE ONLY LEAVES BY BEING PICKED UP, AND PICKING UP ONLY HAPPENS HERE.
     * Fragments also vanish for a reason that has nothing to do with the
     * player: the streamer culls loose debris by Y, on a line that does not
     * line up with the row boundaries this module tracks, so a heap can lose
     * its particles while its row still counts as resident. Reading that as
     * "collected" retired heaps the player never even saw — measured, with the
     * record hitting zero while the machine was driving away from it.
     *
     * So a heap is only allowed to CHANGE while the machine is close enough to
     * have taken it. Anywhere else, an empty heap just means it is not
     * currently materialised: drop the flag and let it come back. */
    var vx = SM.vehicle && SM.vehicle.getX ? SM.vehicle.getX() : 0;
    var vy = SM.vehicle && SM.vehicle.getY ? SM.vehicle.getY() : 0;
    var take = PILE_NEAR;
    if (SM.vehicle && SM.vehicle.getCollectRadius) {
      var cr = SM.vehicle.getCollectRadius();
      if (cr > take) take = cr;
    }
    var take2 = take * take;

    for (var i = plN - 1; i >= 0; i--) {
      if (!plUp[i] || plNum[i] <= 0) continue;

      var base = i * PILE_SLOTS, alive = 0;
      for (var k = 0; k < plNum[i]; k++) {
        var s = plSlot[base + k];
        if (s < 0) continue;
        if (d.state[s] !== LOOSE || d.mat[s] !== plMat[i]) continue;
        var dx = d.x[s] - plX[i], dy = d.y[s] - plY[i];
        if (dx * dx + dy * dy > near2) continue;
        alive++;
      }

      var mdx = plX[i] - vx, mdy = plY[i] - vy;
      var couldTake = (mdx * mdx + mdy * mdy) <= take2;

      if (!couldTake) {
        // Out of reach, so nothing here was picked up. If the fragments are
        // gone anyway the streamer took them: un-flag it so the heap comes back
        // next time its row is filled, and leave the tally untouched.
        if (alive <= 0) plUp[i] = 0;
        continue;
      }

      if (alive <= 0) { dropPileRecord(i); continue; }
      if (alive < plNum[i]) {
        // Partly cleared: keep the remainder honest for the next visit.
        plUnits[i] = plPer[i] * alive;
        plNum[i] = alive;
        var w = 0;
        for (var k2 = 0; k2 < PILE_SLOTS; k2++) {
          var s2 = plSlot[base + k2];
          if (s2 < 0) continue;
          if (d.state[s2] !== LOOSE || d.mat[s2] !== plMat[i]) continue;
          var ex = d.x[s2] - plX[i], ey = d.y[s2] - plY[i];
          if (ex * ex + ey * ey > near2) continue;
          plSlot[base + w++] = s2;
        }
        while (w < PILE_SLOTS) plSlot[base + w++] = -1;
      }
    }
  }

  /** Adopt anything adv.js has dropped since the last check. */
  function adoptPiles() {
    if (!SM.adv || !SM.adv.getPiles) return;
    var src = SM.adv.getPiles();
    if (!src || !src.length) return;
    for (var i = src.length - 1; i >= 0; i--) {
      var p = src[i];
      if (p && p.length >= 3) addPile(p[0], p[1], p[2] | 0, p[3]);
      if (SM.adv.consumePile) SM.adv.consumePile(i);
    }
  }

  /**
   * Spawn every heap that is ready and inside the given world rectangle.
   * The rectangle is 2D now, exactly like the window: a heap dumped 900 units
   * off to one side must NOT materialise while it is outside the resident
   * window, or the pool pays for particles nobody can see and
   * retireTakenPiles() has to reason about heaps it cannot reach.
   */
  function spawnPilesInRect(xLo, yTop, xHi, yBot) {
    /* The keep-clear disc travels with the machine — see PILE_CLEAR_PAD. */
    var hasV = !!(SM.vehicle && SM.vehicle.getX);
    var vx = hasV ? SM.vehicle.getX() : 0;
    var vy = hasV ? SM.vehicle.getY() : 0;
    var reach = PILE_CLEAR_PAD;
    if (SM.vehicle && SM.vehicle.getCollectRadius) {
      var cr = SM.vehicle.getCollectRadius();
      if (cr > 0) reach += cr;
    }
    var reach2 = reach * reach;

    for (var i = 0; i < plN; i++) {
      if (plUp[i]) continue;
      if (plY[i] < yTop || plY[i] >= yBot) continue;
      if (plX[i] < xLo || plX[i] >= xHi) continue;
      if (hasV) {
        var ddx = plX[i] - vx, ddy = plY[i] - vy;
        if (ddx * ddx + ddy * ddy < reach2) continue;   // wait until we drive off
      }
      var m = plMat[i];
      var mat = SM.materials.get(m);
      var vol = 1;
      if (SM.mines && SM.mines.volumeOf) {
        var v = SM.mines.volumeOf(mat.id);
        if (v > 0.05) vol = v;
      }
      var n = Math.round(plUnits[i] / vol);
      if (n < 1) n = 1; else if (n > PILE_SLOTS) n = PILE_SLOTS;
      var r = mat.radius[0] * 0.62;
      /* Remember the slots, and what share of the heap each one carries, so
       * retireTakenPiles() can tell "the player picked this up" from "the band
       * unloaded" and shrink the heap to what is genuinely still lying there. */
      var base = i * PILE_SLOTS, got = 0;
      var per = plUnits[i] / n;
      for (var k = 0; k < n; k++) {
        var a = (k / n) * 6.2831853 + hv(S_FLOOR, i, k) * 1.7;
        var d = 6 + hv(S_FLOOR, i + 71, k) * 26;
        var slot = SM.particles.spawnLoose(plX[i] + Math.cos(a) * d, plY[i] + Math.sin(a) * d,
                                m, 0, 0, r);
        if (slot >= 0) plSlot[base + got++] = slot;
      }
      while (got < PILE_SLOTS) plSlot[base + got++] = -1;
      plNum[i] = 0;
      for (var q = 0; q < PILE_SLOTS; q++) if (plSlot[base + q] >= 0) plNum[i]++;
      plPer[i] = per;
      // The pool was full and nothing spawned: leave the heap un-materialised
      // rather than flagging it up, or it would be retired as "taken".
      if (plNum[i] <= 0) continue;
      plUp[i] = 1;
    }
  }

  /**
   * Spawn any heap that is ready, EVERY step — not only when its row happens to
   * be generated.
   *
   * Piles used to materialise purely as a side effect of row generation, which
   * stopped working the moment the keep-clear rule could decline a spawn: the
   * row is already resident by then, generation never revisits it, and the heap
   * you just tipped out never appeared at all. Retrying here is what makes
   * "drive off and it is lying there behind you" actually happen.
   */
  function spawnReadyPiles() {
    if (!plN || !haveN) return;
    var anyDown = false;
    for (var i = 0; i < plN; i++) { if (!plUp[i]) { anyDown = true; break; } }
    if (!anyDown) return;
    spawnPilesInRect(colEdgeX(haveC0), rowTopY(haveR0),
                     colEdgeX(haveC1), rowTopY(haveR1));
  }

  /**
   * A pile whose particles the streamer has just freed is no longer spawned, so
   * it will be re-spawned the next time the window covers it. The rectangle
   * passed in is therefore the KEEP rect (the one loose particles are culled
   * against), not the solid window: a heap must be un-flagged exactly when its
   * fragments die, or retireTakenPiles() sees an empty heap in reach of nothing
   * and the record drifts.
   */
  function releasePilesOutside(xLo, yTop, xHi, yBot) {
    for (var i = 0; i < plN; i++) {
      if (!plUp[i]) continue;
      if (plY[i] < yTop || plY[i] >= yBot || plX[i] < xLo || plX[i] >= xHi) plUp[i] = 0;
    }
  }

  /* ======================================================================
   * STREAMING
   * =================================================================== */

  function focusX() {
    if (focusOn) return focusFX;
    return (SM.vehicle && SM.vehicle.getX) ? SM.vehicle.getX() : 0;
  }
  function focusY() {
    if (focusOn) return focusFY;
    return (SM.vehicle && SM.vehicle.getY) ? SM.vehicle.getY() : A.MINE_CEILING_Y;
  }

  /**
   * SIZE AND PLACE THE WINDOW.
   *
   * The camera decides what has to be resident; the pool decides what may be.
   * So: take the view, ask for ADV.STREAM_MARGIN of slack around it, and then
   * spend the cell budget in a fixed order of priority —
   *
   *   1. COVER THE VIEW. A hole in the middle of the screen is the one failure
   *      the player can actually see, so the visible rectangle is bought first
   *      and only given up if it does not fit on its own (a very wide viewport;
   *      see the note below).
   *   2. BUY MARGIN, EQUALLY IN WORLD UNITS ON ALL FOUR SIDES, with whatever is
   *      left. Solving 4*(hw+m)*(hh+m) = budget for m is what makes this one
   *      number instead of a pair of fudge factors, and equal margins are what
   *      make driving sideways feel the same as driving down.
   *   3. NEVER CROSS THE HASH WRAP (WIN_MAX_W / WIN_MAX_H).
   *
   * A viewport so wide that even the bare view does not fit (past about 21:9 at
   * ADV.CAM_ZOOM) is shrunk uniformly instead: the far corners of such a screen
   * then show unstreamed rock, which is dark, rather than a corrupted spatial
   * hash, which is a bug. Before 2D windowing that screen showed bedrock walls
   * for the same reason.
   *
   * The centre follows the machine and may drift toward the camera by at most
   * WINDOW_BIAS of the half-extent on each axis, which is what guarantees the
   * machine can never be outside its own terrain.
   */
  function computeWindow(fx, fy) {
    var hw = WINDOW_MIN_HALF, hh = WINDOW_MIN_HALF;
    var camX = fx, camY = fy;
    if (SM.camera && SM.camera.getViewBounds) {
      var v = SM.camera.getViewBounds();
      var vw = (v.maxX - v.minX) * 0.5;
      var vh = (v.maxY - v.minY) * 0.5;
      if (vw > hw) hw = vw;
      if (vh > hh) hh = vh;
      camX = (v.minX + v.maxX) * 0.5;
      camY = (v.minY + v.maxY) * 0.5;
    }

    var cells = A.SOLID_BUDGET / FILL_ESTIMATE * trim;
    var area = cells * SP * SP;                    // world units the pool covers

    // 1 + 2: how much margin the leftovers buy, on all four sides.
    var m = A.STREAM_MARGIN;
    if (4 * (hw + m) * (hh + m) > area) {
      // m^2 + (hw+hh)m + (hw*hh - area/4) = 0
      var b = hw + hh;
      var disc = b * b - 4 * (hw * hh - area * 0.25);
      m = disc > 0 ? (-b + Math.sqrt(disc)) * 0.5 : -1;
      if (m < 0) {
        // The view alone is unaffordable: shrink it, keeping its shape.
        var s = Math.sqrt(area / (4 * hw * hh));
        hw *= s; hh *= s;
        m = 0;
      }
    }
    hw += m; hh += m;

    // 3: the spatial hash's wrap, with margin. See the header.
    var maxHW = (WIN_MAX_W - LOOSE_KEEP_PAD * 2) * 0.5;
    var maxHH = (WIN_MAX_H - LOOSE_KEEP_PAD * 2) * 0.5;
    if (hw > maxHW) hw = maxHW;
    if (hh > maxHH) hh = maxHH;
    if (hw < SP * 3) hw = SP * 3;
    if (hh < SP * 3) hh = SP * 3;

    var bx = camX - fx, by = camY - fy;
    var limX = hw * WINDOW_BIAS, limY = hh * WINDOW_BIAS;
    if (bx > limX) bx = limX; else if (bx < -limX) bx = -limX;
    if (by > limY) by = limY; else if (by < -limY) by = -limY;
    var cx = fx + bx, cy = fy + by;
    winL = cx - hw; winR = cx + hw;
    winTop = cy - hh; winBot = cy + hh;

    /* 4: THE ONE EDGE OF THE WORLD. A level map is unbounded east, west and
     * south, so there is exactly ONE clamp left here and it is the ceiling. This
     * block used to close all four sides; three of them are gone with the walls.
     *
     * Clamping (rather than sliding the window back inside) is right twice over:
     * it never generates rock north of the ceiling, and it can only ever REDUCE
     * the resident count, so it cannot cost budget. The machine stays inside its
     * own terrain regardless, because the machine is below the ceiling by
     * construction (js/vehicle.js's clamp) and the unclamped window always
     * contains the machine (WINDOW_BIAS).
     *
     * NOTHING ELSE BOUNDS THE WINDOW BUT THE POOL AND THE HASH, which is exactly
     * the discipline the header describes and is now doing the whole job in BOTH
     * axes rather than only in x. */
    if (bandN && winTop < bandTopY) winTop = bandTopY;

    if (winR - winL > peakWinW) peakWinW = winR - winL;
    if (winBot - winTop > peakWinH) peakWinH = winBot - winTop;
  }

  /** Free every particle in the world. Used when the window jumps. */
  function flushAll() {
    SM.particles.despawnAhead(1e12);
    haveN = false;
    for (var i = 0; i < plN; i++) plUp[i] = 0;
  }

  /**
   * Recycle down to the desired cell rectangle.
   *
   * TWO RECTANGLES, AND THE OUTER ONE IS NOT OPTIONAL.
   *
   * The inner call frees embedded terrain only (keepLoose), because loose ore is
   * the player's property: debris you shook out of the wall behind you is still
   * lying there when you reverse, and a dumped heap is made of loose particles.
   *
   * The outer call, LOOSE_KEEP_PAD further out, frees everything. Without it
   * loose material would never be collected at all — a heap dumped 3000 units
   * away would stay live for the whole descent, which leaks the pool AND, far
   * worse, puts two live particles more than 2944 units apart, which is where
   * particles.js's wrapped spatial hash starts aliasing them into the same cell.
   * It is also what the old despawnBehind/despawnAhead pair did for free.
   *
   * Both rectangles are clamped to the hash box around the machine, so however
   * the window is placed the live extent stays inside one wrap.
   *
   * The cut lines are exact CELL boundaries: rowTopY() and colEdgeX(). A
   * deposit's jitter cannot reach either of them (see the header), so a strip is
   * never half-recycled — a half strip would be regenerated on top of its own
   * survivors at double density.
   */
  function trimTo(c0, c1, r0, r1) {
    var xL = colEdgeX(c0), xR = colEdgeX(c1);
    var yT = rowTopY(r0), yB = rowTopY(r1);
    SM.particles.despawnOutsideRect(xL, yT, xR, yB, true);

    var kL = xL - LOOSE_KEEP_PAD, kR = xR + LOOSE_KEEP_PAD;
    var kT = yT - LOOSE_KEEP_PAD, kB = yB + LOOSE_KEEP_PAD;
    var mx = focusX(), my = focusY();
    var hx = WIN_MAX_W * 0.5, hy = WIN_MAX_H * 0.5;

    /* THE HASH CLAMP CAN CUT INSIDE THE WINDOW, AND IT HAS TO CUT ON CELL EDGES.
     *
     * Normally this clamp sits well outside the solid window and only bounds
     * stray debris. But the window is SIZED from the camera and PLACED around the
     * streaming focus, so when the two diverge the bias (up to WINDOW_BIAS of the
     * half-extent) can push the window's far edge more than WIN_MAX_W/2 from the
     * focus and the clamp lands INSIDE it. That is not exotic: drive to the far
     * wall of a 5200-wide mine and camera.js stops panning (ADV_WALL_PEEK) while
     * the machine keeps going, which is exactly that divergence. Measured, with a
     * scripted focus 2600 units from the camera, a returning window came back at
     * 1837 of 5106 solids and stayed there.
     *
     * Two things were wrong and both are fixed here. The cut was at an arbitrary
     * x, which splits a column and leaves half a strip alive — the double-density
     * hazard the header warns about — so it is snapped to the cell lattice. And
     * the emptied strips still counted as RESIDENT, so the fill loop never
     * regenerated them: a hole in the ground the streamer believed it had filled,
     * permanent until the window jumped clear and re-filled from scratch. Folding
     * the clamp into the resident rectangle is what makes it heal. */
    if (kL < mx - hx) kL = colEdgeX(Math.ceil((mx - hx - x0) / SP));
    if (kR > mx + hx) kR = colEdgeX(Math.floor((mx + hx - x0) / SP));
    if (kT < my - hy) kT = rowTopY(Math.ceil((my - hy - y0) / SP));
    if (kB > my + hy) kB = rowTopY(Math.floor((my + hy - y0) / SP));
    SM.particles.despawnOutsideRect(kL, kT, kR, kB, false);

    if (haveC0 < c0) haveC0 = c0;
    if (haveC1 > c1) haveC1 = c1;
    if (haveR0 < r0) haveR0 = r0;
    if (haveR1 > r1) haveR1 = r1;
    /* Whatever the clamp emptied is not resident any more. In the ordinary case
     * these four are no-ops — the keep rect is LOOSE_KEEP_PAD outside the window,
     * so its cell range is strictly wider than the resident one. */
    var kc0 = colOfX(kL), kc1 = colOfX(kR);
    var kr0 = cellYOf(kT), kr1 = cellYOf(kB);
    if (haveC0 < kc0) haveC0 = kc0;
    if (haveC1 > kc1) haveC1 = kc1;
    if (haveR0 < kr0) haveR0 = kr0;
    if (haveR1 > kr1) haveR1 = kr1;
    if (haveC0 >= haveC1 || haveR0 >= haveR1) haveN = false;
    releasePilesOutside(kL, kT, kR, kB);

    if (kR - kL > peakLiveW) peakLiveW = kR - kL;
    if (kB - kT > peakLiveH) peakLiveH = kB - kT;
  }

  /**
   * Is there room in the pool for `n` more deposits?
   * `+ n` and not `>=`: a strip is up to n deposits, so testing the budget
   * against the CURRENT count lets one whole strip over the ceiling. It measured
   * 75 deposits of overshoot before this said what it meant.
   */
  function canAfford(n) {
    var st = SM.particles.getStats();
    if (st.free < DEBRIS_RESERVE + n + 8) return false;
    return st.solid + n <= A.SOLID_BUDGET;
  }

  /**
   * Fill cells [c0, c1) of row cy. Returns false when the pool is too tight to
   * afford the strip, which is the graceful failure: streaming pauses for a step
   * or two while the debris in flight is collected or despawned.
   *
   * ONLY THE NORTH IS SKIPPED. There is nothing east, west or south of a level
   * map — it simply continues — so the only cells this refuses are the ones ABOVE
   * the ceiling, which no window should ever ask for anyway (computeWindow clamps
   * there too) and which cost nothing to refuse if one does.
   *
   * AND THE CEILING BEATS THE CARVE STORE. The border rows spawn bedrock BEFORE
   * the carvedCell() consult below, and that order is the one measured truth this
   * whole feature hangs off (ARCHITECTURE.md §7): the store is the mine's whole
   * history, saved with the company, and a tunnel that reached what is now the
   * ceiling would otherwise punch a player-shaped hole straight through the one
   * wall in the game — a hole that persists in the save file forever. Sealing over
   * such a tunnel is accepted and deliberate; a seal with holes in it is not a
   * seal. (Precedent, same shape, same reason: the sub-floor bedrock strip that
   * used to live in cellMaterialAt().)
   */
  function generateRowStrip(cy, c0, c1) {
    if (c1 <= c0) return true;
    if (!canAfford(c1 - c0)) return false;
    if (cy < bandR0) return true;                  // north of the world's roof

    var yMid = rowMidY(cy);
    var stag = rowStagger(cy);
    var cx, px, py;

    if (yMid > deepestY) deepestY = yMid;

    /* THE CEILING. SEAL_ROWS whole rows of bedrock at the top of the map, decided
     * by an integer cell test before a single position is computed — see the
     * CEILING note in the tunables. */
    var sealRow = (cy < bandR0 + SEAL_ROWS);
    var brad = Math.min(11, SM.materials.get(M_BEDROCK).radius[0] * RAD_GAIN);

    var L = lvl;
    if (!sealRow) prepareRow(cy, yMid, L, colEdgeX(c0), colEdgeX(c1));

    for (cx = c0; cx < c1; cx++) {
      px = x0 + (cx + 0.5) * SP + stag + (hv(S_JX, cx, cy) * 2 - 1) * SP * JITTER_X;
      py = yMid + (hv(S_JY, cx, cy) * 2 - 1) * SP * JITTER;

      if (sealRow) {
        SM.particles.spawnSolid(px, py, M_BEDROCK, brad);
        continue;
      }
      if (carvedCell(cx, cy)) continue;            // already dug out

      var m = cellMaterialAt(cx, cy, px, py, L);
      if (m < 0) continue;
      var mm = SM.materials.get(m);
      var rad = mm.radius[0] + hv(S_SPECK, cx, cy + 4099) * (mm.radius[1] - mm.radius[0]);
      rad *= RAD_GAIN;
      if (rad > C.SPRITE_MAX_RADIUS) rad = C.SPRITE_MAX_RADIUS;
      SM.particles.spawnSolid(px, py, m, rad);
    }
    return true;
  }

  /**
   * Fill column cx of rows [r0, r1) — the lateral half of the job.
   *
   * It costs one prepareRow() per row for a single cell of output, which sounds
   * wasteful and is not: the gather is asked about a 21-unit-wide slice of rock,
   * so it looks at one or two structure cells per family rather than the two
   * dozen a full-width row needs. Measured, a column strip of 60 rows costs
   * about the same as two full row strips.
   */
  function generateColStrip(cx, r0, r1) {
    if (r1 <= r0) return true;
    if (!canAfford(r1 - r0)) return false;
    for (var cy = r0; cy < r1; cy++) generateRowStrip(cy, cx, cx + 1);
    return true;
  }

  /**
   * Fill the whole rectangle, rows outward from the focus row.
   *
   * Used for the one-shot fill when a mine is entered and whenever the window
   * jumps clear of what we hold. Row-major on purpose: one prepareRow() per row
   * instead of one per cell of a column walk, which is the difference between a
   * 60-row fill costing 60 gathers and costing 5000.
   *
   * OUTWARD FROM THE FOCUS, so that if the pool refuses a row the resident
   * rectangle stays contiguous AND the machine keeps the terrain nearest it.
   */
  function fillRect(c0, c1, r0, r1, fy) {
    haveC0 = c0; haveC1 = c1;
    var mid = cellYOf(fy);
    if (mid < r0) mid = r0; else if (mid >= r1) mid = r1 - 1;
    haveR0 = mid; haveR1 = mid;
    haveN = true;
    var down = true;
    while (haveR0 > r0 || haveR1 < r1) {
      var canDown = haveR1 < r1, canUp = haveR0 > r0;
      down = canDown && (!canUp || down);
      if (down) {
        if (!generateRowStrip(haveR1, c0, c1)) break;
        haveR1++;
        down = false;
      } else {
        if (!generateRowStrip(haveR0 - 1, c0, c1)) break;
        haveR0--;
        down = true;
      }
    }
    // Nothing at all got in (a pool that tight can only happen mid-run): claim
    // nothing, and the next step tries again.
    if (haveR1 <= haveR0) haveN = false;
  }

  /**
   * One streaming pass. `maxCells` bounds the work: CELLS_PER_STEP while
   * playing, unbounded for the one-shot fill when a mine is entered.
   */
  function streamPass(maxCells) {
    var fx = focusX(), fy = focusY();
    computeWindow(fx, fy);

    wantC0 = colOfX(winL);
    wantC1 = colOfX(winR) + 1;
    wantR0 = cellYOf(winTop);
    wantR1 = cellYOf(winBot) + 1;
    /* THE CEILING IS THE HARD EDGE, in cells, so the outermost resident row of a
     * level is exactly its seal — no off-by-one strip of unsealed rock at the top,
     * and no strip of seal the streamer believes it is missing and re-asks for
     * every step. computeWindow() has already clamped the world box; this is the
     * same clamp on the lattice, and it is the one the fill loop and trimTo()
     * actually walk. THE OTHER THREE SIDES HAVE NO CLAMP because there is nothing
     * to clamp against — the pool and the hash bound them, and they do it in both
     * axes now (see WIN_MAX_W / WIN_MAX_H and trimTo). */
    if (bandN && wantR0 < bandR0) wantR0 = bandR0;
    if (wantC1 <= wantC0) wantC1 = wantC0 + 1;
    if (wantR1 <= wantR0) wantR1 = wantR0 + 1;

    if (!haveN || haveC1 <= wantC0 || haveC0 >= wantC1 ||
        haveR1 <= wantR0 || haveR0 >= wantR1) {
      /* The window has jumped clear of what we hold — a descent, a re-entry, a
       * teleport in a test. Start over rather than stitching two disjoint
       * rectangles together. */
      flushAll();
      fillRect(wantC0, wantC1, wantR0, wantR1, fy);
      sweepTick = 0;
      return;
    }

    if (++sweepTick >= DESPAWN_INTERVAL) {
      sweepTick = 0;
      trimTo(wantC0, wantC1, wantR0, wantR1);
      if (!haveN) { flushAll(); fillRect(wantC0, wantC1, wantR0, wantR1, fy); return; }
    }

    /* GROW THE NEAREST EDGE FIRST. A hole 40 units from the drill matters; a
     * hole 900 units behind the machine does not. Distances are measured from
     * the machine to each of the four edges, and the smallest one is the edge
     * that gets this iteration's strip. */
    var budget = maxCells;
    var rowN = haveC1 - haveC0;
    var colN = haveR1 - haveR0;
    while (budget > 0) {
      var dL = (haveC0 > wantC0) ? (fx - colEdgeX(haveC0)) : 1e12;
      var dR = (haveC1 < wantC1) ? (colEdgeX(haveC1) - fx) : 1e12;
      var dT = (haveR0 > wantR0) ? (fy - rowTopY(haveR0)) : 1e12;
      var dB = (haveR1 < wantR1) ? (rowTopY(haveR1) - fy) : 1e12;
      var best = dL, which = 0;
      if (dR < best) { best = dR; which = 1; }
      if (dT < best) { best = dT; which = 2; }
      if (dB < best) { best = dB; which = 3; }
      if (best > 1e11) break;                      // nothing left to grow

      if (which === 0) {
        if (!generateColStrip(haveC0 - 1, haveR0, haveR1)) break;
        haveC0--; budget -= colN;
      } else if (which === 1) {
        if (!generateColStrip(haveC1, haveR0, haveR1)) break;
        haveC1++; budget -= colN;
      } else if (which === 2) {
        if (!generateRowStrip(haveR0 - 1, haveC0, haveC1)) break;
        haveR0--; budget -= rowN;
      } else {
        if (!generateRowStrip(haveR1, haveC0, haveC1)) break;
        haveR1++; budget -= rowN;
      }
      rowN = haveC1 - haveC0;
      colN = haveR1 - haveR0;
    }
  }

  /**
   * Watch the pool and shrink the window if the geology turns out to be denser
   * than FILL_ESTIMATE guessed. This is the belt to the braces in
   * generateRowStrip(): that one stops streaming, this one gives the space back.
   */
  function adaptBudget() {
    var st = SM.particles.getStats();
    if (st.solid > peakSolid) peakSolid = st.solid;
    if (st.free < lowFree) lowFree = st.free;
    if (st.solid > A.SOLID_BUDGET * BUDGET_EASE || st.free < DEBRIS_RESERVE) {
      trim -= TRIM_DOWN;
      if (trim < TRIM_MIN) trim = TRIM_MIN;
    } else if (trim < 1) {
      trim += TRIM_UP;
      if (trim > 1) trim = 1;
    }
  }

  /* ======================================================================
   * LAYER AND MOTHERLODE AWARENESS
   * =================================================================== */
  var lastLayer = -1;
  var ANN_MAX = 12;
  var annIds = new Int32Array(ANN_MAX);
  var annN = 0;

  function trackLayer(fy) {
    if (!layers.length) return;
    var li = layerIndexAtY(fy);
    if (li === lastLayer) return;
    lastLayer = li;
    evLayer.name = layers[li].name;
    evLayer.depthM = depthOfY(fy);
    SM.events.emit('mine:layer', evLayer);
    // A new layer is a new set of rock: a real scanner would be re-run here.
    if (SM.scanner && SM.scanner.ping) SM.scanner.ping();
  }

  function announced(id) {
    for (var i = 0; i < annN; i++) if (annIds[i] === id) return true;
    return false;
  }

  /** Fire `mine:lode` the first time the machine comes near a motherlode. */
  function trackLode(fx, fy) {
    if (!gldValid || annN >= ANN_MAX) return;
    var j0 = Math.floor((fy - LODE_ANNOUNCE - LODE_H) / LODE_H);
    var j1 = Math.floor((fy + LODE_ANNOUNCE + LODE_H) / LODE_H);
    var i0 = cellI0(fx, LODE_W, LODE_ANNOUNCE + LODE_W);
    var i1 = cellI1(fx, LODE_W, LODE_ANNOUNCE + LODE_W);
    for (var j = j0; j <= j1; j++) {
      for (var i = i0; i <= i1; i++) {
        if (!lodeOfCell(i, j)) continue;
        testLodeAnnounce(fx, fy, lodeX, lodeY, lodeMat, lodeId);
      }
    }
    testLodeAnnounce(fx, fy, gldX, gldY, gldMat, gldId);
  }

  function testLodeAnnounce(fx, fy, lx, ly, m, id) {
    if (announced(id)) return;
    var dx = fx - lx, dy = fy - ly;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d > LODE_ANNOUNCE) return;
    if (annN < ANN_MAX) annIds[annN++] = id;
    evLode.x = lx; evLode.y = ly; evLode.matIndex = m; evLode.dist = d;
    SM.events.emit('mine:lode', evLode);
  }

  /* ======================================================================
   * MINE LIFECYCLE
   * =================================================================== */

  function beginMine(def, mineState) {
    resolveMaterials();

    mineDef = def || null;
    mineStateRef = mineState || null;
    mineSeed = (def && typeof def.seed === 'number') ? (def.seed | 0) : 1337;
    /* EVERY COMPANY DIGS ITS OWN WORLD. The catalogue seed alone made every new
     * game byte-identical — same geology, same guaranteed lode in the same spot.
     * Folding in the company's worldSeed varies all of it per company while
     * keeping it eternal per company (the carve store is diffs against this).
     * A legacy record answers 0 and takes the pure catalogue seed, so old
     * tunnels keep matching the rock they were dug through. */
    var ws = (SM.save && SM.save.getWorldSeed) ? (SM.save.getWorldSeed() | 0) : 0;
    if (ws) mineSeed = h3(mineSeed, ws, S_WORLD) | 0;
    mineDepthM = (def && def.depth > 0) ? def.depth : 400;

    buildGrid();
    allocCarve();
    buildLayers(def);
    buildTiles();
    /* BEFORE the first fill: the level, its ceiling and its doors are part of the
     * geology this mine generates, not something painted on afterwards. The level
     * js/adv.js is entering on is asked for, never assumed — and a build where it
     * cannot answer starts on level 1, which is the one every company owns.
     *
     * setBand() is also what sets genSeed and builds the ore buckets and the
     * guaranteed lode, so nothing above it may resolve a structure. */
    loaded = true;                     // resolveBands/setBand need the geometry
    resolveBands(def);
    var L0 = 1;
    if (SM.adv && typeof SM.adv.getLevel === 'function') {
      var g = SM.adv.getLevel();
      if (typeof g === 'number' && isFinite(g) && g >= 1) L0 = Math.floor(g);
    }
    setBand(L0);
    needFill = false;

    /* RESTORE THE TUNNELS — every level's, in one go. The store is keyed on
     * (level, chunkX, chunkY), so a company's whole history in this mine comes
     * back at once and riding to a level it has worked before finds its own
     * workings there. A corrupt store costs the player their tunnels and nothing
     * else: js/save.js's decoder returns null rather than guessing. */
    if (mineState) {
      var cv = mineState.carve;
      if (cv && typeof cv === 'string' && cv.length &&
          SM.save && SM.save.decodeCarve) {
        var desc = null;
        try { desc = SM.save.decodeCarve(cv); } catch (e) { desc = null; }
        if (desc) importCarve(desc);
      }
      // Piles left underground last visit.
      if (mineState.piles && mineState.piles.length) {
        for (var i = 0; i < mineState.piles.length; i++) {
          var p = mineState.piles[i];
          if (p && p.length >= 3) addPile(p[0], p[1], p[2] | 0, p[3]);
        }
      }
    }

    deepestY = A.MINE_CEILING_Y;
    lastLayer = -1;
    annN = 0;
    trim = 1;
    peakSolid = 0;
    lowFree = 1e9;
    haveN = false;
    sweepTick = 0;
    active = true;
    loaded = true;

    // Fill the whole window now: entering a mine is a screen transition, so this
    // is the one moment a few thousand spawns in one step costs nothing.
    streamPass(1e9);
    spawnReadyPiles();
    SM.particles.rebuildGrid();
    trackLayer(focusY());
  }

  /**
   * End the RUN and hand the carve store back for saving. Also writes the
   * still-buried piles into the mine's save record if it has one, so dropped
   * cargo survives a session and not just a window recycle.
   *
   * Deliberately does NOT unload the geology — see the two-flag note at the top.
   * The extraction card, the world map and the workshop all render over a live
   * mine, and dropping the layer table here is what made them render over the
   * classic time-attack lane instead. unload() is the other half.
   */
  function endMine() {
    var out = '';
    if (chunkIx && SM.save && SM.save.encodeCarve) {
      try { out = SM.save.encodeCarve(exportCarve()) || ''; } catch (e) { out = ''; }
    }
    if (mineStateRef) {
      try {
        var arr = [];
        for (var i = 0; i < plN; i++) arr.push([plX[i], plY[i], plMat[i], plUnits[i]]);
        mineStateRef.piles = arr;
      } catch (e2) { /* a save record we cannot write is not a crash */ }
    }
    active = false;
    plN = 0;
    haveN = false;
    mineStateRef = null;
    return out;
  }

  /**
   * Forget the mine entirely. NOT optional any more: main.js renders this
   * module unconditionally, so `loaded` is the only thing standing between a
   * closed campaign and a level's bedrock box painted behind the title screen.
   * js/adv.js close() is the caller.
   */
  function unload() {
    active = false;
    loaded = false;
    plN = 0;
    haveN = false;
    mineStateRef = null;
    mineDef = null;
    /* The LEVEL belongs to the mine, not to the session. endMine() deliberately
     * keeps it (the world still renders behind the results card); this is the
     * other half, and it must leave bandN at 0 so nothing carves, nothing streams
     * and getLevelBounds() answers null rather than a zero box. */
    bands.length = 0;
    bandN = 0;
    bandR0 = 0;
    lvl = null;
    oreTab.length = 0;
    gldValid = false;
    needFill = false;
    doorArt = null;
    doorOpen = 0;
    doorHeld = false;
  }

  /**
   * Re-descend the SAME mine: clear the streamed window and refill around the
   * machine. The mask survives, deliberately — the tunnels the player dug are
   * the mine's history, not the run's.
   */
  function reset() {
    if (!active) return;
    flushAll();
    deepestY = A.MINE_CEILING_Y;
    lastLayer = -1;
    trim = 1;
    peakSolid = 0;
    lowFree = 1e9;
    sweepTick = 0;
    for (var i = 0; i < plN; i++) plUp[i] = 0;
    streamPass(1e9);
    spawnReadyPiles();
    SM.particles.rebuildGrid();
    trackLayer(focusY());
  }

  /**
   * ONE FIXED STEP. Reached through js/terrain.js's adventure branch, so it is
   * called exactly once per step, in terrain's slot in main.js's order — before
   * vehicle.update(), which is what guarantees the cutter never reaches rock
   * that has not been generated.
   *
   * IT ALSO DRIVES THE SCANNER. Nothing in the frozen loop calls
   * SM.scanner.update(): main.js's order predates it and adv.js's contract does
   * not mention it. Rather than ask for a change to a frozen file, the world
   * module drives the instrument that reads the world, with `stepId` as the
   * token that makes a duplicate call from anywhere else a no-op.
   */
  var stepId = 0;

  function update(dt) {
    if (!active) return;
    adoptPiles();
    /* THE RIDE'S OWED FILL. beginLevel() freed the old level's rock and left this
     * flag: spend it HERE, one step later, because by now js/adv.js has parked the
     * machine at the new level's doors and the camera has snapped to it. Unbounded
     * on purpose — it is the same one-shot fill entering a mine does, in a frame
     * the player is looking at a transition in. */
    var full = needFill;
    needFill = false;
    streamPass(full ? 1e9 : CELLS_PER_STEP);
    spawnReadyPiles();
    if (full) SM.particles.rebuildGrid();
    // AFTER streaming: releasePilesOutside() has already un-flagged any heap
    // whose fragments the sweep freed, so what is left flagged is genuinely
    // resident and a missing fragment really was collected. Order is the whole
    // correctness argument here — see retireTakenPiles().
    retireTakenPiles();
    var fy = focusY();
    trackLayer(fy);
    trackLode(focusX(), fy);
    animateDoor(dt);
    adaptBudget();
    if (SM.scanner && SM.scanner.update) SM.scanner.update(dt, ++stepId);
  }

  function init() {
    resolveMaterials();
    SM.events.on('material:destroyed', onDestroyed);
    /* NO `lift:bought` LISTENER ANY MORE. Buying a level used to re-cut the
     * resident band, because the shaft grew downward through the map you were
     * standing in. A level is its own map now: the purchase changes what the door
     * menu will let you ride to and nothing whatever about the rock around you,
     * and the re-cut happens on the ride, in beginLevel(). */
  }

  /** HOT: up to ~150 per step. One integer decode and one byte write. */
  function onDestroyed(p) {
    if (!active) return;
    markDestroyed(p.x, p.y);
  }

  function isActive() { return active; }

  /* ======================================================================
   * QUERIES
   * =================================================================== */
  function depthOfY(y) {
    var d = (y - A.MINE_CEILING_Y) * A.METERS_PER_UNIT;
    return d > 0 ? d : 0;
  }
  function yOfDepth(m) { return A.MINE_CEILING_Y + m / A.METERS_PER_UNIT; }
  function getGeneratedTo() { return deepestY; }

  /* ----- scanner support ---------------------------------------------
   * The scanner's whole point is seeing ore behind rock that has NOT streamed
   * in, so these answer from the generator. They do not walk cells either:
   * every ore body in this world is a STRUCTURE with a centre and a size, so
   * we enumerate the structures whose grid cells fall inside the range and
   * report one contact per FORMATION. That is both far cheaper than a cell
   * walk and a better answer — "one signature per seam" is what an instrument
   * would say, where a cell walk would return a cloud of dots.
   * ------------------------------------------------------------------ */

  var SCAN_MAX = 8;

  /**
   * Contact slots are allocated LAZILY INTO THE CALLER'S ARRAY and then reused
   * forever, which is why probeAll() takes an `out` rather than returning one.
   * A shared pool would be a real bug here: js/scanner.js keeps its contacts
   * across sweeps and hangs its own display state on them, so a call to
   * probe() from anywhere else would silently rewrite the live HUD readout.
   * One array, one set of objects, at most SCAN_MAX of them, ever.
   */
  function slotIn(out, i) {
    var s = out[i];
    if (!s) {
      s = { x: 0, y: 0, matIndex: 0, dist: 0, strength: 0, size: 0 };
      out[i] = s;
    }
    return s;
  }

  /** Rough "how big a deal is this" score, 0..1. */
  function contactStrength(m, rx, ry, dist, range) {
    var v = SM.materials.get(m).baseValue;
    var vol = Math.sqrt(rx * ry);
    var raw = (v * vol) / 4200;                 // ~1 for a decent gold pocket
    if (raw > 1) raw = 1;
    var near = 1 - (dist / range) * 0.55;
    return raw * (near > 0 ? near : 0);
  }

  var scanN = 0;
  function addContact(out, x, y, m, dist, strength, size) {
    if (!SM.materials.get(m).ore) return;        // spoil is not a signature
    var i;
    // Merge with an existing contact of the same material close by, so one
    // formation reported twice stays one contact.
    for (i = 0; i < scanN; i++) {
      var c = out[i];
      if (c.matIndex !== m) continue;
      var dx = c.x - x, dy = c.y - y;
      if (dx * dx + dy * dy < 260 * 260) {
        if (strength > c.strength) {
          c.x = x; c.y = y; c.dist = dist; c.strength = strength; c.size = size;
        }
        return;
      }
    }
    if (scanN < SCAN_MAX) {
      var s = slotIn(out, scanN);
      s.x = x; s.y = y; s.matIndex = m; s.dist = dist;
      s.strength = strength; s.size = size;
      scanN++;
      return;
    }
    // Full: displace the weakest contact if this one beats it.
    var worst = 0;
    for (i = 1; i < scanN; i++) if (out[i].strength < out[worst].strength) worst = i;
    if (strength > out[worst].strength) {
      var w = out[worst];
      w.x = x; w.y = y; w.matIndex = m; w.dist = dist;
      w.strength = strength; w.size = size;
    }
  }

  function tryContact(out, x, y, m, rx, ry, px, py, range) {
    if (m < 0) return;
    var dx = x - px, dy = y - py;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d > range) return;
    /* A formation the player has already mined out should stop answering — and so
     * should one the door chamber's excavation removed, or one north of the
     * ceiling. That last test is the only one of the old four left: an instrument
     * that points at ore behind the one wall in the game is an instrument lying
     * about the only rule the mode has. East, west and south there is nothing to
     * lie about, because everything the scanner can see is reachable. */
    if (y < lvlTopY) return;
    if (isCarved(x, y)) return;
    if (inDoorVoid(x, y)) return;
    addContact(out, x, y, m, d, contactStrength(m, rx, ry, d, range),
               Math.sqrt(rx * ry));
  }

  /**
   * Every ore formation within `range` of (x, y), written into the caller's
   * array as {x, y, matIndex, dist, strength, size}. -> count written.
   */
  function probeAll(px, py, range, out) {
    scanN = 0;
    if (!loaded || !out || !(range > 0)) return 0;
    var i, j, L;

    /* --- motherlodes (including the guaranteed one) ------------------- */
    var j0 = Math.floor((py - range - LODE_H) / LODE_H);
    var j1 = Math.floor((py + range + LODE_H) / LODE_H);
    var li0 = cellI0(px, LODE_W, range + LODE_W);
    var li1 = cellI1(px, LODE_W, range + LODE_W);
    for (j = j0; j <= j1; j++) {
      for (i = li0; i <= li1; i++) {
        if (!lodeOfCell(i, j)) continue;
        tryContact(out, lodeX, lodeY, lodeMat, lodeRX * 1.35, lodeRY * 1.35, px, py, range);
      }
    }
    if (gldValid) {
      tryContact(out, gldX, gldY, gldMat, gldRX * 1.35, gldRY * 1.35, px, py, range);
    }

    /* --- ANCIENT DEBRIS ------------------------------------------------
     * FIRST after the motherlodes, and its own pass rather than a special case
     * inside the pocket walk, because it is the only contact in the game the
     * player is genuinely hunting. It reports at 1.6x its real radius: a scatter
     * is small, and a signature the instrument can barely see is a signature the
     * player will never chase. addContact() ranks by material value after that,
     * and ancient is the dearest thing in the table, so a find is ALWAYS the
     * headline arrow for as long as it is in range. */
    L = lvl;
    if (L && L.debP > 0) {
      var di0 = Math.floor((px - range) / DEB_W), di1 = Math.floor((px + range) / DEB_W);
      var dj0 = Math.floor((py - range) / DEB_H), dj1 = Math.floor((py + range) / DEB_H);
      for (j = dj0; j <= dj1; j++) {
        for (i = di0; i <= di1; i++) {
          if (hv(S_DEB, i, j) >= L.debP) continue;
          var dyw = j * DEB_H + hv(S_DEB, i * 37 + 3, j) * DEB_H;
          var dr = lerp(DEB_R[0], DEB_R[1], hv(S_DEB, i * 37 + 1, j));
          var dxw = i * DEB_W + hv(S_DEB, i * 37 + 2, j) * DEB_W;
          tryContact(out, dxw, dyw, L.debMat, dr * 1.6, dr * 1.6, px, py, range);
        }
      }
    }

    /* --- pockets and mineralised caverns ------------------------------ */
    if (L && L.pocketP > 0) {
      var pi0 = Math.floor((px - range) / POCKET_W), pi1 = Math.floor((px + range) / POCKET_W);
      var pj0 = Math.floor((py - range) / POCKET_H), pj1 = Math.floor((py + range) / POCKET_H);
      for (j = pj0; j <= pj1; j++) {
        for (i = pi0; i <= pi1; i++) {
          var cyw = j * POCKET_H + hv(S_POCK, i * 17 + 5, j) * POCKET_H;
          var pp = L.pocketP * densAt(cyw);
          if (pp > 0.85) pp = 0.85;
          if (hv(S_POCK, i, j) >= pp) continue;
          if (hv(S_POCKM, i, j) < L.vug) continue;           // hollow, no ore
          var big = hv(S_POCK, i * 17 + 1, j) < POCKET_BIG;
          var rx = big
            ? lerp(POCKET_MAX_R, POCKET_BIG_R, hv(S_POCK, i * 17 + 2, j))
            : lerp(POCKET_MIN_R, POCKET_MAX_R, hv(S_POCK, i * 17 + 2, j));
          var ryd = rx * lerp(0.48, 0.95, hv(S_POCK, i * 17 + 3, j));
          var cxw = i * POCKET_W + hv(S_POCK, i * 17 + 4, j) * POCKET_W;
          tryContact(out, cxw, cyw, pickWeighted(oresAt(cyw), hv(S_POCKM, i + 5, j)),
                     rx, ryd, px, py, range);
        }
      }
    }
    if (L && L.cavernP > 0) {
      var ci0 = Math.floor((px - range) / CAVERN_W), ci1 = Math.floor((px + range) / CAVERN_W);
      var cj0 = Math.floor((py - range) / CAVERN_H), cj1 = Math.floor((py + range) / CAVERN_H);
      for (j = cj0; j <= cj1; j++) {
        for (i = ci0; i <= ci1; i++) {
          if (hv(S_CAVM, i, j) >= CAVERN_MINERAL) continue;
          var ccy = j * CAVERN_H + hv(S_CAV, i * 31 + 4, j) * CAVERN_H;
          if (hv(S_CAV, i, j) >= L.cavernP) continue;
          var crx = lerp(CAVERN_MIN_R, CAVERN_MAX_R, hv(S_CAV, i * 31 + 1, j));
          var cry = crx * lerp(0.44, 0.86, hv(S_CAV, i * 31 + 2, j));
          var ccx = i * CAVERN_W + hv(S_CAV, i * 31 + 3, j) * CAVERN_W;
          tryContact(out, ccx, ccy, pickWeighted(oresAt(ccy), hv(S_CAVM, i + 13, j)),
                     crx, cry, px, py, range);
        }
      }
    }

    /* --- seams: report the nearest point on the bed, not its centre --- */
    if (L && L.seamP > 0) {
      var s0 = Math.floor((py - range) / SEAM_PITCH), s1 = Math.floor((py + range) / SEAM_PITCH);
      for (j = s0; j <= s1; j++) {
        var scy = (j + 0.18 + hv(S_SEAM, j, 101) * 0.64) * SEAM_PITCH;
        var sp2 = L.seamP * densAt(scy);
        if (sp2 > 0.9) sp2 = 0.9;
        if (hv(S_SEAM, j, L.idx) >= sp2) continue;
        var half = SP * lerp(0.7, 2.3, hv(S_SEAM, j, 202));
        var pinch = lerp(0.30, 0.64, hv(S_SEAM, j, 303));
        // Walk a few sample x positions across the range: a seam is long, so the
        // contact should be the part of it nearest the machine. There are no
        // walls to reject a sample against any more — the bed simply continues.
        var bestD = 1e12, bestX = 0, bestY = 0, bestSw = 0;
        for (var k = -3; k <= 3; k++) {
          var sx = px + k * (range / 3);
          var pres = noise1(sx * SEAM_LENS_F + j * 3.77, S_SEAMM);
          if (pres <= pinch) continue;
          var sw = (pres - pinch) / (1 - pinch);
          var sy = scy + noise1s(sx * SEAM_WARP_F + j * 7.31, S_SEAM) * SEAM_WARP;
          var dx = sx - px, dy = sy - py;
          var d2 = dx * dx + dy * dy;
          if (d2 < bestD) { bestD = d2; bestX = sx; bestY = sy; bestSw = sw; }
        }
        if (bestD < 1e12) {
          tryContact(out, bestX, bestY,
                     pickWeighted(oresAt(scy), hv(S_SEAMM, j, L.idx)),
                     half * bestSw * 5, half * bestSw, px, py, range);
        }
      }
    }

    return scanN;
  }

  var probeOut = [];
  function probe(x, y, range) {
    var n = probeAll(x, y, range, probeOut);
    if (!n) return null;
    var best = probeOut[0];
    for (var i = 1; i < n; i++) if (probeOut[i].strength > best.strength) best = probeOut[i];
    return best;
  }

  /* ======================================================================
   * BACKGROUND RENDERING
   *
   * The deposits are the mine; this is what is BEHIND them, and it does three
   * jobs. It makes intact ground read as rock rather than as a hole where a
   * deposit failed to spawn (which matters at the slab's edge, where there
   * genuinely are no deposits). It draws the STRATA — the same warped bed
   * boundaries bedMaterial() used, so a wall reads as one continuous bed. And
   * it carries the two diegetic hints: timber sets in the old workings, and a
   * faint bloom of a motherlode's colour through the rock in front of it.
   * =================================================================== */
  var BG_TILE = 128;

  var lampPhase = 0;           // monotonic; drives a deterministic flicker
  var lampGrads = {};          // radius+colour -> cached radial gradient

  var rockPattern = null, wallPattern = null;
  var tileSeed = 0;

  function tileRnd() {
    tileSeed = (tileSeed + 0x6D2B79F5) >>> 0;
    var t = Math.imul(tileSeed ^ (tileSeed >>> 15), 1 | tileSeed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function noiseTile(r0, g0, b0, spread, speckle) {
    var cv = document.createElement('canvas');
    cv.width = cv.height = BG_TILE;
    var g = cv.getContext('2d');
    g.fillStyle = 'rgb(' + r0 + ',' + g0 + ',' + b0 + ')';
    g.fillRect(0, 0, BG_TILE, BG_TILE);
    for (var i = 0; i < speckle; i++) {
      var f = (tileRnd() * 2 - 1) * spread;
      var r = Math.max(0, Math.min(255, r0 + f)) | 0;
      var gg = Math.max(0, Math.min(255, g0 + f)) | 0;
      var b = Math.max(0, Math.min(255, b0 + f)) | 0;
      g.fillStyle = 'rgb(' + r + ',' + gg + ',' + b + ')';
      var s = 2 + tileRnd() * 8;
      g.fillRect(tileRnd() * BG_TILE, tileRnd() * BG_TILE, s, s);
    }
    return cv;
  }

  function buildTiles() {
    if (rockPattern) return;
    tileSeed = 20240811;
    var rock = noiseTile(30, 26, 24, 13, 900);
    var wall = noiseTile(58, 53, 62, 24, 780);
    var probeCtx = document.createElement('canvas').getContext('2d');
    rockPattern = probeCtx.createPattern(rock, 'repeat');
    wallPattern = probeCtx.createPattern(wall, 'repeat');
  }

  /** Cheap rgba() from a material's shadow colour. */
  function tintOf(matIndex, alpha) {
    var hex = SM.materials.get(matIndex).colors[1];
    var r = 0, g = 0, b = 0;
    if (hex.charAt(0) === '#' && hex.length >= 7) {
      r = parseInt(hex.substr(1, 2), 16);
      g = parseInt(hex.substr(3, 2), 16);
      b = parseInt(hex.substr(5, 2), 16);
    }
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  /**
   * The strata. For every visible bed boundary of every visible layer, draw
   * the SAME curve the generator used: bedMaterial() places a boundary where
   * py + warp(px) = bi * pitch, so the drawn line is py = bi*pitch - warp(px).
   * Ten samples across the shaft is plenty for a 30-unit amplitude.
   */
  function drawStrata(ctx, vLeft, vTop, vRight, vBot) {
    /* SAMPLE ACROSS THE VIEW, NOT ACROSS THE MINE. This used to walk ten
     * samples across the whole shaft, which was fine at 1760 units wide and is
     * nonsense at 5200: the warp's period is 1/BED_WARP_F ~ 476 units, so ten
     * samples over 5200 units alias the curve into a random zig-zag that does
     * not follow the material change the generator made. A fixed WORLD step
     * keeps the drawn boundary on the curve whatever the mine's width, and only
     * the visible span is drawn. */
    var step = 56;
    var w = vRight - vLeft;
    var samples = Math.ceil(w / step);
    if (samples < 4) samples = 4;
    if (samples > 80) { samples = 80; step = w / 80; }
    /* ONE STRATUM, THE WHOLE MAP. This used to walk the layer table and paint
     * each layer's band between its own top and bottom; a level map is one
     * stratum at every depth now (see the header), so there is one pass and it
     * covers the whole visible rock. The bed lines inside it are unchanged — they
     * are what makes a wall read as strata rather than as a flat fill, and they
     * still reconstruct exactly the curve bedMaterial() used. */
    var lines = 0;
    var pass = lvl ? [lvl] : layers;
    for (var li = 0; li < pass.length && lines < 90; li++) {
      var L = pass[li];
      var a = vTop, b = vBot;
      if (!(b > a)) continue;

      // The stratum's own tone, so the rock reads as rock even where no deposit
      // happens to sit.
      ctx.fillStyle = tintOf(L.fill, 0.42);
      ctx.fillRect(vLeft, a, w, b - a);

      var pitch = L.bedPitch;
      var bi0 = Math.floor((a - BED_WARP) / pitch);
      var bi1 = Math.ceil((b + BED_WARP) / pitch);
      for (var bi = bi0; bi <= bi1 && lines < 90; bi++) {
        lines++;
        ctx.beginPath();
        for (var s = 0; s <= samples; s++) {
          var px = vLeft + s * step;
          var y = bi * pitch - noise1s(px * BED_WARP_F, S_BED + L.idx) * BED_WARP;
          if (s === 0) ctx.moveTo(px, y); else ctx.lineTo(px, y);
        }
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(0,0,0,0.34)';
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.stroke();
      }

      // Layer name, once, at its ceiling. Anchored to the middle of the VIEW:
      // in a 520-metre-wide mine a caption at x = 0 is a caption the player
      // usually cannot see.
      if (top > vTop - 60 && top < vBot + 60 && top > A.MINE_CEILING_Y) {
        ctx.strokeStyle = 'rgba(255,196,64,0.22)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(vLeft, top); ctx.lineTo(vRight, top);
        ctx.stroke();
        ctx.font = 'bold 26px ui-sans-serif, system-ui, Arial, sans-serif';
        ctx.fillStyle = 'rgba(255,222,150,0.16)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(L.name, (vLeft + vRight) * 0.5, top - 26);
      }
    }
  }

  /** Timber sets in the abandoned drifts: somebody was here before you. */
  function drawTimbers(ctx, vLeft, vTop, vRight, vBot) {
    var j0 = Math.floor((vTop - DRIFT_H) / DRIFT_H);
    var j1 = Math.floor((vBot + DRIFT_H) / DRIFT_H);
    var i0 = cellI0(vLeft, DRIFT_W, DRIFT_MAX_W + DRIFT_W);
    var i1 = cellI1(vRight, DRIFT_W, DRIFT_MAX_W + DRIFT_W);
    for (var j = j0; j <= j1; j++) {
      for (var i = i0; i <= i1; i++) {
        // Resolved through driftOfCell(), the same call the generator makes, or
        // timbers would be painted across solid rock (and drifts would be left
        // bare) near a layer boundary.
        if (!driftOfCell(i, j)) continue;
        var yc = dfY, h = dfH, w = dfW;
        if (yc + h < vTop || yc - h > vBot) continue;
        if (dfX + w * 0.5 < vLeft || dfX - w * 0.5 > vRight) continue;
        var xA = dfX - w * 0.5, xB = dfX + w * 0.5;
        var yA = yc - h * 0.5, yB = yc + h * 0.5;

        // Excavated floor, darker than the rock so the drift reads as a hole.
        ctx.fillStyle = 'rgba(12,10,10,0.55)';
        ctx.fillRect(xA, yA, w, h);

        ctx.fillStyle = 'rgba(86,58,34,0.85)';
        var n = Math.floor(w / DRIFT_TIMBER_PITCH);
        for (var k = 0; k <= n; k++) {
          var tx = xA + (k / Math.max(1, n)) * w;
          ctx.fillRect(tx - 3, yA, 6, h);                  // post
        }
        ctx.fillRect(xA, yA - 4, w, 7);                    // cap beam
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(xA, yB - 3, w, 4);                    // sill shadow
      }
    }
  }

  /**
   * A motherlode bleeding its colour through the rock. Deliberately faint: it
   * is not a marker, it is a reason to look twice at one wall out of thirty.
   */
  function drawLodeGlow(ctx, vLeft, vTop, vRight, vBot) {
    var j0 = Math.floor((vTop - LODE_H) / LODE_H);
    var j1 = Math.floor((vBot + LODE_H) / LODE_H);
    var i0 = cellI0(vLeft, LODE_W, LODE_W);
    var i1 = cellI1(vRight, LODE_W, LODE_W);
    for (var j = j0; j <= j1; j++) {
      for (var i = i0; i <= i1; i++) {
        if (!lodeOfCell(i, j)) continue;
        lodeBloom(ctx, lodeX, lodeY, lodeRX, lodeRY, lodeMat, vTop, vBot);
      }
    }
    if (gldValid) lodeBloom(ctx, gldX, gldY, gldRX, gldRY, gldMat, vTop, vBot);
  }

  function lodeBloom(ctx, lx, ly, rx, ry, m, vTop, vBot) {
    var reach = Math.max(rx, ry) * 2.6;
    if (ly + reach < vTop || ly - reach > vBot) return;
    var col = SM.materials.get(m).colors[0];
    var g = ctx.createRadialGradient(lx, ly, 0, lx, ly, reach);
    g.addColorStop(0, hexToRgba(col, 0.20));
    g.addColorStop(0.55, hexToRgba(col, 0.07));
    g.addColorStop(1, hexToRgba(col, 0));
    ctx.fillStyle = g;
    ctx.fillRect(lx - reach, ly - reach, reach * 2, reach * 2);
  }

  function hexToRgba(hex, a) {
    var r = 255, g = 255, b = 255;
    if (hex.charAt(0) === '#' && hex.length >= 7) {
      r = parseInt(hex.substr(1, 2), 16);
      g = parseInt(hex.substr(3, 2), 16);
      b = parseInt(hex.substr(5, 2), 16);
    }
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  /**
   * One cached radial glow, keyed by colour and ROUNDED radius. Building a
   * gradient per lamp per frame is exactly the kind of allocation that turns a
   * decoration into a frame-rate problem, and there are only two distinct radii.
   */
  function lampGlow(ctx, x, y, r, rgbPrefix, alpha) {
    if (!(r > 1) || alpha <= 0.004) return;
    var key = rgbPrefix + Math.round(r);
    var g = lampGrads[key];
    if (!g) {
      g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, rgbPrefix + '0.85)');
      g.addColorStop(0.45, rgbPrefix + '0.30)');
      g.addColorStop(1, rgbPrefix + '0)');
      lampGrads[key] = g;
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = g;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.restore();
  }

  /* ======================================================================
   * THE LEVEL BOARD — the big red depth readout beside the doors
   *
   * The one thing a lift must tell you is WHERE YOU ARE, and the owner asked for
   * it in big red LED figures. Seven-segment geometry rather than a font, for two
   * reasons: it reads as an instrument at any size (a 390-wide phone shows this
   * at ~27 px of digit height, a desktop at ~45), and the DARK segments of every
   * digit are half of what makes an LED panel look like an LED panel at all.
   *
   * PRE-RENDERED ONCE PER LEVEL INTO AN OFFSCREEN CANVAS. A level's board never
   * changes, so laying out segments, measuring text and baking the bloom per frame
   * would be paying every frame for a picture that is identical every time. Per
   * frame it is one drawImage and one CACHED radial glow — the same discipline the
   * lamps follow, and for the same reason.
   * =================================================================== */
  var LED_SS = 2;              // supersample of the offscreen art: crisp up to
                               // a 2x camera scale, and nothing shows above 1.
  /* Sized so the widest board in the catalogue (a four-figure depth, "-3 000 m")
   * comes out at 252 world units, which fits between the door's west jamb and the
   * edge of the bulkhead (boardGeom scales it down if a wider one ever appears).
   * At the camera scales this mode actually uses that is 42 px of digit height on
   * a desktop and 26 on a 390-wide phone. */
  var LED_DW = 30, LED_DH = 52;         // one digit cell
  var LED_T = 9;                        // segment thickness
  var LED_GAP = 6, LED_SPACE = 15;      // between digits / the thousands gap
  var LED_PAD = 15, LED_TAG = 14, LED_LVL = 25;

  /* Segment rectangles of one digit cell, in the order a b c d e f g. A flat
   * table rather than seven branches: the panel is baked once, so what matters
   * is that the geometry is readable in one place. */
  var LED_HB = LED_DW - LED_T * 1.24;         // horizontal bar length
  var LED_VB = LED_DH * 0.5 - LED_T * 1.06;   // vertical bar length
  var SEGX = [LED_T * 0.62, LED_DW - LED_T, LED_DW - LED_T, LED_T * 0.62,
              0, 0, LED_T * 0.62];
  var SEGY = [0, LED_T * 0.62, LED_DH * 0.5 + LED_T * 0.44, LED_DH - LED_T,
              LED_DH * 0.5 + LED_T * 0.44, LED_T * 0.62, LED_DH * 0.5 - LED_T * 0.5];
  var SEGW = [LED_HB, LED_T, LED_T, LED_HB, LED_T, LED_T, LED_HB];
  var SEGH = [LED_T, LED_VB, LED_VB, LED_T, LED_VB, LED_VB, LED_T];
  var SEG_ON = ['1111110', '0110000', '1101101', '1111001', '0110011',
                '1011011', '1011111', '1110000', '1111111', '1111011'];
  var SEG_MINUS = '0000001';

  var artCache = {};           // what is printed on it -> baked panel
  var measCtx = null;          // one scratch context for measureText

  /** 2100 -> "-2 100". The thousands gap is a real gap in the segment layout. */
  function ledFigures(depthM) {
    var n = Math.round(depthM);
    if (n < 0) n = 0;
    var s = '' + n;
    var out = '-';
    for (var i = 0; i < s.length; i++) {
      if (i > 0 && ((s.length - i) % 3) === 0) out += ' ';
      out += s.charAt(i);
    }
    return out;
  }

  function measureWith(font, text) {
    if (!measCtx) measCtx = document.createElement('canvas').getContext('2d');
    measCtx.font = font;
    return measCtx.measureText(text).width;
  }

  function drawGlyph(g, x, y, bits, lit) {
    var k;
    /* A DEAD BOARD SHOWS ITS NUMBER FAINTLY AND NOTHING ELSE. Drawing the full
     * ghost field is what an unpowered LED genuinely looks like, and it reads as
     * "-888 m" because every digit becomes an 8 — measured by looking at a
     * screenshot of exactly that. Legible beats literal. */
    if (!lit) {
      g.fillStyle = 'rgba(158,62,50,0.40)';
      for (k = 0; k < 7; k++) {
        if (bits.charAt(k) !== '1') continue;
        g.fillRect(x + SEGX[k], y + SEGY[k], SEGW[k], SEGH[k]);
      }
      return;
    }

    /* The dark segments first: an LED display is a grid of segments that are OFF
     * with a few switched on, and drawing only the lit ones reads as paint
     * rather than as a lamp.
     *
     * EXCEPT ON THE MINUS, where a full ghost field around one lit middle bar
     * does not read as a minus sign — it reads as a broken digit, and the board
     * said "8135" instead of "-135". */
    if (bits !== SEG_MINUS) {
      g.fillStyle = 'rgba(122,26,18,0.5)';
      for (k = 0; k < 7; k++) g.fillRect(x + SEGX[k], y + SEGY[k], SEGW[k], SEGH[k]);
    }
    g.shadowColor = 'rgba(255,64,38,0.95)';
    g.shadowBlur = 15;
    g.fillStyle = '#ff2f1c';
    for (k = 0; k < 7; k++) {
      if (bits.charAt(k) !== '1') continue;
      g.fillRect(x + SEGX[k], y + SEGY[k], SEGW[k], SEGH[k]);
    }
    g.shadowBlur = 0;
    /* A hot core inside each lit bar, so the figures read as emitting rather
     * than as red-painted metal once the darkness composite lands on them.
     *
     * IT IS THE ONLY BRIGHTNESS THAT SURVIVES A DIM LAMP. Past the light radius
     * the composite multiplies everything here by 0.06, so what the player
     * actually sees is this core and nothing else — which is why it is nearly
     * white rather than red, and why it is worth the two extra fillRects. Baked,
     * so it costs nothing per frame. */
    g.fillStyle = 'rgba(255,201,182,0.58)';
    for (k = 0; k < 7; k++) {
      if (bits.charAt(k) !== '1') continue;
      g.fillRect(x + SEGX[k] + 2.4, y + SEGY[k] + 2.4,
                 SEGW[k] - 4.8, SEGH[k] - 4.8);
    }
  }

  /**
   * Bake one panel. `lit` false is the same sign switched OFF. Nothing draws a
   * dark one now that a level's board is always the level you are standing on,
   * but the variant is kept: it costs one branch, and "the same sign, unlit" is
   * the cheapest possible way for anything downstream to say "not yours yet".
   */
  function buildReadout(level, depthM, name, lit) {
    var figs = ledFigures(depthM);
    var i, ch;

    var digitsW = 0;
    for (i = 0; i < figs.length; i++) {
      ch = figs.charAt(i);
      digitsW += (ch === ' ') ? LED_SPACE : (LED_DW + LED_GAP);
    }
    digitsW -= LED_GAP;

    var unitFont = 'bold ' + Math.round(LED_DH * 0.52) +
                   'px ui-sans-serif, system-ui, Arial, sans-serif';
    var unitW = measureWith(unitFont, 'm') + 11;

    /* THE LEVEL NUMBER IS ITS OWN SIZE. One monospace row of everything put the
     * level number at 14 world units, which is 7 px on a 390-wide phone —
     * present, unreadable, and therefore pointless. The number is the second
     * thing the player wants after the depth, so it gets its own weight and the
     * stratum name stays small beside it. */
    var lvl = 'L' + level;
    var nm = name ? ('' + name).toUpperCase() : '';
    if (nm.length > 15) nm = nm.substr(0, 15);
    if (!lit) nm = nm ? (nm + '  LOCKED') : 'LOCKED';
    var lvlFont = 'bold ' + LED_LVL + 'px ui-sans-serif, system-ui, Arial, sans-serif';
    var tagFont = 'bold ' + LED_TAG + 'px ui-monospace, Menlo, Consolas, monospace';
    var tagW = measureWith(lvlFont, lvl) + 8 + measureWith(tagFont, nm);

    var inner = digitsW + unitW;
    if (tagW > inner) inner = tagW;
    var w = Math.ceil(inner + LED_PAD * 2);
    var h = Math.ceil(LED_DH + LED_LVL + 8 + LED_PAD * 2);

    var cv = document.createElement('canvas');
    cv.width = Math.ceil(w * LED_SS);
    cv.height = Math.ceil(h * LED_SS);
    var g = cv.getContext('2d');
    g.scale(LED_SS, LED_SS);

    // Bezel, then the screen inside it.
    g.fillStyle = lit ? '#2a1a1a' : '#1d1717';
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.07)';
    g.fillRect(0, 0, w, 2);
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(0, h - 3, w, 3);
    g.fillStyle = lit ? '#0b0506' : '#0a0809';
    g.fillRect(4, 4, w - 8, h - 8);

    var dy = LED_PAD + LED_LVL + 8;
    if (lit) {
      // The bloom the panel throws onto its own bezel. Baked, so it is free.
      var bx = w * 0.5, by = dy + LED_DH * 0.5;
      var rr = Math.max(w, h) * 0.72;
      var bg = g.createRadialGradient(bx, by, 0, bx, by, rr);
      bg.addColorStop(0, 'rgba(255,72,44,0.40)');
      bg.addColorStop(0.55, 'rgba(255,50,28,0.14)');
      bg.addColorStop(1, 'rgba(255,40,20,0)');
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
    }

    // The level number and the stratum, on their own row above the figures.
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.font = lvlFont;
    g.fillStyle = lit ? 'rgba(255,170,140,0.95)' : 'rgba(178,100,86,0.62)';
    g.fillText(lvl, LED_PAD, LED_PAD - 1);
    var lvlW = measureWith(lvlFont, lvl);
    g.font = tagFont;
    g.fillStyle = lit ? 'rgba(226,138,112,0.82)' : 'rgba(150,84,74,0.55)';
    g.fillText(nm, LED_PAD + lvlW + 8, LED_PAD + (LED_LVL - LED_TAG) * 0.72);

    // The figures, right-aligned against the unit so panels of different depths
    // still line their "m" up with each other.
    var x = w - LED_PAD - unitW - digitsW;
    for (i = 0; i < figs.length; i++) {
      ch = figs.charAt(i);
      if (ch === ' ') { x += LED_SPACE; continue; }
      drawGlyph(g, x, dy, ch === '-' ? SEG_MINUS : SEG_ON[+ch], lit);
      x += LED_DW + LED_GAP;
    }

    g.font = unitFont;
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillStyle = lit ? '#ff6f52' : 'rgba(150,74,64,0.6)';
    g.fillText('m', x + 4, dy + LED_DH);

    return { cv: cv, w: w, h: h };
  }

  /**
   * Cached by exactly what is printed on it, so buying the fourth level re-bakes
   * one panel and not four.
   *
   * The cache is CAPPED, because it outlives a mine: one board is about 400 KB of
   * canvas at LED_SS, and a session that visits every mine in the catalogue and
   * buys down each of them would otherwise accumulate tens of megabytes of
   * pictures of numbers. Re-baking an evicted board costs well under a
   * millisecond and only happens when the level table is re-resolved.
   */
  var LED_CACHE_MAX = 14;
  var artKeys = [];

  function readoutFor(level, depthM, name, lit) {
    var key = level + '|' + Math.round(depthM) + '|' + (lit ? 1 : 0) + '|' + name;
    var a = artCache[key];
    if (a) return a;
    a = buildReadout(level, depthM, name, lit);
    artCache[key] = a;
    artKeys.push(key);
    while (artKeys.length > LED_CACHE_MAX) delete artCache[artKeys.shift()];
    return a;
  }

  /* ======================================================================
   * THE DOORS, DRAWN
   *
   * The owner's headline image: BIG CLOSED DOORS in the world, which open when
   * you drive up to them. Everything below is in ABSOLUTE world coordinates —
   * there is no translate, because a level's lift is on the centre line (x = 0)
   * by definition and always will be.
   *
   * WHY THE DOORS FACE THE CAMERA. This is a side elevation, so a lift can be
   * drawn two ways: as an opening in the CEILING (the shaft rising away above the
   * chamber) or as a pair of doors in the chamber's BACK WALL, with the cage
   * behind them, into the screen. The ceiling version is honest about where a
   * shaft goes and reads as a hatch: seen edge-on it is a horizontal band 26 units
   * tall, and "massive and shut" is exactly what it cannot say. The back wall
   * version gives the full rectangle of the doors — 460 x 440 of steel, taller
   * than the machine is long — and it is also what makes the OPENING mean
   * something: the panels slide apart and the lit cage is behind them.
   *
   * THREE THINGS CARRY IT, in the order the eye finds them:
   *   THE BULKHEAD  a steel wall set into the rock, so the doors are set INTO
   *                 something rather than painted on a cave.
   *   THE PANELS    two of them, clipped to the opening so they slide into
   *                 pockets behind the jambs instead of over them.
   *   THE LIGHT     worklights on the frame in the geometry pass, and in the
   *                 EMISSIVE pass the red level board, two pilot lamps and the
   *                 spill out of the cage — see renderLit for why that split is
   *                 not cosmetic.
   * =================================================================== */

  /* --- steel, in one place so the whole assembly is one object ---------- */
  var DR_BULK = '#2b3037';         // the bulkhead plate
  var DR_BULK_HI = 'rgba(255,255,255,0.06)';
  var DR_FRAME = '#4b525c';        // jambs and lintel
  var DR_PANEL = '#3c434d';        // the door panels
  var DR_PANEL_HI = 'rgba(214,226,240,0.10)';
  var DR_HAZARD = 'rgba(240,186,44,0.88)';
  var DR_CAGE = 'rgba(9,10,12,0.96)';

  /**
   * THE DOOR CHAMBER AND THE DOORS. Culled hard: the assembly is 1240 x 680 in a
   * mine up to 5200 wide, so most frames do not draw it at all.
   */
  function drawDoors(ctx, vLeft, vTop, vRight, vBot) {
    if (!bandN) return;
    if (vRight < -DOOR_HW - 60 || vLeft > DOOR_HW + 60) return;
    if (vBot < doorCeilY - 40 || vTop > doorCY + DOOR_RY + 40) return;

    /* One monotonic phase, as the mouth's lamps had: the flicker must not jump
     * when a band streams out and back in, so it is a pure function of a counter
     * and never of anything the streamer touches. The value is kept for
     * renderLit(), which runs after the darkness composite and has to flicker IN
     * STEP with the lamps drawn here. */
    lampPhase += 0.016;
    var flick = 0.92 + 0.08 * Math.sin(lampPhase * 2.1) * Math.sin(lampPhase * 0.6 + 0.7);
    doorFlick = flick;

    var hw = DOOR_W * 0.5;
    var lintel = doorTopY;

    /* --- the excavated room -------------------------------------------
     * Drawn a little INSIDE the carved superellipse: the deposits at its edge are
     * what the eye reads as the wall, so this only has to darken the void. Painting
     * past it would put a black corner on solid rock. */
    roomPath(ctx, -DOOR_HW + 12, DOOR_HW - 12, doorCY, DOOR_RY - 14, 92);
    ctx.fillStyle = 'rgba(13,11,12,0.66)';
    ctx.fill();

    /* --- the bulkhead the doors are set into ---------------------------- */
    ctx.fillStyle = DR_BULK;
    ctx.fillRect(-DOOR_BULK, doorCeilY + 8, DOOR_BULK * 2, doorSillY + 26 - doorCeilY - 8);
    ctx.fillStyle = DR_BULK_HI;
    ctx.fillRect(-DOOR_BULK, doorCeilY + 8, DOOR_BULK * 2, 3);
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fillRect(-DOOR_BULK, doorSillY + 20, DOOR_BULK * 2, 6);
    // Rivets down both outer edges: cheap, and it is what says PLATE not paint.
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (var ry = doorCeilY + 34; ry < doorSillY; ry += 54) {
      ctx.fillRect(-DOOR_BULK + 11, ry, 5, 5);
      ctx.fillRect(DOOR_BULK - 16, ry, 5, 5);
    }

    /* --- the opening: the cage, behind the doors ------------------------
     * Drawn before the panels, so what the panels uncover is this. It is a LIT
     * interior — the deck plate, the guide rails the cage runs on, and a lamp in
     * its roof — because a lift you can see into is a lift you understand. */
    ctx.fillStyle = DR_CAGE;
    ctx.fillRect(-hw, lintel, DOOR_W, DOOR_H);
    if (doorOpen > 0.02) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(-hw, lintel, DOOR_W, DOOR_H);
      ctx.clip();
      // Back wall of the cage, grimy plate.
      ctx.fillStyle = 'rgba(38,42,48,0.9)';
      ctx.fillRect(-hw + 16, lintel + 14, DOOR_W - 32, DOOR_H - 28);
      // The two guide rails, running out of shot both ways: the cage travels.
      ctx.strokeStyle = 'rgba(158,170,186,0.5)';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(-hw + 44, lintel); ctx.lineTo(-hw + 44, lintel + DOOR_H);
      ctx.moveTo(hw - 44, lintel); ctx.lineTo(hw - 44, lintel + DOOR_H);
      ctx.stroke();
      // Deck plate at the threshold, with the hazard edge every cage carries.
      ctx.fillStyle = 'rgba(96,104,116,0.92)';
      ctx.fillRect(-hw + 18, doorSillY - 26, DOOR_W - 36, 18);
      ctx.fillStyle = DR_HAZARD;
      ctx.fillRect(-hw + 18, doorSillY - 30, DOOR_W - 36, 5);
      // The lamp in the cage roof, and what it throws down the back wall.
      var ly = lintel + 34;
      ctx.fillStyle = 'rgba(255,238,196,' + (0.92 * flick).toFixed(3) + ')';
      ctx.fillRect(-16, ly - 7, 32, 6);
      lampGlow(ctx, 0, ly, 260, 'rgba(255,216,150,', 0.44 * flick * doorOpen);
      ctx.restore();
    }

    /* --- THE PANELS ----------------------------------------------------
     * Two leaves meeting on the centre line, sliding out to the pockets. CLIPPED
     * to the opening, which is the whole reason they read as sliding INTO
     * something: unclipped they would travel out over the jambs and the bulkhead
     * like two pictures of doors moving sideways. At doorOpen 1 the clip has eaten
     * them entirely and the cage is wide open. */
    if (doorOpen < 0.995) {
      var slide = doorOpen * hw;
      ctx.save();
      ctx.beginPath();
      ctx.rect(-hw, lintel, DOOR_W, DOOR_H);
      ctx.clip();
      for (var s = -1; s <= 1; s += 2) {
        // leaf spans [-hw, 0] mirrored, then slides outward by `slide`
        var pL = s < 0 ? (-hw - slide) : (slide);
        ctx.fillStyle = DR_PANEL;
        ctx.fillRect(pL, lintel, hw, DOOR_H);
        // Vertical ribs, and the highlight down the leading edge.
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        for (var rb = 1; rb < 4; rb++) ctx.fillRect(pL + hw * rb / 4 - 3, lintel + 8, 6, DOOR_H - 16);
        ctx.fillStyle = DR_PANEL_HI;
        ctx.fillRect(s < 0 ? pL + hw - 5 : pL, lintel, 5, DOOR_H);
        // The hazard chevron band across the middle of both leaves.
        ctx.save();
        ctx.beginPath();
        ctx.rect(pL, doorMidY - 26, hw, 52);
        ctx.clip();
        ctx.fillStyle = 'rgba(28,26,22,0.9)';
        ctx.fillRect(pL, doorMidY - 26, hw, 52);
        ctx.strokeStyle = DR_HAZARD;
        ctx.lineWidth = 15;
        ctx.beginPath();
        for (var cxx = pL - 52; cxx < pL + hw + 52; cxx += 46) {
          ctx.moveTo(cxx, doorMidY + 30); ctx.lineTo(cxx + 34, doorMidY - 30);
        }
        ctx.stroke();
        ctx.restore();
        // Bolt heads at the corners of each leaf.
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(pL + (s < 0 ? 12 : hw - 20), lintel + 12, 7, 7);
        ctx.fillRect(pL + (s < 0 ? 12 : hw - 20), lintel + DOOR_H - 20, 7, 7);
      }
      /* The MEETING LINE. Two leaves that merely touch read as one slab; the seam
       * is what makes them two, and it is the first thing that visibly changes
       * when they start to move. */
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(-slide - 3, lintel, 6, DOOR_H);
      ctx.restore();
    }

    /* --- the frame and the threshold ----------------------------------
     * Both are drawn by drawDoorHead(), because renderLit() draws them AGAIN over
     * the machine during the transit frames — see the note on it. One function, so
     * the overlay can never be a slightly different door frame. */
    drawDoorHead(ctx, 1);

    /* --- two worklights, on brackets outside the frame -----------------
     * The mouth's own lamps, one size down. This is the GEOMETRY pass, so none of
     * it survives the darkness composite past the headlight — carrying the doors
     * from further out than that is renderLit()'s job. These are the close read,
     * and they are what makes the chamber a place people work.
     */
    var wy = doorCeilY + 132;
    for (var pk = -1; pk <= 1; pk += 2) {
      var wx = pk * (hw + DOOR_JAMB + 62);
      ctx.fillStyle = '#3b3f47';
      ctx.fillRect(wx - 7, wy - 9, 14, 9);
      ctx.fillStyle = 'rgba(24,26,30,0.9)';
      ctx.fillRect(wx - 2, wy, 4, 9);
      lampGlow(ctx, wx, wy, 116, 'rgba(255,214,138,', 0.48 * flick);
      ctx.fillStyle = 'rgba(255,236,190,' + (0.95 * flick).toFixed(3) + ')';
      ctx.fillRect(wx - 5, wy - 7, 10, 5);
    }

    /* --- the level board's brackets and shadow ------------------------
     * The board ITSELF is drawn in renderLit(): an LED sign is a light source, not
     * lit geometry, and this pass runs before the darkness composite. What belongs
     * here is what holds it up, because unlit brackets SHOULD darken with the rock.
     */
    var g = boardGeom();
    if (!g) return;
    ctx.fillStyle = 'rgba(44,38,36,0.92)';
    ctx.fillRect(g.px + 10, g.py - 14, 8, 16);
    ctx.fillRect(g.px + g.pw - 18, g.py - 14, 8, 16);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(g.px, g.py + g.ph, g.pw, 7);
  }

  /**
   * THE DOORWAY'S OWN STRUCTURE: jambs, lintel beam, threshold plate.
   *
   * Drawn TWICE per frame, at two different alphas, and that is the whole trick
   * behind driving into the lift. In the geometry pass (alpha 1) it is the frame,
   * darkening with the rock like everything else. In the EMISSIVE pass, which runs
   * after the vehicle, it is re-laid OVER the top — so as the machine climbs into
   * the doorway its tracks go BEHIND the threshold and its roof BEHIND the lintel,
   * and it reads as passing into a structure rather than sliding across a picture
   * of one. Without it the machine simply vanishes at the boundary, which
   * screenshotted exactly as badly as it sounds.
   *
   * THE SECOND ALPHA IS headOcclusion(), NOT headMix, and the difference is a real
   * bug: the overlay must fade OUT again as the machine comes back out of the
   * doorway, or the threshold plate is laid across a solid machine parked in front
   * of it. Read that function — the rule is one line and it is the only thing
   * keeping this pass honest in both directions.
   *
   * One function so the overlay is provably the same door frame. Any asymmetry
   * between the two passes would show up as a bright ghost edge.
   */
  function drawDoorHead(ctx, alpha) {
    if (alpha <= 0.01) return;
    var hw = DOOR_W * 0.5;
    var lintel = doorTopY;
    ctx.save();
    if (alpha < 1) ctx.globalAlpha = alpha;

    // Jambs and the lintel beam.
    ctx.fillStyle = DR_FRAME;
    ctx.fillRect(-hw - DOOR_JAMB, lintel - 30, DOOR_JAMB, DOOR_H + 30);
    ctx.fillRect(hw, lintel - 30, DOOR_JAMB, DOOR_H + 30);
    ctx.fillRect(-hw - DOOR_JAMB, lintel - 30, DOOR_W + DOOR_JAMB * 2, 30);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(-hw - DOOR_JAMB, lintel - 30, DOOR_W + DOOR_JAMB * 2, 4);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(-hw - DOOR_JAMB, lintel, DOOR_W + DOOR_JAMB * 2, 5);

    /* The THRESHOLD the machine drives over, hazard-striped: it is the one place on
     * this level where the floor is not rock, and in the overlay pass it is the
     * edge the machine sinks behind. */
    ctx.fillStyle = 'rgba(88,95,106,0.95)';
    ctx.fillRect(-hw - 42, doorSillY, DOOR_W + 84, 16);
    ctx.save();
    ctx.beginPath();
    ctx.rect(-hw - 42, doorSillY, DOOR_W + 84, 16);
    ctx.clip();
    ctx.strokeStyle = 'rgba(240,186,44,0.55)';
    ctx.lineWidth = 11;
    ctx.beginPath();
    for (var tx = -hw - 90; tx < hw + 60; tx += 38) {
      ctx.moveTo(tx, doorSillY + 20); ctx.lineTo(tx + 26, doorSillY - 4);
    }
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(-hw - 42, doorSillY + 16, DOOR_W + 84, 7);
    ctx.restore();
  }

  /**
   * Board geometry, shared by the geometry pass and the emissive pass so the two
   * can never drift apart. Returns a REUSED object — read, do not stash.
   *
   * HARD AGAINST THE WEST JAMB, at head height. See BOARD_GAP for why it is not
   * above the doors: renderLit() runs after the vehicle, so a board the parked
   * machine overlaps is a board drawn ON TOP OF the machine, and the machine's ore
   * bed reaches to within 62 units of the ceiling on the door's own centre line.
   */
  var boardG = { px: 0, py: 0, pw: 0, ph: 0, art: null };
  function boardGeom() {
    var art = doorArt;
    if (!art) return null;
    /* Scaled to fit between the jamb and the bulkhead's edge if the figures ever
     * make a board wider than that — a sign 8% smaller beats a sign with its end
     * buried in rock. */
    var maxW = DOOR_BULK - DOOR_W * 0.5 - DOOR_JAMB - BOARD_GAP - 8;
    var sc = art.w > maxW ? maxW / art.w : 1;
    boardG.pw = art.w * sc;
    boardG.ph = art.h * sc;
    boardG.px = -DOOR_W * 0.5 - DOOR_JAMB - BOARD_GAP - boardG.pw;
    boardG.py = doorCeilY + BOARD_RISE;
    boardG.art = art;
    return boardG;
  }

  /**
   * THE EMISSIVE PASS — everything on the doors that is genuinely a light.
   *
   * Called by adv.renderWorld() AFTER effects.renderDarkness(), inside the same
   * world transform, so these read at full brightness however far the headlight
   * reaches. Near the machine it draws over already-lit positions and changes
   * nothing visible; in the dark it is the difference between a legible level sign
   * and a black rectangle. That fix was hard-won — the board used to draw in the
   * geometry pass with a glow and a comment claiming that survived the composite.
   * It cannot: nothing under a multiply-towards-black does.
   *
   * IT IS ALSO HOW THE DOORS ARE FINDABLE. The geometry above is invisible past
   * the light radius, so from across a level all three of these ARE the lift: the
   * red board, two amber pilot lamps that are on whether the doors are or not, and
   * the warm spill that grows as they open. Drive toward the red light.
   *
   * The flicker REUSES the phase drawDoors() advanced this frame (doorFlick)
   * rather than advancing it again — two advances per frame would double the rate
   * and desync these from the lamps under them.
   */
  function renderLit(ctx) {
    if (!loaded || !bandN) return;
    var v = SM.camera.getViewBounds();
    var vTop = v.minY - 40, vBot = v.maxY + 40;
    if (v.maxX < -DOOR_BULK - 260 || v.minX > DOOR_BULK + 260) return;
    if (vBot < doorCeilY - 200 || vTop > doorSillY + 200) return;

    var hw = DOOR_W * 0.5;
    var lintel = doorTopY;

    /* --- THE DOORWAY, OVER THE MACHINE -------------------------------
     * FIRST in this pass, so everything emissive below it still reads. This is the
     * occlusion that makes driving into the lift a manoeuvre — see drawDoorHead —
     * and it is drawn at exactly the strength the machine is NOT: see
     * headOcclusion(), which is the whole reason a machine standing outside the
     * doors is in front of them and one halfway in is behind them. */
    drawDoorHead(ctx, headOcclusion());

    /* The spill out of the cage. One cached radial glow, scaled by how far open the
     * doors are, which is what turns the approach into an event: the light arrives
     * before you do. */
    if (doorOpen > 0.02) {
      lampGlow(ctx, 0, doorMidY, 330, 'rgba(255,214,148,',
               0.46 * doorOpen * doorFlick);
    }

    /* --- OCCUPIED: warm light through the seam of a shut door ----------
     * The owner's shot is the lift CLOSED WITH THE MACHINE IN IT, and a shut steel
     * door with nothing behind it is indistinguishable from a shut steel door with
     * your machine behind it. So the seam leaks: a thin warm line down the meeting
     * line and a low glow around it, at full strength only when the leaves are
     * actually together. It is the whole reason the disappearance reads as "in the
     * lift" rather than as "gone". */
    var occ = machineInLift() ? (1 - doorOpen) : 0;
    if (occ > 0.02) {
      lampGlow(ctx, 0, doorMidY, 190, 'rgba(255,196,120,', 0.30 * occ * doorFlick);
      ctx.save();
      ctx.globalAlpha = occ * (0.72 + 0.10 * doorFlick);
      ctx.fillStyle = 'rgba(255,222,168,0.9)';
      ctx.fillRect(-2, lintel + 12, 4, DOOR_H - 24);
      ctx.fillStyle = 'rgba(255,236,200,0.75)';
      ctx.fillRect(-hw + 20, doorSillY - 12, DOOR_W - 40, 4);
      ctx.restore();
    }

    // Two pilot lamps on the lintel, always lit: the lift has power even shut.
    for (var s = -1; s <= 1; s += 2) {
      var px = s * (hw - 26);
      lampGlow(ctx, px, lintel - 15, 74, 'rgba(255,168,72,', 0.5 * doorFlick);
      ctx.fillStyle = 'rgba(255,206,138,' + (0.9 * doorFlick).toFixed(3) + ')';
      ctx.fillRect(px - 5, lintel - 22, 10, 7);
    }

    // THE RED LEVEL BOARD, and the light it throws on the bulkhead around it.
    var g = boardGeom();
    if (!g) return;
    lampGlow(ctx, g.px + g.pw * 0.5, g.py + g.ph * 0.5, 210,
             'rgba(255,58,34,', 0.34 * doorFlick);
    ctx.save();
    ctx.globalAlpha = 0.94 + 0.06 * doorFlick;
    ctx.drawImage(g.art.cv, g.px, g.py, g.pw, g.ph);
    ctx.restore();
  }

  /**
   * A rounded-rectangle path spanning x in [xL, xR], centred on cy in y. Built by
   * hand rather than with ctx.roundRect(): one less canvas API to depend on, and
   * the corner radius is clamped here where it is obvious why.
   */
  function roomPath(ctx, xL, xR, cy, ry, r) {
    var rx = (xR - xL) * 0.5;
    if (r > rx * 0.9) r = rx * 0.9;
    if (r > ry * 0.9) r = ry * 0.9;
    var L = xL, R = xR, T = cy - ry, B = cy + ry;
    ctx.beginPath();
    ctx.moveTo(L + r, T);
    ctx.lineTo(R - r, T);
    ctx.quadraticCurveTo(R, T, R, T + r);
    ctx.lineTo(R, B - r);
    ctx.quadraticCurveTo(R, B, R - r, B);
    ctx.lineTo(L + r, B);
    ctx.quadraticCurveTo(L, B, L, B - r);
    ctx.lineTo(L, T + r);
    ctx.quadraticCurveTo(L, T, L + r, T);
    ctx.closePath();
  }

  function render(ctx) {
    // `loaded`, not `active`: the mine stays on screen behind the extraction
    // card, the map and the workshop. See the two-flag note at the top.
    if (!loaded) return;
    var v = SM.camera.getViewBounds();
    var vTop = v.minY - 40, vBot = v.maxY + 40;
    var wallL = v.minX - 60, wallR = v.maxX + 60;

    /* --- ONE BEDROCK CAP, THEN ROCK ALL THE WAY DOWN --------------------
     * The single strongest statement this file makes used to be "a level is a
     * BOX". It is the opposite now: a level is ENDLESS in every direction but
     * one, and the one bedrock cap over the lift is the whole of the world's
     * edge. Everything east, west and south of the view is more rock, and the
     * rock pattern with the strata in it now covers the entire view below the
     * cap. Drive as far as fuel allows and the answer is the same — this goes on,
     * and the only way OUT is the doors.
     *
     * THE CHEAP-WAY-ROUND ARGUMENT SURVIVES INTACT, and gets cheaper. This
     * function once painted bedrock across the WHOLE view and then painted the
     * mine's rock on top of ~85% of it: two full-screen REPEATING-PATTERN fills
     * per frame, where a pattern costs far more per pixel than a solid because
     * every pixel does a modulo address and a texture fetch. Measured at 14.4
     * ms/frame — stubbing this function alone took the mode from 36 fps to 74,
     * while particles.render sat at 0.92 ms either way. So bedrock is painted
     * ONLY above the ceiling, which on almost every frame of a run is nothing at
     * all, and there is now exactly ONE pattern fill per frame instead of two.
     * ---------------------------------------------------------------- */
    var bT = bandN ? bandTopY : A.MINE_CEILING_Y;

    var rockL = wallL;
    var rockR = wallR;
    var rockT = vTop > bT ? vTop : bT;
    var rockB = vBot;

    // The cap over the level, full view width — the roof of the world, and the
    // only bedrock a camera can frame.
    if (rockT > vTop) {
      ctx.fillStyle = wallPattern || '#3a3540';
      ctx.fillRect(wallL, vTop, wallR - wallL, rockT - vTop);
    }

    if (rockB > rockT && rockR > rockL) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(rockL, rockT, rockR - rockL, rockB - rockT);
      ctx.clip();

      ctx.fillStyle = rockPattern || '#231f1d';
      ctx.fillRect(rockL, rockT, rockR - rockL, rockB - rockT);

      drawStrata(ctx, rockL, rockT, rockR, rockB);
      drawLodeGlow(ctx, rockL, rockT, rockR, rockB);
      drawTimbers(ctx, rockL, rockT, rockR, rockB);
      // LAST of the in-rock draws: the doors are built THROUGH the strata and the
      // old workings, so they have to paint over both.
      drawDoors(ctx, rockL, rockT, rockR, rockB);

      /* Ambient occlusion under the cap — only when the cap is on screen. This is
       * what makes the ceiling read as THICKNESS rather than as a change of
       * texture, and it is the last of four such gradients: the other three had
       * faces to hang off and no longer do. */
      if (rockT < bT + 70) {
        var g4 = ctx.createLinearGradient(0, bT, 0, bT + 70);
        g4.addColorStop(0, 'rgba(0,0,0,0.6)');
        g4.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g4;
        ctx.fillRect(rockL, bT, rockR - rockL, 70);
      }

      ctx.restore();
    }

    /* --- THE FLOOR AND THE ROOF OF THE LEVEL --------------------------
     * Bedrock is hardness 26, which is not a wall — and a tier-5 bit's cap is 34,
     * so the ROCK has never been the guarantee here (ARCHITECTURE.md §7): the cut
     * box is clipped and the position clamped in js/vehicle.js, and this band of
     * hazard paint is what tells the player so BEFORE they spend a tank of fuel
     * finding out. A word and a stripe, not a subtle change of rock.
     *
     * AND NOW IT GETS THE WORD. There used to be two of these — a floor and a
     * roof — and only the floor was labelled, because a roof was not somewhere
     * anyone tried to go. The roof is the only edge in the world now, so it takes
     * the label the floor left behind: a machine that drives north until it stops
     * is owed an explanation, and this is it. */
    if (bandN && rockR > rockL) {
      hazardFace(ctx, lvlTopY, -1, rockL, rockR, vTop, vBot, 'BEDROCK');
    }

    /* --- depth ruler, in metres --------------------------------------
     * ABSOLUTE depth, deliberately: the HUD's DEPTH gauge reads absolute y and so
     * does the level board on the doors, so a ruler that restarted at every level
     * would be the one thing on screen disagreeing with the other two. The label
     * rides the left edge of the view, because in a 520-metre-wide mine the wall
     * it used to sit against is almost never on screen. */
    var stepU = 100;                      // 10 m
    var first = Math.ceil((rockT - A.MINE_CEILING_Y) / stepU) * stepU;
    var last = rockB - A.MINE_CEILING_Y;
    var labelX = v.minX + 14;
    ctx.lineWidth = 1;
    ctx.font = '13px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (var d = first; d <= last; d += stepU) {
      if (d < 0) continue;
      var wy = A.MINE_CEILING_Y + d;
      var major = (d % 500) === 0;
      ctx.strokeStyle = major ? 'rgba(255,255,255,0.085)' : 'rgba(255,255,255,0.035)';
      ctx.beginPath();
      ctx.moveTo(rockL, wy); ctx.lineTo(rockR, wy);
      ctx.stroke();
      if (major) {
        ctx.fillStyle = 'rgba(255,255,255,0.20)';
        ctx.fillText((d * A.METERS_PER_UNIT) + ' m', labelX, wy);
      }
    }

    /* --- the world's one edge, trimmed -------------------------------- */
    if (vTop < bT + 4) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,196,64,0.22)';
      ctx.beginPath();
      ctx.moveTo(rockL, bT); ctx.lineTo(rockR, bT);
      ctx.stroke();
    }
  }

  /**
   * THE ONE HAZARD-PAINTED FACE IN THE WORLD. `dir` is -1 for a roof (the paint
   * goes UP from the line, into the rock); +1 for a floor is kept because the
   * function is written for a face and not for a ceiling, and a one-sided
   * function would be a worse thing to inherit than an unused branch.
   *
   * Stepped across the VIEW rather than the world, which is not an optimisation
   * any more — an endless face has no width to hatch.
   */
  function hazardFace(ctx, y, dir, rockL, rockR, vTop, vBot, label) {
    if (y < vTop - 200 || y > vBot + 200) return;
    var h = 46;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,96,84,0.40)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(rockL, y); ctx.lineTo(rockR, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.rect(rockL, dir > 0 ? y : y - h, rockR - rockL, h);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,96,84,0.16)';
    ctx.lineWidth = 9;
    ctx.beginPath();
    var hx0 = Math.floor((rockL - h) / 40) * 40;
    for (var hx = hx0; hx < rockR; hx += 40) {
      ctx.moveTo(hx, y + dir * (h + 2)); ctx.lineTo(hx + h + 2, y);
    }
    ctx.stroke();
    ctx.restore();
    if (!label) return;
    ctx.font = 'bold 24px ui-sans-serif, system-ui, Arial, sans-serif';
    ctx.fillStyle = 'rgba(255,150,140,0.30)';
    ctx.textAlign = 'center';
    ctx.textBaseline = dir > 0 ? 'bottom' : 'top';
    ctx.fillText(label, (rockL + rockR) * 0.5, y - dir * 12);
  }

  /* ======================================================================
   * DIAGNOSTICS
   * Everything below is for measurement and for scripted tests. Nothing in
   * the game depends on it.
   * =================================================================== */
  var dbg = {
    carved: 0, chunks: 0, chunkBytes: 0, chunkFull: false,
    winL: 0, winR: 0, winTop: 0, winBot: 0, winW: 0, winH: 0,
    haveC0: 0, haveC1: 0, haveR0: 0, haveR1: 0, cells: 0,
    peakWinW: 0, peakWinH: 0, peakLiveW: 0, peakLiveH: 0,
    trim: 1, cellBudget: 0, peakSolid: 0, lowFree: 0, solid: 0, free: 0,
    piles: 0, pilesUp: 0, deepestM: 0, layer: '',
    level: 0, levels: 0, levelName: '', genSeed: 0,
    bandR0: 0, bandTopM: 0,
    lvlTopY: 0,
    /* THE WORLD IS OPEN ON THREE SIDES. Reported as booleans, not as Infinity,
     * because a scripted test reads this through JSON and JSON has no Infinity —
     * it would arrive as null and an assertion would quietly pass. */
    openX: false, openBot: false,
    doorX: 0, doorY: 0, doorOpen: 0, needFill: false,
    doorTopY: 0, doorSillY: 0, inLift: false, headMix: 0,
    /* The alpha the doorway is actually laid over the machine at, and the
     * machine's own alpha. They are conjugate by construction (headOcclusion),
     * so a scripted test can assert the z-order without reading pixels. */
    headOcc: 0, machineFade: 1
  };
  function getDebug() {
    var st = SM.particles.getStats();
    dbg.carved = carved;
    dbg.chunks = chunkN;
    dbg.chunkBytes = chunkN * CHUNK_BYTES;
    dbg.chunkFull = chunkFull;
    dbg.winL = winL; dbg.winR = winR;
    dbg.winTop = winTop; dbg.winBot = winBot;
    dbg.winW = winR - winL; dbg.winH = winBot - winTop;
    dbg.haveC0 = haveC0; dbg.haveC1 = haveC1;
    dbg.haveR0 = haveR0; dbg.haveR1 = haveR1;
    dbg.cells = haveN ? (haveC1 - haveC0) * (haveR1 - haveR0) : 0;
    /* THE HASH AUDIT. peakLive* is the widest and tallest the KEEP rect has ever
     * been, which is the outermost box any live particle can sit in. Both must
     * stay under particles.js's 2944 x 5888 wrap or collision detection starts
     * pairing particles that are nowhere near each other. */
    dbg.peakWinW = peakWinW; dbg.peakWinH = peakWinH;
    dbg.peakLiveW = peakLiveW; dbg.peakLiveH = peakLiveH;
    dbg.trim = trim; dbg.cellBudget = cellBudget;
    dbg.peakSolid = peakSolid; dbg.lowFree = lowFree;
    dbg.solid = st.solid; dbg.free = st.free;
    dbg.piles = plN;
    var up = 0;
    for (var i = 0; i < plN; i++) if (plUp[i]) up++;
    dbg.pilesUp = up;
    dbg.deepestM = depthOfY(deepestY);
    dbg.layer = lvl ? lvl.name : '';
    /* THE ACTIVE LEVEL, as a cell row AND as world units, because the ceiling
     * test lives in cell space and the clamp downstream lives in world units — a
     * test that cannot see both cannot prove the two agree. */
    dbg.level = bandN;
    dbg.levels = bands.length;
    dbg.levelName = (bandN && bands[bandN - 1]) ? bands[bandN - 1].name : '';
    dbg.genSeed = genSeed;
    dbg.bandR0 = bandR0;
    dbg.bandTopM = depthOfY(bandTopY);
    dbg.lvlTopY = lvlTopY;
    dbg.openX = !!bandN; dbg.openBot = !!bandN;
    dbg.doorX = 0; dbg.doorY = doorY; dbg.doorOpen = doorOpen;
    dbg.needFill = needFill;
    dbg.doorTopY = doorTopY; dbg.doorSillY = doorSillY;
    dbg.inLift = bandN ? machineInLift() : false;
    dbg.headMix = headMix;
    dbg.machineFade = bandN ? getDoorFade(focusX(), focusY()) : 1;
    dbg.headOcc = bandN ? headOcclusion() : 0;
    return dbg;
  }
  function resetPeaks() {
    peakSolid = 0; lowFree = 1e9;
    peakWinW = 0; peakWinH = 0; peakLiveW = 0; peakLiveH = 0;
  }

  /**
   * The material a cell WOULD contain, resolved straight from the generator with
   * no streaming involved: the determinism test asks for a region's materials,
   * drives away until it unloads, comes back and asks again. -1 means "empty".
   * Exported for tests only; nothing in the game calls it.
   */
  function cellMaterial(cx, cy) {
    if (!loaded) return -2;
    /* THE SAME TWO ANSWERS generateRowStrip() gives, in the same order, or this
     * would not be a probe of the generator — it would be a probe of a different
     * generator that happens to share a name. -2 for a cell north of the ceiling,
     * bedrock for the ceiling itself, and only then the carve store. There is no
     * "outside the map" any more in x or to the south. */
    if (bandN) {
      if (cy < bandR0) return -2;
      if (cy < bandR0 + SEAL_ROWS) return M_BEDROCK;
    }
    if (carvedCell(cx, cy)) return -1;
    var yMid = rowMidY(cy);
    var stag = rowStagger(cy);
    var px = x0 + (cx + 0.5) * SP + stag + (hv(S_JX, cx, cy) * 2 - 1) * SP * JITTER_X;
    var py = yMid + (hv(S_JY, cx, cy) * 2 - 1) * SP * JITTER;
    // The SAME gather range a one-column strip uses, so this asks the generator
    // exactly what generateColStrip() would have asked it.
    prepareRow(cy, yMid, lvl, colEdgeX(cx), colEdgeX(cx + 1));
    return cellMaterialAt(cx, cy, px, py, lvl);
  }

  /**
   * WHAT THIS LEVEL ACTUALLY SPAWNS, counted rather than argued about.
   *
   * Walks a rectangle of cells through the real generator (cellMaterial, so the
   * ceiling and the carve store are honoured exactly as they are in play) and
   * returns a tally keyed by material id, plus the ORE-ONLY percentages that
   * js/mines.js's spawn tables are stated in. Exported for the balance harness;
   * nothing in the game calls it, and it allocates freely because it is a tool.
   *
   *   depthM   how far below THIS LEVEL'S LIFT to sample, in metres
   *   spanM    how tall a slice, in metres (the whisper varies across it)
   *   halfW    how far east and west of the lift line, in world units
   */
  var SAMPLE_STRIP = 114;     // cells (~2400 units) — see the note below
  function sampleSpawn(depthM, spanM, halfW) {
    var out = { cells: 0, empty: 0, solid: 0, oreCells: 0, areaU2: 0,
                counts: {}, orePct: {}, allPct: {} };
    if (!loaded || !bandN) return out;
    var yTop = lvlTopY + num(depthM, 0) / A.METERS_PER_UNIT;
    var yBot = yTop + num(spanM, 100) / A.METERS_PER_UNIT;
    var hw = num(halfW, 1200);
    var r0 = cellYOf(yTop), r1 = cellYOf(yBot);
    if (r0 < bandR0 + SEAL_ROWS) r0 = bandR0 + SEAL_ROWS;
    var c0 = colOfX(-hw), c1 = colOfX(hw);
    var cy, cx, m, mm, id, s0, s1, yMid, stag, px, py;

    /* ROW-MAJOR, IN STRIPS THE WIDTH OF A PLAY WINDOW, and both halves of that
     * matter. Row-major so the gather is paid once per row instead of once per
     * cell (the difference between a second and a minute over a big slab). And
     * in STRIPS because the blob lists are capped at BLOB_MAX: a gather asked
     * about twenty thousand units of rock at once would saturate them and this
     * would report a world the generator does not build. SAMPLE_STRIP is about
     * the width the streamer actually asks for, so what is counted here is
     * exactly what is spawned in play. */
    for (s0 = c0; s0 <= c1; s0 += SAMPLE_STRIP) {
      s1 = s0 + SAMPLE_STRIP;
      if (s1 > c1 + 1) s1 = c1 + 1;
      for (cy = r0; cy <= r1; cy++) {
        yMid = rowMidY(cy);
        stag = rowStagger(cy);
        prepareRow(cy, yMid, lvl, colEdgeX(s0), colEdgeX(s1));
        for (cx = s0; cx < s1; cx++) {
          out.cells++;
          if (carvedCell(cx, cy)) { out.empty++; continue; }
          px = x0 + (cx + 0.5) * SP + stag + (hv(S_JX, cx, cy) * 2 - 1) * SP * JITTER_X;
          py = yMid + (hv(S_JY, cx, cy) * 2 - 1) * SP * JITTER;
          m = cellMaterialAt(cx, cy, px, py, lvl);
          if (m < 0) { out.empty++; continue; }
          out.solid++;
          mm = SM.materials.get(m);
          id = mm.id;
          out.counts[id] = (out.counts[id] || 0) + 1;
          if (mm.ore) out.oreCells++;
        }
      }
    }
    out.areaU2 = out.cells * SP * SP;
    for (id in out.counts) {
      if (!out.counts.hasOwnProperty(id)) continue;
      out.allPct[id] = out.solid > 0
        ? Math.round(out.counts[id] / out.solid * 1e5) / 1e3 : 0;
      if (SM.materials.getById(id).ore) {
        out.orePct[id] = out.oreCells > 0
          ? Math.round(out.counts[id] / out.oreCells * 1e5) / 1e3 : 0;
      }
    }
    return out;
  }

  var mlOut = { x: 0, y: 0, rx: 0, ry: 0, matIndex: 0, depthM: 0 };

  /** Streaming follows the vehicle unless something overrides it here. */
  function setFocusOverride(x, y) { focusOn = true; focusFX = x; focusFY = y; }
  function clearFocusOverride() { focusOn = false; }

  return {
    init: init,
    isActive: isActive,
    beginMine: beginMine,
    endMine: endMine,
    /** True while a mine's geology is still resolved and drawable. */
    isLoaded: function () { return loaded; },
    unload: unload,
    update: update,
    reset: reset,
    render: render,
    renderLit: renderLit,

    markDestroyed: markDestroyed,
    isCarved: isCarved,
    /* THE SAVE SEAM, sparse. js/save.js encodes the descriptor exportCarve()
     * hands back and decodes into the same shape for importCarve(). The old
     * exportMask/importMask pair is gone with the flat array it described. */
    exportCarve: exportCarve,
    importCarve: importCarve,
    maskDims: maskDims,

    depthOfY: depthOfY,
    yOfDepth: yOfDepth,
    layerAtY: layerAtY,
    getGeneratedTo: getGeneratedTo,
    probe: probe,
    probeAll: probeAll,

    /* --- additions beyond the stub (documented in the report) ---------- */
    /** Resolved layer table of the live mine: name/toY/heat/hardnessScale. */
    getLayers: function () { return layers; },
    /** The material ids this generator places. js/mines.js prices these. */
    getMaterialIds: function () { return MAT_IDS; },
    /** The stratum the active level is made of, for the HUD and the harness. */
    getLevelLayer: function () { return lvl; },
    /** How many cells the player has dug out of this mine, ever. */
    getCarvedCount: function () { return carved; },
    /** How many carve chunks are resident. Multiply by 128 for the bytes. */
    getCarveChunkCount: function () { return chunkN; },
    /** The mine's guaranteed motherlode, or null. REUSED object. */
    getMotherlode: function () {
      if (!gldValid) return null;
      mlOut.x = gldX; mlOut.y = gldY; mlOut.matIndex = gldMat;
      mlOut.rx = gldRX; mlOut.ry = gldRY;
      mlOut.depthM = depthOfY(gldY);
      return mlOut;
    },
    /* --- LEVELS AS MAPS (ARCHITECTURE.md §7) -----------------------------
     * Four functions are the whole seam. beginLevel() activates a band;
     * getLevelBounds() is the ONE box js/vehicle.js and js/camera.js clamp
     * against; getDoorX/getDoorY are where the lift is. The door's open state is
     * this module's own business — it computes the machine's distance itself, so
     * there is no event to miss and no state for two files to disagree about. */
    beginLevel: beginLevel,
    getLevelBounds: getLevelBounds,
    /** World x of the level's doors. Always the mine's centre line. */
    getDoorX: function () { return 0; },
    /** World y of the doors' centre: the point EXIT_RADIUS is measured from. */
    getDoorY: function () { return doorY; },
    /** 0 shut .. 1 wide open. For the HUD, if it ever wants to say so — and for
     *  js/adv.js, which reads the leaves' current position before it starts
     *  walking them itself so a transition never begins with a jump. */
    getDoorOpen: function () { return doorOpen; },
    /**
     * PIN THE LEAVES (0..1) for the length of a docking or an undocking, or pass
     * null/-1 to hand them back to the proximity ramp. js/adv.js is the only
     * caller: the doors have to close AFTER the machine is in and open BEFORE it
     * comes out, and "after" is not something a distance can say. See
     * setDoorHold() for why it assigns rather than eases.
     */
    setDoorHold: setDoorHold,
    /**
     * IS THIS POINT INSIDE THE LIFT? The chamber region behind the door line, and
     * the ONE source of truth for it: js/adv.js's isInLift() and js/vehicle.js's
     * "do not draw the machine" both resolve through this, so the three cannot
     * disagree about the frame the machine went in on. See DOOR_IN_*.
     */
    inDoorInterior: inDoorInterior,
    /**
     * HAS IT STARTED TO GO IN? The same column, caught DOOR_CATCH further out —
     * this is what js/adv.js polls to take the machine over and drive it in, and
     * it is deliberately NOT inDoorInterior(), which by then has nothing left to
     * show. See DOOR_CATCH.
     */
    inDoorThreshold: inDoorThreshold,
    /**
     * Alpha for a machine at (x, y): 1 in the rock, 0 in the cage, ramped across
     * the doorway. js/vehicle.js multiplies its render by this so driving into the
     * lift reads as sinking into it. See DOOR_FADE_H.
     *
     * IT IS ALSO WHAT MAKES THE DOCKING GLIDE READ. adv.js's manoeuvre is a
     * straight line along this ramp, so the machine is fully drawn where the
     * player lost control of it and gone by the time it is in the cage, with no
     * second alpha channel anywhere and nothing to keep in step.
     */
    getDoorFade: getDoorFade,
    /** Current level index (1-based), or 0 when no mine is loaded. */
    getLevel: function () { return bandN; },
    /** How many levels the loaded mine has, as bands. */
    getLevelCount: function () { return bands.length; },
    /**
     * TRANSITIONAL ALIASES. js/adv.js resolved the shaft's x through getMouthX()
     * and the dormant rails table is still written against it; a level's lift is
     * on the centre line, so both answer the doors. Drop them once the other side
     * of the seam is on getDoorX/getDoorY.
     */
    getMouthX: function () { return 0; },
    getMouthY: function () { return doorY; },
    /** True where the door chamber's excavation has removed the rock. */
    isLiftVoid: inDoorVoid,

    getDebug: getDebug,
    resetPeaks: resetPeaks,
    /** Grid geometry + the generator's answer for one cell. Tests only. */
    cellMaterial: cellMaterial,
    /** Counted spawn percentages for the active level. Balance harness only. */
    sampleSpawn: sampleSpawn,
    cellOfPoint: function (x, y, out) {
      var o = out || {};
      o.cy = cellYOf(y);
      o.cx = cellXOf(x, o.cy);
      return o;
    },
    setFocusOverride: setFocusOverride,
    clearFocusOverride: clearFocusOverride
  };
})();
