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
 * 2. THE CARVE MASK IS WHAT MAKES TUNNELS REAL.
 *    One byte per generation cell for the whole mine (cols x rows, 247 x 260 =
 *    63 KB for the shallowest mine in the catalogue and 247 x 1745 = 421 KB for
 *    the deepest). ONE FLAT TYPED ARRAY, deliberately, rather than a sparse map
 *    of allocated blocks: this is the hottest path in the file
 *    (`material:destroyed` fires up to ~150 times per step) and a flat array
 *    makes it two integer divides and one byte write with no hashing, no
 *    allocation and no branch on "has this block been created yet". 421 KB for
 *    the one mine that is resident at a time is a price worth paying for that,
 *    and it is also what keeps the save seam (exportMask/importMask, a plain
 *    length check) as simple as it is.
 *    `material:destroyed` marks the cell it came from — O(1), allocation-free,
 *    no strings — and generation
 *    skips marked cells. Without it, driving back through your own tunnel
 *    re-fills it with solid rock. js/save.js RLE-encodes the array between
 *    sessions; the seam is exportMask() / importMask() and it round-trips
 *    byte-for-byte.
 *
 * 3. THE POOL IS 7500 AND THE WINDOW IS A 2D RECTANGLE OF CELLS.
 *    The mine is 5200 world units across — far more than any screen shows and
 *    far more than the pool could hold — so the resident set is a RECTANGLE in
 *    BOTH axes, sized from the camera's view plus ADV.STREAM_MARGIN and clamped
 *    by SOLID_BUDGET. Everything outside it is freed with
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
 *   THE SEAL        the band's four bedrock borders. A LEVEL IS ITS OWN MAP
 *                   (ARCHITECTURE.md §7): the active level is a bounded y-band of
 *                   this coordinate space, and its top rows, bottom rows and
 *                   side columns are spawned as bedrock by a test that runs
 *                   BEFORE the carve mask is consulted. That order is the whole
 *                   point — an old save's tunnel across a band boundary would
 *                   otherwise punch a player-shaped hole in the seal.
 *   THE DOORS       the one piece of geology that is not geology: a chamber
 *                   carved at the band's TOP CENTRE (x = 0) with the lift's big
 *                   closed double doors in its back wall, worklights, and the
 *                   red level board beside them. It is INFRASTRUCTURE — carved
 *                   by the generator from the active band and never written into
 *                   the carve mask, so it exists on a level nobody has visited
 *                   and moves with the band on a ride.
 *   BEDROCK FLOOR   below the mine's stated depth. The bottom of a mine is
 *                   expressed as HARDNESS (26), not as an invisible wall.
 *   MOTHERLODE      the money shot. A big natural cavern whose far WALL is
 *                   lined with a thick shell of the deepest ore in the mine.
 *                   Every mine has exactly one guaranteed one, plus a hashed
 *                   chance of more in its deep layers. The approach is
 *                   readable: HALO STRINGERS of the same ore thicken in the
 *                   country rock as you close in, the background carries a
 *                   faint bloom of its colour through the rock, and the
 *                   scanner sees it long before the drill does.
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
 * WHAT js/mines.js HAS TO SUPPLY, AND WHAT IS OPTIONAL
 *   Required (documented in mines.js): toDepth, name, fill, weights,
 *   pocketRate, cavernRate, hardnessScale, heat. `pocketRate` and `cavernRate`
 *   are per GENERATED BAND as mines.js states them, and perCell() converts.
 *   Optional extras this generator understands, all with sensible depth-derived
 *   defaults so a layer table that only has the required fields still produces
 *   a full arc from soft rich topsoil to barren deep rock with motherlodes in
 *   it:  beds:['sandstone','limestone']  bedPitch  seamRate  driftRate
 *        lodeRate  lode:'ancient'  vugChance
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

  /* --- the generation grid ------------------------------------------- */
  // SP and the shaft width are SM.config.ADV's (shared, frozen). Everything
  // below is derived from them so nothing has to be re-tuned if they move.
  var SP = A.SPACING;                 // 21 — cell pitch, also the mask pitch
  var HALF_W = A.MINE_HALF_WIDTH;     // 880

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

  /* --- LEVELS AS MAPS: THE BAND, THE SEAL, THE DOORS -------------------
   * ARCHITECTURE.md §7. Each level is ITS OWN MAP, and the map is realised as a
   * bounded y-band of this one coordinate space: level k is geological layer k's
   * depth range, the full field width for that level, and NOTHING ELSE IS
   * REACHABLE. Absolute (seed, cellX, cellY) determinism, depth-driven geology
   * and heat, the ONE whole-mine carve mask and the 2D streamer are all
   * unchanged by that — a band is a clamp on the window and a border of bedrock,
   * not a second coordinate system, which is exactly why old saves still load
   * and why per-level tunnel persistence comes free (bands are disjoint in y).
   *
   * WIDTH GROWS WITH DEPTH, because size is part of what a level purchase buys.
   * js/mines.js states `widthU` per band; these are the fallback ladder used
   * while it does not, and the cap is the mine's own width — the mask, the
   * generation grid and the lode/drift lattices are all keyed to HALF_W and a
   * level may not be wider than the mine it is a slice of.
   * ------------------------------------------------------------------ */
  var LVL_W_BASE = 3600;       // full width of level 1, world units (360 m)
  var LVL_W_STEP = 400;        // ...plus this per level down, capped at HALF_W*2
  var LVL_W_MIN = 1400;        // a level narrower than this is not a map

  /* THE SEAL IS COUNTED IN CELLS, NOT IN WORLD UNITS, and that is what makes it
   * exact. A border expressed as "y < bandTop + 63" has to be tested against a
   * deposit's JITTERED position and lands mid-row; a border expressed as "the
   * first three ROWS of the band" is an integer compare, is decided before any
   * position is computed, and coincides EXACTLY with the streaming clamp — the
   * outermost resident rows and columns of a level ARE its seal. It is also what
   * lets markDestroyed() refuse a seal cell in two integer compares.
   *
   * THREE CELLS (63 units) is what reads as a border rather than as a line at
   * every camera scale this mode uses, and the cut-box clip in js/vehicle.js
   * means it is never chewed, so it does not need to be thick enough to survive
   * a tier-5 bit — see THE TWO SEAL TRUTHS in ARCHITECTURE.md §7. */
  var SEAL_ROWS = 3;
  var SEAL_COLS = 3;

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
   *   clear of the floor, and the climb into the interior is 116 units.
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
  /* AND THE MACHINE SINKS IN RATHER THAN POPPING OUT OF EXISTENCE.
   *
   * The machine is about 560 units long (121 of bit ahead of centre, 438.7 of ore
   * bed behind it) and the doorway is 430 tall, so there is NO position at which
   * the whole machine is inside the opening — whatever line "inside" is drawn at,
   * a few hundred units of ore bed is still hanging out of the door on the frame
   * it disappears. Screenshotted, that is exactly the pop it sounds like.
   *
   * So the last 100 units of the approach are a FADE, and js/vehicle.js multiplies
   * the machine's alpha by getDoorFade(). By the time the interior test flips, the
   * machine is already at alpha 0 — so "nothing is drawn while in the lift" stays
   * strictly true AND nothing vanishes. It is also the cheapest possible version:
   * one globalAlpha on a transform that was already being built.
   *
   * FADE_X is the lateral ramp, so a machine driving PAST the doorway on its way
   * somewhere else does not flicker as it crosses the door's x range. */
  var DOOR_FADE_H = 100;
  var DOOR_FADE_X = 90;
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
  var FLOOR_PAD_M = 60;        // metres of bedrock modelled below the bottom

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
   * candidate wide. In a 5200-unit mine that same ladder puts a third as many
   * formations in the same volume of rock and the mode's two best discoveries
   * become three times rarer per metre driven. So both grids now have an X
   * pitch, sized at the ORIGINAL shaft width: at HALF_W 880 there is exactly
   * one candidate column and the shipped feel is unchanged, and a wider mine
   * gets proportionally more of them. This is the same areal-density-invariance
   * perCell() already gives pockets and caverns. */
  var LODE_W = 1760;                 // one motherlode slot per 176 m across
  var LODE_H = 1500;                 // ...and per 150 m of depth
  var LODE_RX = [190, 330];
  var LODE_RY = [140, 250];
  var LODE_SHELL = [1.40, 1.72];     // the glittering wall, as squared-t
  var HALO_T = 3.4;                  // stringers reach this far out (in t)
  var HALO_MAX = 0.22;               // stringer density at the shell wall
  var LODE_ANNOUNCE = 760;           // world units at which `mine:lode` fires
  // The ANCIENT FORMATION is the reward for the bottom of a deep mine, and the
  // brief asks for it in "the deepest mine". A layer table may name it outright
  // (`lode:'ancient'`), but js/mines.js states only the fields its own header
  // documents, so the deepest layer of any mine at least this deep gets it by
  // default. Below that the motherlode is the best ore the layer already has,
  // which keeps a shallow mine's headline formation in proportion to the mine.
  var ANCIENT_DEPTH_M = 650;
  /* The GUARANTEED motherlode stays within this of the MINE'S CENTRE LINE, which
   * is also the line the doors are on. Depth is still the axis of progression, so
   * "go all the way down and there is one waiting" has to survive the mine being
   * 5200 units wide: a headline formation 2400 units off to one side is not a
   * reward, it is a lottery. Rolled lodes are free to be anywhere.
   *
   * IT IS AN ABSOLUTE POSITION AND IT STAYS ONE. The motherlode is not re-placed
   * per level: it sits where the seed put it and simply LIVES on whichever band
   * contains it, which is the level whose price bought the depth it is at. Keying
   * it to the active band instead would regenerate the geology of every seed in
   * the catalogue and make the same formation move when you rode past it. */
  var LODE_GUARANTEED_X = 1150;

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
  var mineDepthM = 400;
  var floorY = 4000;              // bedrock starts here
  var layers = [];
  var deepestY = 0;

  /* ----- the generation grid, resolved once per mine ------------------ */
  var cols = 1, rows = 1;
  var x0 = -HALF_W, y0 = 0;       // world position of cell (0,0)'s top-left
  var mask = null;                // Uint8Array(cols*rows) — 1 = dug out
  var carved = 0;                 // how many cells are marked

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
  var bands = [];                 // [{i, name, topM, botM, halfW}], live mine
  var bandN = 0;                  // active level index, 1-based (0 = none)
  var bandR0 = 0, bandR1 = 0;     // the band's rows, [R0, R1)
  var bandC0 = 0, bandC1 = 0;     // ...and columns, [C0, C1)
  var bandTopY = 0, bandBotY = 0; // the band's outer edges, on exact cell lines
  var bandXL = 0, bandXR = 0;
  var lvlTopY = 0, lvlBotY = 0;   // the void inside the seal
  var lvlHalfW = 0;
  var needFill = false;           // a band change owes us one full re-fill

  /* THE DOORS. Geometry derived from the band in setBand(); `doorOpen` is the
   * only animated state in this file and it is driven by machine proximity in
   * update(), not by an event — see DOOR_NEAR. `doorArt` is the red level board,
   * baked by readoutFor() the way a station's board was. */
  var doorCeilY = 0;              // the chamber's ceiling = the seal's inner face
  var doorCY = 0;                 // the chamber's centre
  var doorTopY = 0;               // the lintel
  var doorMidY = 0;               // the leaves' own centre (art only)
  var doorSillY = 0;              // the THRESHOLD — what getDoorY() publishes
  var doorY = 0;                  // = doorSillY. Named for the getter it feeds.
  var doorOpen = 0;               // 0 shut .. 1 wide open
  var doorArt = null;
  var doorFlick = 1;              // last geometry-pass flicker, for renderLit()
  var headMix = 0;                // 0..1, how solidly the doorway occludes

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

  /** Hash -> 0..1, salted and tied to the mine seed. */
  function hv(salt, a, b) { return h3(mineSeed ^ salt, a, b) / 4294967296; }

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
   * The grid is anchored to the MINE. Cell (0,0)'s top-left corner is
   * (x0, MINE_CEILING_Y), and cols is chosen so the grid is centred in the
   * shaft with a sliver of clearance against each bedrock wall.
   * =================================================================== */

  function buildGrid() {
    cols = Math.floor((HALF_W * 2) / SP);
    if (cols < 4) cols = 4;
    x0 = -HALF_W + ((HALF_W * 2) - cols * SP) * 0.5;
    y0 = A.MINE_CEILING_Y;
    var bottomM = mineDepthM + FLOOR_PAD_M;
    rows = Math.ceil((bottomM / A.METERS_PER_UNIT) / SP) + 2;
    if (rows < 8) rows = 8;
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
   * THE CARVE MASK
   * =================================================================== */

  function allocMask() {
    var n = cols * rows;
    if (!mask || mask.length !== n) mask = new Uint8Array(n);
    else mask.fill(0);
    carved = 0;
  }

  /**
   * Mark the cell containing (x, y) as dug out.
   *
   * HOT PATH: `material:destroyed` fires up to ~150 times per step. Integer
   * maths and one array write, no allocation, no strings, no events.
   *
   * IT REFUSES A SEAL CELL, and that is not belt-and-braces: the mask is the
   * mine's whole history and it is saved, so one seal byte written by a tier-5
   * bit that got a shot at the border would be a permanent hole in the border of
   * a level — in a save file, in every future session. The generator already
   * refuses to read the mask there (see generateRowStrip), so this is the second
   * of the two locks, and it is the cheap one: four integer compares.
   */
  function markDestroyed(x, y) {
    if (!active || !mask) return;
    var cy = Math.floor((y - y0) / SP);
    if (cy < bandR0 + SEAL_ROWS || cy >= bandR1 - SEAL_ROWS) return;
    var cx = Math.floor((x - ((cy & 1) ? SP * STAGGER : -SP * STAGGER) - x0) / SP);
    if (cx < bandC0 + SEAL_COLS || cx >= bandC1 - SEAL_COLS) return;
    var i = cy * cols + cx;
    if (mask[i]) return;
    mask[i] = 1;
    carved++;
  }

  function isCarved(x, y) {
    if (!mask) return false;
    var cy = cellYOf(y);
    if (cy < 0 || cy >= rows) return false;
    var cx = cellXOf(x, cy);
    if (cx < 0 || cx >= cols) return false;
    return mask[cy * cols + cx] === 1;
  }

  function exportMask() { return mask; }

  /** Adopt a decoded mask. Refuses anything that is not exactly our shape. */
  function importMask(u8) {
    if (!mask || !u8 || !u8.length || u8.length !== mask.length) return false;
    mask.set(u8);
    carved = 0;
    for (var i = 0; i < mask.length; i++) if (mask[i]) carved++;
    return true;
  }

  var dimsOut = { cols: 0, rows: 0, spacing: 0, x0: 0, y0: 0, length: 0 };
  /**
   * Keyed on the ARRAY existing, not on a run being live: js/save.js validates
   * a decoded mask's length against this, and it does that around load and save
   * — both of which can happen with no run in progress.
   */
  function maskDims() {
    if (!mask) return null;
    dimsOut.cols = cols; dimsOut.rows = rows; dimsOut.spacing = SP;
    dimsOut.x0 = x0; dimsOut.y0 = y0;
    dimsOut.length = cols * rows;
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

  /** Clamp and record one band. Rejects a degenerate one rather than clamping. */
  function pushBand(i, name, topM, botM, widthU) {
    if (botM > mineDepthM) botM = mineDepthM;
    if (!(botM > topM)) return;
    var w = widthU > 0 ? widthU : (LVL_W_BASE + (i - 1) * LVL_W_STEP);
    if (w > HALF_W * 2) w = HALF_W * 2;
    if (w < LVL_W_MIN) w = LVL_W_MIN;
    bands.push({ i: i, name: name || ('LEVEL ' + i),
                 topM: topM, botM: botM, halfW: w * 0.5 });
  }

  /**
   * Resolve the whole ladder for the live mine, shallowest first. Called once by
   * beginMine(); a ride only ever calls setBand().
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
        pushBand(num(e.i, i + 1), e.name, num(e.depthTopM, 0),
                 num(e.depthBotM, mineDepthM), num(e.widthU, 0));
      }
    } else {
      /* NO BAND TABLE. One level per layer, cumulatively — which is the same cut
       * js/mines.js makes, so a build with either half missing plays the same
       * shape of world. */
      var src = (def && def.layers && def.layers.length) ? def.layers : DEFAULT_LAYERS;
      var from = 0;
      for (i = 0; i < src.length; i++) {
        var to = num(src[i].toDepth, mineDepthM);
        if (i === src.length - 1 || to > mineDepthM) to = mineDepthM;
        pushBand(bands.length + 1, src[i].name, from, to, 0);
        from = to;
        if (from >= mineDepthM) break;
      }
    }
    // A mine with no usable table at all is still one whole level, not a crash.
    if (!bands.length) {
      pushBand(1, (def && def.name) || 'LEVEL 1', 0, mineDepthM, 0);
    }
  }

  /**
   * ACTIVATE BAND L (1-based, clamped). Everything the rest of the file needs is
   * derived here and nowhere else.
   *
   * THE BAND IS AN INTEGER CELL RECTANGLE FIRST and a world box second, and that
   * order is the whole trick. Both ends of the row range come from cellYOf(), so
   * consecutive bands are exactly disjoint — [R0, R1) then [R1, R2) — with no
   * shared row and no gap, which is what makes the ONE whole-mine carve mask a
   * per-level mask for free. The world edges are then read back off the lattice
   * (rowTopY / colEdgeX) rather than from the metres, so the seal, the streaming
   * clamp and the despawn cuts all land on the SAME lines.
   */
  function setBand(L) {
    var n = bands.length;
    if (!n) return false;
    var i = Math.floor(num(L, 1));
    if (!(i >= 1)) i = 1;
    if (i > n) i = n;
    var b = bands[i - 1];
    bandN = i;

    bandR0 = cellYOf(yOfDepth(b.topM));
    bandR1 = cellYOf(yOfDepth(b.botM));
    if (bandR0 < 0) bandR0 = 0;
    if (bandR1 > rows) bandR1 = rows;
    /* A band has to be able to HOLD the seal and a chamber. A layer table thin
     * enough to fail this is a data bug, but a data bug must not produce an
     * inverted rectangle here — every clamp downstream is derived from it. */
    var minRows = SEAL_ROWS * 2 + Math.ceil((DOOR_RY * 2 + SP) / SP) + 2;
    if (bandR1 - bandR0 < minRows) {
      bandR1 = bandR0 + minRows;
      if (bandR1 > rows) { bandR1 = rows; bandR0 = bandR1 - minRows; }
      if (bandR0 < 0) bandR0 = 0;
    }

    var hw = b.halfW > HALF_W ? HALF_W : b.halfW;
    bandC0 = colOfX(-hw);
    bandC1 = colOfX(hw) + 1;
    if (bandC0 < 0) bandC0 = 0;
    if (bandC1 > cols) bandC1 = cols;

    bandTopY = rowTopY(bandR0);
    bandBotY = rowTopY(bandR1);
    bandXL = colEdgeX(bandC0);
    bandXR = colEdgeX(bandC1);

    // The playable void, INSIDE the seal. This is getLevelBounds().
    lvlTopY = rowTopY(bandR0 + SEAL_ROWS);
    lvlBotY = rowTopY(bandR1 - SEAL_ROWS);
    var wL = -colEdgeX(bandC0 + SEAL_COLS), wR = colEdgeX(bandC1 - SEAL_COLS);
    lvlHalfW = wL < wR ? wL : wR;

    /* THE DOORS, hung off the seal's inner face at the top of the band. The
     * chamber's ceiling IS that face, so the excavation can never eat into the
     * border it hangs from however the numbers above move. */
    doorCeilY = lvlTopY;
    doorCY = doorCeilY + DOOR_RY;
    doorTopY = doorCeilY + DOOR_TOP;
    doorSillY = doorTopY + DOOR_H;
    doorMidY = doorTopY + DOOR_H * 0.5;
    doorY = doorSillY;                 // the doorstep: see the DOOR_* note
    /* OPEN, because the machine has just come out of them. Closing behind you as
     * you drive off is the read we want; snapping shut the frame you arrive is
     * not, and it is also not what happened. */
    doorOpen = 1;
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
    }
    lastLayer = -1;                    // the stratum is re-announced on arrival
    return getLevelBounds();
  }

  /* THE PLAYABLE BOX, REUSED. js/vehicle.js clamps its position and CLIPS ITS
   * CUT BOX to this, and js/camera.js frames it; nothing else in the codebase
   * should ever spell a level's extent out. Null while no band is active, which
   * is a state both callers must handle — a zeroed box would pin the machine at
   * the origin, which is worse than no clamp at all. */
  var lvlOut = { level: 0, topY: 0, botY: 0, halfW: 0 };
  function getLevelBounds() {
    if (!bandN) return null;
    lvlOut.level = bandN;
    lvlOut.topY = lvlTopY;
    lvlOut.botY = lvlBotY;
    lvlOut.halfW = lvlHalfW;
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
    var ky = clamp01((y - (doorSillY - DOOR_IN_BOT)) / DOOR_FADE_H);
    return 1 - kx * (1 - ky);
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
   * `headMix` rides the same distance: it is how solidly the doorway's own
   * structure is re-drawn over the machine in the emissive pass, which is what
   * makes driving in read as passing INTO something. See HEAD_FAR.
   */
  function animateDoor(dt) {
    if (!bandN) return;
    var dx = focusX(), dy = focusY() - doorY;
    var d = Math.sqrt(dx * dx + dy * dy);
    var inside = machineInLift();
    var t = inside ? 0 : clamp01((DOOR_FAR - d) / (DOOR_FAR - DOOR_NEAR));
    var rate = inside ? DOOR_SHUT_LERP : DOOR_LERP;
    doorOpen += (t - doorOpen) * (1 - Math.exp(-rate * dt));
    var h = clamp01((HEAD_FAR - d) / (HEAD_FAR - HEAD_NEAR));
    headMix += (h - headMix) * (1 - Math.exp(-6 * dt));
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
      lodeRate: 0.14, hardnessScale: 1.15, heat: 0.15 },
    { toDepth: 460, name: 'GRANITE', fill: 'granite', beds: ['granite', 'stone'],
      weights: { gold: 5, platinum: 2, uranium: 2, silver: 2 },
      pocketRate: 0.32, cavernRate: 0.11, seamRate: 0.14, driftRate: 0.07,
      lodeRate: 0.26, hardnessScale: 1.3, heat: 0.35 },
    { toDepth: 1e9, name: 'THE DEEP', fill: 'obsidian',
      beds: ['obsidian', 'granite', 'bedrock'],
      weights: { platinum: 4, uranium: 4, gold: 2 },
      pocketRate: 0.18, cavernRate: 0.08, seamRate: 0.06, driftRate: 0.02,
      lodeRate: 0.42, lode: 'ancient', hardnessScale: 1.5, heat: 0.7 }
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
   * band", where a band is BAND_REF tall and the full shaft wide. Convert to a
   * probability per structure cell of the given size.
   */
  function perCell(rate, cw, ch, dflt) {
    var r = num(rate, dflt);
    if (!(r > 0)) return 0;
    var cellsPerBand = ((HALF_W * 2) / cw) * (BAND_REF / ch);
    if (!(cellsPerBand > 0)) return 0;
    var p = r / cellsPerBand;
    return p > 0.85 ? 0.85 : p;
  }

  function buildLayers(def) {
    layers.length = 0;
    var src = (def && def.layers && def.layers.length) ? def.layers : DEFAULT_LAYERS;
    var n = src.length;
    for (var i = 0; i < n; i++) {
      var s = src[i] || {};
      // Relative depth of this layer, 0 = shallowest .. 1 = deepest. Every
      // optional rate defaults off this, which is what gives an under-specified
      // layer table the arc described in the header for free.
      var f = (n <= 1) ? 1 : i / (n - 1);
      var L = {};
      L.idx = i;
      L.name = s.name || ('LAYER ' + (i + 1));
      L.toDepth = num(s.toDepth, 1e9);
      L.toY = yOfDepth(L.toDepth);
      L.fill = matIdx(s.fill, 'stone');
      L.beds = buildBeds(s, L);
      L.ores = buildWeights(s.weights);
      L.pocketP = perCell(s.pocketRate, POCKET_W, POCKET_H, 0.9 - 0.7 * f);
      L.cavernP = perCell(s.cavernRate, CAVERN_W, CAVERN_H, 0.06 + 0.10 * f);
      L.seamP = num(s.seamRate, 0.38 - 0.26 * f);
      L.driftP = num(s.driftRate, 0.42 - 0.36 * f);
      L.lodeP = num(s.lodeRate, f < 0.55 ? 0 : (f - 0.55) / 0.45 * 0.42);
      L.lodeMat = s.lode ? matIdx(s.lode, 'ancient')
        : ((i === n - 1 && mineDepthM >= ANCIENT_DEPTH_M)
            ? matIdx('ancient', 'starcore')
            : richestOre(L.ores));
      L.bedPitch = num(s.bedPitch, BED_PITCH * (0.78 + hv(S_BED, i, 5) * 0.55));
      L.hardnessScale = num(s.hardnessScale, 1);
      L.heat = num(s.heat, 0);
      L.vug = num(s.vugChance, 0.16 - 0.10 * f);
      layers.push(L);
    }
    // The deepest layer always runs to the bottom of the world, whatever it
    // declared: below it there is only bedrock, and that is floorY's job.
    layers[layers.length - 1].toY = 1e12;
  }

  function layerIndexAtY(y) {
    for (var i = 0; i < layers.length; i++) if (y < layers[i].toY) return i;
    return layers.length - 1;
  }
  function layerAtY(y) {
    if (!layers.length) return null;
    return layers[layerIndexAtY(y)];
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
  var K_LODE = 0, K_CAVERN = 1, K_POCKET = 2;

  // Sized for the widest strip a 2D window generates (a full window-wide row),
  // with headroom: a 5200-unit mine's shallow layers can put a dozen pockets
  // and a couple of caverns across one row, and a dropped blob would be a
  // formation the scanner reports and the rock does not contain.
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
   * Every mine gets exactly ONE guaranteed lode, placed deterministically in
   * the lowest 20-140 m of its stated depth — the reward for going all the way
   * down is never a coin flip. Deep layers then roll for extra ones on the
   * LODE_H grid, so a big mine can hold several and a shallow one holds only
   * the guaranteed one.
   * ------------------------------------------------------------------ */

  /** Fill the lode scratch slots for grid cell (i, j). -> true if one exists. */
  var lodeX = 0, lodeY = 0, lodeRX = 0, lodeRY = 0, lodeMat = 0, lodeShell = 0, lodeId = 0;

  function lodeOfCell(i, j) {
    var yc = (j + 0.5) * LODE_H + (hv(S_LODE, i * 71 + 1, j) - 0.5) * LODE_H * 0.7;
    var L = layerAtY(yc);
    if (!L || L.lodeP <= 0) return false;
    if (hv(S_LODE, i * 71 + 2, j) >= L.lodeP) return false;
    return describeLode(i, j, yc, L, 1.0, false);
  }

  /**
   * Resolve one motherlode into the scratch slots.
   * `centred` is the guaranteed lode: it is placed near the MINE'S centre line
   * rather than anywhere across the width (see LODE_GUARANTEED_X), because it is
   * the payoff for DEPTH. That line is x = 0, which is also where the doors are —
   * see the note on LODE_GUARANTEED_X for why it is an absolute position and why
   * re-keying it per level would be a regeneration rather than a relocation.
   */
  function describeLode(i, j, yc, L, scale, centred) {
    if (!L) return false;
    lodeId = h3(mineSeed ^ S_LODE, i * 71 + 7, j) | 0;
    lodeRX = lerp(LODE_RX[0], LODE_RX[1], hv(S_LODE, i * 71 + 3, j)) * scale;
    lodeRY = lerp(LODE_RY[0], LODE_RY[1], hv(S_LODE, i * 71 + 4, j)) * scale;
    // Keep the whole chamber inside the shaft, shell included.
    var inset = lodeRX * Math.sqrt(LODE_SHELL[1]) + 30;
    var u = hv(S_LODE, i * 71 + 5, j);
    if (centred) {
      var span = HALF_W - inset;
      if (span > LODE_GUARANTEED_X) span = LODE_GUARANTEED_X;
      if (span < 0) span = 0;
      lodeX = (u * 2 - 1) * span;
    } else {
      /* Anchored to the lode grid cell, then pulled inside the walls. The
       * REJECT comes first and matters: the i-range a caller scans is padded by
       * the halo reach, so without it every cell beyond the wall would resolve
       * to a lode clamped ONTO the wall and a wide mine would grow a stack of
       * them along both edges. A cell whose anchor is outside the mine has no
       * lode; a cell whose anchor is inside keeps it, hugging the wall if it
       * must. */
      lodeX = (i + u) * LODE_W;
      if (lodeX < -HALF_W || lodeX > HALF_W) return false;
      var lim = HALF_W - inset;
      if (lim < 0) lim = 0;
      if (lodeX > lim) lodeX = lim; else if (lodeX < -lim) lodeX = -lim;
    }
    lodeY = yc;
    lodeShell = lerp(LODE_SHELL[0], LODE_SHELL[1], hv(S_LODE, i * 71 + 6, j));
    lodeMat = L.lodeMat;
    return true;
  }

  /* Structure-grid cell range covering [xLo, xHi] with `pad` units of reach.
   * Every 2D structure family resolves its i-range through these two so the
   * generator, the scanner and the renderer can never disagree about which
   * cells they are looking at. */
  function cellI0(xLo, w, pad) { return Math.floor((xLo - pad) / w); }
  function cellI1(xHi, w, pad) { return Math.floor((xHi + pad) / w); }

  /** The guaranteed motherlode of this mine. Cached; depends only on the seed. */
  var gldValid = false, gldX = 0, gldY = 0, gldRX = 0, gldRY = 0,
      gldMat = 0, gldShell = 0, gldId = 0;

  function buildGuaranteedLode() {
    gldValid = false;
    if (!layers.length) return;
    var bottom = yOfDepth(mineDepthM);
    var up = 200 + hv(S_LODE, 991, 1) * 1200;      // 20-140 m above the floor
    var yc = bottom - up;
    if (yc < yOfDepth(20)) yc = yOfDepth(20);
    var L = layerAtY(yc);
    // A little bigger than a rolled one: this is the mine's headline formation.
    if (!describeLode(0, 991, yc, L, 1.18, true)) return;
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
   * A STRUCTURE BELONGS TO THE LAYER ITS CENTRE IS IN, not to the layer of the
   * row we happen to be filling. That is not a detail: probeAll() (the
   * scanner) asks about structures without any row context at all, so if the
   * two disagreed the scanner would report formations that do not exist, and
   * miss ones that do, everywhere near a layer boundary. Both paths resolve the
   * layer the same way — from the structure's own hashed centre.
   * ------------------------------------------------------------------ */
  function gatherCaverns(ry, gxLo, gxHi) {
    var i0 = cellI0(gxLo, CAVERN_W, CAVERN_MAX_R + CAVERN_W);
    var i1 = cellI1(gxHi, CAVERN_W, CAVERN_MAX_R + CAVERN_W);
    var j0 = Math.floor((ry - CAVERN_MAX_R - SP) / CAVERN_H);
    var j1 = Math.floor((ry + CAVERN_MAX_R + SP) / CAVERN_H);
    for (var j = j0; j <= j1; j++) {
      for (var i = i0; i <= i1; i++) {
        var cyw = j * CAVERN_H + hv(S_CAV, i * 31 + 4, j) * CAVERN_H;
        var L = layerAtY(cyw);
        if (!L || L.cavernP <= 0) continue;
        if (hv(S_CAV, i, j) >= L.cavernP) continue;
        var rx = lerp(CAVERN_MIN_R, CAVERN_MAX_R, hv(S_CAV, i * 31 + 1, j));
        var ryd = rx * lerp(0.44, 0.86, hv(S_CAV, i * 31 + 2, j));
        var cxw = i * CAVERN_W + hv(S_CAV, i * 31 + 3, j) * CAVERN_W;
        var mineral = hv(S_CAVM, i, j) < CAVERN_MINERAL;
        var shell = mineral
          ? lerp(CAVERN_SHELL[0], CAVERN_SHELL[1], hv(S_CAVM, i + 7, j))
          : 1;
        var dy = ry - cyw; if (dy < 0) dy = -dy;
        if (dy > ryd * Math.sqrt(shell) + SP) continue;
        var m = mineral && L.ores ? pickWeighted(L.ores, hv(S_CAVM, i + 13, j)) : -1;
        pushBlob(cxw, cyw, rx, ryd, m, shell, K_CAVERN, h3(mineSeed ^ S_CAV, i, j) | 0);
      }
    }
  }

  /* ----- ore pockets -------------------------------------------------- */
  function gatherPockets(ry, gxLo, gxHi) {
    var i0 = cellI0(gxLo, POCKET_W, POCKET_BIG_R + POCKET_W);
    var i1 = cellI1(gxHi, POCKET_W, POCKET_BIG_R + POCKET_W);
    var j0 = Math.floor((ry - POCKET_BIG_R - SP) / POCKET_H);
    var j1 = Math.floor((ry + POCKET_BIG_R + SP) / POCKET_H);
    for (var j = j0; j <= j1; j++) {
      for (var i = i0; i <= i1; i++) {
        var cyw = j * POCKET_H + hv(S_POCK, i * 17 + 5, j) * POCKET_H;
        var L = layerAtY(cyw);
        if (!L || L.pocketP <= 0) continue;
        if (hv(S_POCK, i, j) >= L.pocketP) continue;
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
        var vug = hv(S_POCKM, i, j) < L.vug;
        var m = vug ? -1 : pickWeighted(L.ores, hv(S_POCKM, i + 5, j));
        pushBlob(cxw, cyw, rx, ryd, m, 1, K_POCKET, h3(mineSeed ^ S_POCK, i, j) | 0);
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
    var yc = j * DRIFT_H + hv(S_DRIFT, i * 53 + 2, j) * DRIFT_H;
    var L = layerAtY(yc);
    if (!L || L.driftP <= 0) return false;
    if (hv(S_DRIFT, i * 53 + 1, j) >= L.driftP) return false;
    var w = lerp(DRIFT_MIN_W, DRIFT_MAX_W, hv(S_DRIFT, i * 53 + 4, j));
    // Anchored to the cell, rejected if the cell is not in this mine, then
    // pulled inside the walls — see the note in describeLode().
    var cx = (i + hv(S_DRIFT, i * 53 + 5, j)) * DRIFT_W;
    if (cx < -HALF_W || cx > HALF_W) return false;
    var lim = HALF_W - w * 0.5 - 20;
    if (lim < 0) lim = 0;
    if (cx > lim) cx = lim; else if (cx < -lim) cx = -lim;
    dfX = cx; dfY = yc; dfW = w;
    dfH = SP * lerp(1.7, 3.1, hv(S_DRIFT, i * 53 + 3, j));
    dfId = h3(mineSeed ^ S_DRIFT, i * 53 + 9, j) | 0;
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
    var si = Math.floor(ry / SEAM_PITCH);
    for (var k = -1; k <= 1; k++) {
      var j = si + k;
      var cyc = (j + 0.18 + hv(S_SEAM, j, 101) * 0.64) * SEAM_PITCH;
      var L = layerAtY(cyc);
      if (!L || L.seamP <= 0 || !L.ores) continue;
      if (hv(S_SEAM, j, L.idx) >= L.seamP) continue;
      var half = SP * lerp(0.7, 2.3, hv(S_SEAM, j, 202));
      if (ry < cyc - half - SEAM_WARP - SP) continue;
      if (ry > cyc + half + SEAM_WARP + SP) continue;
      seamOn = true;
      seamJ = j;
      seamCy = cyc;
      seamHalf = half;
      seamMat = pickWeighted(L.ores, hv(S_SEAMM, j, L.idx));
      seamPinch = lerp(0.30, 0.64, hv(S_SEAM, j, 303));
      return;
    }
  }

  /**
   * Gather the structures that can touch row `cy` between world x `gxLo` and
   * `gxHi`. The x range is the STRIP being filled, not the mine: a column strip
   * asks about 21 units of rock and a row strip about the width of the window,
   * and the cost of the gather tracks that instead of the mine's width.
   */
  function prepareRow(cy, ry, L, gxLo, gxHi) {
    bbN = 0;
    gxA = gxLo; gxB = gxHi;
    gatherLodes(ry, gxLo, gxHi);
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

    /* --- the floor of the mine --------------------------------------- */
    if (py > floorY) {
      // A ragged top surface so the floor does not read as a drawn line.
      if (py < floorY + SP * 1.5 && hv(S_FLOOR, cx, cy) < 0.35) return M_GRANITE;
      return M_BEDROCK;
    }

    /* --- blobs: motherlode, then cavern, then pocket ------------------ */
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

    /* 4: THE LEVEL IS THE WORLD. Clamp to the active band on all four sides —
     * this file used to have no world-y bound at all, because there was only ever
     * one continuous field. Clamping (rather than sliding the window back inside)
     * is right twice over: it never generates rock the level does not have, and it
     * can only ever REDUCE the resident count, so it cannot cost budget. The
     * machine stays inside its own terrain regardless, because the machine is
     * inside the band by construction (js/vehicle.js's clamp) and the unclamped
     * window always contains the machine (WINDOW_BIAS). */
    if (bandN) {
      if (winTop < bandTopY) winTop = bandTopY;
      if (winBot > bandBotY) winBot = bandBotY;
      if (winL < bandXL) winL = bandXL;
      if (winR > bandXR) winR = bandXR;
    }

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
   * EVERYTHING OUTSIDE THE ACTIVE BAND IS SKIPPED, which is what makes a level a
   * map rather than a region: cells beyond [bandR0, bandR1) x [bandC0, bandC1) are
   * not generated at all, so no drill tier can reach anything there because there
   * is nothing there to reach.
   *
   * AND THE SEAL BEATS THE MASK. The border rows and columns spawn bedrock BEFORE
   * the `mask[]` consult below, and that order is the one measured truth this
   * whole feature hangs off (ARCHITECTURE.md §7): the mask is a byte per cell of
   * everything the player has ever dug, saved with the company, and a v1.8 save
   * whose tunnel crossed what is now a band boundary would otherwise punch a
   * player-shaped hole straight through the border — a hole that persists in the
   * save file forever. Sealing over such a tunnel is accepted and deliberate; a
   * seal with holes in it is not a seal. (Precedent, same shape, same reason: the
   * sub-floor bedrock strip that used to live here.)
   */
  function generateRowStrip(cy, c0, c1) {
    if (c0 < bandC0) c0 = bandC0;
    if (c1 > bandC1) c1 = bandC1;
    if (c1 <= c0) return true;
    if (!canAfford(c1 - c0)) return false;
    if (cy < bandR0 || cy >= bandR1) return true;  // not this level's rock

    var yMid = rowMidY(cy);
    var stag = rowStagger(cy);
    var cx, px, py;

    if (yMid > deepestY) deepestY = yMid;

    /* THE BORDER. A whole row of it top and bottom; SEAL_COLS of every other row
     * at each side. Both are integer cell tests decided before a single position
     * is computed — see the SEAL note in the tunables. */
    var sealRow = (cy < bandR0 + SEAL_ROWS) || (cy >= bandR1 - SEAL_ROWS);
    var sealL = bandC0 + SEAL_COLS, sealR = bandC1 - SEAL_COLS;
    var brad = Math.min(11, SM.materials.get(M_BEDROCK).radius[0] * RAD_GAIN);

    var L = null;
    if (!sealRow) {
      L = layers.length ? layers[layerIndexAtY(yMid)] : null;
      prepareRow(cy, yMid, L, colEdgeX(c0), colEdgeX(c1));
    }

    var base = cy * cols;
    for (cx = c0; cx < c1; cx++) {
      px = x0 + (cx + 0.5) * SP + stag + (hv(S_JX, cx, cy) * 2 - 1) * SP * JITTER_X;
      py = yMid + (hv(S_JY, cx, cy) * 2 - 1) * SP * JITTER;

      if (sealRow || cx < sealL || cx >= sealR) {
        SM.particles.spawnSolid(px, py, M_BEDROCK, brad);
        continue;
      }
      if (mask[base + cx]) continue;               // already dug out

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
    if (cx < bandC0 || cx >= bandC1) return true;
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
    /* THE BAND IS THE HARD EDGE, in cells, so the outermost resident row and
     * column of a level are exactly its seal — no off-by-one strip of unsealed
     * rock at an edge, and no strip of seal the streamer believes it is missing
     * and re-asks for every step. computeWindow() has already clamped the world
     * box; this is the same clamp on the lattice, and it is the one the fill loop
     * and trimTo() actually walk. */
    if (bandN) {
      if (wantC0 < bandC0) wantC0 = bandC0;
      if (wantC1 > bandC1) wantC1 = bandC1;
      if (wantR0 < bandR0) wantR0 = bandR0;
      if (wantR1 > bandR1) wantR1 = bandR1;
    }
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
    mineDepthM = (def && def.depth > 0) ? def.depth : 400;
    floorY = yOfDepth(mineDepthM);

    buildGrid();
    allocMask();
    buildLayers(def);
    buildGuaranteedLode();
    buildTiles();
    /* BEFORE the first fill: the band, its seal and its doors are part of the
     * geology this mine generates, not something painted on afterwards. The level
     * js/adv.js is entering on is asked for, never assumed — and a build where it
     * cannot answer starts on level 1, which is the one every company owns. */
    loaded = true;                     // resolveBands/setBand need the geometry
    resolveBands(def);
    var L0 = 1;
    if (SM.adv && typeof SM.adv.getLevel === 'function') {
      var g = SM.adv.getLevel();
      if (typeof g === 'number' && isFinite(g) && g >= 1) L0 = Math.floor(g);
    }
    setBand(L0);
    needFill = false;

    /* Restore the tunnels. Two possible providers, because the mask lives in
     * save.js's record but is this module's array: prefer an already-decoded
     * Uint8Array, fall back to asking save.js to decode its RLE string. A
     * corrupt mask costs the player their tunnels and nothing else. */
    if (mineState) {
      var m = mineState.mask;
      if (m && m.length && typeof m !== 'string') {
        importMask(m);
      } else if (typeof m === 'string' && m.length &&
                 SM.save && SM.save.decodeMask) {
        var u8 = null;
        try { u8 = SM.save.decodeMask(m, cols * rows); } catch (e) { u8 = null; }
        if (u8) importMask(u8);
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
   * End the RUN and hand the mask back for saving. Also writes the still-buried
   * piles into the mine's save record if it has one, so dropped cargo survives
   * a session and not just a band recycle.
   *
   * Deliberately does NOT unload the geology — see the two-flag note at the top.
   * The extraction card, the world map and the workshop all render over a live
   * mine, and dropping the layer table here is what made them render over the
   * classic time-attack lane instead. unload() is the other half.
   */
  function endMine() {
    var out = '';
    if (mask && SM.save && SM.save.encodeMask) {
      try { out = SM.save.encodeMask(mask) || ''; } catch (e) { out = ''; }
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
    bandR0 = bandR1 = bandC0 = bandC1 = 0;
    needFill = false;
    doorArt = null;
    doorOpen = 0;
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
     * should one the door chamber's excavation removed, or one on the far side of
     * the seal. The band test is the important one now: an instrument that points
     * at ore under the floor of a level you cannot dig through is an instrument
     * lying about the only rule the mode has. */
    if (y < lvlTopY || y > lvlBotY || x < -lvlHalfW || x > lvlHalfW) return;
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

    /* --- pockets and mineralised caverns ------------------------------ */
    var pi0 = Math.floor((px - range) / POCKET_W), pi1 = Math.floor((px + range) / POCKET_W);
    var pj0 = Math.floor((py - range) / POCKET_H), pj1 = Math.floor((py + range) / POCKET_H);
    for (j = pj0; j <= pj1; j++) {
      for (i = pi0; i <= pi1; i++) {
        var cyw = j * POCKET_H + hv(S_POCK, i * 17 + 5, j) * POCKET_H;
        L = layerAtY(cyw);
        if (!L || L.pocketP <= 0) continue;
        if (hv(S_POCK, i, j) >= L.pocketP) continue;
        if (hv(S_POCKM, i, j) < L.vug) continue;             // hollow, no ore
        var big = hv(S_POCK, i * 17 + 1, j) < POCKET_BIG;
        var rx = big
          ? lerp(POCKET_MAX_R, POCKET_BIG_R, hv(S_POCK, i * 17 + 2, j))
          : lerp(POCKET_MIN_R, POCKET_MAX_R, hv(S_POCK, i * 17 + 2, j));
        var ryd = rx * lerp(0.48, 0.95, hv(S_POCK, i * 17 + 3, j));
        var cxw = i * POCKET_W + hv(S_POCK, i * 17 + 4, j) * POCKET_W;
        tryContact(out, cxw, cyw, pickWeighted(L.ores, hv(S_POCKM, i + 5, j)),
                   rx, ryd, px, py, range);
      }
    }
    var ci0 = Math.floor((px - range) / CAVERN_W), ci1 = Math.floor((px + range) / CAVERN_W);
    var cj0 = Math.floor((py - range) / CAVERN_H), cj1 = Math.floor((py + range) / CAVERN_H);
    for (j = cj0; j <= cj1; j++) {
      for (i = ci0; i <= ci1; i++) {
        if (hv(S_CAVM, i, j) >= CAVERN_MINERAL) continue;
        var ccy = j * CAVERN_H + hv(S_CAV, i * 31 + 4, j) * CAVERN_H;
        L = layerAtY(ccy);
        if (!L || L.cavernP <= 0 || !L.ores) continue;
        if (hv(S_CAV, i, j) >= L.cavernP) continue;
        var crx = lerp(CAVERN_MIN_R, CAVERN_MAX_R, hv(S_CAV, i * 31 + 1, j));
        var cry = crx * lerp(0.44, 0.86, hv(S_CAV, i * 31 + 2, j));
        var ccx = i * CAVERN_W + hv(S_CAV, i * 31 + 3, j) * CAVERN_W;
        tryContact(out, ccx, ccy, pickWeighted(L.ores, hv(S_CAVM, i + 13, j)),
                   crx, cry, px, py, range);
      }
    }

    /* --- seams: report the nearest point on the bed, not its centre --- */
    var s0 = Math.floor((py - range) / SEAM_PITCH), s1 = Math.floor((py + range) / SEAM_PITCH);
    for (j = s0; j <= s1; j++) {
      var scy = (j + 0.18 + hv(S_SEAM, j, 101) * 0.64) * SEAM_PITCH;
      L = layerAtY(scy);
      if (!L || L.seamP <= 0 || !L.ores) continue;
      if (hv(S_SEAM, j, L.idx) >= L.seamP) continue;
      var half = SP * lerp(0.7, 2.3, hv(S_SEAM, j, 202));
      var pinch = lerp(0.30, 0.64, hv(S_SEAM, j, 303));
      // Walk a few sample x positions across the range: a seam is long, so the
      // contact should be the part of it nearest the machine.
      var bestD = 1e12, bestX = 0, bestY = 0, bestSw = 0;
      for (var k = -3; k <= 3; k++) {
        var sx = px + k * (range / 3);
        if (sx < -HALF_W || sx > HALF_W) continue;
        var pres = noise1(sx * SEAM_LENS_F + j * 3.77, S_SEAMM);
        if (pres <= pinch) continue;
        var sw = (pres - pinch) / (1 - pinch);
        var sy = scy + noise1s(sx * SEAM_WARP_F + j * 7.31, S_SEAM) * SEAM_WARP;
        var dx = sx - px, dy = sy - py;
        var d2 = dx * dx + dy * dy;
        if (d2 < bestD) { bestD = d2; bestX = sx; bestY = sy; bestSw = sw; }
      }
      if (bestD < 1e12) {
        tryContact(out, bestX, bestY, pickWeighted(L.ores, hv(S_SEAMM, j, L.idx)),
                   half * bestSw * 5, half * bestSw, px, py, range);
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
    var lines = 0;
    for (var li = 0; li < layers.length && lines < 90; li++) {
      var L = layers[li];
      var top = li === 0 ? A.MINE_CEILING_Y : layers[li - 1].toY;
      var bot = L.toY;
      if (bot < vTop || top > vBot) continue;
      var a = Math.max(top, vTop), b = Math.min(bot, vBot);

      // The layer's own tone, so a boundary between layers is visible even
      // where no deposit happens to sit on it.
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
   * after the vehicle, it is re-laid at `headMix` over the top — so as the machine
   * climbs into the doorway its tracks go BEHIND the threshold and its roof BEHIND
   * the lintel, and it reads as passing into a structure rather than sliding across
   * a picture of one. Without it the machine simply vanishes at the boundary, which
   * screenshotted exactly as badly as it sounds.
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
     * occlusion that makes driving into the lift a manoeuvre — see drawDoorHead. */
    drawDoorHead(ctx, headMix);

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

    /* --- BEDROCK ON ALL FOUR SIDES, THEN THE LEVEL'S ROCK INSIDE IT ------
     * The single strongest statement this file makes: a level is a BOX. Above the
     * band, below it and beyond its width there is nothing but bedrock, painted
     * with the same wall pattern the mine's own edges always used, and the rock
     * pattern with the strata in it exists only inside the band. Stand anywhere on
     * a level and drive to any edge and the answer is the same — this is the whole
     * world, and the only way out is the doors.
     *
     * IT IS ALSO THE CHEAP WAY ROUND. This function used to paint bedrock across
     * the WHOLE view and then paint the mine's rock on top of ~85% of it: two
     * full-screen REPEATING-PATTERN fills per frame, where a pattern costs far
     * more per pixel than a solid because every pixel does a modulo address and a
     * texture fetch. Measured at 14.4 ms/frame — stubbing this function alone took
     * the mode from 36 fps to 74, while particles.render sat at 0.92 ms either
     * way. (Whichever draw call forces the rasterisation flush gets billed for it,
     * which is why per-function timings first pointed at particles.render.
     * Bisecting by stubbing whole stages is the measurement that holds up.)
     *
     * So bedrock is painted ONLY where the level's own fill will not cover it —
     * now four edges rather than two — and every fill is clipped to the VIEW, not
     * to the band: at 5200 units wide, filling the band would hand the rasteriser
     * two and a half screens of pattern per frame to throw away.
     * ---------------------------------------------------------------- */
    var bT = bandN ? bandTopY : A.MINE_CEILING_Y;
    var bB = bandN ? bandBotY : 1e9;
    var bL = bandN ? bandXL : -HALF_W;
    var bR = bandN ? bandXR : HALF_W;

    var rockL = wallL > bL ? wallL : bL;
    var rockR = wallR < bR ? wallR : bR;
    var rockT = vTop > bT ? vTop : bT;
    var rockB = vBot < bB ? vBot : bB;

    ctx.fillStyle = wallPattern || '#3a3540';
    // The cap over the level, full view width — the roof of the world.
    if (rockT > vTop) ctx.fillRect(wallL, vTop, wallR - wallL, rockT - vTop);
    // ...and its floor.
    if (rockB < vBot) ctx.fillRect(wallL, rockB, wallR - wallL, vBot - rockB);
    // The two slivers flanking it, for the band's own height only.
    if (rockB > rockT) {
      if (wallL < bL) ctx.fillRect(wallL, rockT, bL - wallL, rockB - rockT);
      if (wallR > bR) ctx.fillRect(bR, rockT, wallR - bR, rockB - rockT);
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

      /* Ambient occlusion on all four inner faces of the box — only where a face
       * is actually on screen. This is what makes the seal read as thickness
       * rather than as a change of texture. */
      var g4;
      if (rockL < bL + 70) {
        g4 = ctx.createLinearGradient(bL, 0, bL + 70, 0);
        g4.addColorStop(0, 'rgba(0,0,0,0.6)');
        g4.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g4;
        ctx.fillRect(bL, rockT, 70, rockB - rockT);
      }
      if (rockR > bR - 70) {
        g4 = ctx.createLinearGradient(bR, 0, bR - 70, 0);
        g4.addColorStop(0, 'rgba(0,0,0,0.6)');
        g4.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g4;
        ctx.fillRect(bR - 70, rockT, 70, rockB - rockT);
      }
      if (rockT < bT + 70) {
        g4 = ctx.createLinearGradient(0, bT, 0, bT + 70);
        g4.addColorStop(0, 'rgba(0,0,0,0.6)');
        g4.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g4;
        ctx.fillRect(rockL, bT, rockR - rockL, 70);
      }
      if (rockB > bB - 70) {
        g4 = ctx.createLinearGradient(0, bB, 0, bB - 70);
        g4.addColorStop(0, 'rgba(0,0,0,0.6)');
        g4.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g4;
        ctx.fillRect(rockL, bB - 70, rockR - rockL, 70);
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
     * Both faces get the stripe; only the floor gets the word, because a level's
     * roof is not somewhere anyone tries to go and two labels on one screen at the
     * top of a thin band would read as a UI, not as a place. */
    if (bandN && rockR > rockL) {
      hazardFace(ctx, lvlBotY, 1, rockL, rockR, vTop, vBot, 'BEDROCK');
      hazardFace(ctx, lvlTopY, -1, rockL, rockR, vTop, vBot, '');
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
    if (labelX < bL + 14) labelX = bL + 14;
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

    /* --- the level's edge trim, on all four sides --------------------- */
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,196,64,0.22)';
    ctx.beginPath();
    if (wallL < bL + 4) { ctx.moveTo(bL, rockT); ctx.lineTo(bL, rockB); }
    if (wallR > bR - 4) { ctx.moveTo(bR, rockT); ctx.lineTo(bR, rockB); }
    if (vTop < bT + 4) { ctx.moveTo(rockL, bT); ctx.lineTo(rockR, bT); }
    if (vBot > bB - 4) { ctx.moveTo(rockL, bB); ctx.lineTo(rockR, bB); }
    ctx.stroke();
  }

  /**
   * One hazard-painted face of the level's box. `dir` is +1 for a floor (the paint
   * goes DOWN from the line, into the rock) and -1 for a roof.
   *
   * Stepped across the VIEW rather than the band: at 5200 units wide, hatching a
   * whole face is 130 strokes of which a handful are ever on screen.
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
    cols: 0, rows: 0, carved: 0, maskBytes: 0,
    winL: 0, winR: 0, winTop: 0, winBot: 0, winW: 0, winH: 0,
    haveC0: 0, haveC1: 0, haveR0: 0, haveR1: 0, cells: 0,
    peakWinW: 0, peakWinH: 0, peakLiveW: 0, peakLiveH: 0,
    trim: 1, cellBudget: 0, peakSolid: 0, lowFree: 0, solid: 0, free: 0,
    piles: 0, pilesUp: 0, deepestM: 0, layer: '',
    level: 0, levels: 0, levelName: '',
    bandR0: 0, bandR1: 0, bandC0: 0, bandC1: 0,
    bandTopM: 0, bandBotM: 0, bandHalfW: 0,
    lvlTopY: 0, lvlBotY: 0, lvlHalfW: 0,
    doorX: 0, doorY: 0, doorOpen: 0, needFill: false,
    doorTopY: 0, doorSillY: 0, inLift: false, headMix: 0
  };
  function getDebug() {
    var st = SM.particles.getStats();
    dbg.cols = cols; dbg.rows = rows; dbg.carved = carved;
    dbg.maskBytes = mask ? mask.length : 0;
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
    dbg.layer = (lastLayer >= 0 && layers[lastLayer]) ? layers[lastLayer].name : '';
    /* THE ACTIVE LEVEL, as cells AND as world units, because the seal test lives
     * in cell space and every clamp downstream lives in world units — a test that
     * cannot see both cannot prove the two agree. */
    dbg.level = bandN;
    dbg.levels = bands.length;
    dbg.levelName = (bandN && bands[bandN - 1]) ? bands[bandN - 1].name : '';
    dbg.bandR0 = bandR0; dbg.bandR1 = bandR1;
    dbg.bandC0 = bandC0; dbg.bandC1 = bandC1;
    dbg.bandTopM = depthOfY(bandTopY);
    dbg.bandBotM = depthOfY(bandBotY);
    dbg.bandHalfW = bandN ? (bandXR - bandXL) * 0.5 : 0;
    dbg.lvlTopY = lvlTopY; dbg.lvlBotY = lvlBotY; dbg.lvlHalfW = lvlHalfW;
    dbg.doorX = 0; dbg.doorY = doorY; dbg.doorOpen = doorOpen;
    dbg.needFill = needFill;
    dbg.doorTopY = doorTopY; dbg.doorSillY = doorSillY;
    dbg.inLift = bandN ? machineInLift() : false;
    dbg.headMix = headMix;
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
    if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) return -2;
    /* THE SAME TWO ANSWERS generateRowStrip() gives, in the same order, or this
     * would not be a probe of the generator — it would be a probe of a different
     * generator that happens to share a name. -2 for a cell the active level does
     * not contain, bedrock for its border, and only then the mask. */
    if (bandN) {
      if (cy < bandR0 || cy >= bandR1 || cx < bandC0 || cx >= bandC1) return -2;
      if (cy < bandR0 + SEAL_ROWS || cy >= bandR1 - SEAL_ROWS ||
          cx < bandC0 + SEAL_COLS || cx >= bandC1 - SEAL_COLS) return M_BEDROCK;
    }
    if (mask[cy * cols + cx]) return -1;
    var yMid = rowMidY(cy);
    var stag = rowStagger(cy);
    var px = x0 + (cx + 0.5) * SP + stag + (hv(S_JX, cx, cy) * 2 - 1) * SP * JITTER_X;
    var py = yMid + (hv(S_JY, cx, cy) * 2 - 1) * SP * JITTER;
    var L = layers.length ? layers[layerIndexAtY(yMid)] : null;
    // The SAME gather range a one-column strip uses, so this asks the generator
    // exactly what generateColStrip() would have asked it.
    prepareRow(cy, yMid, L, colEdgeX(cx), colEdgeX(cx + 1));
    return cellMaterialAt(cx, cy, px, py, L);
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
    exportMask: exportMask,
    importMask: importMask,
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
    /** Depth in metres of the bedrock floor of the live mine. */
    getFloorDepthM: function () { return depthOfY(floorY); },
    /** How many cells the player has dug out of this mine, ever. */
    getCarvedCount: function () { return carved; },
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
    /** 0 shut .. 1 wide open. For the HUD, if it ever wants to say so. */
    getDoorOpen: function () { return doorOpen; },
    /**
     * IS THIS POINT INSIDE THE LIFT? The chamber region behind the door line, and
     * the ONE source of truth for it: js/adv.js's isInLift() and js/vehicle.js's
     * "do not draw the machine" both resolve through this, so the three cannot
     * disagree about the frame the machine went in on. See DOOR_IN_*.
     */
    inDoorInterior: inDoorInterior,
    /**
     * Alpha for a machine at (x, y): 1 in the rock, 0 in the cage, ramped across
     * the doorway. js/vehicle.js multiplies its render by this so driving into the
     * lift reads as sinking into it. See DOOR_FADE_H.
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
