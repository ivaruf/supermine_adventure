/* =============================================================================
 * SUPERMINE ADVENTURE — js/mines.js
 * -----------------------------------------------------------------------------
 * THE CATALOGUE AND THE ECONOMY. Pure data plus lookups: no canvas, no DOM, no
 * events, no state that survives a call. Every other adventure module asks this
 * one "what is in that mine" and "what is this worth".
 *
 * ---------------------------------------------------------------------------
 * A MINE DEFINITION
 *   {
 *     id: 'old_creek',            // stable key; used in save data forever
 *     name: 'Old Creek Mine',
 *     region: 'Foothills',        // groups pins on the world map
 *     mapX: 0.18, mapY: 0.62,     // 0..1 position on the map artwork
 *     price: 0,                   // mining rights, dollars (0 = you start with it)
 *     recDrill: 8,                // recommended drill power (mining power/sec)
 *     depth: 180,                 // METRES to the bottom
 *     seed: 1337,                 // deterministic geology
 *     common: ['coal','copper'],  // material ids, for the map card
 *     rare: ['iron'],
 *     hazards: ['Soft ceilings'], // display strings
 *     blurb: '...',               // one paragraph of flavour for the map card
 *     layers: [ ... ]             // see below — READ BY js/advterrain.js
 *   }
 *
 * A LAYER (ordered shallow -> deep; advterrain.js picks by depth in metres)
 *   {
 *     toDepth: 40,                     // this layer covers depth < 40 m
 *     name: 'Topsoil',
 *     fill: 'dirt',                    // the bulk material id
 *     weights: { coal: 6, copper: 2 }, // ore pocket lottery, relative weights
 *     pocketRate: 0.9,                 // expected pockets per generated band
 *     cavernRate: 0.10,                // chance of an open cavern per band
 *     hardnessScale: 1.0,              // multiplies material hardness here
 *     heat: 0                          // 0..1 contribution to machine heat
 *   }
 *
 * BALANCE CONTRACT WITH js/rig.js AND js/advterrain.js
 *   Contact time is roughly BLADE_DEPTH / speed. A deposit is drillable without
 *   stalling when  hardness * hardnessScale < drillPower * contactTime. That is
 *   the whole "your drill cannot get through that yet" gate — express a mine's
 *   difficulty as HARDNESS, not as a lockout, so an under-gunned player is slow
 *   and burns fuel rather than being told no.
 *
 * =============================================================================
 * ================  DESIGN NOTES — READ BEFORE TUNING  ================
 * =============================================================================
 *
 * 1. THE ONE EQUATION THE WHOLE CURVE RESTS ON
 *
 *    js/particles.js applies the cutter's FULL damage to EVERY deposit inside
 *    the blade rectangle, independently. So for the blade to advance one deposit
 *    pitch it has to spend `hardness / drillPower` seconds, and the machine's
 *    advance rate through solid material of hardness h is
 *
 *        v_drill  ~=  min( freeSpeed,  SPACING * drillPower / h )      units/s
 *
 *    Sanity check against the shipped classic game, which is already tuned and
 *    which nobody is allowed to argue with: TERRAIN_SPACING 18, power 21,
 *    VEHICLE_SPEED 200.  Stone (h 2.1) -> 18*21/2.1 = 180 u/s, i.e. ~90% of full
 *    speed, which is exactly how stone feels.  Granite (h 6.2) -> 61 u/s = 30%,
 *    and VEHICLE_MIN_SPEED_FACTOR is 0.34.  The model is right.
 *
 *    audit() below evaluates that equation over the whole catalogue at every
 *    drill tier, which is how these numbers were checked rather than guessed.
 *
 * 2. DIFFICULTY IS RATE, NOT PERMISSION
 *
 *    Two levers, and they do different jobs on purpose:
 *
 *      drillPower  is the CURVE. Every mine is physically enterable with the
 *                  starting auger — Deep Hollow's dead granite just advances at
 *                  ~25% of a slow machine's speed, which means the run costs
 *                  three tanks of fuel and comes up with nothing. The player
 *                  loses money, learns why, and buys a drill. That is the brief.
 *
 *      hardnessCap is the LATE WALL. Exactly three materials sit above the
 *                  starting cap of 8.5: the ANCIENT FORMATION (9.5), OBSIDIAN
 *                  (16) and BEDROCK (26). All three appear only as POCKETS, as
 *                  wall linings or as the mine floor — never as a layer's bulk
 *                  `fill` — so an uncuttable material is always something you
 *                  route around, never a floor you cannot get past.
 *
 *    >> TWO INVARIANTS, do not break either. audit() reports both per layer and
 *    >> the smoke test asserts them:
 *    >>   fillBlocked      every layer's `fill` must be below
 *    >>                    SM.rig.getHardnessCap() at drill tier 0, or that mine
 *    >>                    becomes physically unenterable.
 *    >>   fillIsSellable   every layer's `fill` must be SPOIL (volumeOf === 0).
 *    >>                    A sellable bulk rock fills the hold with the ground
 *    >>                    itself in seconds and the cargo decision evaporates.
 *
 *    Note that the FOUR softest ore materials — coal 1.5, copper 3.0, silver 3.6,
 *    uranium 4.4 — are all cuttable from the first minute. Uranium in particular
 *    is gated by HEAT and by DEPTH, not by the drill; that is deliberate, and it
 *    is why cooling is a real category rather than a tax.
 *
 * 3. WHY VOLUME AND PRICE ARE SEPARATE NUMBERS
 *
 *    priceOf() is dollars per cargo UNIT; volumeOf() is how many units ONE
 *    deposit occupies. The hold is bounded in units, so what a run is worth is
 *    `cargoCap * (dollars per unit of what you chose to carry)`, and the spread
 *    of dollars-per-unit across the table IS the "dump the coal" decision:
 *
 *        coal      $7/unit  x 4 units/deposit  =  $28  a deposit,  $7/unit
 *        gold    $165/unit  x 1 unit /deposit  = $165  a deposit, $165/unit
 *
 *    24x per unit of hold. Standing on a gold seam with a hold full of coal, the
 *    coal is costing you $158 per unit it occupies. That has to be obvious from
 *    the manifest without any tutorial, which is why the ratio is this violent.
 *
 *    Volume 0 means "not cargo at all" (dirt, stone, granite, obsidian, the
 *    classic power-up cells). js/adv.js can offer anything it collects to
 *    offerCargo() and spoil will simply never consume the hold. priceOf and
 *    volumeOf are zero together, always.
 *
 * 4. THE INCOME LADDER, AND WHY THE STEPS ARE THIS SIZE
 *
 *    `rate` is dollars per unit of HOLD from a mine's deepest layer — the number
 *    a player who works a mine properly earns, because they dump the cheap ore
 *    and refill from the richest seam they can stand in. `net` is one full tank,
 *    at the recDrill tier, AFTER paying for the fuel, from the one-tank model
 *    described in note 4b. Every figure below was measured, not chosen:
 *
 *        mine          rate  recDrill  hold    net    rights   $/sec of run
 *        Old Creek      $12      8      48    $448      free       $3
 *        Red Ridge      $36     13      80  $2 684    $1 600      $14
 *        Blackstone    $131     21     130 $16 726   $18 000      $72
 *        Frostpeak     $293     35     210 $60 879   $44 000     $216
 *        Deep Hollow   $305     35     210 $63 344   $48 000     $225
 *        Cinder Fell   $677     55     330 $222 340 $185 000     $669
 *        The Rift    $1 187     84     520 $615 362 $420 000   $1 553
 *
 *    THE RULE THAT MATTERS IS THE LAST COLUMN, READ AT A FIXED TIER. A deeper
 *    mine costs more MINUTES per run, so its rate has to beat the previous
 *    mine's by MORE than the extra round trip costs, or the new mine is strictly
 *    a worse use of an afternoon and the player correctly ignores it.
 *
 *    Blackstone originally failed exactly this test — it paid the same per second
 *    as Red Ridge, and a simulated greedy player stayed in Red Ridge for thirty
 *    runs rather than use the rights it had just bought — which is why its Gold
 *    Pocket layer is as rich as it is. Re-check this column after any retune.
 *
 * 4a. FROSTPEAK IS A FORK, NOT A RUNG
 *
 *    Frostpeak used to cost $96 000 and sit above Deep Hollow, and measurement
 *    killed that: it paid ~4% LESS per second at every tier, for twice the
 *    rights. Strictly dominated, and no amount of flavour text fixes a mine that
 *    is simply the worse option.
 *
 *    So it is now $44 000 against Deep Hollow's $48 000 and the two are a CHOICE
 *    at the same point on the map. They cost the same, they pay within 4% of
 *    each other, and they ask for completely different machines:
 *
 *        Deep Hollow   heat 0.50 on the floor -> at cooling tier 0 you have
 *                      about 29 seconds in the payload layer before the needle
 *                      tops; tier 2 is the first that holds station there.
 *        Frostpeak     heat 0.00 in EVERY layer -> you can stand in the Crystal
 *                      Vaults indefinitely with the radiator you started with.
 *                      It charges for that with the hardest non-granite rock in
 *                      the game (hardnessScale 1.20 on limestone) and 4% less
 *                      money, so it wants DRILL and FUEL instead of COOLING.
 *
 *    That is a real decision about which upgrade you bought last, which is worth
 *    far more than another rung. Do not "fix" the 4% — it is what makes the
 *    cheaper mine the better one for a player with a weak radiator.
 *
 * 4b. THE ONE-TANK MODEL, AND THE TWO MARGINAL TIERS
 *
 *    A mine's income is not `hold x rate`; it is bounded by the FUEL left over
 *    once the climb out has been reserved. Deep Hollow at machine tier 1 reaches
 *    the bottom with enough fuel for 16 of its 80 units, and The Rift at tier 2
 *    with enough for 6 of 130. Both therefore pay WORSE per second than the
 *    cheaper mine above them at that one tier, and both flip violently one tier
 *    later ($25 -> $169/s and $30 -> $601/s).
 *
 *    That is not a hole in the curve, it is the most interesting moment in it:
 *    "I can get down there, and I can't do anything when I arrive." The fix the
 *    player reaches for is the tank and the hold, and the mine transforms. Do not
 *    flatten it.
 *
 *    Rights are 1.5-4 runs of the PREVIOUS mine, so buying in is a decision you
 *    make after a good week rather than a grind. Total campaign income needed:
 *    ~$2.60M of workshop plus ~$0.72M of rights. A simulated player who always
 *    buys the cheapest available upgrade — the worst case — owns every mine
 *    after ~57 runs and has a maxed machine after ~62, which is about 95 minutes
 *    of in-mine time.
 *
 * 4c. LEVELS — THE LIFT'S PRICE LIST, AND WHY THE GEOLOGY SETS IT
 *
 *    The mine entrance is a LIFT. A company buys STATIONS down the shaft and
 *    rides to them for free, so a purchased level is not a shortcut: it is the
 *    only way to spend a whole tank WORKING a stratum instead of driving to it.
 *
 *    RE-CUT AS ENDLESS MAPS (ARCHITECTURE.md §7): level k IS layer k, each level
 *    is its own map, and LEVEL 1 IS FREE — it comes with the mining rights. A
 *    level map is now UNBOUNDED east, west and south; the only wall in the game
 *    is the bedrock ceiling just north of that level's lift. So a level no longer
 *    has a width or a bottom to sell — what it sells is a BETTER TABLE, and that
 *    is what design note 4e is about. levelsOf() prices each one at
 *
 *        LEVEL_K x refHold(mine) x rateOfLayer(stratum) x LEVEL_GROWTH^(i-1)
 *
 *    which reads, in words: a level costs a fraction of ONE FULL HOLD of the
 *    rock it opens, and each level deeper costs half again as much on top. Both
 *    halves matter:
 *
 *      the rate term   makes a rich stratum expensive and a dead one cheap.
 *                      Deep Hollow's Dead Granite carries almost nothing, so the
 *                      station into it is nearly free — which is honest, and it
 *                      is the mine telling you the truth about itself.
 *      the growth term keeps the ladder rising even where two strata pay the
 *                      same, so "the next level down" is always a bigger
 *                      decision than the last one.
 *
 *    refHold is the CARGO CAPACITY at the rig tier this mine's recDrill implies
 *    (design note 4's own assumption, read straight off js/rig.js rather than
 *    copied), so the ladder tracks the workshop instead of drifting from it.
 *
 *    Every mine's table is in audit() under `levels`; re-read it after any
 *    retune.
 *
 * 4f. ...AND WHY THE STARTER MINE IS PRICED BY A DIFFERENT QUESTION
 *
 *    The equation above prices a rung against the rock it OPENS. That is right
 *    for a catalogue you shop across and wrong for the one mine a new company
 *    learns the loop in, because it says nothing about how long the player has
 *    to WORK for the rung. Measured on Old Creek under LEVEL_K alone: L2 cost
 *    $510 against a full L1 hold worth $570 — one haul, and the ladder that is
 *    supposed to BE the progression was over before it registered as one.
 *
 *    So a mine may state `levelPriceHolds: n` and be priced in the unit the
 *    player actually feels — HAULS out of the level above:
 *
 *        price(level i) = n x refHold x rateEffective(level i-1)
 *
 *    Old Creek states 3. At 48 units of hold and its own balanced tables that
 *    is $0 / $1 700 / $3 800 against full hauls of $570 / $1 255 / $3 582, so
 *    every rung is three good hauls of exactly where the player is standing.
 *    NOTHING ELSE IN THE CATALOGUE STATES IT and every other mine's price list
 *    is unchanged to the dollar — this is an override, not a new default. See
 *    the LEVEL_PRICE_HOLDS_MIN block for why the two questions must not be
 *    merged, and js/adv.js's GATING note for the rule that decides when the
 *    price is allowed to be on screen at all.
 *
 * 4e. PER-LEVEL SPAWN TABLES — THE OWNER'S PROGRESSION AXIS
 *
 *    >> OWNER'S RULE, VERBATIM: "the spawn percentage stays fixed in level 1 —
 *    >> well maybe it gets a little better as you drill south. But in the end,
 *    >> for better hauls you have to BUY lower levels in the lift and move on
 *    >> from there."
 *
 *    So there are two axes and they are deliberately not the same size:
 *
 *      BETWEEN LEVELS — the real one. Each level owns a FIXED ore table
 *        (`spawn.levels[k].weights`). A deeper level is richer in both senses the
 *        brief asks for: the cheap bulk shrinks as a share, and minerals that
 *        simply do not exist higher up start appearing. Old Creek's ladder is
 *        $11.04 -> $23.39 -> $55.92 per unit of hold, i.e. 2.1x then 2.4x. The
 *        only way onto the next rung is the lift's price list.
 *
 *      WITHIN A LEVEL — a whisper. A level map is endless southward, so "dig
 *        down forever in L1" must never become an alternative to buying L2. Each
 *        material carries a `drift` coefficient in -1..+1.5 and its weight is
 *        scaled by (1 + drift * g), where
 *
 *            g = min(SOUTH_DRIFT_CAP, metresSouthOfLift / 100 * SOUTH_PER_100M)
 *
 *        At SOUTH_PER_100M 0.030 and SOUTH_DRIFT_CAP 0.30 that is +3.0% of
 *        relative share per 100 m for a drift-1 mineral, saturating 1000 m south
 *        of the lift. MEASURED on Old Creek L1: $11.04/unit at the lift, $12.33
 *        at the cap — ELEVEN PER CENT, against L2's 112% step. Ore DENSITY gets
 *        the same treatment at half strength (DENSITY_DRIFT 0.5, so +15% pockets
 *        at the cap), which is worth another ~15% of $/minute. Roughly +28% of
 *        income for a thousand metres of driving nobody has to do, against a 2.1x
 *        step for a purchase. That is the ratio the owner's rule asks for; if it
 *        ever needs to be zero, set SOUTH_PER_100M to 0.
 *
 *    ANCIENT DEBRIS IS NOT IN THE ORE LOTTERY, AND THAT IS STRUCTURAL.
 *    A pocket picks ONE material for the whole blob (js/advterrain.js's
 *    gatherPockets), so an 'ancient' weight of even 0.05 would mean "one pocket
 *    in two thousand is FORTY DEPOSITS of the richest material in the game" —
 *    $80 000 out of the free starter mine, or nothing, decided by one hash. That
 *    is not a rare find, it is a slot machine.
 *
 *    So it is its own structure family: a DEBRIS SCATTER, a handful of cells in a
 *    tight cluster, priced per LEVEL through `debrisRate` (clusters per reference
 *    band, the same unit pocketRate uses). Old Creek: 0.016 / 0.05 / 0.12 down
 *    the three levels, which is roughly one find per 25 / 8 / 3 starter-scale
 *    expeditions, at 2 / 3 / 4 deposits a cluster and $2 000 a deposit.
 *
 *    >> AND ON LEVEL 1 A STARTING RIG CANNOT CUT IT. Ancient is hardness 9.5
 *    >> against the worn auger's cap of 8.5 (design note 2), so the first one a
 *    >> company ever finds is a tease that sells the $1 000 tungsten bit. That is
 *    >> deliberate and it is the most likely number in this file to want the
 *    >> owner's opinion.
 *
 * 4d. RAILS — THE LATERAL TWIN OF THE LIFT
 *
 *    The lift buys REACH; rails buy THROUGHPUT. Within one level a company lays
 *    track EASTWARD from the shaft and buys CHECKPOINTS along it, each of which
 *    can refuel (at a markup) and — the one that matters — SECURE the hold.
 *
 *    WHY THIS IS AN ECONOMY AND NOT A CONVENIENCE. Measured on the lift ladder:
 *    levels raise $/MINUTE, not $/RUN, because the HOLD binds long before the
 *    tank does. A deposit checkpoint removes exactly that binding constraint, so
 *    it raises $/RUN directly.
 *
 *    MEASURED, Blackstone's payoff level (Gold Pocket, 1020 m) at rig tier 2,
 *    one descent and one tank either way, same seam, same driving policy:
 *
 *        without a deposit checkpoint   $24 764/run    58 of 450 fuel spent
 *        with one                       $38 442/run   426 of 450 fuel spent
 *
 *    1.55x on $/run, and the fuel column is the real finding: a hold-bound run
 *    spends THIRTEEN PER CENT of its tank before the hopper sends it home. The
 *    checkpoint turns that into a fuel-bound run at 95%. The uplift is ~1.5 holds
 *    rather than three because the tank binds as soon as the hold stops — which
 *    is the correct next constraint, and it is what makes the tank the upgrade a
 *    player wants immediately after their first checkpoint. Re-measure this after
 *    any retune of CP_K: it is the only justification for the price.
 *
 *    checkpointsOf() prices each one at
 *
 *        CP_K x refHold(mine) x rateOfLayer(level's stratum)
 *              x CP_GROWTH^(k-1) x (1 + CP_DEPTH_K x depthKm)
 *
 *    which is levelsOf()'s equation with the compounding moved from DEPTH to
 *    DISTANCE, plus a mild depth term so that infrastructure 3 km down is dearer
 *    than the same infrastructure 300 m down even in a poor stratum.
 *
 *    THE TARGET THE COEFFICIENTS WERE SOLVED FOR, not chosen: the FIRST
 *    checkpoint on any level costs 0.5-1.0 full holds of that level's rate and
 *    the OUTERMOST costs 2-3. With CP_GROWTH 1.5 over 4 checkpoints the outer/
 *    inner ratio is fixed at 3.375, so the first must land in 0.593-0.889 holds
 *    for BOTH ends to be inside their band. CP_DEPTH_K 0.15 makes the depth term
 *    span 1.02 (Old Creek level 1, 135 m) to 1.45 (The Rift level 4, 3000 m),
 *    and CP_K 0.60 therefore puts every mine's first checkpoint in 0.61-0.87
 *    holds and every outermost in 2.07-2.94. Both bands hold by construction
 *    across the whole catalogue — audit()'s `rails` block prints the tables.
 *
 *    CP_PITCH_M x CP_PER_LEVEL IS BOUNDED BY THE MINE, not by taste, and the
 *    margin is THIN — measured against the shipped shaft, not assumed:
 *
 *        getMouthX()            -2280   (js/advterrain.js: -HALF_W + ELEV_INSET)
 *        + 4 x 120 m (4800u)    +2520   the outermost checkpoint's CENTRE
 *        MINE_HALF_WIDTH         2600   the east wall
 *        margin                    80 units
 *
 *    So four checkpoints at 120 m fit, and a FIFTH would be 1120 units outside
 *    the world. The cage (radius ADV.EXIT_RADIUS 200) does overhang the east wall
 *    by 120 units at k=4; that is harmless, because the cage is a service radius
 *    and not carved geometry — the centre is what has to be reachable.
 *
 *    >> CONSTRAINT FOR WHOEVER OWNS js/advterrain.js: ELEV_INSET must stay at or
 *    >> below 400, or the outermost checkpoint centre leaves the mine and
 *    >> CP_PITCH_M or CP_PER_LEVEL has to come down with it. This file cannot
 *    >> check that itself — it is pure data and must not read a live module — so
 *    >> it is written down here and asserted in the rails harness instead.
 *
 *    FUEL AT A CHECKPOINT IS DELIBERATELY A BAD DEAL (RAIL_FUEL_MARKUP 1.5).
 *    Filling at the surface has to stay the smart default or the tank stops being
 *    a decision; the markup is what you pay for not having planned. Always go
 *    through railFuelCost() — see the rounding note on fuelCost().
 *
 * 5. DEVICE HARDNESS COMPENSATION — the trap in this file
 *
 *    js/materials.js REWRITES `hardness` at load (applyWorldDensity) because a
 *    portrait phone generates the classic world on a coarser grid. Adventure
 *    mode does not: ADV.SPACING is a fixed 21 everywhere. So the hardness
 *    numbers this file reasons about are up to ~1.3x larger on a phone while the
 *    geometry is identical, and an uncompensated drill would fail to cut granite
 *    on exactly the devices we care most about.
 *
 *    deviceHardnessK() recovers that factor from the table itself
 *    (stone.hardness / stone.baseHardness) and js/rig.js multiplies drill power
 *    and hardness cap by it. Per-deposit PRICES and VOLUMES are deliberately
 *    NOT scaled: adventure's deposit count per square metre of mine is the same
 *    on every device, so the money must be too.
 *
 * 6. MATERIAL IDS ARE RESOLVED, NOT ASSUMED
 *
 *    Agent 3 appends the adventure materials to js/materials.js in parallel with
 *    this file. Every id used below goes through resolve(), which falls back to
 *    the nearest existing material BY ROLE (coal -> iron, silver -> gold, ...)
 *    if the real one has not landed yet. The mines therefore always have a
 *    working economy; it just degrades in flavour. Nothing here ever hard-codes
 *    a numeric material index — those are baked into the particle arrays and are
 *    Agent 3's to allocate.
 * ========================================================================== */

var SM = SM || {};

SM.mines = (function () {
  'use strict';

  /* ----- Tunables live here -----------------------------------
   *
   * THE ECONOMY TABLE.  [ dollars per cargo unit, cargo units per deposit ]
   *
   * Read note 3 above for why these are two numbers. The ordering rule is that
   * dollars-per-UNIT (col 1) must climb faster than dollars-per-DEPOSIT, so that
   * every step deeper also makes the hold more efficient — otherwise a bigger
   * hopper would be strictly better than a better drill and the workshop would
   * collapse into one purchase.
   *
   * Spoil is [0, 0] on purpose: zero price AND zero volume, so js/adv.js may
   * offer every collected deposit to offerCargo() without a filter and rock
   * never eats the hold. Barrier materials (granite, obsidian) are spoil too —
   * you meet them as a wall to be survived, not a seam to be hunted, exactly as
   * js/materials.js already argues for obsidian.
   * ------------------------------------------------------------------ */
  var ECON = {
    /* --- spoil: free to break, worthless, occupies nothing -------------
     * >>> HARD INVARIANT: every material used as a layer `fill` MUST be spoil.
     * >>> A sellable bulk rock would fill the hold with the ground itself
     * >>> within a few seconds of drilling, and the cargo decision would stop
     * >>> being a decision. audit() checks this; so does the smoke test. */
    dirt:      [0, 0],
    clay:      [0, 0],
    rubble:    [0, 0],
    stone:     [0, 0],
    sandstone: [0, 0],       // fill — soft and FAST to drive through
    limestone: [0, 0],       // fill — the harder country rock, and cavern rock
    granite:   [0, 0],       // fill / barrier
    obsidian:  [0, 0],       // barrier
    bedrock:   [0, 0],       // the floor of the mine; hardness 26, worth nothing
    timecell:  [0, 0],       // classic power-up; never cargo
    boostcell: [0, 0],       // classic power-up; never cargo

    /* --- bulk: the volume lesson ---------------------------------------
     * Coal carries this lesson ALONE, on purpose. An earlier draft also priced
     * limestone as cheap-and-bulky, but Agent 3's limestone is country rock and
     * a layer fill, so pricing it would have broken the invariant above. One
     * material that is cheap and takes four units a deposit teaches the idea
     * more sharply than two that half-teach it. */
    coal:      [7, 4],       //  $28 a deposit,   $7/unit — CHEAP AND BULKY

    /* --- early ore ----------------------------------------------------- */
    copper:    [20, 2],      //  $40 a deposit,  $20/unit
    iron:      [32, 2],      //  $64 a deposit,  $32/unit

    /* --- mid ore: volume collapses to 1, price takes over -------------- */
    silver:    [78, 1],
    gold:      [165, 1],     // dense, small, worth a fortune per unit
    gem:       [240, 1],     // Emerald
    crystal:   [330, 1],

    /* --- deep ore ------------------------------------------------------ */
    platinum:  [560, 1],
    rare:      [700, 1],     // Voidstone
    uranium:   [820, 1],     // pays for its own heat problem
    starcore:  [1300, 1],
    ancient:   [2000, 1]     // the deepest formation in the game, and the richest
  };

  /* ROLE FALLBACKS. If Agent 3's material has not landed yet, degrade to the
   * nearest existing one so the mine still pays out something sensible. Order
   * matters: the first id in the chain that exists in SM.materials wins. */
  var FALLBACK = {
    clay:      ['clay', 'dirt'],
    coal:      ['coal', 'iron'],
    copper:    ['copper', 'iron'],
    sandstone: ['sandstone', 'stone'],
    limestone: ['limestone', 'stone'],
    silver:    ['silver', 'gold'],
    platinum:  ['platinum', 'crystal'],
    uranium:   ['uranium', 'rare'],
    ancient:   ['ancient', 'ancientcore', 'ancientstone', 'relic', 'fossil',
                'starcore']
  };

  /* PRICES / VOLUMES ABOVE ARE PER DEPOSIT AT ADV.SPACING 21. Adventure never
   * changes its generation pitch, so unlike js/materials.js there is no
   * per-device compensation here. See design note 5. */

  /* Fuel is priced so that filling the STARTING tank (175 units) costs $97 —
   * about a fifth of what an Old Creek run brings up. Big enough that a full
   * tank is a decision on day one, small enough that it never becomes the
   * reason a run was not worth doing. Always go through fuelCost(), never
   * multiply by fuelPrice() yourself: the rounding is deliberate. */
  var FUEL_PRICE = 0.55;
  var REPAIR_PRICE = 14;     // dollars per INTEGRITY POINT on a 0..100 scale
  var STARTING_CASH = 900;   // a full tank ($97) plus the cheapest upgrade ($320)

  /* HEAT. js/rig.js owns the shedding side (getHeatShed(), points/sec); this is
   * the gaining side, so the two halves of the balance are one paragraph apart.
   *   gain = HEAT_AMBIENT * layer.heat  +  HEAT_DRILL   (while cutting)
   * Cooling sheds 3.5 / 5 / 7 / 9.5 / 13 / 18 per second across its six tiers,
   * so with these two coefficients:
   *   layer.heat 0     -> 2.2/s while drilling: below even tier 0's 3.5, which
   *      is why Old Creek and Frostpeak never show a live heat gauge at all.
   *   layer.heat 0.40 (the Blackstone gold pocket) -> 6.0/s: tier 0 loses,
   *      tier 1 nearly holds, tier 2 is comfortable. The warning shot.
   *   layer.heat 1.00 (Cinder Core, the Rift floor) -> 11.7/s: tier 4 is the
   *      first that breaks even and tier 5 the first that is relaxed.
   * Below the break-even tier the mine is still workable, because heatCap is a
   * BUFFER — you dive, work the seam and climb out before the needle tops. That
   * is what makes COOLING read as a mine unlock rather than as a stat. */
  var HEAT_AMBIENT = 9.5;
  var HEAT_DRILL = 2.2;

  /* LEVELS. See design note 4c — these two numbers are the whole lift economy.
   * LEVEL_K is what one station costs as a fraction of one full hold of the
   * stratum it opens; LEVEL_GROWTH is the compounding step per level down. */
  var LEVEL_K = 0.45;
  var LEVEL_GROWTH = 1.5;
  var LEVEL_MIN = 50;        // a station is infrastructure; none of them is free

  /* --- THE HAUL-COUNTED LADDER, PER MINE (design note 4f) ---------------
   * A mine may state `levelPriceHolds: n` and be priced by a completely
   * different question: NOT "a fraction of the hold this level opens" but
   * "how many full hauls out of the level ABOVE does the next one cost?"
   *
   *     price(level i) = n x refHold x rateEffective(level i-1)
   *
   * WHY THIS EXISTS, AND WHY IT IS PER-MINE. The LEVEL_K ladder prices a rung
   * against the rock it OPENS, which is the right question for a catalogue you
   * shop across — a rich stratum is dear, a dead one is cheap, and the map reads
   * honestly. It is the wrong question for the ONE mine a new company is
   * learning the loop in, because it says nothing about how long the player must
   * WORK to afford the rung. Measured on Old Creek before this landed: level 2
   * cost $510 against a full L1 hold worth $570 — the first haul a player ever
   * banks pays for the next level outright, so the ladder that is supposed to BE
   * the progression is cleared before the player has understood there was one.
   *
   * `levelPriceHolds` states the answer in the unit the player actually feels:
   * HAULS. Old Creek states 3, so every rung costs three full holds of the level
   * above it, and the number goes on meaning that if the spawn tables are ever
   * retuned — which a hard-coded price list could not do.
   *
   * IT IS AN OVERRIDE AND NOTHING ELSE. A mine that does not state it is priced
   * exactly as it was; the six that do not are byte-identical (verified against
   * the shipped tables). Do not promote this to a global default without
   * re-pricing the whole catalogue against it — LEVEL_K and this are two
   * different questions and the answers do not agree. */
  var LEVEL_PRICE_HOLDS_MIN = 0;   // <= 0 on a mine = use the LEVEL_K ladder

  /* LEVEL WIDTH IS GONE. A level map is UNBOUNDED east, west and south now
   * (ARCHITECTURE.md §7), so there is no width to sell and no `widthU` to state.
   * The entry keeps the key at 0 so a UI that still reads it prints nothing
   * rather than a lie; `endless: true` is what a new UI should key off.
   *
   * WHAT REPLACED IT AS "what a level purchase buys" is design note 4e: a
   * strictly better ore table. RATE_REF_WIDTH below is the one number the old
   * width left behind, and it is NOT a bound — it is the width every shipped
   * `pocketRate` / `cavernRate` was quoted against, kept so those numbers go on
   * meaning exactly what they meant when they were measured. */
  var RATE_REF_WIDTH = 5200; // the width "per generated band" was measured at

  /* --- THE SOUTHWARD WHISPER (design note 4e) -------------------------
   * Within one endless level map, richness drifts UP as you drill south, by a
   * deliberately tiny amount. Set SOUTH_PER_100M to 0 to switch it off entirely;
   * raise SOUTH_DRIFT_CAP to let it run further before it plateaus.
   *   g(metresSouth) = min(SOUTH_DRIFT_CAP, metresSouth / 100 * SOUTH_PER_100M)
   *   weight_i      *= 1 + drift_i * g          (drift_i is per material)
   *   oreDensity    *= 1 + DENSITY_DRIFT * g
   * At these values g saturates 1000 m south of the lift and is worth ~+12% on
   * Old Creek L1's dollars-per-unit and ~+15% on its ore density. */
  var SOUTH_PER_100M = 0.030;
  var SOUTH_DRIFT_CAP = 0.30;
  var DENSITY_DRIFT = 0.50;

  /* ANCIENT DEBRIS — the headline rare find (design note 4e). Its own structure
   * family in js/advterrain.js, never an ore-lottery weight. `debrisRate` is per
   * level and is quoted in the same unit as pocketRate: expected clusters per
   * reference band (BAND_HEIGHT tall x RATE_REF_WIDTH wide). */
  var DEBRIS_MAT = 'ancient';
  /* Derivation for a mine with no authored spawn block: a layer that named
   * `ancient` in its ore weights gets that share converted into a cluster rate
   * instead, so the old catalogue keeps its ancient formations without ever
   * rolling a forty-deposit pocket of them. Capped, because two of the shipped
   * layers name it heavily. */
  var DEBRIS_FROM_WEIGHT = 6.0;
  var DEBRIS_RATE_MAX = 0.60;

  /* Fallback reference hold per mine, index-aligned with LIST, for a build where
   * js/rig.js has not landed. These ARE the current cargo tiers (48/96/192/384/
   * 384/768/1536) at the drill tier each mine's recDrill names — refHoldOf()
   * reads them out of rig.js when it can, so this is only ever a stand-in. */
  var REF_HOLD = [48, 96, 192, 384, 384, 768, 1536];

  /* RAILS. See design note 4d — these six numbers are the whole rail economy,
   * and the first three were SOLVED for the 0.5-1.0 / 2-3 hold band rather than
   * picked. Re-read audit()'s `rails` block after touching any of them. */
  var CP_K = 0.60;           // first checkpoint, as a fraction of one full hold
  var CP_GROWTH = 1.5;       // ...compounding per pitch further east
  var CP_DEPTH_K = 0.15;     // ...plus this much again per 1000 m of depth
  var CP_MIN = 40;           // track is infrastructure; none of it is free
  var CP_PER_LEVEL = 4;      // bounded by the mine's width, not by taste
  var CP_PITCH_M = 120;      // metres of track between checkpoints (1200 units)
  /* What a checkpoint charges for fuel, as a multiple of the surface price.
   * 1.5 keeps "fill up before you go down" the correct default. */
  var RAIL_FUEL_MARKUP = 1.5;

  var LIST = [];          // the catalogue, built in init()
  var BY_ID = {};

  /* Index-keyed fast paths. js/adv.js's offerCargo() receives a numeric matIndex
   * on the collection hot path (up to ~30 events per step), so it must never
   * have to go through a string lookup. Rebuilt in init(). */
  var priceByIndex = null;    // Float32Array, dollars per cargo unit
  var volumeByIndex = null;   // Float32Array, cargo units per deposit
  var SELLABLES = [];
  var REGIONS = [];
  var deviceK = 1;            // see design note 5

  /* =====================================================================
   * MATERIAL RESOLUTION
   * ================================================================== */

  /** Does this material id exist in SM.materials right now? */
  function exists(id) {
    return !!(SM.materials && SM.materials.getById && SM.materials.getById(id));
  }

  /**
   * Map a LOGICAL material id onto one that actually exists, walking the role
   * fallback chain. Returns the input unchanged when there is nothing better to
   * say, so a typo shows up as a dirt-coloured pocket rather than a crash.
   */
  function resolve(id) {
    if (exists(id)) return id;
    var chain = FALLBACK[id];
    if (chain) {
      for (var i = 0; i < chain.length; i++) {
        if (exists(chain[i])) return chain[i];
      }
    }
    return id;
  }

  /** Numeric material index for an id, or -1 when the material does not exist. */
  function matIndexOf(id) {
    if (!SM.materials || !SM.materials.getById) return -1;
    var m = SM.materials.getById(id);
    return m ? m.index : -1;
  }

  /**
   * The factor js/materials.js has already multiplied every hardness by, so
   * js/rig.js can multiply drill power and hardness cap by the same thing and
   * keep drillability identical on every device. Derived from the table rather
   * than from HARDNESS_EXP so it cannot drift if that exponent is ever retuned.
   */
  function deviceHardnessK() { return deviceK; }

  function computeDeviceK() {
    var k = 1;
    if (SM.materials && SM.materials.getById) {
      var s = SM.materials.getById('stone');
      if (s && s.baseHardness > 0 && s.hardness > 0) k = s.hardness / s.baseHardness;
    }
    if (!(k > 0.2) || !(k < 5)) k = 1;      // paranoia: never trust a wild ratio
    return k;
  }

  /** Live (device-compensated) hardness of a material id. 0 when unknown. */
  function hardnessOf(id) {
    if (!SM.materials || !SM.materials.getById) return 0;
    var m = SM.materials.getById(resolve(id));
    return m ? m.hardness : 0;
  }

  /* =====================================================================
   * THE CATALOGUE
   * ------------------------------------------------------------------
   * Seven mines. Each one exists to answer a different question, because a mine
   * that is only "the last one but bigger" is a menu entry, not a place:
   *
   *   Old Creek    teaches the loop, and is the only place you can afford
   *   Red Ridge    the first rock that resists: a fast soft sandstone bed and
   *                then a limestone bench that a worn auger cannot chew, plus
   *                the copper/iron money that pays for the first real hopper
   *   Blackstone   long tunnels through hard rock, silver veins, a gold pocket
   *                at the bottom — the first mine you can get LOST in
   *   Frostpeak    Deep Hollow's TWIN at the same price, with ZERO heat in every
   *                layer. The mine you run when your cooling is still tier 0 and
   *                Deep Hollow's floor would cook you in half a minute. It
   *                charges for that with the hardest non-granite rock in the
   *                game (hardnessScale 1.20) and 4% less money, so it wants
   *                DRILL and FUEL where its twin wants COOLING. See note 4a —
   *                these two are a fork in the map, not two rungs of a ladder.
   *   Deep Hollow  THE GAMBLE, and the mine the brief is really about. 220 m of
   *                dead granite at a pocket rate of 0.22 before anything pays,
   *                then a cavern floor stuffed with gold, crystal, platinum and
   *                the ancient formation. MEASURED: a starting machine reaches
   *                211 m of 700, surfaces with under 2 units of iron and nets
   *                MINUS $44; a tier-3 machine bottoms it, fills the hold from
   *                The Hollow and nets $63 344. That 1400x swing is the whole
   *                design, and both ends of it have to stay extreme.
   *   Cinder Fell  the opposite of Frostpeak: heat 0.85-1.00 for 560 m. Cooling
   *                is the ticket of entry, and obsidian pockets in the magma
   *                skin need drill tier 3. Where the two hazard axes cross.
   *   The Rift     everything at once, at 1200 m: geothermal vents, obsidian
   *                pressure locks, huge caverns and a floor of starcore,
   *                voidstone and ancient rock.
   *
   * ORDERED BY PRICE, ascending, and getStarterId() is LIST[0]. Keep it that way:
   * a price-sorted catalogue is the natural reading order for the world map, and
   * it makes a dominated mine (see note 4a) obvious at a glance.
   * ================================================================== */
  function buildCatalogue() {
    return [
      {
        id: 'old_creek',
        name: 'Old Creek Mine',
        region: 'Foothills',
        mapX: 0.16, mapY: 0.60,
        price: 0,
        recDrill: 8,
        depth: 480,
        seed: 1337,
        common: ['coal', 'copper'],
        rare: ['iron'],
        hazards: ['Rotten timbers'],
        blurb: 'A worked-out family claim in the creek bed. Shallow, soft, ' +
               'and picked over twice already — but the coal is still there ' +
               'and nobody charges you to take it.',
        /* THREE FULL HAULS PER RUNG (design note 4f). Old Creek is the only
         * mine that states this, because it is the only one where the LEVEL_K
         * ladder was pricing the tutorial wrong: L2 came out at $510 against a
         * full L1 hold worth $570, so the first haul a new company ever banked
         * bought the next level outright and the progression the lift IS never
         * happened. Three is the number the loop wants — long enough that a rung
         * is a small campaign, short enough that it never becomes a grind.
         *
         * MEASURED, at refHold 48 and this mine's own balanced tables:
         *   L1  free (comes with the rights)   full hold $570
         *   L2  $1 700   = 3 x $570            full hold $1 255
         *   L3  $3 800   = 3 x $1 255          full hold $3 582
         * Re-read those with SM.mines.levelEconomyOf('old_creek', k) after any
         * retune of the spawn ladder above; the price follows it automatically. */
        levelPriceHolds: 3,
        /* ===============================================================
         * THE ONE BALANCED SPAWN LADDER IN THE CATALOGUE (design note 4e).
         *
         * Old Creek is the mine every company starts in and the only one the
         * owner asked to have tuned, so it is the only one that states its own
         * `spawn`. Every other mine derives one from its layer table (see
         * deriveSpawn), which reproduces exactly what it generated before.
         *
         * READ THE TABLE AS SHARES, NOT AS WEIGHTS. What matters is the
         * dollars-per-unit-of-hold each row produces and how far apart the three
         * rungs are, because that spread IS the reason to buy a level:
         *
         *   L1 TOPSOIL      $11.04/unit   coal 62.9  copper 24.7  iron 10.1
         *                                 silver 2.25
         *   L2 CREEK GRAVEL $23.39/unit   coal 26.5  copper 29.1  iron 23.8
         *                                 silver 15.9  GOLD 4.64
         *   L3 OLD WORKINGS $55.92/unit   coal  6.3  copper 15.6  iron 23.4
         *                                 silver 32.8  gold 17.2  EMERALD 4.69
         *
         * 2.12x then 2.39x, and each rung introduces a mineral the one above it
         * does not have at all. VALUE TRACKS SCARCITY all the way down: coal is
         * the commonest and the cheapest per unit ($7), emerald the rarest and
         * the dearest of the ordinary table ($240), and ancient debris — which is
         * not in this table at all — is rarer than any of them and worth $2 000.
         *
         * `drift` is the southward whisper. Negative for the bulk you want to
         * stop finding, positive for the money. See design note 4e for the
         * measured size of it (+11% of $/unit across a thousand metres).
         * ============================================================ */
        spawn: {
          levels: [
            { weights: { coal: 56, copper: 22, iron: 9, silver: 2.0 },
              drift:   { coal: -1.0, copper: -0.4, iron: 0.2, silver: 0.8 },
              /* One cluster per ~29 million square units of rock, which is about
               * one find per 25 starter-scale expeditions. Two deposits a
               * cluster, $2 000 each: a $4 000 event in a mine whose ordinary run
               * grosses ~$530, and one a worn auger cannot cut. */
              debrisRate: 0.016, debrisCells: 2,
              lode: 'silver', lodeRate: 0.020, lodeUplift: 1.075 },
            { weights: { coal: 20, copper: 22, iron: 18, silver: 12, gold: 3.5 },
              drift:   { coal: -1.0, copper: -0.5, iron: 0.0, silver: 0.6,
                         gold: 1.1 },
              debrisRate: 0.050, debrisCells: 3,
              lode: 'gold', lodeRate: 0.026, lodeUplift: 1.118 },
            { weights: { coal: 4, copper: 10, iron: 15, silver: 21, gold: 11,
                         gem: 3.0 },
              drift:   { coal: -1.0, copper: -0.8, iron: -0.3, silver: 0.3,
                         gold: 0.9, gem: 1.3 },
              debrisRate: 0.120, debrisCells: 4,
              /* MEASURED, AND THE ONE NUMBER THIS MINE HAD TO STATE FOR ITSELF.
               * js/advterrain.js's default lodeRate ladder is
               * (f - 0.55) / 0.45 * 0.42 over the layer index, which puts 0.42 on
               * the DEEPEST layer of every mine — written for a world where you
               * descended through all of them in one run and the bottom was
               * supposed to be spectacular. A level is its own endless map now, so
               * 0.42 means a motherlode every 6.3 million square units FOREVER:
               * counted, that made emerald 33.8% of Old Creek L3's ore against a
               * table share of 4.7%, and doubled the level's dollars-per-unit
               * against the price it is sold at. A headline formation has to be
               * rare enough to be a landmark, so all three levels state their own,
               * rising with depth: roughly one rolled lode per 132 / 102 / 78
               * million square units, on top of the guaranteed one below the lift
               * that every player finds on their first run down. advterrain's own
               * default ladder moved with them, for the six mines that do not
               * state one. */
              lode: 'gem', lodeRate: 0.034, lodeUplift: 1.335 }
          ]
        },
        layers: [
          { toDepth: 135, name: 'Topsoil', fill: 'dirt',
            weights: { coal: 5, clay: 3, copper: 1 },
            pocketRate: 1.00, cavernRate: 0.10, hardnessScale: 1.00, heat: 0 },
          { toDepth: 300, name: 'Creek Gravel', fill: 'clay',
            /* No limestone in the ore lottery here. Limestone is spoil, so a
             * pocket that rolls it pays nothing, and the ONE mine where the
             * player cannot afford a wasted pocket is the free one. Dead weight
             * in the lottery is a deliberate tool — see Deep Hollow's Dead
             * Granite and Frostpeak's Permafrost, which both use it on purpose. */
            weights: { coal: 7, copper: 2, iron: 0.6 },
            pocketRate: 1.15, cavernRate: 0.16, hardnessScale: 1.00, heat: 0 },
          { toDepth: 480, name: 'Old Workings', fill: 'stone',
            weights: { coal: 5, copper: 3, iron: 1.2 },
            pocketRate: 1.30, cavernRate: 0.24, hardnessScale: 1.00, heat: 0 }
        ]
      },

      {
        id: 'red_ridge',
        name: 'Red Ridge Quarry',
        region: 'Red Ridge',
        mapX: 0.30, mapY: 0.43,
        /* Four Old Creek runs. Act one has to be four runs long, not eight:
         * it is the only part of the game where the player has no choices. */
        price: 1600,
        recDrill: 13,
        depth: 780,
        seed: 20481,
        common: ['copper', 'iron'],
        rare: ['silver', 'gold'],
        hazards: ['Limestone benches'],
        blurb: 'An open quarry cut back into the ridge. Soft red beds give way ' +
               'in minutes and then the bench limestone stops you dead — the ' +
               'first rock in the world that a worn auger cannot simply chew.',
        /* THE FIRST RESISTING ROCK IS LIMESTONE, NOT SANDSTONE. Agent 3's
         * sandstone is hardness 1.7 and is explicitly designed as "the FAST
         * part of a descent"; the limestone next to it is 2.6. So the mine is
         * built as a CONTRAST: a fast soft bed, then a bench you have to work.
         * That reads better than an undifferentiated slog anyway — you feel the
         * bench arrive. */
        layers: [
          { toDepth: 165, name: 'Red Overburden', fill: 'clay',
            weights: { coal: 4, copper: 4 },
            pocketRate: 1.10, cavernRate: 0.12, hardnessScale: 1.00, heat: 0 },
          { toDepth: 360, name: 'Sandstone Beds', fill: 'sandstone',
            weights: { copper: 5, coal: 3, iron: 2 },
            pocketRate: 1.15, cavernRate: 0.14, hardnessScale: 1.00, heat: 0 },
          /* 2.6 x 1.05 = 2.73: 56% of free speed on a tier-0 auger, 72% on a
           * tier-1 bit. Slow enough to be the reason you buy the bit, never
           * slow enough to be a wall. */
          { toDepth: 570, name: 'Bench Limestone', fill: 'limestone',
            weights: { copper: 6, iron: 4 },
            pocketRate: 1.00, cavernRate: 0.20, hardnessScale: 1.05, heat: 0.05 },
          { toDepth: 780, name: 'Ore Benches', fill: 'stone',
            weights: { copper: 5, iron: 7, silver: 2, gold: 1 },
            pocketRate: 1.35, cavernRate: 0.22, hardnessScale: 1.10, heat: 0.10 }
        ]
      },

      {
        id: 'blackstone',
        name: 'Blackstone Mine',
        region: 'Blackstone Range',
        mapX: 0.50, mapY: 0.54,
        price: 18000,
        recDrill: 21,
        depth: 1260,
        seed: 77345,
        common: ['iron', 'silver'],
        rare: ['gold', 'crystal'],
        hazards: ['Hard rock', 'Long tunnels'],
        blurb: 'Two hundred metres of granite standing between you and the ' +
               'silver. The company that sank this shaft went under paying for ' +
               'the drill bits; the veins they were chasing are still down there.',
        layers: [
          { toDepth: 270, name: 'Broken Ground', fill: 'stone',
            weights: { coal: 3, iron: 4 },
            pocketRate: 1.00, cavernRate: 0.18, hardnessScale: 1.00, heat: 0.05 },
          { toDepth: 690, name: 'Hard Rock', fill: 'granite',
            weights: { iron: 6, silver: 3 },
            pocketRate: 0.55, cavernRate: 0.10, hardnessScale: 1.05, heat: 0.15 },
          { toDepth: 1020, name: 'Silver Veins', fill: 'granite',
            weights: { silver: 7, iron: 4, gold: 1 },
            pocketRate: 1.30, cavernRate: 0.18, hardnessScale: 1.10, heat: 0.30 },
          /* THE STEP. A mine only reads as an upgrade if its bottom layer beats
           * the previous mine's bottom layer by MORE than the extra round-trip
           * time costs — Blackstone is 2.5x a Red Ridge run in minutes, so its
           * floor has to be well over 2.5x richer. Measured (see audit()):
           * $131/unit against Red Ridge's $36, which is 3.7x. Before this was
           * retuned the two mines paid the same per second and Blackstone was
           * strictly a worse use of an afternoon. */
          { toDepth: 1260, name: 'Gold Pocket', fill: 'stone',
            weights: { gold: 6, silver: 5, crystal: 2.5, gem: 1.5, iron: 3 },
            pocketRate: 2.40, cavernRate: 0.35, hardnessScale: 1.05, heat: 0.40 }
        ]
      },

      {
        id: 'frostpeak',
        name: 'Frostpeak Shaft',
        region: 'Frostpeak',
        mapX: 0.68, mapY: 0.22,
        /* CHEAPER than Deep Hollow on purpose — see design note 4a. */
        price: 44000,
        recDrill: 35,
        depth: 1680,
        seed: 31415,
        common: ['silver', 'crystal'],
        rare: ['gem', 'rare'],
        hazards: ['Frozen ground', 'Ice falls'],
        blurb: 'Nothing down here is warm, which is the whole attraction: the ' +
               'crystal vaults at five hundred metres pay like a deep mine and ' +
               'ask nothing of your cooling. The ground itself is the problem.',
        layers: [
          /* hardnessScale 1.15-1.20 is the highest in the catalogue. Frostpeak
           * is the mine that asks for DRILL and FUEL instead of COOLING, so
           * that a player whose cooling is still tier 1 has somewhere to earn.
           * heat is 0 in every layer on purpose — do not add any. */
          { toDepth: 270, name: 'Permafrost', fill: 'clay',
            weights: { limestone: 3, silver: 1 },
            pocketRate: 0.80, cavernRate: 0.10, hardnessScale: 1.15, heat: 0 },
          /* limestone, not sandstone: this layer's whole job is to be the
           * hardest non-granite rock in the game (2.6 x 1.20 = 3.12, 49% of
           * free speed on a tier-0 auger), and Agent 3's sandstone is soft. */
          { toDepth: 780, name: 'Ice-Bound Rock', fill: 'limestone',
            weights: { silver: 4, crystal: 2, gem: 1.5 },
            pocketRate: 1.00, cavernRate: 0.14, hardnessScale: 1.20, heat: 0 },
          { toDepth: 1260, name: 'Blue Ice Granite', fill: 'granite',
            weights: { crystal: 5, gem: 4, silver: 3 },
            pocketRate: 1.40, cavernRate: 0.30, hardnessScale: 1.10, heat: 0 },
          { toDepth: 1680, name: 'Crystal Vaults', fill: 'stone',
            weights: { crystal: 8, gem: 6, silver: 4, rare: 1.5, platinum: 1 },
            pocketRate: 2.40, cavernRate: 0.50, hardnessScale: 1.00, heat: 0 }
        ]
      },

      {
        id: 'deep_hollow',
        name: 'Deep Hollow',
        region: 'The Hollows',
        mapX: 0.38, mapY: 0.75,
        price: 48000,
        recDrill: 35,
        depth: 2100,
        seed: 90210,
        common: ['silver', 'gold'],
        rare: ['platinum', 'ancient'],
        hazards: ['Dead rock', 'Heat', 'No return without fuel'],
        blurb: 'Four hundred metres of granite that carries nothing at all, ' +
               'and then the Hollow itself. Every survey says the same thing: ' +
               'do not come down here without the machine to get back out.',
        layers: [
          { toDepth: 240, name: 'Collapsed Adit', fill: 'stone',
            weights: { rubble: 4, coal: 2, iron: 1 },
            pocketRate: 0.60, cavernRate: 0.22, hardnessScale: 1.00, heat: 0.05 },
          /* THE POINT OF THE MINE. pocketRate 0.22 over 220 m: at ADV band
           * heights that is a pocket every few hundred metres of driving, and
           * the fill is granite. An under-gunned rig spends its whole tank in
           * here for iron money. Do not "fix" this layer. */
          { toDepth: 900, name: 'Dead Granite', fill: 'granite',
            weights: { iron: 1.2, limestone: 1 },
            pocketRate: 0.22, cavernRate: 0.06, hardnessScale: 1.00, heat: 0.15 },
          { toDepth: 1560, name: 'Deeper Granite', fill: 'granite',
            weights: { silver: 1.5, gold: 0.8, crystal: 0.5 },
            pocketRate: 0.35, cavernRate: 0.10, hardnessScale: 1.10, heat: 0.35 },
          /* ...and the payoff. pocketRate 2.60 and cavernRate 0.50 is the
           * highest ore density outside The Rift. This contrast is the mode's
           * defining moment; both halves of it have to stay extreme. */
          { toDepth: 2100, name: 'The Hollow', fill: 'stone',
            weights: { silver: 6, gold: 5, crystal: 5, gem: 3, platinum: 3,
                       ancient: 0.8 },
            pocketRate: 2.60, cavernRate: 0.50, hardnessScale: 1.00, heat: 0.50 }
        ]
      },

      {
        id: 'cinder_fell',
        name: 'Cinder Fell',
        region: 'Cinder Coast',
        mapX: 0.81, mapY: 0.63,
        price: 185000,
        recDrill: 55,
        depth: 2640,
        seed: 66613,
        common: ['gold', 'platinum'],
        rare: ['uranium', 'starcore'],
        hazards: ['Extreme heat', 'Gas pockets', 'Obsidian'],
        blurb: 'A dead volcano with a live basement. Five hundred and sixty ' +
               'metres of it read above 0.8 on the thermal survey, and the ' +
               'cinder core underneath is stiff with platinum and uranium.',
        layers: [
          { toDepth: 300, name: 'Ash Beds', fill: 'clay',
            weights: { coal: 5, limestone: 4, copper: 2 },
            pocketRate: 1.00, cavernRate: 0.14, hardnessScale: 1.00, heat: 0.20 },
          { toDepth: 960, name: 'Basalt Flows', fill: 'granite',
            weights: { copper: 3, silver: 2, gold: 2 },
            pocketRate: 0.60, cavernRate: 0.10, hardnessScale: 1.10, heat: 0.55 },
          /* obsidian as a WEIGHT, never as `fill`: pockets of rock the drill
           * cannot touch below tier 3, sitting inside granite you can. Routing
           * around them is the layer's texture. See design note 2. */
          { toDepth: 1800, name: 'Magma Skin', fill: 'granite',
            weights: { gold: 5, platinum: 3, uranium: 3, obsidian: 2 },
            pocketRate: 1.20, cavernRate: 0.20, hardnessScale: 1.15, heat: 0.85 },
          { toDepth: 2640, name: 'Cinder Core', fill: 'stone',
            weights: { platinum: 5, uranium: 5, gold: 4, starcore: 3, rare: 2 },
            pocketRate: 2.50, cavernRate: 0.50, hardnessScale: 1.05, heat: 1.00 }
        ]
      },

      {
        id: 'the_rift',
        name: 'The Rift',
        region: 'The Rift',
        mapX: 0.92, mapY: 0.37,
        price: 420000,
        recDrill: 84,
        depth: 3600,
        seed: 4242,
        common: ['platinum', 'uranium'],
        rare: ['starcore', 'rare', 'ancient'],
        hazards: ['Geothermal', 'Obsidian locks', 'Depth'],
        blurb: 'Twelve hundred metres, and the last two hundred are not rock ' +
               'in any sense a geologist will sign off on. The rights cost more ' +
               'than most companies are worth. It is worth it once.',
        layers: [
          { toDepth: 360, name: 'Rift Shoulder', fill: 'stone',
            weights: { iron: 3, copper: 2, silver: 1 },
            pocketRate: 0.80, cavernRate: 0.20, hardnessScale: 1.00, heat: 0.10 },
          { toDepth: 1140, name: 'Basalt Column', fill: 'granite',
            weights: { silver: 2, platinum: 1 },
            pocketRate: 0.40, cavernRate: 0.10, hardnessScale: 1.15, heat: 0.35 },
          { toDepth: 2100, name: 'Obsidian Locks', fill: 'granite',
            weights: { obsidian: 6, platinum: 2, uranium: 1.5 },
            pocketRate: 1.10, cavernRate: 0.12, hardnessScale: 1.20, heat: 0.60 },
          { toDepth: 3000, name: 'Geothermal Vents', fill: 'stone',
            weights: { uranium: 5, platinum: 4, rare: 2, starcore: 1 },
            pocketRate: 2.00, cavernRate: 0.55, hardnessScale: 1.00, heat: 0.90 },
          { toDepth: 3600, name: 'The Rift Floor', fill: 'granite',
            weights: { starcore: 6, ancient: 4, rare: 4, uranium: 2,
                       platinum: 2 },
            pocketRate: 3.00, cavernRate: 0.60, hardnessScale: 1.10, heat: 1.00 }
        ]
      }
    ];
  }

  /* =====================================================================
   * INIT
   * ================================================================== */
  function init() {
    var i, j, k;

    deviceK = computeDeviceK();

    LIST = buildCatalogue();
    BY_ID = {};

    for (i = 0; i < LIST.length; i++) {
      var mine = LIST[i];
      mine.index = i;
      /* recDrill MEANS: the drill power at which this mine pays the income step
       * design note 4 assigns it — not the minimum that survives it. Every value
       * was read off the one-tank model rather than chosen, which is why they are
       * exactly the drill powers of tiers 0,1,2,3,3,4,5.
       *
       * It is COMPARED AGAINST SM.rig.getDrillPower() on the map card, and that
       * value is device-compensated, so this one has to be too or the
       * "your drill: 21 / recommended: 35" line lies on a coarse-grid phone. */
      mine.recDrillBase = mine.recDrill;
      mine.recDrill = Math.round(mine.recDrill * deviceK);

      var from = 0;
      for (j = 0; j < mine.layers.length; j++) {
        var L = mine.layers[j];
        L.index = j;
        L.fromDepth = from;
        from = L.toDepth;
        if (j === mine.layers.length - 1) L.toDepth = mine.depth;

        /* Resolve every material id onto something that exists, merging
         * weights when two logical ids collapse onto the same fallback. */
        L.fill = resolve(L.fill);
        L.fillIndex = matIndexOf(L.fill);
        var w = {}, wi = {};
        for (k in L.weights) {
          if (!L.weights.hasOwnProperty(k)) continue;
          var rid = resolve(k);
          w[rid] = (w[rid] || 0) + L.weights[k];
        }
        L.weights = w;
        var total = 0;
        for (k in w) {
          if (!w.hasOwnProperty(k)) continue;
          wi[matIndexOf(k)] = w[k];
          total += w[k];
        }
        L.weightIndex = wi;         // extra: numeric index -> weight
        L.weightTotal = total;      // extra: so callers need no second pass
      }

      /* The map card's material lists have to survive a missing material too. */
      mine.common = resolveList(mine.common);
      mine.rare = resolveList(mine.rare);

      BY_ID[mine.id] = mine;
    }

    buildIndexTables();
    buildSellables();
    buildRegions();
  }

  function resolveList(arr) {
    var out = [], seen = {}, i, id;
    for (i = 0; i < arr.length; i++) {
      id = resolve(arr[i]);
      if (!seen[id]) { seen[id] = 1; out.push(id); }
    }
    return out;
  }

  /* Flat typed arrays keyed by material index. `SM.materials.count` is a
   * SNAPSHOT taken when that module's body ran, so if Agent 3 appends after
   * load it would be stale — read list.length instead. */
  function buildIndexTables() {
    var n = (SM.materials && SM.materials.list) ? SM.materials.list.length : 1;
    priceByIndex = new Float32Array(n);
    volumeByIndex = new Float32Array(n);
    for (var id in ECON) {
      if (!ECON.hasOwnProperty(id)) continue;
      var idx = matIndexOf(id);
      if (idx < 0 || idx >= n) continue;
      priceByIndex[idx] = ECON[id][0];
      volumeByIndex[idx] = ECON[id][1];
    }
  }

  /* Every id that is (a) real and (b) worth money, cheapest first — the manifest
   * and the "dump the worst thing in the hold" button both want that order. */
  function buildSellables() {
    var rows = [], id;
    for (id in ECON) {
      if (!ECON.hasOwnProperty(id)) continue;
      if (!(ECON[id][0] > 0) || !(ECON[id][1] > 0)) continue;
      if (!exists(id)) continue;
      rows.push({ id: id, unit: ECON[id][0] });
    }
    rows.sort(function (a, b) { return a.unit - b.unit; });
    SELLABLES = [];
    for (var i = 0; i < rows.length; i++) SELLABLES.push(rows[i].id);
  }

  function buildRegions() {
    var seen = {}, i;
    REGIONS = [];
    for (i = 0; i < LIST.length; i++) {
      var r = LIST[i].region;
      if (seen[r]) { seen[r].mines.push(LIST[i].id); continue; }
      seen[r] = { name: r, mines: [LIST[i].id] };
      REGIONS.push(seen[r]);
    }
    return REGIONS;
  }

  /* =====================================================================
   * CATALOGUE LOOKUPS
   * ================================================================== */
  function getAll() { return LIST; }                      // LIVE array, read-only
  function get(id) { return BY_ID[id] || null; }
  function count() { return LIST.length; }
  function getStarterId() { return LIST.length ? LIST[0].id : null; }

  function coerce(mineOrId) {
    if (!mineOrId) return null;
    if (typeof mineOrId === 'string') return BY_ID[mineOrId] || null;
    return mineOrId.layers ? mineOrId : null;
  }

  /** The layer covering `depthM` in this mine. Never null for a valid mine. */
  function layerAt(mineOrId, depthM) {
    var m = coerce(mineOrId);
    if (!m || !m.layers.length) return null;
    var d = depthM > 0 ? depthM : 0;
    for (var i = 0; i < m.layers.length; i++) {
      if (d < m.layers[i].toDepth) return m.layers[i];
    }
    return m.layers[m.layers.length - 1];     // past the bottom -> deepest layer
  }

  /** Layer INDEX covering `depthM`, or -1. Cheaper than layerAt for the HUD. */
  function layerIndexAt(mineOrId, depthM) {
    var L = layerAt(mineOrId, depthM);
    return L ? L.index : -1;
  }

  function layersOf(mineOrId) { var m = coerce(mineOrId); return m ? m.layers : []; }
  function depthOf(mineOrId) { var m = coerce(mineOrId); return m ? m.depth: 0; }
  function recDrillOf(mineOrId) { var m = coerce(mineOrId); return m ? m.recDrill : 0; }
  function seedOf(mineOrId) { var m = coerce(mineOrId); return m ? m.seed : 0; }
  function regions() { return REGIONS; }

  /* =====================================================================
   * THE ECONOMY
   * ================================================================== */
  /** Dollars per cargo unit for a material id. 0 for worthless spoil. */
  function priceOf(matId) {
    var e = ECON[matId];
    return e ? e[0] : 0;
  }
  /** Cargo units ONE deposit of this material occupies. Coal is bulky. */
  function volumeOf(matId) {
    var e = ECON[matId];
    return e ? e[1] : 0;
  }
  /** Index-keyed fast paths for the collection hot path. */
  function priceOfIndex(i) {
    return (priceByIndex && i >= 0 && i < priceByIndex.length) ? priceByIndex[i] : 0;
  }
  function volumeOfIndex(i) {
    return (volumeByIndex && i >= 0 && i < volumeByIndex.length) ? volumeByIndex[i] : 0;
  }
  /** Dollars one whole deposit is worth once it is in the hold. */
  function depositValue(matId) { return priceOf(matId) * volumeOf(matId); }
  function depositValueIndex(i) { return priceOfIndex(i) * volumeOfIndex(i); }
  /** Spoil: costs nothing to carry because it is never carried. */
  function isSpoil(matId) { return volumeOf(matId) <= 0; }
  /** What `units` of a material sell for. */
  function sellValue(matId, units) { return priceOf(matId) * (units > 0 ? units : 0); }

  /** Display name + colour for manifests, from SM.materials where possible. */
  function displayOf(matId) {
    var id = resolve(matId);
    var m = (SM.materials && SM.materials.getById) ? SM.materials.getById(id) : null;
    if (!m) return null;
    return {
      id: id,
      index: m.index,
      name: m.name,
      color: m.colors ? m.colors[0] : '#888888',
      shadow: m.colors ? m.colors[1] : '#444444',
      highlight: m.colors ? m.colors[2] : '#cccccc',
      price: priceOf(id),
      volume: volumeOf(id),
      hardness: m.hardness,
      ore: !!m.ore,
      spoil: isSpoil(id)
    };
  }

  /* Money is always a whole number of dollars and always rounds AGAINST the
   * player, but 100 * 0.55 is 55.00000000000001 in binary floating point and a
   * naive ceil charges $56 for a tank the prep screen advertised at $55. The
   * epsilon is one thousandth of a cent: far below anything a price can mean,
   * far above the error of any multiply these tables can produce. */
  var CENT = 1e-6;
  function dollars(v) { return v > 0 ? Math.ceil(v - CENT) : 0; }

  /** Dollars per unit of fuel. */
  function fuelPrice() { return FUEL_PRICE; }
  /** Dollars for `units` of fuel, rounded the way the prep screen will show it. */
  function fuelCost(units) { return dollars((units > 0 ? units : 0) * FUEL_PRICE); }
  /**
   * Dollars to repair one point of hull integrity.
   * >> UNITS: integrity is 0..100 POINTS here. js/adv.js's getIntegrity()
   * >> reports 0..1, so a full repair from `frac` costs repairCost(frac).
   */
  function repairPrice() { return REPAIR_PRICE; }
  function repairCost(integrityFrac) {
    var f = integrityFrac;
    if (!(f >= 0)) f = 0;
    if (f > 1) f = 1;
    return dollars((1 - f) * 100 * REPAIR_PRICE);
  }

  /* =====================================================================
   * LEVELS — the lift's price list (design note 4c)
   * ================================================================== */

  var EMPTY_LEVELS = [];      // shared, frozen-by-convention: never written to

  /**
   * Round money to two significant figures. A price list is read, compared and
   * remembered by the player, so $26 000 is worth more than $25 525 even though
   * it is less precise — every hand-picked price in this file is already a round
   * number and a derived ladder has no business looking calculated.
   */
  function niceMoney(v) {
    if (!(v > 0)) return 0;
    var mag = Math.pow(10, Math.floor(Math.log(v) / Math.LN10) - 1);
    if (!(mag >= 1)) mag = 1;
    return Math.round(v / mag) * mag;
  }

  /** The drill tier whose power is nearest `power`. Used only for refHoldOf(). */
  function drillTierFor(power) {
    var maxT = (SM.rig && SM.rig.maxTier) ? SM.rig.maxTier('drill') : 0;
    var best = 0, bestD = -1, t, p, d;
    for (t = 0; t <= maxT; t++) {
      p = statAtTier('drill', t, 'power');
      if (!(p > 0)) continue;
      d = p > power ? p - power : power - p;
      if (bestD < 0 || d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  /**
   * The hold size this mine's prices are quoted against: the cargo capacity at
   * the rig tier its recDrill names. recDrillBase, not recDrill — the latter is
   * device-compensated and money never is (design note 5).
   */
  function refHoldOf(m) {
    var cap = statAtTier('cargo', drillTierFor(m.recDrillBase || m.recDrill), 'cap');
    if (cap > 0) return cap;
    var f = REF_HOLD[m.index];
    return f > 0 ? f : 48;
  }

  /* =====================================================================
   * PER-LEVEL SPAWN TABLES (design note 4e)
   * ------------------------------------------------------------------
   * ONE RESOLVED RECORD PER LEVEL, cached on the mine, handed to
   * js/advterrain.js as the complete description of what that endless map
   * generates. It is the only thing a level purchase changes about the world,
   * so it is the only thing this section has to get right.
   *
   * A mine may state its own `spawn.levels[]`; Old Creek does and nothing else
   * does. Everything absent is derived from the layer table so an unauthored
   * mine generates exactly what it generated before the levels were re-cut.
   * ================================================================== */

  var EMPTY_SPAWN = [];

  /** The layer a level opens. Level k is layer k-1, clamped. */
  function layerOfLevel(mineOrId, i) {
    var m = coerce(mineOrId);
    if (!m || !m.layers.length) return null;
    var j = Math.floor(i) - 1;
    if (!(j >= 0)) j = 0;
    if (j >= m.layers.length) j = m.layers.length - 1;
    return m.layers[j];
  }

  /**
   * Weight -> drift coefficient, for a mine that did not author one. Ordered by
   * dollars per DEPOSIT, so the cheapest thing in the table drifts out (-1) and
   * the dearest drifts in (+1) as the player works south. Spoil never drifts:
   * it is not why anyone is down there.
   */
  function deriveDrift(weights) {
    var ids = [], id, i;
    for (id in weights) {
      if (!weights.hasOwnProperty(id)) continue;
      if (!(volumeOf(id) > 0)) continue;
      ids.push(id);
    }
    ids.sort(function (a, b) { return depositValue(a) - depositValue(b); });
    var out = {};
    for (i = 0; i < ids.length; i++) {
      out[ids[i]] = (ids.length < 2) ? 0 : (-1 + 2 * (i / (ids.length - 1)));
    }
    return out;
  }

  /**
   * The best ore in a table worth calling a motherlode. Deliberately IGNORES
   * anything under MIN_LODE_SHARE of the table: a lode is the formation the mine
   * is famous for, and picking the rarest trace mineral in the lottery would put
   * a chamber of something you meet twice a campaign on every level.
   */
  var MIN_LODE_SHARE = 0.02;
  function bestLodeIn(weights) {
    var id, tot = 0, best = null, bv = -1;
    for (id in weights) {
      if (weights.hasOwnProperty(id)) tot += weights[id];
    }
    if (!(tot > 0)) return null;
    for (id in weights) {
      if (!weights.hasOwnProperty(id)) continue;
      if (weights[id] / tot < MIN_LODE_SHARE) continue;
      var v = depositValue(id);
      if (v > bv) { bv = v; best = id; }
    }
    return best;
  }

  /**
   * Resolve level `i`'s spawn record. Authored fields win; everything else comes
   * off the layer, which is what keeps the six unbalanced mines generating what
   * they always generated.
   */
  function deriveSpawn(m, i) {
    var L = layerOfLevel(m, i);
    if (!L) return null;
    var authored = (m.spawn && m.spawn.levels && m.spawn.levels[i - 1])
      ? m.spawn.levels[i - 1] : null;

    /* THE ORE TABLE. Authored, or the layer's own weights with `ancient` lifted
     * out of the lottery — see design note 4e for why an ancient WEIGHT is a
     * forty-deposit jackpot rather than a rare find. */
    var w = {}, id, ancientShare = 0, tot = 0;
    var src = (authored && authored.weights) ? authored.weights : L.weights;
    for (id in src) {
      if (!src.hasOwnProperty(id)) continue;
      if (!(src[id] > 0)) continue;
      tot += src[id];
      if (id === DEBRIS_MAT) { ancientShare += src[id]; continue; }
      w[resolve(id)] = (w[resolve(id)] || 0) + src[id];
    }
    ancientShare = tot > 0 ? ancientShare / tot : 0;

    var drift = (authored && authored.drift) ? authored.drift : deriveDrift(w);

    var debris = authored && typeof authored.debrisRate === 'number'
      ? authored.debrisRate
      : Math.min(DEBRIS_RATE_MAX, ancientShare * DEBRIS_FROM_WEIGHT);

    return {
      i: i,
      name: L.name,
      layerIndex: L.index,
      /* --- the country rock: straight off the layer, unchanged ---------- */
      fill: L.fill,
      beds: L.beds || null,
      bedPitch: L.bedPitch || 0,
      hardnessScale: L.hardnessScale || 1,
      heat: L.heat || 0,
      vugChance: (typeof L.vugChance === 'number') ? L.vugChance : -1,
      /* --- structure rates, in "per generated band" units --------------- */
      pocketRate: (typeof L.pocketRate === 'number') ? L.pocketRate : -1,
      cavernRate: (typeof L.cavernRate === 'number') ? L.cavernRate : -1,
      seamRate: (typeof L.seamRate === 'number') ? L.seamRate : -1,
      driftRate: (typeof L.driftRate === 'number') ? L.driftRate : -1,
      lodeRate: (typeof L.lodeRate === 'number') ? L.lodeRate : -1,
      /* --- the ore lottery and its southward whisper -------------------- */
      weights: w,
      drift: drift,
      /* --- the headline formations -------------------------------------- */
      lode: (authored && authored.lode) ? resolve(authored.lode)
                                        : (L.lode ? resolve(L.lode)
                                                  : bestLodeIn(w)),
      debrisMat: resolve(DEBRIS_MAT),
      debrisRate: debris,
      /* HOW MUCH THE MOTHERLODES ADD ON TOP OF THE LOTTERY, MEASURED.
       *
       * The ore table above describes pockets, seams and cavern linings. It does
       * NOT describe the level's headline formation: a motherlode paints about
       * 2 100 cells of its own mineral between its shell and its halo, and none
       * of that goes through the lottery. So the rock a player actually fills a
       * hold from is worth MORE than rateOfWeights() says, by an amount that
       * depends on how rich the lode's mineral is relative to the table.
       *
       * These three are COUNTED, not derived — the analytic version needs the
       * halo's area integral and was wrong by 4x when it was tried. Re-measure
       * with SM.advterrain.sampleSpawn(20, 500, 44000) on each level and divide
       * the generated dollars-per-unit by rateAtLift. 1.0 for a mine nobody has
       * measured, which is the honest answer for the six that are not balanced. */
      lodeUplift: (authored && authored.lodeUplift > 0) ? authored.lodeUplift : 1,
      debrisCells: (authored && authored.debrisCells > 0)
        ? authored.debrisCells : (2 + i),
      /* --- what the whole thing is worth, at the lift -------------------- */
      rate: rateOfWeights(w)
    };
  }

  /**
   * LIVE, cached array of every level's spawn record for a mine, level 1 first.
   * js/advterrain.js holds the entry for the active level for a whole run, so
   * this must not reallocate once warm.
   */
  function spawnTableOf(mineOrId) {
    var m = coerce(mineOrId);
    if (!m || !m.layers || !m.layers.length) return EMPTY_SPAWN;
    if (m.spawnTable) return m.spawnTable;
    var out = [];
    for (var i = 1; i <= m.layers.length; i++) out.push(deriveSpawn(m, i));
    m.spawnTable = out;
    return out;
  }

  /** One level's spawn record (1-based), or null. */
  function levelSpawnOf(mineOrId, i) {
    var t = spawnTableOf(mineOrId);
    var k = Math.floor(i);
    if (!(k >= 1)) k = 1;
    if (k > t.length) k = t.length;
    return t.length ? t[k - 1] : null;
  }

  /**
   * The southward whisper's three coefficients, as one REUSED object.
   * js/advterrain.js reads them once per level and bakes the buckets, so this is
   * not a hot path — it is a single source of truth for a number that would
   * otherwise be written down twice.
   */
  var driftOut = { per100M: 0, cap: 0, density: 0, fullM: 0 };
  function getSouthDrift() {
    driftOut.per100M = SOUTH_PER_100M;
    driftOut.cap = SOUTH_DRIFT_CAP;
    driftOut.density = DENSITY_DRIFT;
    driftOut.fullM = SOUTH_PER_100M > 0
      ? (SOUTH_DRIFT_CAP / SOUTH_PER_100M) * 100 : 0;
    return driftOut;
  }

  /** g(metres south of this level's lift), 0..SOUTH_DRIFT_CAP. */
  function southDriftAt(metresSouth) {
    if (!(metresSouth > 0) || !(SOUTH_PER_100M > 0)) return 0;
    var g = (metresSouth / 100) * SOUTH_PER_100M;
    return g > SOUTH_DRIFT_CAP ? SOUTH_DRIFT_CAP : g;
  }

  /** The ore weights of a level, drifted by `g`. Writes into `out`; -> out. */
  function driftedWeights(sp, g, out) {
    var id, d;
    for (id in out) { if (out.hasOwnProperty(id)) delete out[id]; }
    if (!sp) return out;
    for (id in sp.weights) {
      if (!sp.weights.hasOwnProperty(id)) continue;
      d = (typeof sp.drift[id] === 'number') ? sp.drift[id] : 0;
      var w = sp.weights[id] * (1 + d * g);
      out[id] = w > 0 ? w : 0;
    }
    return out;
  }

  /**
   * THE LEVELS OF A MINE, RE-CUT AS ENDLESS MAPS (ARCHITECTURE.md §7).
   *
   * A level is ITS OWN MAP now, not a station on one long shaft and not a band
   * either — it runs east, west and south without limit, and the only wall is
   * the bedrock ceiling above its lift. Level k IS geological layer k, so this
   * enumerates every layer, shallowest first, and entry k is level k+1:
   *
   *     [{ i: 3, name: 'Silver Veins', depthTopM: 270, depthBotM: 270,
   *        price: 7800, endless: true, widthU: 0, layerIndex: 2, rate: 60.4 }]
   *
   * THREE THINGS TO KNOW ABOUT THE ENTRY SHAPE.
   *
   *   LEVEL 1 IS IN THE TABLE, AT PRICE 0. It is the first layer and it comes
   *   with the mining rights (there is no surface entry any more — the surface
   *   is UI only and you never drive it). A price of 0 is what makes "L1 is
   *   owned" a fact about the catalogue rather than a rule every caller has to
   *   remember, and js/adv.js's ownership count is anchored on it.
   *
   *   `depthTopM` IS THE LIFT'S DEPTH and it is the only depth a level has. The
   *   map runs south from it forever, so `depthBotM` is written EQUAL to it and
   *   `endless` is true; the two HUD readouts that print "top-bottom m" collapse
   *   to a single depth on their own when they are equal, which is why the key
   *   is kept rather than removed. `widthU` is 0 for the same reason — a level
   *   has no width to sell any more (design note 4e says what it sells instead).
   *
   *   EVERY PRICE CARRIES OVER, but it is now priced against the level's own
   *   SPAWN TABLE (design note 4e) rather than its layer's ore weights. For every
   *   mine except Old Creek those are the same numbers, so nothing moved; Old
   *   Creek is priced by design note 4f's per-mine `levelPriceHolds` override
   *   instead — three full hauls of the level above, $0 / $1 700 / $3 800 — and
   *   is the only entry in the catalogue that states it.
   *
   * LIVE array, cached on the mine: js/adv.js holds the reference and walks it,
   * so this must not allocate once warm. Cached LAZILY rather than in init(),
   * because refHoldOf() reads js/rig.js and mines.init() runs before it exists.
   */
  function levelsOf(mineOrId) {
    var m = coerce(mineOrId);
    if (!m || !m.layers || !m.layers.length) return EMPTY_LEVELS;
    if (m.levelTable) return m.levelTable;

    var hold = refHoldOf(m);
    /* HAULS PER RUNG, if this mine states one — see the LEVEL_PRICE_HOLDS_MIN
     * note above. Read once: it is a constant of the catalogue entry. */
    var holds = (typeof m.levelPriceHolds === 'number' && m.levelPriceHolds > 0)
      ? m.levelPriceHolds : LEVEL_PRICE_HOLDS_MIN;
    var out = [], j, L, i, rate, price, sp, above;
    for (j = 0; j < m.layers.length; j++) {
      L = m.layers[j];
      i = j + 1;
      sp = levelSpawnOf(m, i);
      rate = sp ? sp.rate : rateOfLayer(L);
      if (j === 0) {
        price = 0;                       // L1 comes with the mining rights
      } else if (holds > 0) {
        /* PRICED IN HAULS OF THE LEVEL ABOVE. `rateEffective` (the ore table
         * TIMES the motherlode uplift) is what a hold out of that level is
         * really worth — the same number levelEconomyOf() reports — so this is
         * literally "n full hauls out of where you are standing". Level i's
         * predecessor is level i-1, which is index j-1 in the layer table and
         * therefore levelSpawnOf(m, j). */
        above = levelSpawnOf(m, j);
        price = above
          ? niceMoney(holds * hold * above.rate * above.lodeUplift)
          : niceMoney(LEVEL_K * hold * rate * Math.pow(LEVEL_GROWTH, j - 1));
        if (price < LEVEL_MIN) price = LEVEL_MIN;
      } else {
        price = niceMoney(LEVEL_K * hold * rate * Math.pow(LEVEL_GROWTH, j - 1));
        if (price < LEVEL_MIN) price = LEVEL_MIN;
      }
      out.push({
        i: i,
        name: L.name,
        depthTopM: L.fromDepth,
        /* EQUAL TO THE TOP, DELIBERATELY: an endless map has no bottom, and the
         * two consumers that print a band render "top-bot" only when bot > top. */
        depthBotM: L.fromDepth,
        endless: true,
        price: price,
        widthU: 0,                       // see the note above
        /* Alias: the one depth a UI quotes for a level is where its lift is. */
        depthM: L.fromDepth,
        /* Extras, for the map card and for audit(): which stratum this is and
         * what a unit of hold out of it is worth AT THE LIFT. */
        layerIndex: j,
        rate: Math.round(rate * 10) / 10
      });
    }
    m.levelTable = out;
    return out;
  }

  /* =====================================================================
   * WHAT A LEVEL IS WORTH — the data the pricing pass needs
   * ------------------------------------------------------------------
   * >> BUILT FOR THE NEXT AGENT. Nothing in the game calls this; it exists so
   * >> that "what should level 3 cost" can be answered from measurements rather
   * >> than from a growth exponent. Allocates: it is a tool, not a hot path.
   * ================================================================== */

  /**
   * The expected economics of one level of one mine.
   *
   *   rateAtLift    dollars per unit of hold, working the ore at the lift
   *   rateAtCap     ...and at the southward whisper's plateau (design note 4e)
   *   holdAtLift    one full reference hold of it, in dollars
   *   share         [{id, pct, unit, perDeposit}] the ore lottery as PERCENTAGES,
   *                 richest last — this is the table the owner asked to see
   *   debris        {rate, cells, perFind, expedM2PerFind} the ancient staging
   *   stepFromAbove how many times richer this level is than the one above it
   */
  function levelEconomyOf(mineOrId, i) {
    var m = coerce(mineOrId);
    if (!m) return null;
    var sp = levelSpawnOf(m, i);
    if (!sp) return null;
    var lv = levelsOf(m);
    var e = lv[sp.i - 1];
    var hold = refHoldOf(m);

    var capW = {};
    driftedWeights(sp, SOUTH_DRIFT_CAP, capW);

    var tot = 0, id;
    for (id in sp.weights) { if (sp.weights.hasOwnProperty(id)) tot += sp.weights[id]; }
    var share = [];
    for (id in sp.weights) {
      if (!sp.weights.hasOwnProperty(id)) continue;
      share.push({
        id: id,
        pct: tot > 0 ? Math.round(sp.weights[id] / tot * 10000) / 100 : 0,
        unit: priceOf(id),
        volume: volumeOf(id),
        perDeposit: depositValue(id)
      });
    }
    share.sort(function (a, b) { return a.perDeposit - b.perDeposit; });

    var prev = (sp.i > 1) ? levelSpawnOf(m, sp.i - 1) : null;
    /* One reference band is BAND_HEIGHT tall and RATE_REF_WIDTH wide; a
     * `debrisRate` of r means r clusters in one of those, so a find costs
     * (area / r) square units of rock swept. */
    var bandArea = SM.config.BAND_HEIGHT * RATE_REF_WIDTH;

    return {
      i: sp.i,
      name: sp.name,
      price: e ? e.price : 0,
      depthM: e ? e.depthTopM : 0,
      refHold: hold,
      rateAtLift: Math.round(sp.rate * 100) / 100,
      rateAtCap: Math.round(rateOfWeights(capW) * 100) / 100,
      /* WHAT THE ROCK IS ACTUALLY WORTH, motherlodes included. This is the
       * number to price a level against; `rateAtLift` is the ore table alone.
       * See `lodeUplift` in deriveSpawn() for where the multiplier comes from. */
      rateEffective: Math.round(sp.rate * sp.lodeUplift * 100) / 100,
      lodeUplift: sp.lodeUplift,
      holdAtLift: Math.round(hold * sp.rate),
      holdAtCap: Math.round(hold * rateOfWeights(capW)),
      holdEffective: Math.round(hold * sp.rate * sp.lodeUplift),
      stepFromAbove: (prev && prev.rate > 0)
        ? Math.round(sp.rate / prev.rate * 100) / 100 : 0,
      share: share,
      lode: sp.lode,
      debris: {
        mat: sp.debrisMat,
        rate: sp.debrisRate,
        cells: sp.debrisCells,
        perFind: Math.round(sp.debrisCells * priceOf(sp.debrisMat) *
                            (volumeOf(sp.debrisMat) || 1)),
        areaPerFind: sp.debrisRate > 0 ? Math.round(bandArea / sp.debrisRate) : 0
      },
      pocketRate: sp.pocketRate,
      heat: sp.heat,
      hardnessScale: sp.hardnessScale
    };
  }

  /** Every level of a mine, as levelEconomyOf() rows. A tool; allocates. */
  function mineEconomyOf(mineOrId) {
    var m = coerce(mineOrId);
    if (!m) return [];
    var out = [];
    for (var i = 1; i <= m.layers.length; i++) out.push(levelEconomyOf(m, i));
    return out;
  }

  /** Dollars for level `i` (1-based) of a mine, or 0 if there is no such level. */
  function levelPriceOf(mineOrId, i) {
    var t = levelsOf(mineOrId);
    return (i >= 1 && i <= t.length) ? t[i - 1].price : 0;
  }

  /** How many levels below the surface this mine sells. */
  function levelCountOf(mineOrId) { return levelsOf(mineOrId).length; }

  /* =====================================================================
   * RAILS — the lateral price list (design note 4d)
   * ================================================================== */

  var EMPTY_CPS = [];         // shared, frozen-by-convention: never written to

  /**
   * The CHECKPOINTS a company can buy on level `L` of this mine (L is 1-based
   * and indexes levelsOf(), so L 0 — the surface — has no rails and returns
   * empty, as does any level this mine does not sell).
   *
   *     [{ k: 1, outM: 120, price: 3400 }, ...]
   *
   * `outM` is metres EAST of the lift shaft; js/adv.js turns that into a world x
   * through SM.advterrain.getMouthX() so the table is correct wherever the shaft
   * is. LIVE array, cached on the mine exactly as levelsOf() is — js/adv.js
   * holds the reference and getServiceable() walks it, so this must not allocate
   * once it is warm. Cached LAZILY: refHoldOf() reads js/rig.js, which does not
   * exist yet when mines.init() runs.
   */
  function checkpointsOf(mineOrId, L) {
    var m = coerce(mineOrId);
    if (!m) return EMPTY_CPS;
    var lv = levelsOf(m);
    var i = Math.floor(L);
    if (!(i >= 1) || i > lv.length) return EMPTY_CPS;
    if (!m.railTable) m.railTable = [];
    if (m.railTable[i - 1]) return m.railTable[i - 1];

    var e = lv[i - 1];
    var hold = refHoldOf(m);
    /* The stratum the level OPENS is the one its rails run through, so the rate
     * term is that layer's — read off the layer rather than off the level's
     * rounded `rate` extra, which exists for display. */
    var rate = rateOfLayer(m.layers[e.layerIndex]);
    var depthK = 1 + CP_DEPTH_K * (e.depthM / 1000);
    var out = [], k, price;
    for (k = 1; k <= CP_PER_LEVEL; k++) {
      price = niceMoney(CP_K * hold * rate * depthK * Math.pow(CP_GROWTH, k - 1));
      if (price < CP_MIN) price = CP_MIN;
      out.push({ k: k, outM: k * CP_PITCH_M, price: price });
    }
    m.railTable[i - 1] = out;
    return out;
  }

  /** Dollars for checkpoint `k` on level `L`, or 0 if there is no such one. */
  function checkpointPriceOf(mineOrId, L, k) {
    var t = checkpointsOf(mineOrId, L);
    return (k >= 1 && k <= t.length) ? t[k - 1].price : 0;
  }

  /** How many checkpoints a level sells. 0 for the surface / an invalid level. */
  function checkpointCountOf(mineOrId, L) { return checkpointsOf(mineOrId, L).length; }

  /** Metres of track between checkpoints. js/adv.js derives world x from this. */
  function checkpointPitchM() { return CP_PITCH_M; }

  /** What a checkpoint's pump charges, as a multiple of the surface price. */
  function railFuelMarkup() { return RAIL_FUEL_MARKUP; }

  /**
   * Dollars for `units` of fuel AT A CHECKPOINT.
   * >> Built on fuelCost(), not on units x price x markup. fuelCost() already
   * >> rounds up out of binary floating point (see its note); marking up the
   * >> QUOTE and rounding once more keeps the checkpoint's price exactly 1.5x
   * >> the number the prep screen showed for the same litres, which is the only
   * >> way a player can check the markup for themselves.
   */
  function railFuelCost(units) { return dollars(fuelCost(units) * RAIL_FUEL_MARKUP); }

  /** Ordered list of sellable material ids, most valuable last. */
  function sellables() { return SELLABLES; }

  /** Cash a brand new company starts with. js/save.js reads this. */
  function startingCash() { return STARTING_CASH; }

  /**
   * Heat points per second in a layer. The other half of this balance is
   * SM.rig.getHeatShed(); see the HEAT note in the tunables block.
   */
  function heatGainRate(layerHeat, drilling) {
    var h = layerHeat > 0 ? (layerHeat < 1 ? layerHeat : 1) : 0;
    return HEAT_AMBIENT * h + (drilling ? HEAT_DRILL : 0);
  }
  /** Convenience: the same thing straight off a mine and a depth. */
  function heatGainAt(mineOrId, depthM, drilling) {
    var L = layerAt(mineOrId, depthM);
    return heatGainRate(L ? L.heat : 0, drilling);
  }

  /* =====================================================================
   * BALANCE TOOLING — not gameplay, but the reason the numbers above can be
   * trusted. audit() re-derives the whole curve from the live tables so the
   * next person to tune this can check their work in one console call:
   *     JSON.stringify(SM.mines.audit(), null, 1)
   * ================================================================== */

  /**
   * Dollars per unit of HOLD you can expect from a layer's ore lottery.
   * Weighted by VOLUME, not by deposit count: the hold fills in units, so a
   * material that is four units per deposit contributes four units of the
   * average. This is the number that decides what a run is worth.
   */
  function rateOfWeights(weights) {
    var id, num = 0, den = 0, w, v;
    if (!weights) return 0;
    for (id in weights) {
      if (!weights.hasOwnProperty(id)) continue;
      w = weights[id];
      v = volumeOf(id);
      if (v <= 0) continue;                 // spoil never enters the hold
      num += w * priceOf(id) * v;
      den += w * v;
    }
    return den > 0 ? num / den : 0;
  }
  function rateOfLayer(L) { return L ? rateOfWeights(L.weights) : 0; }

  /**
   * The advance-rate model from design note 1. `power` and `hardness` must be in
   * the same (device-compensated) units.
   */
  function advanceRate(hardness, power, freeSpeed) {
    if (!(hardness > 0)) return freeSpeed;
    var v = SM.config.ADV.SPACING * power / hardness;
    return v < freeSpeed ? v : freeSpeed;
  }

  /**
   * One row per mine: the money, the depths, and — per drill tier — how fast the
   * machine actually moves through each layer's bulk fill and whether anything
   * in the layer is above that drill's hardness cap.
   */
  function audit() {
    var rows = [], i, j, t;
    var maxT = (SM.rig && SM.rig.maxTier) ? SM.rig.maxTier('drill') : 0;

    for (i = 0; i < LIST.length; i++) {
      var m = LIST[i];
      var layers = [];
      for (j = 0; j < m.layers.length; j++) {
        var L = m.layers[j];
        var fillH = hardnessOf(L.fill) * L.hardnessScale;
        var tiers = [];
        for (t = 0; t <= maxT; t++) {
          /* >> DEVICE UNITS. BUG, FOUND BY MEASUREMENT, REPORTING-ONLY BUT LOUD:
           * >> these two came straight off the tier table while `fillH` below is
           * >> the LIVE hardness js/materials.js has already multiplied by
           * >> deviceK. js/rig.js multiplies both power and cap by exactly that
           * >> factor (getDrillPower/getHardnessCap), so audit() was comparing
           * >> compensated hardness against uncompensated caps and reporting the
           * >> `fillBlocked` invariant BROKEN on eight layers that the real game
           * >> cuts without complaint — granite live 7.99 against a raw cap of
           * >> 8.5 rather than the live 10.96. A no-op wherever deviceK is 1,
           * >> which is why it survived: design note 1's own numbers were read on
           * >> a desktop grid. A tool that cries wolf on the invariant it exists
           * >> to protect is worse than no tool, so it is fixed here. Nothing in
           * >> the game calls audit(); it is a console instrument only. */
          var power = SM.rig ? statAtTier('drill', t, 'power') * deviceK : 0;
          var cap = SM.rig ? statAtTier('drill', t, 'cap') * deviceK : 99;
          var free = SM.rig ? statAtTier('engine', Math.min(t, maxT), 'speed') : 200;
          var blocked = [];
          for (var id in L.weights) {
            if (!L.weights.hasOwnProperty(id)) continue;
            if (hardnessOf(id) * L.hardnessScale > cap) blocked.push(id);
          }
          tiers.push({
            tier: t,
            fillSpeed: Math.round(advanceRate(fillH, power, free)),
            freeSpeed: Math.round(free),
            fillBlocked: fillH > cap,
            blockedOre: blocked
          });
        }
        layers.push({
          name: L.name, fromDepth: L.fromDepth, toDepth: L.toDepth,
          fill: L.fill, fillHardness: Math.round(fillH * 100) / 100,
          pocketRate: L.pocketRate, heat: L.heat,
          rate: Math.round(rateOfLayer(L) * 10) / 10,
          /* The two invariants from the ECON table and design note 2. Both must
           * be false on every row; the smoke test asserts it. */
          fillIsSellable: volumeOf(L.fill) > 0,
          tiers: tiers
        });
      }
      rows.push({
        id: m.id, name: m.name, price: m.price, depth: m.depth,
        recDrill: m.recDrill,
        shallowRate: Math.round(rateOfLayer(m.layers[0]) * 10) / 10,
        deepRate: Math.round(rateOfLayer(m.layers[m.layers.length - 1]) * 10) / 10,
        /* THE LIFT LADDER (design note 4c). refHold is the hold these prices are
         * quoted against and holdRun is one full hold of the deepest stratum —
         * the run a company that owns every level is working, and therefore the
         * number every price below should be read against. */
        refHold: refHoldOf(m),
        holdRun: Math.round(refHoldOf(m) *
                            rateOfLayer(m.layers[m.layers.length - 1])),
        levels: levelsOf(m),
        /* THE SPAWN LADDER (design note 4e). One row per level: what it pays at
         * its lift, what the southward whisper adds, and how big a step it is
         * from the level above. This is the table a retune is checked against. */
        spawn: mineEconomyOf(m),
        /* THE RAIL LADDER (design note 4d). `holds` is each checkpoint's price
         * expressed in FULL HOLDS of the stratum it stands in — the only unit
         * the 0.5-1.0 / 2-3 target can be read in, so it is printed rather than
         * left to be worked out. */
        rails: railAudit(m),
        layers: layers
      });
    }
    return rows;
  }

  /**
   * One row per LEVEL: the rail checkpoints on it, each priced both in dollars
   * and in full holds of the stratum it stands in. That second column is the
   * design target from note 4d, so it is what a retune is checked against.
   */
  function railAudit(m) {
    var lv = levelsOf(m), hold = refHoldOf(m), out = [], i, k, cps, one, holds;
    for (i = 1; i <= lv.length; i++) {
      cps = checkpointsOf(m, i);
      one = hold * rateOfLayer(m.layers[lv[i - 1].layerIndex]);
      holds = [];
      for (k = 0; k < cps.length; k++) {
        holds.push(one > 0 ? Math.round(cps[k].price / one * 100) / 100 : 0);
      }
      out.push({
        level: i, name: lv[i - 1].name, depthM: lv[i - 1].depthM,
        levelPrice: lv[i - 1].price, rate: lv[i - 1].rate,
        holdRun: Math.round(one),
        price: cps.map(function (c) { return c.price; }),
        outM: cps.map(function (c) { return c.outM; }),
        holds: holds
      });
    }
    return out;
  }

  /* audit() needs single stats out of js/rig.js's tier tables without owning a
   * rig. rig.js exposes getPart(); dig the field out defensively so this tool
   * never breaks the game if that shape changes. */
  function statAtTier(partKey, tier, field) {
    if (!SM.rig || !SM.rig.getPart) return 0;
    var p = SM.rig.getPart(partKey);
    if (!p || !p.tiers || !p.tiers[tier]) return 0;
    var v = p.tiers[tier][field];
    return typeof v === 'number' ? v : 0;
  }

  return {
    init: init,
    getAll: getAll,
    get: get,
    count: count,
    getStarterId: getStarterId,
    layerAt: layerAt,
    priceOf: priceOf,
    volumeOf: volumeOf,
    displayOf: displayOf,
    fuelPrice: fuelPrice,
    repairPrice: repairPrice,
    sellables: sellables,

    /* --- Agent-2 additions (documented in the report) ------------------- */
    layerIndexAt: layerIndexAt,
    layersOf: layersOf,
    /* --- the lift (design note 4c) -------------------------------------
     * levelsOf()      LIVE, cached [{name, depthM, price, layerIndex, rate}],
     *                 shallowest first, SURFACE EXCLUDED. Entry k is level k+1.
     * levelPriceOf()  dollars for level i (1-based)
     * levelCountOf()  how many levels this mine sells
     */
    levelsOf: levelsOf,
    levelPriceOf: levelPriceOf,
    levelCountOf: levelCountOf,
    /* A level map has no width any more — it is endless east, west and south.
     * Kept so a caller written against the band era gets 0 (which every consumer
     * already reads as "say nothing") instead of a TypeError. */
    levelWidthOf: function () { return 0; },
    /* --- per-level spawn tables (design note 4e) -----------------------
     * levelSpawnOf(mine, i)  the resolved record js/advterrain.js generates from:
     *                        {weights, drift, pocketRate.., lode, debrisRate..}
     * spawnTableOf(mine)     all of them, level 1 first. LIVE and cached.
     * layerOfLevel(mine, i)  the stratum level i opens — the country rock of its
     *                        WHOLE map, because a level is one stratum now
     * getSouthDrift()        REUSED {per100M, cap, density, fullM}
     * southDriftAt(m)        g at `m` metres south of a level's lift
     * driftedWeights(sp,g,o) the ore table at that g, written into `o`
     */
    levelSpawnOf: levelSpawnOf,
    spawnTableOf: spawnTableOf,
    layerOfLevel: layerOfLevel,
    getSouthDrift: getSouthDrift,
    southDriftAt: southDriftAt,
    driftedWeights: driftedWeights,
    rateOfWeights: rateOfWeights,
    /* --- pricing tools, for whoever revamps the lift's price list -------
     * NOT called by the game. See levelEconomyOf() for the shape. */
    levelEconomyOf: levelEconomyOf,
    mineEconomyOf: mineEconomyOf,
    /* --- rails (design note 4d) ----------------------------------------
     * checkpointsOf(mine, L)  LIVE, cached [{k, outM, price}] for level L
     *                         (1-based, indexes levelsOf()). Empty for the
     *                         surface and for a level this mine does not sell.
     * checkpointPriceOf()     dollars for checkpoint k on level L
     * checkpointCountOf()     how many checkpoints a level sells
     * checkpointPitchM()      metres of track between checkpoints
     * railFuelMarkup()        checkpoint fuel price / surface fuel price
     * railFuelCost(units)     dollars for `units` at a checkpoint pump
     */
    checkpointsOf: checkpointsOf,
    checkpointPriceOf: checkpointPriceOf,
    checkpointCountOf: checkpointCountOf,
    checkpointPitchM: checkpointPitchM,
    railFuelMarkup: railFuelMarkup,
    railFuelCost: railFuelCost,
    depthOf: depthOf,
    recDrillOf: recDrillOf,
    seedOf: seedOf,
    regions: regions,
    priceOfIndex: priceOfIndex,
    volumeOfIndex: volumeOfIndex,
    depositValue: depositValue,
    depositValueIndex: depositValueIndex,
    isSpoil: isSpoil,
    sellValue: sellValue,
    fuelCost: fuelCost,
    repairCost: repairCost,
    startingCash: startingCash,
    heatGainRate: heatGainRate,
    heatGainAt: heatGainAt,
    hardnessOf: hardnessOf,
    matIndexOf: matIndexOf,
    resolve: resolve,
    deviceHardnessK: deviceHardnessK,
    rateOfLayer: rateOfLayer,
    advanceRate: advanceRate,
    audit: audit
  };
})();
