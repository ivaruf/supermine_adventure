/* =============================================================================
 * SUPERMINE ADVENTURE — js/adv.js
 * -----------------------------------------------------------------------------
 * THE EXPEDITION DIRECTOR — the game's state machine and its bank. It owns:
 *
 *   1. THE STATE MACHINE. Which screen the campaign is on, and therefore
 *      whether the simulation is running at all.
 *   2. THE RUN. Fuel, cargo, heat, hull integrity, depth, elapsed time — every
 *      pressure that makes "do I push deeper or go home" a real question.
 *   3. THE LEDGER. Cash, mining rights, workshop purchases, the day counter.
 *      adv.js is the ONLY module that moves money.
 *
 * ---------------------------------------------------------------------------
 * THE STATE MACHINE
 *
 *   off  --open()-->  slots  --startCompany()-->  map
 *                                                 |  ^
 *                              openGarage() ------+  |
 *                                     garage ---------+
 *                                                 |
 *                              selectMine() ------+
 *                                     prep
 *                                       | enterMine()
 *                                     MINE  <-- the only state where time passes
 *                                       |    ^ rideTo(L) hops between level maps
 *                                       |    | sellAtDoor()/refuelAtDoor() stay
 *                                       |      in the mine: the door IS the shop
 *                                       +-- leaveToMap() ------------> map
 *                                       | strand()
 *                                     results   <-- STRAND ONLY now
 *                                       | sell() (banks the secured ledger)
 *
 *   Only 'mine' runs the simulation. Every other state returns true from
 *   holdsSim(), which makes main.js zero its fixed-step accumulator — the world
 *   still RENDERS behind the map and the workshop, it just does not advance.
 *
 *   Announce every transition with `adv:state` and let js/advui.js decide what
 *   to draw. Do not reach into advui.js to open a specific screen; the whole
 *   point of the split is that this file never touches the DOM.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR PRESSURES — get the FEEL of these right and the mode works
 *
 *   FUEL      Bought before the descent, at a price. Burned by driving, and
 *             much harder by DRILLING, and continuously by lights, cooling and
 *             the scanner. Running dry underground is the failure state: the
 *             player is STRANDED and loses the cargo (recoverable as a pile on
 *             the next visit — see below — so it stings without being cruel).
 *   CARGO     Volume, not money. Coal is bulky and cheap; gold is dense and
 *             worth a fortune. A full hold in front of a fresh gold seam is the
 *             single best decision the game offers, and dump() is the answer.
 *   HEAT      Rises with depth and with drilling, shed by cooling. At the cap
 *             the machine takes integrity damage. This is the soft depth gate.
 *   INTEGRITY Hull condition. Cave-ins and overheating chew it; repairs cost
 *             money at the surface. At zero the machine is stranded.
 *
 *   DUMPED AND LOST CARGO PERSISTS. dump() drops a pile at the machine's
 *   position; a strand() drops the whole hold. Piles live in the save record
 *   and js/advterrain.js re-spawns them when their band streams in, which is
 *   what makes "I'll come back for the coal" true.
 *
 * ---------------------------------------------------------------------------
 * CROSS-MODULE SEAMS
 *   vehicle.js  asks isDriving() every step and, when true, drives the free-roam
 *               2D path off SM.input.getMove() instead of auto-advancing. It
 *               reports work back through burnFuel() / addHeat() / offerCargo().
 *   advterrain  asks getMine() for the definition and getPiles() for the drops.
 *   advhud      polls the getters below. It must never mutate anything here.
 *   advui       drives the machine through the verbs (buyRights, buyFuel,
 *               buyPart, selectMine, enterMine, sell, openGarage, backToMap).
 *
 * ---------------------------------------------------------------------------
 * EVERY SEAM IS FEATURE-DETECTED, ON PURPOSE
 * The other three agents' modules come up as stubs that return zeros and nulls.
 * Nothing in here may throw on that, so every cross-module read goes through a
 * small `??`-shaped guard with a documented default, and the mine catalogue
 * falls back to FALLBACK_MINE (below) when SM.mines is still empty. That is
 * what keeps the build runnable — and testable from the console — at every
 * point during the parallel phase.
 *
 * EVENTS EMITTED (payload objects are REUSED — read them inside the handler)
 *   adv:state     {state, prev}
 *   adv:entered   {mineId, depth}
 *   adv:extracted {gross, cargo, depthM, reason}
 *   adv:stranded  {reason, depthM, lost}
 *   adv:cash      {cash, delta, reason}
 *   adv:fuellow   {pct}
 *   adv:cargofull  null
 *   adv:dumped    {matIndex, units, x, y}
 *   adv:rig       {partKey, tier}
 *   adv:rights    {mineId, price}
 *   adv:day       {day}
 *   adv:heat      {pct}
 *   adv:damage    {integrity, source}
 *   adv:sold      {gross, cash, day}          <- ADDITION: "money has actually
 *                                                moved" — the results screen's
 *                                                beat AND the door sale's
 *   lift:bought   {i, price, mineId}          <- a level was bought
 *   lift:entered  {level, reason}             <- the machine drove INTO the cage
 *                                                (or arrived in one). It is
 *                                                hidden and parked from here
 *   lift:exited   {level}                     <- ...and rolled back out
 *   lift:ride     {from, to}                  <- the lift moved between LEVEL
 *                                                MAPS, both 1-based. Emitted
 *                                                BEFORE the world swaps, so a
 *                                                presentation layer can put the
 *                                                screen to black over the seam
 *   rail:bought   {L, k, price, mineId}       <- a checkpoint was bought
 *   rail:fuel     {units, cost}               <- refuelled at a checkpoint
 *   rail:deposit  {value, units}              <- the hold was SECURED; the
 *                                                payload is what JUST moved, not
 *                                                the running total (getSecured())
 *
 * ---------------------------------------------------------------------------
 * THE LIFT — LEVELS ARE SEPARATE MAPS (ARCHITECTURE.md §7)
 *
 * EACH LEVEL IS ITS OWN MAP, conceptually stacked under the one above, and the
 * lift is the ONLY way between them. Level k IS geological layer k, realized as
 * a bounded y-band of the same coordinate space (js/advterrain.js owns the band,
 * js/vehicle.js's four-side clamps are the seal GUARANTEE). LEVEL 1 COMES WITH
 * THE MINING RIGHTS; deeper ones are bought, strictly next-one-down, and each is
 * WIDER than the last (mines.levelsOf().widthU).
 *
 *   THE SURFACE IS NOT A PLACE ANY MORE. It is UI: there is no level 0, no
 *   surface station and no mouth to drive to. Levels are 1-based everywhere in
 *   this file, and `runLevel` is never 0 during a run.
 *
 *   THE LIFT IS BIG CLOSED DOORS at the top-centre of the level, and it is a
 *   PLACE YOU ENTER. Proximity (getBoardable(), a circle of ADV.EXIT_RADIUS about
 *   advterrain.getDoorX/getDoorY) only makes the doors open. Driving INTO them
 *   puts the machine in the cage: it disappears, it cannot be driven, and THE
 *   DOOR MENU comes up — SELL the haul / REFUEL / OUT / the level list / MAP.
 *   See "BEING IN THE LIFT" below for the state, and note there is NO ARMING
 *   RULE on the door circle: the old one existed because the mouth extracted ON
 *   CONTACT, and the menu replaced auto-extraction with explicit verbs.
 *
 *   THE DOOR IS SURFACE ACCESS. sellAtDoor() banks the hold (and the secured
 *   ledger) and rolls the day, exactly as a surface sale did; refuelAtDoor()
 *   fills the tank at the SURFACE price, because the goods come down the same
 *   lift the ore goes up. Neither ends the run: you sell, refuel and drive back
 *   into the rock, or take MAP and leave.
 *
 *   RIDING IS FREE AND MID-RUN, HOLD INTACT. rideTo(L) is legal from the door
 *   circle to any owned level: the money was spent when the level was bought and
 *   charging for the cage would make owning it feel like a tax. The carve mask
 *   is whole-mine and the bands are disjoint in y, so a level keeps its tunnels
 *   with no bookkeeping here at all.
 *
 *   STRANDING IS UNCHANGED, and it is now the ONLY route to the results screen.
 *   A dry tank is not rescued by a lift you cannot drive to. The hold drops as
 *   piles ON THAT LEVEL and is recoverable on the next descent to it.
 *
 *   getDistanceToExit() IS THE DISTANCE TO THIS LEVEL'S DOOR. There is exactly
 *   one exit from a map, so the reserve estimate and the HUD's TURN BACK warning
 *   inherit the right number by doing nothing. getDepthM() keeps meaning
 *   ABSOLUTE depth: bands live in absolute coordinates and the readout is true.
 *
 * ---------------------------------------------------------------------------
 * RAILS — CHECKPOINTS, FUEL, AND THE SECURED LEDGER
 *
 * A mine expands two ways. The LIFT buys depth; RAILS buy width WITHIN a level.
 * Track runs EAST from the shaft and a company buys CHECKPOINTS along it —
 * checkpoint k on level L sits at (getStationX() + k x pitch, levels[L].y), in a
 * cage of ADV.EXIT_RADIUS, and every position is read through
 * SM.advterrain.getMouthX() so the whole feature is correct wherever the shaft
 * is. Bought strictly outward, one level at a time, price from
 * SM.mines.checkpointsOf().
 *
 * A CHECKPOINT DOES TWO THINGS, and only one of them matters.
 *
 *   FUEL     refuelHere() fills the tank at SM.mines.railFuelMarkup() — 1.5x the
 *            surface price. Deliberately a bad deal: filling before you descend
 *            has to stay the smart default, and the markup is the price of not
 *            having planned. Charges what the cash reaches, exactly as buyFuel().
 *
 *   DEPOSIT  depositHere() SECURES the hold. It does NOT bank it. The units leave
 *            the manifest, the hold is empty and free to fill again, and the
 *            value sits in a run-long SECURED ledger that strand() and abort()
 *            cannot touch. It becomes money in sell(), with the rest of the run.
 *
 * WHY SECURED AND NOT INSTANT MONEY. Paying out at the checkpoint would make the
 * climb optional, and the climb is the loop's heartbeat — extraction is the game.
 * What SHOULD die is the round trip you make because the HOPPER is full rather
 * than because the TANK is empty. Measured on the lift ladder: buying levels
 * raises $/MINUTE and leaves $/RUN alone, because the hold binds long before the
 * fuel does. A deposit checkpoint removes exactly that constraint, so it is the
 * first thing in the game that raises $/RUN. Rails buy THROUGHPUT; the lift buys
 * REACH.
 *
 * MEASURED, Blackstone's payoff level (Gold Pocket, 1020 m) at rig tier 2 — one
 * descent, one tank, the same seam and the same driving policy either way:
 *
 *     without a deposit checkpoint   $24 764/run   58 of 450 fuel spent (13%)
 *     with one                       $38 442/run  426 of 450 fuel spent (95%)
 *
 * 1.55x, and the number that matters is the SECOND column: the run stops being
 * HOLD-bound and becomes FUEL-bound, which is what it should have been all along.
 * 13% of a tank is what "the hopper decides when you go home" actually costs. The
 * uplift is ~1.5 holds rather than three, because once the hold is unbound the
 * tank binds instead — that is the correct next constraint, and it is what makes
 * the tank upgrade the thing you want after your first checkpoint.
 *
 * IT IS CREDITED IN sell(), NOT ON ARRIVAL AT THE SURFACE. One place rounds a
 * run's ore into whole dollars, rolls the day and writes the lifetime stats, and
 * two would drift. The results screen therefore has the secured figure to SHOW
 * (getResults().secured) before it turns into cash, which is the beat the screen
 * wants anyway — and a STRANDED results screen must offer SELL for the same
 * reason, because on a bad run the secured ore is the whole payout.
 *
 * SECURED ORE IS RUN STATE AND IS NEVER SAVED. It is cleared by enterMine(), so
 * restart()'s do-over drops it along with the hold — R means "that descent never
 * happened", and it never pays out either.
 * ========================================================================== */

var SM = SM || {};

SM.adv = (function () {
  'use strict';

  /* =====================================================================
   * TUNABLES
   * ================================================================== */

  // --- the ledger a brand-new company starts with ----------------------
  // SM.mines.startingCash() is authoritative — Agent 2 balanced it against the
  // first tank and the cheapest upgrade. This is only the answer for a build
  // where the catalogue has not landed.
  var START_CASH = 900;

  // --- hull ------------------------------------------------------------
  // Integrity is carried in POINTS, not in 0..1, because SM.mines.repairPrice()
  // is documented as "dollars to repair ONE POINT of hull integrity" — so the
  // point has to be the unit money is quoted in. getIntegrity() still returns
  // 0..1 as the contract says.
  var HULL_POINTS = 100;
  // Armour soaks damage. The stub calls it "damage soaked per impact", but
  // adv.js is fed continuous wear as well as discrete hits, and subtracting a
  // flat soak from a 0.01-point tick would make armour absolute immunity. So it
  // is applied as a divisor: 10 points of armour halves incoming damage.
  var ARMOR_DIV = 0.10;

  // --- fuel ------------------------------------------------------------
  // THE BUDGET IS SM.rig's, NOT OURS. rig.js publishes the whole fuel model —
  // getIdleBurn/getLightBurn/getCoolBurn/getDriveBurn/getDrillBurn — and sizes
  // its tanks from a target ENDURANCE computed off exactly those numbers. So
  // adv.js draws the STANDING part of that budget (idle + lights + cooling +
  // scanner) and vehicle.js draws the duty-cycle part; inventing a coefficient
  // here would silently invalidate every tank size in the game.
  // These two are the fallbacks for a build where rig.js is still a stub.
  var FALLBACK_LIGHT_BURN = 0.05;
  var FALLBACK_IDLE_BURN = 0.35;
  /* What counts as PARKED, for the free-idle rule in update(). Both are
   * deliberately tight: the point is that a deliberately stationary machine is
   * free, not that a slow one is cheap. */
  var IDLE_STICK = 0.02;       // stick magnitude below this = not asking to move
  var IDLE_SPEED = 4;          // world units/sec below this = come to rest
  // Warning thresholds, high to low. Each fires `adv:fuellow` once as it is
  // crossed downward, and re-arms only on a new descent.
  var FUEL_WARN = [0.35, 0.20, 0.10, 0.05];
  // How long the machine coasts on an empty tank before the run is called.
  // Without this the strand lands on the same frame the needle hits zero and
  // reads as a bug; with it, the engine dies, the machine rolls to a stop, and
  // THEN the screen comes up.
  var DRY_GRACE = 1.8;
  // Getting home is never a straight line, and the reserve warning has to be
  // pessimistic or it is worse than useless.
  var RESERVE_PATH = 1.45;       // multiplier on the straight-line distance
  var RESERVE_SAFETY = 1.20;     // ...and then a margin on top of the estimate

  // --- heat ------------------------------------------------------------
  // Same division of labour as fuel: SM.mines.heatGainRate(layerHeat, drilling)
  // is the GAINING side of the balance and SM.rig.getHeatShed() is the shedding
  // side, and the two were tuned against each other. adv.js only integrates
  // them. The constants below are the fallback model for a build with no layer
  // tables: a flat ramp with depth, so the deep gate exists either way.
  var HEAT_AMBIENT_MAX = 12;     // points/sec at layer heat 1.0
  var HEAT_PER_KM = 8;           // points/sec per 1000 m of depth
  var OVERHEAT_DPS = 3;          // integrity points/sec while pinned at the cap
  var FALLBACK_HEAT_CAP = 100;
  var FALLBACK_HEAT_SHED = 6;

  // --- cargo -----------------------------------------------------------
  // Spoil (anything nobody will buy) is thrown out the back rather than stored.
  // Without this rule the hold fills with dirt in ten seconds and the volume
  // decision the mode is built around never happens.
  var STORE_WORTHLESS = false;
  var FALLBACK_CARGO_CAP = 40;
  // Cargo units are fractional, so "is it full" needs a tolerance rather than an
  // equality test — see offerCargo(), where being a hair under capacity used to
  // keep the collector running against ore that could never fit.
  var CARGO_EPS = 0.001;

  // --- results ---------------------------------------------------------
  // A strand does not lose the ore, it LEAVES it: one pile per material, at the
  // wreck. This is the number that decides whether coming back is a plan or a
  // consolation prize. 1.0 = every unit is still there.
  var STRAND_RECOVERY = 1.0;

  // --- rails -----------------------------------------------------------
  // The pitch and the markup are SM.mines's numbers (design note 4d there), for
  // the same reason the fuel budget is rig.js's: one owner per number. These are
  // the fallbacks for a build where that catalogue is still a stub.
  var CP_PITCH_M = 120;              // metres of track between checkpoints
  var RAIL_FUEL_MARKUP = 1.5;        // ...of the surface fuel price
  /* "The tank is already full enough that there is nothing to sell." Fuel units
   * are fractional, so this needs a tolerance rather than an equality test — the
   * same argument as CARGO_EPS, in the other resource's units. */
  var FUEL_EPS = 0.001;

  /* ================================================================== */

  var A = SM.config.ADV;

  var state = 'off';

  /* --- the ledger (persists across runs) ------------------------------ */
  var cash = 0;
  var day = 1;
  var hull = HULL_POINTS;              // integrity in points, survives a run
  var rightsHeld = Object.create(null); // mineId -> true. Mirrored into save.js.
  /* mineId -> HOW MANY levels are owned (1..n, in order). A count, not a set:
   * js/save.js's header argues the case, and a set would let a lift have a hole
   * in it that no purchase path can produce. */
  var levelsHeld = Object.create(null);
  /* mineId -> ARRAY of "how many checkpoints are owned on this level", index 0
   * being LEVEL 1. Counts for the same reason `levelsHeld` is a count: track is
   * laid outward and a set would describe a rail line with a gap in it that no
   * purchase path can produce. Mirrored into save.js, which stores the same
   * shape. Sparse until read: ownedCheckpoints() fills a slot on first touch. */
  var railsHeld = Object.create(null);
  var companyName = '';

  /* --- selection / loadout -------------------------------------------- */
  var selectedId = null;               // the mine the prep screen is about
  var tank = 0;                        // fuel bought and waiting in the tank
  var tankPaid = 0;                    // what the last descent launched with
  var soldThisRun = false;             // this run's hold has been banked

  /* --- run state ------------------------------------------------------ */
  var runMineId = null;
  var mineDef = null;
  var runTime = 0;
  var depthM = 0, maxDepthM = 0;
  var fuel = 0, fuelCap = 1;
  var heat = 0, heatCap = FALLBACK_HEAT_CAP;
  var cargo = 0, cargoCap = 1;
  var dryTimer = -1;                   // >= 0 once the tank has run dry
  var warnIndex = 0;                   // next FUEL_WARN threshold to fire
  var cargoFullSent = false;
  var burnRate = 0, burnAccum = 0;     // smoothed fuel draw, for the HUD needle
  var fuelAtEntry = 0;
  var results = null;

  /* --- the hold -------------------------------------------------------
   * Per-material rows in preallocated typed arrays, because offerCargo() is
   * called once per collected FRAGMENT — up to ~30 times a step. `manifest` is
   * a live array of entry objects that are mutated in place; entries are only
   * created the first time a material is seen and only removed when its holding
   * is dumped, so the HUD can hold the array reference forever.
   * ------------------------------------------------------------------ */
  var manifest = [];
  var matCount = 0;
  var slotOf = null;        // Int16Array: matIndex -> manifest slot, -1 = none
  var fragUnits = null;     // Float32Array: cargo units ONE FRAGMENT occupies
  var unitPrice = null;     // Float32Array: dollars per cargo unit
  var matHard = null;       // Float32Array: hardness, for vehicle.js's cap gate

  /* --- dropped cargo --------------------------------------------------
   * [x, y, matIndex, units] per pile. LIVE array; js/advterrain.js walks it and
   * calls consumePile(i) once it has re-spawned one as particles.
   * ------------------------------------------------------------------ */
  var piles = [];

  /* --- the lift -------------------------------------------------------
   * `levels` is the LIVE band table getLevels() hands out: entry k describes
   * LEVEL k+1 (levels are 1-based; there is no surface entry). Entry OBJECTS are
   * reused, because the HUD and the door menu hold references across frames.
   *
   * NO ARMING ARRAY. There is one door per map and the menu is explicit, so
   * `stArmed` (which existed only because the mouth extracted on contact) is
   * gone with the mouth. See the LIFT note in the header.
   * ------------------------------------------------------------------ */
  var levels = [];
  var lvMineId = null;                 // which mine `levels` describes
  var lvOwned = -1;                    // ...and how many levels were owned then
  var lvMouthX = 0;                    // ...and where advterrain put the door x
  var runLevel = 1;                    // the level map the run is ON right now

  /* --- the rails ------------------------------------------------------
   * `cpArrays[L]` is the LIVE checkpoint table getCheckpoints(L) hands out for
   * level L, and `cpKeys[L]` is its cache key. Both are indexed BY LEVEL and the
   * entry objects are reused, exactly as `levels` is — the HUD and the rail panel
   * hold references across frames and getServiceable() walks them.
   *
   * Slot 0 is never used: the surface has no rails.
   * ------------------------------------------------------------------ */
  var cpArrays = [];
  var cpKeys = [];
  var EMPTY_CPS = [];                  // shared; getCheckpoints() never writes it

  /* --- the secured ledger ---------------------------------------------
   * RUN STATE, never saved. `secured` is the REUSED object getSecured() returns;
   * `securedLines` is the per-material breakdown the results screen itemises,
   * with entry objects mutated in place so a merge never allocates.
   * ------------------------------------------------------------------ */
  var secured = { value: 0, units: 0 };
  var securedLines = [];
  var svcOut = { level: 0, k: 0 };     // REUSED: getServiceable()'s answer

  /* --- reused event payloads (never stashed) -------------------------- */
  var evState = { state: '', prev: '' };
  var evEntered = { mineId: '', depth: 0, level: 0 };
  var evExtracted = { gross: 0, cargo: 0, depthM: 0, reason: '', secured: 0 };
  var evStranded = { reason: '', depthM: 0, lost: 0, secured: 0 };
  var evCash = { cash: 0, delta: 0, reason: '' };
  var evFuelLow = { pct: 0 };
  var evDumped = { matIndex: 0, units: 0, x: 0, y: 0 };
  var evRig = { partKey: '', tier: 0 };
  var evRights = { mineId: '', price: 0 };
  var evDay = { day: 1 };
  var evHeat = { pct: 0 };
  var evDamage = { integrity: 1, source: '' };
  var evSold = { gross: 0, cash: 0, day: 1 };
  /* The lift events fire a handful of times a run, so allocation would be fine
   * here — they are reused anyway, because a codebase with two conventions for
   * event payloads has one convention nobody trusts. */
  var evLiftBought = { i: 0, price: 0, mineId: '' };
  var evLiftRide = { from: 0, to: 0 };
  /* Rails fire even less often than the lift — reused anyway, same argument. */
  var evRailBought = { L: 0, k: 0, price: 0, mineId: '' };
  var evRailFuel = { units: 0, cost: 0 };
  var evRailDeposit = { value: 0, units: 0 };

  var heatPctSent = -1;                // 1% granularity gate on adv:heat
  var dmgPctSent = -1;                 // ...and on adv:damage

  /* =====================================================================
   * THE FALLBACK MINE
   * ---------------------------------------------------------------------
   * SM.mines comes up as an empty catalogue, and a director with nothing to
   * descend into cannot be played or tested. This definition stands in until
   * Agent 2's table exists — resolveMine() prefers the catalogue in every case,
   * so it disappears the moment there is one entry to find.
   * ================================================================== */
  var FALLBACK_MINE = {
    id: 'shakedown',
    name: 'SHAKEDOWN SHAFT',
    region: 'Test Ground',
    mapX: 0.5, mapY: 0.5,
    price: 0,
    recDrill: 8,
    depth: 240,
    seed: 1337,
    common: ['dirt', 'stone'],
    rare: ['iron'],
    hazards: ['Unsurveyed'],
    blurb: 'A shaft nobody bothered to name. Good enough to shake the rig down.',
    layers: []
  };

  /* =====================================================================
   * SMALL GUARDED READS ACROSS THE SEAMS
   * ================================================================== */
  function rigNum(fn, dflt) {
    if (!SM.rig || typeof SM.rig[fn] !== 'function') return dflt;
    var v = SM.rig[fn]();
    return (typeof v === 'number' && isFinite(v) && v > 0) ? v : dflt;
  }

  function resolveMine(id) {
    if (SM.mines && SM.mines.get) {
      var m = SM.mines.get(id);
      if (m) return m;
    }
    // No catalogue yet (or an id from a save this build does not have): the
    // shakedown shaft keeps the mode playable instead of dead.
    if (SM.mines && SM.mines.count && SM.mines.count() > 0) return null;
    return FALLBACK_MINE;
  }

  function firstMineId() {
    if (SM.mines && SM.mines.getStarterId) {
      var id = SM.mines.getStarterId();
      if (id) return id;
    }
    return FALLBACK_MINE.id;
  }

  /** The layer covering the machine right now, or null while tables are empty. */
  function currentLayer() {
    if (!mineDef) return null;
    if (SM.mines && SM.mines.layerAt) {
      var l = SM.mines.layerAt(mineDef, depthM);
      if (l) return l;
    }
    if (SM.advterrain && SM.advterrain.layerAtY && SM.vehicle) {
      return SM.advterrain.layerAtY(SM.vehicle.getY());
    }
    return null;
  }

  function saveRecord() {
    return (SM.save && SM.save.get) ? SM.save.get() : null;
  }

  function mineRecord(id) {
    if (!id || !SM.save || !SM.save.mineState) return null;
    return SM.save.mineState(id);
  }

  function markDirty() {
    if (SM.save && SM.save.markDirty) SM.save.markDirty();
  }

  /* =====================================================================
   * THE LIFT — LEVELS AS MAPS
   * ---------------------------------------------------------------------
   * Geometry first, and there is far less of it than there used to be: ONE door
   * per level map, at the band's top-centre, and its circle is the whole of the
   * lift's presence in the world. Every reading goes through js/advterrain.js
   * when it has it and falls back to the identity it is defined by, so the
   * ladder works while that module is still being re-cut — and the fallbacks are
   * not arbitrary: door x 0 is the mine's centre line, door y is just inside the
   * band's top, and yOfDepth is the depth equation from ARCHITECTURE.md §3, which
   * advterrain implements verbatim.
   * ================================================================== */

  /* How far below the band's top edge the door sits when advterrain cannot say.
   * A door AT the ceiling would put half its circle in the seal; one machine
   * length down is where a chamber would be carved anyway. */
  var DOOR_INSET_U = 90;

  /* THE CAGE'S OWN FOOTPRINT, as a fraction of ADV.EXIT_RADIUS, for a build
   * where js/advterrain.js cannot yet answer inDoorInterior(). Deliberately much
   * smaller than the door circle: the circle is "the doors notice you and open",
   * the interior is "you have driven INTO the lift and the doors close on you".
   * Two different questions, and conflating them is what would make the menu
   * open at arm's length. */
  var LIFT_INTERIOR_K = 0.55;

  function yOfDepth(m) {
    if (SM.advterrain && SM.advterrain.yOfDepth) {
      var v = SM.advterrain.yOfDepth(m);
      if (typeof v === 'number' && isFinite(v)) return v;
    }
    return A.MINE_CEILING_Y + (m > 0 ? m : 0) / A.METERS_PER_UNIT;
  }

  /**
   * World x of THIS level's door. advterrain.getDoorX() is authoritative; the
   * fallback is the mine's centre line, which is where §2b puts it.
   *
   * getMouthX() is still consulted in between, because a build where Agent W's
   * band work has not landed still answers that one and the two mean the same
   * thing while the lift is central.
   */
  function doorX() {
    var t = SM.advterrain, v;
    if (t && t.getDoorX) {
      v = t.getDoorX();
      if (typeof v === 'number' && isFinite(v)) return v;
    }
    if (t && t.getMouthX) {
      v = t.getMouthX();
      if (typeof v === 'number' && isFinite(v)) return v;
    }
    return 0;
  }

  /**
   * World y of THIS level's door. The fallback is the top of the active band
   * plus DOOR_INSET_U — which is why it needs the level table, and why callers
   * must have called ensureLevels() first (all of them do).
   */
  function doorY() {
    var t = SM.advterrain, v;
    if (t && t.getDoorY) {
      v = t.getDoorY();
      if (typeof v === 'number' && isFinite(v)) return v;
    }
    var e = levels[runLevel - 1];
    var top = e ? yOfDepth(e.depthTopM) : yOfDepth(0);
    return top + DOOR_INSET_U;
  }

  /** The BAND table for a mine: level k is entry k-1. Never empty when live. */
  function levelTable(def) {
    if (def && SM.mines && SM.mines.levelsOf) {
      var t = SM.mines.levelsOf(def);
      if (t && t.length) return t;
    }
    return null;
  }

  /** How many levels (bands) this mine has at all. */
  function levelCount(id) {
    var t = levelTable(resolveMine(id));
    return t ? t.length : 0;
  }

  /**
   * How many levels this company has BOUGHT in a mine — which is NOT how many it
   * owns, because level 1 comes with the mining rights.
   *
   * THIS IS THE SAVED NUMBER, AND ITS MEANING IS UNCHANGED FROM v1.8. A v1.8
   * record stored "how many lift stations were purchased", and a station bought
   * at layer k's boundary gave access to layer k — which is band k+1 here. So
   * `purchased` maps across exactly: a save with levels:2 owned two stations
   * into layers 1 and 2, and owns bands 1 (free), 2 and 3 now. No schema change,
   * no migration, and nothing a company paid for is lost.
   */
  function purchasedLevels(id) {
    if (!id) return 0;
    var n = levelsHeld[id];
    if (typeof n !== 'number') {
      n = 0;
      if (SM.save && SM.save.levelsOwned) {
        var v = SM.save.levelsOwned(id);
        if (typeof v === 'number' && v > 0) n = Math.floor(v);
      }
      levelsHeld[id] = n;
    }
    var max = levelCount(id) - 1;
    if (max < 0) max = 0;
    return n > max ? max : n;
  }

  /**
   * How many LEVELS this company owns in a mine: the purchases plus the free
   * first band. 1..levelCount, or 0 for a mine with no bands at all (a stub
   * catalogue). Levels 1..ownedLevels(id) are exactly the ridable ones.
   */
  function ownedLevels(id) {
    var n = levelCount(id);
    if (!n) return 0;
    var owned = purchasedLevels(id) + 1;
    return owned > n ? n : owned;
  }

  /** Record that levels 1..owned are held. Stores owned-1: see purchasedLevels. */
  function setOwnedLevels(id, owned) {
    var p = owned - 1;
    if (!(p > 0)) p = 0;
    levelsHeld[id] = p;
    if (SM.save && SM.save.setLevelsOwned) SM.save.setLevelsOwned(id, p);
    else {
      // No dedicated accessor (an older save.js): write the documented field.
      var ms = mineRecord(id);
      if (ms) { ms.levels = p; markDirty(); }
    }
  }

  /**
   * Rebuild `levels` if the mine in context, the levels owned in it, or the
   * door's x has changed since the last call. Everything else about a band is
   * derived, so those three are the whole cache key.
   *
   * HOT-ADJACENT: getDistanceToExit() calls this every step through
   * getReserveNeeded(), so the steady-state path is three comparisons and a
   * return. The rebuild reuses the array AND the entry objects — a UI that
   * stashed `getLevels()[2]` keeps a live reference for the whole session.
   */
  function ensureLevels() {
    var def = getMine();
    var id = def ? def.id : null;
    var owned = id ? ownedLevels(id) : 0;
    var mx = doorX();
    if (id === lvMineId && owned === lvOwned && mx === lvMouthX) return levels;

    lvMineId = id;
    lvOwned = owned;
    lvMouthX = mx;

    var tbl = id ? levelTable(def) : null;
    var want = tbl ? tbl.length : 0;
    while (levels.length > want) levels.pop();
    while (levels.length < want) {
      levels.push({
        i: 0, name: '', depthTopM: 0, depthBotM: 0, depthM: 0,
        price: 0, widthU: 0, y: 0, owned: false
      });
    }
    for (var k = 0; k < want; k++) {
      var e = levels[k], L = tbl[k];
      e.i = k + 1;
      e.name = L.name;
      e.depthTopM = (typeof L.depthTopM === 'number') ? L.depthTopM : (L.depthM || 0);
      e.depthBotM = (typeof L.depthBotM === 'number') ? L.depthBotM : e.depthTopM;
      e.depthM = e.depthTopM;               // alias: the depth a UI quotes
      e.price = L.price || 0;
      e.widthU = L.widthU || 0;
      /* `y` is the band's TOP in world units — the door's row. It is an extra,
       * not part of §2b's entry shape, and it exists because every consumer that
       * used to read a station's y (the HUD, a fallback park) wants this. */
      e.y = yOfDepth(e.depthTopM);
      e.owned = e.i <= owned;
    }
    return levels;
  }

  /**
   * LIVE array of BAND entries for the mine in context, level 1 first:
   *   {i, name, depthTopM, depthBotM, price, widthU, owned}
   * plus the extras `depthM` (= depthTopM) and `y` (band top in world units).
   * Empty when there is no mine to talk about. THERE IS NO SURFACE ENTRY.
   */
  function getLevels() { return ensureLevels(); }

  /** One band entry by 1-based level index, or null. */
  function getLevelDef(i) {
    ensureLevels();
    i = Math.floor(i);
    return (i >= 1 && i <= levels.length) ? levels[i - 1] : null;
  }

  /** The level map the run is ON (1-based), or — between runs — the one it will. */
  function getLevel() { return runLevel; }

  /** World x of this level's door. vehicle.js parks the machine on it. */
  function getStationX() { ensureLevels(); return lvMouthX; }
  /** World y of this level's door. */
  function getStationY() { ensureLevels(); return doorY(); }
  /* Names §2b uses. getStationX/Y are kept because js/vehicle.js's
   * parkAtStation() already reads them, so the park lands in the right place
   * even in a build where Agent W's parkAtDoor() has not arrived yet. */
  function getDoorX() { return getStationX(); }
  function getDoorY() { return getStationY(); }

  /**
   * Buy the next level down in the mine in context. -> true if money moved.
   *
   * Refused unless `i` is exactly the next unowned level, which is what makes the
   * stored count (rather than a set) legitimate. Level 1 can never be bought: it
   * comes with the rights and its catalogue price is 0.
   *
   * ALLOWED DURING A RUN, deliberately — from the DOOR MENU, which is where a
   * player is when the question "how much for the next level?" occurs to them.
   * It does not move the machine: the new map has to be RIDDEN to, and rideTo()
   * is what does that.
   */
  function buyLevel(i) {
    // ...but not from outside the campaign. close() leaves `mineDef` set, and a
    // verb that moves money while no company is on screen is a way to spend a
    // ledger that is no longer being displayed.
    if (state === 'off') return false;
    var def = getMine();
    if (!def || !ownsRights(def.id)) return false;
    ensureLevels();
    i = Math.floor(i);
    if (!(i > 1) || i > levels.length) return false;
    if (i !== ownedLevels(def.id) + 1) return false;
    var price = levels[i - 1].price;
    if (!canAfford(price)) return false;

    moveCash(-price, 'level');
    setOwnedLevels(def.id, i);
    ensureLevels();                 // the cache key just changed: refresh `owned`
    /* BUYING DEPTH IS ASKING TO GO THERE. The prep screen reads getLevel() to
     * say where the lift is taking you, and a player who has just paid for level
     * 2 and is then told they are descending to level 1 has been ignored.
     *
     * NOT DURING A RUN, though: getLevel() means "the map the run is on" while
     * one is live, and the machine is still standing where it was. */
    if (state !== 'mine') runLevel = i;

    evLiftBought.i = i;
    evLiftBought.price = price;
    evLiftBought.mineId = def.id;
    SM.events.emit('lift:bought', evLiftBought);
    flushSave();
    return true;
  }

  /**
   * THE DOOR TEST. The current level's index while the machine is inside the
   * door circle (ADV.EXIT_RADIUS about the door), else -1.
   *
   * One door per map, so there is nothing to disambiguate and — see the header —
   * no arming rule: the menu is explicit, so standing in the doorway can no
   * longer end a run by accident. This is polled by the HUD on its slow timer
   * and is O(1) with no allocation.
   */
  function getBoardable() {
    if (state !== 'mine' || !SM.vehicle) return -1;
    ensureLevels();
    var dx = SM.vehicle.getX() - lvMouthX;
    var dy = SM.vehicle.getY() - doorY();
    var r = A.EXIT_RADIUS;
    return (dx * dx + dy * dy <= r * r) ? runLevel : -1;
  }

  /** True while the machine is standing in the doorway. */
  function isAtDoor() { return getBoardable() >= 0; }

  /* =====================================================================
   * BEING IN THE LIFT
   * ---------------------------------------------------------------------
   * OWNER'S CALL, AND IT IS THE RIGHT ONE: you do not stand NEAR the lift, you
   * DRIVE INTO IT AND DISAPPEAR. Proximity only makes the doors open (that is
   * advterrain's own animation, off getBoardable()); crossing into the cage is
   * what puts you inside, hides the machine (js/vehicle.js reads isInLift()) and
   * raises the door menu.
   *
   * IT IS A STATE FLAG, NOT A PURE GEOMETRY TEST, and that is deliberate:
   *
   *   ARRIVING IS ENTERING. A descent and a ride both put the machine down in the
   *   cage, so the run OPENS inside the lift with the menu up — which is a good
   *   beat and it is also how the player learns the menu exists. A pure position
   *   test could not distinguish that from "drove past the door".
   *
   *   LEAVING HAS TO STICK. exitLift() re-places the machine with
   *   vehicle.parkAtDoor(), whose offset belongs to js/vehicle.js and may well
   *   still be inside the cage. So geometry cannot re-trigger until the machine
   *   has been OUTSIDE the interior at least once (`liftArmed`) — the same
   *   argument the old mouth-arming rule made, and this time it is load-bearing
   *   rather than a trap, because entry here IS by contact.
   *
   * WHILE INSIDE, THE MACHINE IS PARKED IN THE CAGE. update() re-parks it every
   * step and clears the stick, so it cannot be driven, cannot cut and cannot burn
   * fuel (isWorking() reads false with the stick cleared and the hull at rest).
   * This does not fight js/vehicle.js: parkAtDoor() is that module's own verb for
   * exactly this, and it is what the ride path calls.
   * ================================================================== */
  var inLift = false;                  // the machine is inside the cage
  var liftArmed = false;               // ...and geometry may put it there again
  var evLiftIn = { level: 0, reason: '' };
  var evLiftOut = { level: 0 };

  /** Is (x, y) inside the CAGE — not merely in the door circle? */
  function inDoorInterior(x, y) {
    var t = SM.advterrain;
    if (t && t.inDoorInterior) return !!t.inDoorInterior(x, y);
    var dx = x - lvMouthX, dy = y - doorY();
    var r = A.EXIT_RADIUS * LIFT_INTERIOR_K;
    return dx * dx + dy * dy <= r * r;
  }

  /** True while the machine is IN the lift: hidden, parked, menu up. */
  function isInLift() { return state === 'mine' && inLift; }

  /** Either answer is "the door menu's verbs are legal here". */
  function atDoorOrInLift() { return inLift || getBoardable() >= 0; }

  /**
   * Step into the cage. Called by the drive-in test, by a ride's arrival and by
   * a descent's — every one of which is genuinely "you are now in the lift".
   */
  function enterLift(reason) {
    if (state !== 'mine' || inLift) return false;
    inLift = true;
    liftArmed = false;
    if (SM.input && SM.input.clearStick) SM.input.clearStick();
    parkAtDoor();
    evLiftIn.level = runLevel;
    evLiftIn.reason = reason || '';
    SM.events.emit('lift:entered', evLiftIn);
    return true;
  }

  /**
   * ROLL OUT. The menu's OUT plate, and what dismissing the menu means — a
   * player who waves the panel away wants to be back in the rock, not standing
   * in a lift with no controls.
   */
  function exitLift() {
    if (state !== 'mine' || !inLift) return false;
    inLift = false;
    liftArmed = false;                 // leave the cage before it can re-take you
    parkAtDoor();
    evLiftOut.level = runLevel;
    SM.events.emit('lift:exited', evLiftOut);
    return true;
  }

  /**
   * RIDE THE LIFT TO ANOTHER LEVEL MAP. Free — no fuel, no money, no day — and
   * the hold comes with you.
   *
   * Only from the doorway: the lift is a place in the world, not a menu you can
   * open in the middle of a seam. The carve mask is whole-mine and the bands are
   * disjoint in y, so nothing has to be saved or restored here — the level you
   * left is exactly as you left it when you come back.
   *
   * ORDER MATTERS, and it is the contract's: `lift:ride` goes out FIRST, while
   * the old world is still standing, so the presentation layer can put the
   * screen to black in the same tick and the swap happens underneath it. Then
   * the band, then the machine (parkAtDoor reads getStationY(), which reads
   * runLevel), then the camera — which re-snaps onto the machine instead of
   * flying 300 m down a shaft that no longer exists.
   */
  function rideTo(i) {
    if (state !== 'mine') return false;
    /* RIDES HAPPEN FROM INSIDE THE CAGE. A caller that is merely parked in the
     * doorway (a console, or a UI built before the lift became a place) steps in
     * first rather than being refused — the machine is at the doors either way,
     * and refusing would be pedantry about which frame it crossed the threshold. */
    if (!inLift) {
      if (getBoardable() < 0) return false;
      enterLift('ride');
    }
    ensureLevels();
    i = Math.floor(i);
    if (!(i >= 1) || i > levels.length || !levels[i - 1].owned) return false;
    if (i === runLevel) return false;      // you are standing in it

    evLiftRide.from = runLevel;
    evLiftRide.to = i;
    SM.events.emit('lift:ride', evLiftRide);

    runLevel = i;
    beginLevel(i);
    parkAtDoor();
    if (SM.camera && SM.camera.reset) SM.camera.reset();
    /* YOU ARRIVE INSIDE THE DESTINATION LIFT. The cage is the thing that moved,
     * so the doors on the new level open onto the same machine in the same cage:
     * the menu stays up, the machine stays hidden, and OUT is what puts you in
     * the new rock. `lift:entered` is re-announced because it is a different
     * lift on a different map, and both the HUD and the world want to know. */
    inLift = true;
    liftArmed = false;
    evLiftIn.level = runLevel;
    evLiftIn.reason = 'ride';
    SM.events.emit('lift:entered', evLiftIn);
    return true;
  }

  /**
   * Hand the active band to js/advterrain.js.
   *
   * FEATURE-DETECTED, and the fallback is not a no-op: while Agent W's
   * beginLevel() is still in flight, endMine/beginMine is a legitimate way to
   * rebuild the world around a new band, and doing nothing at all would leave
   * the machine parked at a door in a map that is still the old level's. The
   * mask survives either way — advterrain.endMine() hands it back and
   * beginMine() takes it straight in again.
   */
  function beginLevel(i) {
    var t = SM.advterrain;
    if (!t || !mineDef) return false;
    if (t.beginLevel) { t.beginLevel(mineDef, i); return true; }
    if (t.endMine && t.beginMine) {
      var ms = mineRecord(runMineId);
      var mask = t.endMine();
      if (ms && typeof mask === 'string' && mask) ms.mask = mask;
      t.beginMine(mineDef, ms);
      return true;
    }
    return false;
  }

  /** Put the machine in the doorway, however this build spells it. */
  function parkAtDoor() {
    if (!SM.vehicle) return false;
    if (SM.vehicle.parkAtDoor) return !!SM.vehicle.parkAtDoor();
    if (SM.vehicle.parkAtStation) return !!SM.vehicle.parkAtStation();
    return false;
  }

  /* =====================================================================
   * THE DOOR MENU'S VERBS
   * ---------------------------------------------------------------------
   * The doors ARE the surface, reached by the lift the ore goes up. Everything
   * the surface used to do in its own screen happens here instead, one tap per
   * verb, without ending the run:
   *
   *   sellAtDoor()    bank the hold AND the secured ledger, roll the day
   *   refuelAtDoor()  fill the tank at the SURFACE price
   *   rideTo(L)       change level map, hold intact
   *   leaveToMap()    end the expedition and go back to the world map
   *
   * WHY SELLING ROLLS THE DAY. It is the same transaction a surface sale was —
   * one visit to the door with a load is one day's work — and the day counter is
   * what every price and every stat is quoted against. Leaving it still while ore
   * turns into money would make the loop free.
   *
   * WHY REFUEL IS SURFACE-PRICED. There is nothing between the player and the
   * surface but a lift they own; the 1.5x markup belongs to the dormant rail
   * checkpoints, which are the thing you did NOT plan for.
   * ================================================================== */

  /**
   * Bank the hold and the secured ledger: the ONE place a run's ore becomes
   * money, the day rolls and the lifetime stats are written.
   *
   * `requireValue` refuses an empty sale rather than rolling the day for nothing
   * — the door menu passes true, because SELL is a plate the player can tap
   * whenever they are parked. sell() (the results screen) passes false, because
   * it has its own once-per-run gate and its own reason to be tapped.
   *
   * -> {gross, lines, secured, securedUnits, securedLines} or null if refused.
   */
  function bankRun(reason, requireValue) {
    var lines = [];
    var gross = 0, i, e;
    for (i = 0; i < manifest.length; i++) {
      e = manifest[i];
      if (e.units <= 0) continue;
      lines.push({ matId: e.matId, units: e.units, value: e.value });
      gross += e.value;
    }

    /* THE SECURED LEDGER IS BANKED HERE, WITH THE HOLD — see the RAILS note in
     * the header. It is banked even when the hold is empty and even after a
     * STRAND, which is the whole reason the results screen still offers SELL. */
    var secGross = secured.value;
    var secUnits = secured.units;
    if (requireValue && !(gross + secGross > 0)) return null;
    var secLines = securedForResults();

    clearHold();
    clearSecured();

    // Cargo units are fractional (a fragment of a deposit is a fraction of its
    // volume) but MONEY is not, and js/save.js floors `cash` on load — so the
    // gross is rounded here, once, at the moment it becomes money.
    gross = Math.round(gross + secGross);
    /* 'sale' whichever door it came through — nothing keys on the distinction and
     * two strings for one transaction is how a ledger's audit trail rots.
     * `reason` is carried for the log line and for future callers. */
    if (gross > 0) moveCash(gross, 'sale');

    var r = saveRecord();
    if (r) {
      r.integrity = hull / HULL_POINTS;
      if (!r.stats) r.stats = { hauled: 0, bestHaul: 0, runs: 0 };
      r.stats.hauled = (r.stats.hauled || 0) + gross;
      if (gross > (r.stats.bestHaul || 0)) r.stats.bestHaul = gross;
      r.stats.runs = (r.stats.runs || 0) + 1;
    }

    day++;
    if (r) r.day = day;
    evDay.day = day;
    SM.events.emit('adv:day', evDay);

    evSold.gross = gross;
    evSold.cash = cash;
    evSold.day = day;
    SM.events.emit('adv:sold', evSold);

    flushSave();
    return {
      gross: gross,
      lines: lines,
      secured: secGross,
      securedUnits: secUnits,
      securedLines: secLines
    };
  }

  /**
   * SELL AT THE DOOR. Banks the hold plus anything secured, rolls the day, and
   * leaves the machine exactly where it is with an empty hold and a full day's
   * pay in the account. -> the same record sell() returns, or null.
   *
   * It does NOT set the results screen's `soldThisRun` flag: a run that sells at
   * the door, drives back into the rock, secures ore and then strands must still
   * be able to bank the secured ore on the results screen.
   */
  function sellAtDoor() {
    if (state !== 'mine') return null;
    if (!atDoorOrInLift()) return null;
    return bankRun('door', true);
  }

  /** Dollars per unit of fuel at the surface price. */
  function fuelUnitPrice() {
    if (SM.mines && SM.mines.fuelPrice) {
      var p = SM.mines.fuelPrice();
      if (typeof p === 'number' && p > 0) return p;
    }
    return 1;
  }

  var fuelQuote = { units: 0, cost: 0 };     // REUSED: the door menu polls this

  /**
   * What filling the tank AT THE DOOR would cost right now, as a REUSED
   * {units, cost}. Both are 0 when there is nothing to buy. The quote goes
   * through SM.mines.fuelCost() so it is provably the number every other screen
   * shows for the same litres.
   */
  function getDoorFuelQuote() {
    fuelQuote.units = 0;
    fuelQuote.cost = 0;
    if (state !== 'mine') return fuelQuote;
    var want = getFuelCap() - fuel;
    if (!(want > FUEL_EPS)) return fuelQuote;
    fuelQuote.units = want;
    fuelQuote.cost = quoteFuel(want, fuelUnitPrice());
    return fuelQuote;
  }

  /**
   * Fill the tank, in the mine, at the surface price. -> {units, cost} or null.
   *
   * Charges what the cash reaches rather than refusing outright, exactly as
   * buyFuel() does at the surface — a machine 400 m down with $30 must always be
   * able to buy $30 of diesel. It fills `fuel` and not `tank`, because the run is
   * live: buyFuel() is the between-runs verb and refuses while state is 'mine'.
   */
  function refuelAtDoor() {
    if (state !== 'mine') return null;
    if (!atDoorOrInLift()) return null;
    return pumpFuel(fuelUnitPrice(), quoteDoorFuel, 'fuel');
  }

  function quoteDoorFuel(units) { return quoteFuel(units, fuelUnitPrice()); }

  /**
   * The shared pump. Fills the tank from `unitPrice` and `quote`, buying only
   * what the cash reaches, and re-arms the low-fuel warnings.
   * -> {units, cost} (freshly allocated: a handful of calls per run) or null.
   *
   * ONE ARITHMETIC FOR BOTH PUMPS. The door pays the surface price and a rail
   * checkpoint pays 1.5x it; everything else about the transaction — the partial
   * fill, the shave for fractional cash, the warning re-arm — was identical, and
   * two copies of it is how the two prices drift apart.
   */
  function pumpFuel(unitPrice, quote, reason) {
    var cap = getFuelCap();
    var want = cap - fuel;
    if (!(want > FUEL_EPS)) return null;

    var units = want;
    var cost = quote(units);
    if (cost > cash) {
      /* Whole units, so the rounding-up in the quote can never land above the
       * cash on hand — and then shave, because cash can be fractional. */
      units = Math.floor(cash / unitPrice);
      if (units < 1) return null;
      cost = quote(units);
      while (units >= 1 && cost > cash) { units -= 1; cost = quote(units); }
      if (units < 1 || cost > cash) return null;
    }

    fuel += units;
    if (fuel > cap) fuel = cap;
    moveCash(-cost, reason);

    /* RE-ARM THE LOW-FUEL WARNINGS. They fire once each as the needle crosses a
     * threshold downward and otherwise only re-arm on a new descent, so a tank
     * refilled underground would climb back through 20% and 10% in silence on the
     * way down again — which is the one moment the warning is worth most. */
    var pct = getFuelPct();
    while (warnIndex > 0 && pct > FUEL_WARN[warnIndex - 1]) warnIndex--;

    return { units: units, cost: cost };
  }

  /**
   * LEAVE. Close the level down and go back to the world map.
   *
   * ANYTHING STILL ABOARD IS SOLD ON THE WAY OUT. The alternative was to refuse
   * with a full hold, or to bin it — and both are wrong for the same reason: the
   * player is standing IN the lift at the surface end of it. Walking out of your
   * own doorway must never destroy ore, and having to tap SELL before MAP is a
   * rule the game would be teaching by taking money away. The day rolls with the
   * sale, exactly as it would have.
   */
  function leaveToMap() {
    if (state !== 'mine') return false;
    if (!atDoorOrInLift()) return false;
    bankRun('door', true);        // null when there was nothing to bank
    teardownRun();
    results = null;               // the results screen is for STRANDS only
    setState('map');
    flushSave();
    return true;
  }

  function flushSave() {
    if (SM.save && SM.save.flush) SM.save.flush();
  }

  /* =====================================================================
   * THE RAILS
   * ---------------------------------------------------------------------
   * Geometry first, and it is one line: checkpoint k on level L sits at
   * (getStationX() + k x pitch, levels[L].y). getStationX() is the shaft's x as
   * js/advterrain.js reports it, so this is correct whether the shaft is at the
   * mine's centre line or at its west edge — nothing here ever hard-codes a
   * position. The cage is a circle of ADV.EXIT_RADIUS and, exactly like a deep
   * lift station, it is BOARDABLE BY DEFINITION: there is no arming rule,
   * because a checkpoint does nothing on contact. Refuelling and depositing are
   * explicit verbs, so arming would only ever lock out a machine that had driven
   * back to its own siding.
   * ================================================================== */

  /**
   * THE ROW A LEVEL'S TRACK IS LAID ON — the DOOR's row, not the band's top edge.
   *
   * DORMANT-SYSTEM FIX, and it matters the day rails come back: this used to be
   * the level entry's `y`, which in the shaft era was the station's cage and in
   * the band era is the band's CEILING — inside the seal, where no machine can
   * ever stand. Measured on the live build: a checkpoint at level 1's band top
   * sat at y 0 while the playable void starts at y 63 and the doors are at 593,
   * so getServiceable() could never answer. ARCHITECTURE.md §7 already says rails
   * run east and west FROM THE CENTRAL DOOR within a band; this is that sentence,
   * in code, and it costs nothing while the system is switched off.
   */
  function cpRowY(L) {
    ensureLevels();
    if (L === runLevel && state === 'mine') return doorY();
    var e = levels[L - 1];
    return e ? yOfDepth(e.depthTopM) + DOOR_INSET_U : yOfDepth(0) + DOOR_INSET_U;
  }

  /** The price table for one level of one mine. Never null. */
  function cpTable(id, L) {
    if (!id || !(L >= 1)) return EMPTY_CPS;
    if (SM.mines && SM.mines.checkpointsOf) {
      var t = SM.mines.checkpointsOf(id, L);
      if (t && t.length) return t;
    }
    return EMPTY_CPS;
  }

  /** Units of track between checkpoints. SM.mines owns the number. */
  function cpPitch() {
    var m = CP_PITCH_M;
    if (SM.mines && SM.mines.checkpointPitchM) {
      var v = SM.mines.checkpointPitchM();
      if (typeof v === 'number' && v > 0) m = v;
    }
    return m / A.METERS_PER_UNIT;
  }

  /**
   * How many checkpoints this company owns on level L of a mine, clamped to what
   * the catalogue actually sells. Read through from js/save.js once and then
   * mirrored, exactly as `levelsHeld` is.
   */
  function ownedCheckpoints(id, L) {
    if (!id || !(L >= 1)) return 0;
    var arr = railsHeld[id];
    if (!arr) { arr = []; railsHeld[id] = arr; }
    var i = L - 1;
    if (typeof arr[i] !== 'number') {
      var n = 0;
      if (SM.save && SM.save.railsOwned) {
        var v = SM.save.railsOwned(id, L);
        if (typeof v === 'number' && v > 0) n = Math.floor(v);
      }
      arr[i] = n;
    }
    var max = cpTable(id, L).length;
    return arr[i] > max ? max : arr[i];
  }

  function setOwnedCheckpoints(id, L, n) {
    var arr = railsHeld[id];
    if (!arr) { arr = []; railsHeld[id] = arr; }
    var i = L - 1;
    while (arr.length <= i) arr.push(0);
    arr[i] = n;
    if (SM.save && SM.save.setRailsOwned) SM.save.setRailsOwned(id, L, n);
    else {
      // No dedicated accessor (an older save.js): write the documented field.
      var ms = mineRecord(id);
      if (ms) {
        if (!ms.rails || typeof ms.rails.length !== 'number') ms.rails = [];
        while (ms.rails.length <= i) ms.rails.push(0);
        ms.rails[i] = n;
        markDirty();
      }
    }
  }

  /**
   * Rebuild level L's checkpoint table if the mine, the checkpoints owned on that
   * level, the shaft's x or the level's y has changed. Everything else about a
   * checkpoint is derived, so those four are the whole cache key.
   *
   * HOT-ADJACENT: getServiceable() calls this for every level the machine is
   * level with, so the steady-state path is a string compare and a return. The
   * rebuild reuses the array AND the entry objects — a UI that stashed
   * getCheckpoints(2)[0] keeps a live reference for the whole session.
   */
  function ensureCheckpoints(L) {
    ensureLevels();
    // DORMANT, and re-indexed with the band re-cut: level L is entry L-1 now.
    if (!(L >= 1) || L > levels.length) return EMPTY_CPS;
    var def = getMine();
    var id = def ? def.id : null;
    if (!id) return EMPTY_CPS;

    var e = levels[L - 1];
    var owned = ownedCheckpoints(id, L);
    var key = id + '|' + owned + '|' + lvMouthX + '|' + cpRowY(L);
    if (cpKeys[L] === key && cpArrays[L]) return cpArrays[L];

    var tbl = cpTable(id, L);
    var arr = cpArrays[L];
    if (!arr) { arr = []; cpArrays[L] = arr; }
    while (arr.length > tbl.length) arr.pop();
    while (arr.length < tbl.length) {
      arr.push({ k: 0, outM: 0, x: 0, y: 0, price: 0, owned: false });
    }
    var pitch = cpPitch();
    var rowY = cpRowY(L);
    for (var i = 0; i < tbl.length; i++) {
      var t = tbl[i], c = arr[i];
      c.k = t.k;
      c.outM = t.outM;
      c.price = t.price;
      c.x = lvMouthX + t.k * pitch;     // EAST of the door, always
      c.y = rowY;
      c.owned = t.k <= owned;
    }
    cpKeys[L] = key;
    return arr;
  }

  /**
   * LIVE array [{k, outM, x, y, price, owned}] for level L of the mine in
   * context, k >= 1 and outward. Empty for the surface, for a level this mine
   * does not sell, and when there is no mine to talk about.
   *
   * Returned for levels the company does NOT own, with every `owned` false, so a
   * UI can quote the ladder before the lift reaches it.
   */
  function getCheckpoints(L) { return ensureCheckpoints(Math.floor(L)); }

  /**
   * Buy the next checkpoint outward on level L. -> true if money moved.
   *
   * Refused unless `k` is exactly the next unowned one ON THAT LEVEL, which is
   * what makes the stored count (rather than a set) legitimate — the same rule
   * buyLevel() enforces, one dimension over. Each level's line is independent:
   * owning three checkpoints on level 1 buys you nothing on level 2.
   *
   * THE LEVEL ITSELF MUST BE OWNED. Track on a stratum you cannot reach is money
   * spent on a place you have never been, and unlike a level it does not open the
   * way to anything — the lift is the only way in.
   *
   * ALLOWED DURING A RUN, for the same reason buyLevel() is: you are standing at
   * the end of your own line looking east, and the answer is money.
   */
  function buyCheckpoint(L, k) {
    // ...but not from outside the campaign — see buyLevel().
    if (state === 'off') return false;
    var def = getMine();
    if (!def || !ownsRights(def.id)) return false;
    ensureLevels();
    L = Math.floor(L);
    k = Math.floor(k);
    if (!(L >= 1) || L >= levels.length) return false;
    if (L > ownedLevels(def.id)) return false;
    var tbl = ensureCheckpoints(L);
    if (!tbl.length) return false;
    if (!(k >= 1) || k > tbl.length) return false;
    if (k !== ownedCheckpoints(def.id, L) + 1) return false;
    var price = tbl[k - 1].price;
    if (!canAfford(price)) return false;

    moveCash(-price, 'rail');
    setOwnedCheckpoints(def.id, L, k);
    ensureCheckpoints(L);           // the cache key just changed: refresh `owned`

    evRailBought.L = L;
    evRailBought.k = k;
    evRailBought.price = price;
    evRailBought.mineId = def.id;
    SM.events.emit('rail:bought', evRailBought);
    flushSave();
    return true;
  }

  /**
   * The checkpoint whose cage the machine is standing in, as {level, k}, else
   * null. REUSED object — read it inside the call.
   *
   * Every owned checkpoint on every owned level is a candidate, not just the ones
   * on the level the run is based at: a machine that drove down its own tunnel
   * from level 1 to level 2's depth is standing at level 2 whatever runLevel
   * says, and a siding you paid for has to work when you are in it. The y test is
   * a cheap reject first, so the loop is a handful of compares in the normal case.
   */
  function getServiceable() {
    if (state !== 'mine' || !SM.vehicle) return null;
    ensureLevels();
    var vx = SM.vehicle.getX(), vy = SM.vehicle.getY();
    var r = A.EXIT_RADIUS, r2 = r * r;
    var bestL = -1, bestK = -1, bestD = 0;
    for (var L = 1; L <= levels.length; L++) {
      var e = levels[L - 1];            // DORMANT: level L is entry L-1 now
      if (!e.owned) continue;
      var dy = vy - cpRowY(L);          // ...and the track is on the DOOR's row
      if (dy > r || dy < -r) continue;
      var tbl = ensureCheckpoints(L);
      for (var i = 0; i < tbl.length; i++) {
        var c = tbl[i];
        if (!c.owned) continue;
        var dx = vx - c.x;
        if (dx > r || dx < -r) continue;
        var d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        if (bestL < 0 || d2 < bestD) { bestL = L; bestK = c.k; bestD = d2; }
      }
    }
    if (bestL < 0) return null;
    svcOut.level = bestL;
    svcOut.k = bestK;
    return svcOut;
  }

  /** Dollars for `units` of fuel at a checkpoint pump. */
  function quoteRailFuel(units) {
    if (SM.mines && SM.mines.railFuelCost) return SM.mines.railFuelCost(units);
    return Math.ceil((units > 0 ? units : 0) * railUnitPrice());
  }

  /** Dollars per unit at a checkpoint pump — for sizing a partial fill only. */
  function railUnitPrice() {
    var price = 1;
    if (SM.mines && SM.mines.fuelPrice) {
      var p = SM.mines.fuelPrice();
      if (typeof p === 'number' && p > 0) price = p;
    }
    var mk = RAIL_FUEL_MARKUP;
    if (SM.mines && SM.mines.railFuelMarkup) {
      var m = SM.mines.railFuelMarkup();
      if (typeof m === 'number' && m > 0) mk = m;
    }
    return price * mk;
  }

  /**
   * Top the tank up at the checkpoint the machine is standing in. -> true if
   * money moved.
   *
   * Charges what the cash reaches rather than refusing outright, exactly as
   * buyFuel() does — a machine 400 m down with $30 must always be able to buy $30
   * of fuel. The arithmetic goes through SM.mines.railFuelCost() and never
   * through units x price: the quote has to be provably 1.5x the number the prep
   * screen showed for the same litres.
   */
  function refuelHere() {
    if (state !== 'mine') return false;
    if (!getServiceable()) return false;
    // Same pump as the door, one markup apart — see pumpFuel().
    var got = pumpFuel(railUnitPrice(), quoteRailFuel, 'railfuel');
    if (!got) return false;

    evRailFuel.units = got.units;
    evRailFuel.cost = got.cost;
    SM.events.emit('rail:fuel', evRailFuel);
    return true;
  }

  /**
   * SECURE the whole hold at the checkpoint the machine is standing in. -> true
   * if anything moved.
   *
   * The units leave the manifest and the hold is empty and free to fill again;
   * the VALUE goes into the run's secured ledger, which strand() and abort()
   * cannot touch and which sell() banks. This is the verb rails exist for — see
   * the RAILS note in the header for why it is not instant money.
   */
  function depositHere() {
    if (state !== 'mine') return false;
    if (!getServiceable()) return false;
    if (!(cargo > 0) || !manifest.length) return false;

    var moved = 0, units = 0;
    for (var i = 0; i < manifest.length; i++) {
      var e = manifest[i];
      if (e.units <= 0) continue;
      addSecuredLine(e.matIndex, e.matId, e.units, e.value);
      moved += e.value;
      units += e.units;
    }
    if (!(units > 0)) return false;
    secured.value += moved;
    secured.units += units;
    clearHold();

    evRailDeposit.value = moved;
    evRailDeposit.units = units;
    SM.events.emit('rail:deposit', evRailDeposit);
    return true;
  }

  /**
   * Merge a holding into the secured breakdown. Entries are created once per
   * material per run and mutated in place after that, so a deposit allocates
   * nothing on the second and every subsequent trip.
   */
  function addSecuredLine(mi, matId, units, value) {
    for (var i = 0; i < securedLines.length; i++) {
      if (securedLines[i].matIndex === mi) {
        securedLines[i].units += units;
        securedLines[i].value += value;
        return;
      }
    }
    securedLines.push({ matIndex: mi, matId: matId, units: units, value: value });
  }

  /** What this run has secured so far, as {value, units}. REUSED object. */
  function getSecured() { return secured; }

  /** LIVE per-material breakdown of the secured ledger. REUSED entries. */
  function getSecuredLines() { return securedLines; }

  function clearSecured() {
    secured.value = 0;
    secured.units = 0;
    securedLines.length = 0;
  }

  /** A plain copy for the results record. Once per descent: allocation is fine. */
  function securedForResults() {
    var out = [];
    for (var i = 0; i < securedLines.length; i++) {
      var e = securedLines[i];
      out.push({ matId: e.matId, matIndex: e.matIndex, units: e.units, value: e.value });
    }
    return out;
  }

  /* =====================================================================
   * MATERIAL TABLES
   * ---------------------------------------------------------------------
   * Built on first use inside a mine — NOT in init(), because Agent 3 owns
   * materials.js and camera.js re-scales every hardness and value at load
   * (applyWorldDensity), so the numbers are only final once the page has
   * finished parsing. Rebuilt if the table ever grows underneath us.
   * ================================================================== */
  function ensureMatTables() {
    var M = SM.materials;
    var n = (M && M.count) ? M.count : 0;
    if (n === matCount && slotOf) return;

    matCount = n;
    slotOf = new Int16Array(n);
    fragUnits = new Float32Array(n);
    unitPrice = new Float32Array(n);
    matHard = new Float32Array(n);

    /* THE CATALOGUE'S ZEROS ARE MEANINGFUL. SM.mines quotes volume 0 / price 0
     * for SPOIL — dirt, stone, granite, obsidian — and that is the whole reason
     * a hold does not fill with topsoil in the first ten seconds. So the
     * material table is only consulted when there is no catalogue at all; the
     * moment there is one, its zeros are the answer. (Measured before this
     * split: dirt at a fallback $1/unit took 38 of the 48-unit starting hold.)
     */
    var haveEconomy = !!(SM.mines && SM.mines.count && SM.mines.count() > 0);

    for (var i = 0; i < n; i++) {
      slotOf[i] = -1;
      var mat = M.get(i);
      if (!mat) continue;
      matHard[i] = mat.hardness || 0;

      var vol, p;
      if (haveEconomy) {
        // Index-keyed fast paths exist precisely because offerCargo() runs on
        // the collection hot path; the string lookups are for the UI.
        vol = SM.mines.volumeOfIndex ? SM.mines.volumeOfIndex(i)
                                     : SM.mines.volumeOf(mat.id);
        p = SM.mines.priceOfIndex ? SM.mines.priceOfIndex(i)
                                  : SM.mines.priceOf(mat.id);
      } else {
        vol = 1;
        p = mat.value || 0;
      }
      if (!(vol > 0) || !(p > 0)) { fragUnits[i] = 0; unitPrice[i] = 0; continue; }

      // Volume is quoted PER DEPOSIT and cargo arrives as fragments, so one
      // fragment is one deposit's volume split over its debris count. Coal
      // being bulky therefore costs more hold per fragment, exactly as the
      // brief wants, with no per-fragment division on the hot path.
      var frags = mat.debrisCount > 0 ? mat.debrisCount : 1;
      fragUnits[i] = vol / frags;
      unitPrice[i] = p;
    }
  }

  /* =====================================================================
   * MODE + STATE
   * ================================================================== */
  /** True from open() until close(). Everything that owns a frame branches on this. */
  function isActive() { return state !== 'off'; }
  /** True only during a descent — the one state where the world simulates. */
  function isInMine() { return state === 'mine'; }
  /**
   * main.js: freeze the fixed step. True on every meta screen — AND on the
   * title screen ('off'), which is the one thing that changed when the classic
   * mode went away. There used to be a time-attack lane running under the main
   * menu that had every right to tick; there is nothing under the title gate
   * now but an empty pool, so stepping it 60 times a second bought nothing and
   * meant every module still had to answer "what do I do outside a mine?".
   * One state, one answer: a descent simulates and nothing else does.
   */
  function holdsSim() { return state !== 'mine'; }
  function getState() { return state; }

  function setState(next) {
    if (next === state) return;
    var prev = state;
    state = next;
    evState.state = next;
    evState.prev = prev;
    SM.events.emit('adv:state', evState);
  }

  function init() {
    // Nothing to build: adv.js owns no DOM and no pool. The only wiring is the
    // collection hook, and it is armed for the whole session because
    // `resource:collected` is far too hot to be subscribing and unsubscribing
    // around it — offerCargo() returns immediately when no run is live.
    SM.events.on('resource:collected', onCollected);
  }

  /* --- collection ------------------------------------------------------
   * HOT: up to ~30 calls per step. O(1), no allocation, no strings.
   * ------------------------------------------------------------------ */
  function onCollected(p) {
    if (state !== 'mine' || !p) return;
    if (offerCargo(p.matIndex)) return;

    /* THE HOLD IS FULL AND THIS FRAGMENT HAD ALREADY BEEN SWALLOWED.
     *
     * This used to spit it back onto the floor so that no ore was ever
     * destroyed. It read as a fault: ore pouring back out of a full hopper,
     * which is indistinguishable on screen from the collect/refuse loop that
     * offerCargo() now prevents — and there is nothing the player can do about
     * it either way, because the collector is already shut off.
     *
     * Now it is simply dropped. offerCargo() takes PARTIAL fragments, so the
     * hold is at exactly capacity by the time anything gets here: the only ore
     * this can discard is what was already in flight on the step the hold
     * filled, which is a handful of fragments and never a decision the player
     * made. A hopper that visibly stops taking things is worth more than
     * accounting for the last sliver. */
  }

  /** Enter the campaign from the title gate. ui.js is the only caller. */
  function open() {
    if (state !== 'off') return;
    ensureMatTables();
    clearPause();
    setState('slots');
  }

  /**
   * Release main.js's pause gate.
   *
   * A campaign can be re-opened from a title screen that was reached out of a
   * PAUSED run — LEAVE EXPEDITION on the in-mine pause card closes the campaign
   * without unpausing on the way out. Without this the next descent inherits
   * the stuck pause: measured, one entered that way sat at depth 0 with the
   * machine frozen and no on-screen reason why. Cheap to assert, impossible to
   * debug from the outside.
   */
  function clearPause() {
    if (SM.main && SM.main.isPaused && SM.main.isPaused()) SM.main.setPaused(false);
  }

  /** Leave the campaign. MUST call SM.ui.leaveAdventure() to restore the title. */
  function close() {
    if (state === 'off') return;
    if (state === 'mine') teardownRun();
    hideRunChrome();
    setState('off');
    flushSave();
    /* FORGET THE MINE. teardownRun() ends the run but deliberately leaves the
     * world LOADED, because the results card is read over the top of it. The
     * title screen is not: it is the one place that owns the whole frame, and
     * a level's bedrock box painted behind a logo reads as a bug. unload()
     * exists for exactly this caller — it drops the band so nothing streams,
     * nothing carves and render() returns immediately. */
    if (SM.advterrain.unload) SM.advterrain.unload();
    if (SM.ui && SM.ui.leaveAdventure) SM.ui.leaveAdventure();
    // ...and main.restart() empties the pool behind the title, so what is left
    // on screen is black rather than the deposits of the mine just left.
    if (SM.main && SM.main.restart) SM.main.restart();
  }

  /* --- screen transitions (js/advui.js drives these) ------------------- */

  /** A slot is loaded -> adopt its ledger and go to the map. */
  function startCompany() {
    var r = saveRecord();
    /* THE MIRRORS BELONG TO THE COMPANY, NOT TO THE SESSION. Both of these are
     * caches of what is in the record, so loading a second slot has to start
     * from that slot's answer — otherwise slot B inherits slot A's mining rights
     * and its lift, which is a real bug that `rightsHeld` has always had and
     * which `levelsHeld` would have copied. Cleared before anything reads them. */
    rightsHeld = Object.create(null);
    levelsHeld = Object.create(null);
    railsHeld = Object.create(null);
    lvMineId = null;                     // ...and so the station table rebuilds
    /* ...and the checkpoint tables with it. The ARRAYS are kept — a UI holding
     * getCheckpoints(1) keeps a live reference — and only the cache keys are
     * dropped, so the next read refills the same objects in place. */
    cpKeys.length = 0;
    clearSecured();
    if (r) {
      cash = typeof r.cash === 'number' ? r.cash : START_CASH;
      day = typeof r.day === 'number' && r.day > 0 ? r.day : 1;
      companyName = r.company || '';
      // `integrity` is not in save.js's documented schema; it is written back
      // as an addition and read defensively, so an older or stricter record
      // simply starts with a sound hull.
      hull = typeof r.integrity === 'number'
        ? Math.max(0, Math.min(1, r.integrity)) * HULL_POINTS : HULL_POINTS;
      if (r.mines) {
        for (var id in r.mines) {
          if (!r.mines[id]) continue;
          if (r.mines[id].owned) rightsHeld[id] = true;
          // `levels` is a count and js/save.js has already clamped it into
          // range; a record from before the lift simply has no such field.
          if (r.mines[id].levels > 0) levelsHeld[id] = Math.floor(r.mines[id].levels);
          /* `rails` is one count per level and js/save.js has already clamped
           * each into range; a record from before rails simply has no such
           * field, and ownedCheckpoints() reads 0 through for every level. */
          var rr = r.mines[id].rails;
          if (rr && rr.length) {
            var ra = [];
            for (var ri = 0; ri < rr.length; ri++) {
              ra.push(rr[ri] > 0 ? Math.floor(rr[ri]) : 0);
            }
            railsHeld[id] = ra;
          }
        }
      }
    } else {
      // No save module yet: a playable default company.
      cash = (SM.mines && SM.mines.startingCash) ? SM.mines.startingCash() : START_CASH;
      day = 1;
      hull = HULL_POINTS;
      companyName = companyName || 'SHAKEDOWN CO';
    }
    // Anything that costs nothing is yours by definition.
    var all = (SM.mines && SM.mines.getAll) ? SM.mines.getAll() : null;
    if (all && all.length) {
      for (var i = 0; i < all.length; i++) {
        if (!all[i].price) rightsHeld[all[i].id] = true;
      }
    } else {
      rightsHeld[FALLBACK_MINE.id] = true;
    }
    clearHold();
    tank = 0;
    setState('map');
  }

  function openMap() { if (isActive() && state !== 'mine') setState('map'); }
  function openGarage() { if (isActive() && state !== 'mine') setState('garage'); }
  function backToMap() { openMap(); }

  /** -> prep, if the rights are held. */
  function selectMine(mineId) {
    if (state === 'mine') return false;
    var def = resolveMine(mineId);
    if (!def) return false;
    if (!ownsRights(def.id)) return false;      // the map buys them first
    selectedId = def.id;
    /* THE SELECTED MINE IS NOW THE MINE IN CONTEXT.
     *
     * `mineDef` used to be set only by enterMine(), which made getMine() mean
     * "the mine of the last DESCENT" rather than "the mine we are talking
     * about". Both the prep screen and its DESCEND button read getMine(), so
     * buying a new plot and tapping it on the map showed — and then descended
     * into — the PREVIOUS mine. Setting it here is safe: selectMine() is refused
     * outright while a run is live, so this can never move the ground out from
     * under an expedition in progress. */
    mineDef = def;
    /* ...and the lift is now talking about THAT mine. runLevel is set to the
     * deepest LEVEL the company owns, which is both what enterMine() will
     * default to and what the prep screen should be showing as "descending to"
     * before the player has touched anything. Never 0: level 1 comes with the
     * rights, and a stub catalogue still has to name a level. */
    lvMineId = null;
    ensureLevels();
    runLevel = ownedLevels(def.id) || 1;

    /* The tank is DELIBERATELY not emptied here. Fuel the player paid for and
     * did not burn is still in the machine — see teardownRun(). Zeroing it on
     * the way into prep is what made "fill the tank" descend on a fraction of
     * one: the prep slider sizes the purchase as (capacity - what is already
     * aboard), so wiping the tank behind it made the two disagree. */
    setState('prep');
    return true;
  }

  function ownsRights(id) {
    if (rightsHeld[id]) return true;
    if (SM.save && SM.save.isOwned && SM.save.isOwned(id)) return true;
    var def = resolveMine(id);
    return !!(def && !def.price);
  }

  /* =====================================================================
   * THE DESCENT
   * ================================================================== */

  /**
   * Begin a run.
   *
   * `loadout` is OPTIONAL and everything in it has a working default:
   *   {level: n}    the LEVEL MAP the lift drops you on (1-based), at its door.
   *                 DEFAULTS TO THE DEEPEST OWNED LEVEL, because riding up is
   *                 free and a player who has paid for depth has no reason to
   *                 start above it. Clamped into 1..owned, so a stale UI can
   *                 neither descend into a level the company does not have nor
   *                 ask for the level 0 that no longer exists.
   *   {fuel: units} a top-up bought in the same breath. Historical: the prep
   *                 screen no longer sells fuel.
   *   {refuel:false} skip the automatic full tank. restart() is the only caller
   *                 — see the note there.
   */
  function enterMine(mineId, loadout) {
    if (state === 'mine') return false;
    var def = resolveMine(mineId || selectedId);
    if (!def) return false;
    if (!ownsRights(def.id)) return false;
    if (loadout && loadout.fuel > 0) buyFuel(loadout.fuel);

    ensureMatTables();

    runMineId = def.id;
    selectedId = def.id;
    mineDef = def;

    /* --- which LEVEL MAP this descent lands on ------------------------- */
    var owned = ownedLevels(def.id);
    var want = (loadout && typeof loadout.level === 'number')
      ? Math.floor(loadout.level) : owned;
    if (!(want >= 1)) want = 1;
    if (want > owned) want = owned;
    if (!(want >= 1)) want = 1;            // a stub catalogue owns nothing
    runLevel = want;
    // Rebuild the band table for THIS mine before anything reads it —
    // vehicle.reset() asks for getStationY() a few lines down.
    lvMineId = null;
    ensureLevels();

    /* --- fuel ---------------------------------------------------------
     * A DESCENT LEAVES WITH A FULL TANK, and the company is charged for what it
     * takes. Fuel used to be a slider on the prep screen, which made every run
     * open with the same arithmetic the player had already done once; the
     * decision that survives is the interesting one (how deep, which level),
     * not "how many litres". buyFuel() is unchanged and still does the honest
     * thing when the money is short: it buys what the cash reaches and the run
     * starts on a part tank. Done HERE rather than in the UI so the flow is
     * correct even when a caller forgets. */
    if (!(loadout && loadout.refuel === false)) {
      var full = rigNum('getFuelCap', 100);
      if (tank < full) buyFuel(full - tank);
    }

    fuelCap = rigNum('getFuelCap', 100);
    cargoCap = rigNum('getCargoCap', FALLBACK_CARGO_CAP);
    heatCap = rigNum('getHeatCap', FALLBACK_HEAT_CAP);

    fuel = tank > fuelCap ? fuelCap : tank;
    fuelAtEntry = fuel;
    tankPaid = fuel;
    tank = 0;

    runTime = 0;
    /* Seeded from the LEVEL, not from zero. update() recomputes this off the
     * machine on the first step anyway, but a HUD that paints between
     * setState('mine') and that step would otherwise read 0 m at the top of a
     * band 300 m down — and the depth readout is the one number in this mode
     * that is never allowed to lie. */
    depthM = levels[runLevel - 1] ? levels[runLevel - 1].depthTopM : 0;
    maxDepthM = depthM;
    heat = 0;
    dryTimer = -1;
    warnIndex = 0;
    cargoFullSent = false;
    burnRate = 0;
    burnAccum = 0;
    heatPctSent = -1;
    dmgPctSent = -1;
    results = null;
    soldThisRun = false;
    clearHold();
    /* SECURED ORE IS RUN STATE. Cleared here rather than in teardownRun() so it
     * survives until sell() has had a chance to bank it — and so restart()'s
     * do-over, which comes back through this function, drops it along with the
     * hold. R means "that descent never happened", and it does not pay out. */
    clearSecured();

    // Piles left in THIS mine on a previous visit. The array identity is kept
    // because js/advterrain.js holds the reference.
    piles.length = 0;
    var ms = mineRecord(def.id);
    if (ms && ms.piles && ms.piles.length) {
      for (var i = 0; i < ms.piles.length; i++) {
        var p = ms.piles[i];
        if (p && p.length >= 4) piles.push([p[0], p[1], p[2], p[3]]);
      }
    }

    /* --- rebuild the world -------------------------------------------
     * main.restart()'s order, for the same reasons it documents: the vehicle
     * and the camera first so the streamer sizes its window from the real
     * view, then an empty pool, then the geology, then the presentation
     * layers. advterrain.beginMine() lands between the two so terrain.reset()
     * already knows which mine it is generating.
     * ------------------------------------------------------------------ */
    SM.vehicle.reset();
    SM.camera.reset();
    SM.particles.reset();
    if (SM.advterrain && SM.advterrain.beginMine) SM.advterrain.beginMine(def, ms);
    /* ...and then the BAND, because a descent lands on a level map and not on a
     * mine. beginMine() opens the mine (seed, mask, piles); beginLevel() bounds
     * it to this level and carves the door chamber. Feature-detected: in a build
     * without it, beginMine() alone is the whole world, exactly as before. */
    if (SM.advterrain && SM.advterrain.beginLevel) SM.advterrain.beginLevel(def, runLevel);
    /* The machine and the camera again, AFTER the band is known: vehicle.reset()
     * ran before advterrain could say where this level's door is, so the park is
     * re-done against the real answer. Both are idempotent and neither touches
     * the rig sync or the hold. */
    parkAtDoor();
    SM.camera.reset();
    SM.advterrain.reset();
    /* THE RUN OPENS INSIDE THE LIFT. The cage brought you down, so it is where
     * you are: the machine is hidden, the door menu is up, and the first thing a
     * descent asks for is OUT. That is a better opening beat than materialising
     * in a chamber, and it is how a player finds the menu without being told. */
    inLift = true;
    liftArmed = false;
    SM.effects.reset();
    SM.sound.reset();
    SM.input.reset();
    if (SM.scanner && SM.scanner.reset) SM.scanner.reset();
    if (SM.advhud && SM.advhud.reset) SM.advhud.reset();
    clearPause();                  // see clearPause(): a descent must not open frozen

    setState('mine');

    evEntered.mineId = def.id;
    evEntered.depth = def.depth || 0;
    evEntered.level = runLevel;      // ADDITION: which level map the lift opened on
    SM.events.emit('adv:entered', evEntered);
    // ...and the machine is in the cage — announced AFTER adv:entered so a
    // listener that rebuilds itself on a descent has already done so.
    evLiftIn.level = runLevel;
    evLiftIn.reason = 'descent';
    SM.events.emit('lift:entered', evLiftIn);

    // Chrome comes up AFTER the state event, so an Agent-4 handler that opens
    // its own HUD off `adv:state` has already run and these are no-ops.
    showRunChrome();
    return true;
  }

  function showRunChrome() {
    if (SM.advui && SM.advui.closeAll) SM.advui.closeAll();
    if (SM.advhud && SM.advhud.show) SM.advhud.show();
    if (SM.joystick && SM.joystick.show) SM.joystick.show();
  }

  function hideRunChrome() {
    if (SM.joystick && SM.joystick.hide) SM.joystick.hide();
    if (SM.advhud && SM.advhud.hide) SM.advhud.hide();
  }

  /** Close the mine down and hand the carve mask back to the save record. */
  function teardownRun() {
    clearPause();
    // The cage does not follow you to the world map.
    inLift = false;
    liftArmed = false;
    var ms = mineRecord(runMineId);
    if (SM.advterrain && SM.advterrain.endMine) {
      var mask = SM.advterrain.endMine();
      if (ms && typeof mask === 'string' && mask) ms.mask = mask;
    }
    if (ms) {
      ms.visits = (ms.visits || 0) + 1;
      if (maxDepthM > (ms.deepestM || 0)) ms.deepestM = Math.round(maxDepthM);
      ms.piles = pilesForSave();
      markDirty();
    }
    if (SM.particles.clearCollectorTarget) SM.particles.clearCollectorTarget();
    hideRunChrome();

    /* FUEL YOU DID NOT BURN IS STILL YOURS. It goes back into the tank rather
     * than evaporating at the surface, which is both what a player expects of a
     * fuel tank and what the prep screen's slider is built against: it sells
     * (capacity - what is aboard). Without this, coming up with 93% burnt left
     * `fuel` reading as the tank's contents on the next visit, so "total
     * refuel" bought the missing 7% and the next descent started on 7%.
     *
     * A dry strand leaves this at ~0 on its own, so there is nothing to special
     * case: run out of fuel and you genuinely have none left. */
    tank = fuel > 0 ? fuel : 0;
  }

  function pilesForSave() {
    var out = [];
    for (var i = 0; i < piles.length; i++) {
      var p = piles[i];
      out.push([Math.round(p[0]), Math.round(p[1]), p[2], p[3]]);
    }
    return out;
  }

  /** Build the results record. Allocation is fine: this runs once per descent. */
  function buildResults(kind, reason, gross) {
    var lines = [];
    for (var i = 0; i < manifest.length; i++) {
      var e = manifest[i];
      if (e.units <= 0) continue;
      lines.push({ matId: e.matId, matIndex: e.matIndex, units: e.units, value: e.value });
    }
    results = {
      kind: kind,
      reason: reason || '',
      mineId: runMineId,
      mineName: mineDef ? mineDef.name : '',
      /* WHICH LEVEL MAP IT HAPPENED ON. A strand drops the hold as piles on that
       * level and nowhere else, so "go back for it" is only actionable if the
       * screen can say WHERE — and with levels as separate maps, a depth in
       * metres no longer identifies a place on its own. */
      level: runLevel,
      levelName: levels[runLevel - 1] ? levels[runLevel - 1].name : '',
      depthM: depthM,
      maxDepthM: maxDepthM,
      runTime: runTime,
      gross: gross,
      cargoUnits: cargo,
      cargoCap: cargoCap,
      fuelLeft: fuel,
      fuelUsed: fuelAtEntry - fuel,
      integrity: hull / HULL_POINTS,
      day: day,
      lines: lines,
      /* THE SECURED LEDGER. `gross` above is the HOLD — what the machine is
       * carrying — and `secured` is what the rails already took off it. sell()
       * banks both, so the screen's total is gross + secured, and on a STRANDED
       * run `gross` is 0 while `secured` is the entire payout. That is exactly the
       * case the figure exists to show. */
      secured: secured.value,
      securedUnits: secured.units,
      securedLines: securedForResults()
    };
    return results;
  }

  /**
   * THE OLD EXTRACTION. NOTHING IN THE GAME CALLS THIS ANY MORE.
   *
   * It used to fire the instant the machine touched the mine mouth: reach the
   * surface, run over, results screen, sell. There is no mouth now — the surface
   * is UI and the doors are the only way out — and the door MENU replaced it with
   * four explicit verbs (sellAtDoor / refuelAtDoor / rideTo / leaveToMap), none
   * of which ends a run by contact.
   *
   * IT IS KEPT, EXPORTED AND WORKING, for exactly two reasons: it is strand()'s
   * sibling (same teardown, same results record, same 'extracted' shape the
   * results screen still reads), and it is the one verb that can bring a run to
   * the results screen from a console or a future path that wants that ending.
   * If you are looking for "how does a good run end" — it is leaveToMap().
   * -> results.
   */
  function escape() {
    if (state !== 'mine') return false;
    var gross = holdValue();
    teardownRun();
    buildResults('extracted', 'mouth', gross);
    setState('results');

    evExtracted.gross = gross;
    evExtracted.cargo = cargo;
    evExtracted.depthM = maxDepthM;
    evExtracted.reason = 'mouth';
    // ADDITION: what the rails secured on the way. `gross` still means the HOLD.
    evExtracted.secured = secured.value;
    SM.events.emit('adv:extracted', evExtracted);
    flushSave();
    return true;
  }

  /**
   * Out of fuel or hull: the cargo is left where it stands. -> results.
   * It is DROPPED, not deleted — one pile per material at the wreck — which is
   * what turns a bad run into a reason to come back rather than a punishment.
   */
  function strand(reason) {
    if (state !== 'mine') return false;
    var lost = holdValue();
    var vx = SM.vehicle.getX(), vy = SM.vehicle.getY();

    /* BUILD THE RESULTS FIRST, while the manifest still exists. The extraction
     * screen has to be able to say exactly what was left behind and where —
     * that itemised list is what turns a lost run into a plan to come back —
     * and buildResults() reads the hold, which the next two lines empty. */
    buildResults('stranded', reason || 'unknown', 0);
    results.lost = lost;

    for (var i = 0; i < manifest.length; i++) {
      var e = manifest[i];
      if (e.units <= 0) continue;
      dropPile(e.matIndex, e.units * STRAND_RECOVERY, vx, vy);
    }
    clearHold();

    // AFTER the piles are dropped: teardownRun() is what writes them into the
    // save record, so it has to see the full set.
    teardownRun();
    setState('results');

    evStranded.reason = reason || 'unknown';
    evStranded.depthM = depthM;
    evStranded.lost = lost;
    /* ADDITION, and the whole point of a deposit checkpoint: `lost` is the HOLD
     * and it is gone, `secured` is what the rails put beyond reach of this. */
    evStranded.secured = secured.value;
    SM.events.emit('adv:stranded', evStranded);
    flushSave();
    return true;
  }

  /** Give up the descent from the pause menu; same cost as a strand. */
  function abort() {
    if (state !== 'mine') return false;
    return strand('abort');
  }

  /**
   * main.js hands R / input:restart here.
   *
   * A DO-OVER, NOT A STRAND. The tank goes back to what the player paid for,
   * the hold is emptied without dropping piles and the day does not advance —
   * an accidental R must not cost a company money, and a deliberate one is the
   * "that descent went wrong immediately" reset every arcade build needs.
   * Refused outside a run, because on a meta screen R would otherwise rebuild
   * the classic time-attack world under the world map.
   */
  function restart() {
    if (state !== 'mine' && state !== 'results') return false;
    var id = runMineId;
    var refill = tankPaid;
    var lvl = runLevel;
    if (state === 'mine') teardownRun();
    clearHold();
    piles.length = 0;
    setState('prep');
    tank = refill;
    /* SAME LEVEL, SAME TANK, NO CHARGE. A do-over has to be free, so the
     * automatic full tank is suppressed: `refuel:false` leaves the tank at
     * exactly what the run launched with, even when that was a part tank the
     * company could not afford to fill. And it starts from the station the run
     * started from rather than the deepest one owned, because R means "that
     * descent went wrong immediately", not "take me somewhere else". */
    return enterMine(id, { level: lvl, refuel: false });
  }

  /* =====================================================================
   * UPDATE
   * ================================================================== */
  function update(dt) {
    if (state !== 'mine') return;

    runTime += dt;

    /* --- THE LIFT: driving in, and being in ---------------------------
     * Cheapest possible: one point-in-region test per step, and while inside,
     * two assignments that keep the machine parked in the cage. Entry is by
     * CONTACT (that is the whole feel of it — you drive into the doors and you
     * are gone), so it needs the arming rule: the machine must have been outside
     * the cage at least once since it was last put in one, or exitLift() would
     * hand you straight back to the menu you just dismissed.
     * ------------------------------------------------------------------ */
    if (inLift) {
      /* PARKED, NOT PAUSED. Time passes, heat sheds, the world streams — the
       * machine simply cannot be driven, cut with or burn fuel while it is in a
       * cage. Clearing the stick each step is what stops a held joystick from
       * pouring drive input into a machine nobody can see. */
      if (SM.input && SM.input.clearStick) SM.input.clearStick();
      parkAtDoor();
    } else if (SM.vehicle) {
      var inside = inDoorInterior(SM.vehicle.getX(), SM.vehicle.getY());
      if (!liftArmed) { if (!inside) liftArmed = true; }
      else if (inside) enterLift('drive');
    }

    /* --- depth ------------------------------------------------------- */
    var vy = SM.vehicle.getY();
    depthM = (vy - A.MINE_CEILING_Y) * A.METERS_PER_UNIT;
    if (depthM < 0) depthM = 0;
    if (depthM > maxDepthM) maxDepthM = depthM;

    /* --- the scanner --------------------------------------------------
     * main.js's step order has no slot for it — adv.js is the adventure
     * director, so the instrument runs from here and pays for itself out of
     * the same tank as everything else.
     * ------------------------------------------------------------------ */
    var scanDraw = 0;
    if (SM.scanner && SM.scanner.update) {
      SM.scanner.update(dt);
      if (SM.scanner.getDraw) {
        var d = SM.scanner.getDraw();
        if (d > 0) scanDraw = d;
      }
    }
    // A fitted scanner that reports no draw is a scanner module that has not
    // implemented getDraw() yet — charge rig.js's rate for it so the fuel
    // budget stays honest, and defer to the instrument the moment it speaks.
    if (scanDraw <= 0 && rigNum('getScanRange', 0) > 0) {
      scanDraw = rigNum('getScanBurn', 0);
    }

    /* --- standing fuel draw ------------------------------------------
     * The always-on part of rig.js's published budget. Driving and drilling are
     * vehicle.js's to report, because it is the only module that knows the duty
     * cycle it actually ran this step.
     *
     * EXCEPT THAT A PARKED MACHINE BURNS NOTHING. This used to run every step
     * regardless, so standing still to read the manifest, weigh up a dump, or
     * just look at where the scanner is pointing quietly cost fuel — and fuel is
     * the resource the whole mode is about. That taxes THINKING, which is the
     * one activity a game about risk decisions should never charge for. Idling
     * is now free, so the tank measures how far you have DRIVEN and how much
     * rock you have CUT, which is what the player can actually reason about.
     *
     * "Working" is deliberately generous: a centred stick and a hull that has
     * come to rest and a bit that is not in rock. Anything else bills as normal,
     * so this cannot be exploited by feathering the stick — coasting still burns.
     * ------------------------------------------------------------------ */
    if (isWorking()) {
      var standing = rigNum('getIdleBurn', FALLBACK_IDLE_BURN)
                   + rigNum('getLightBurn', FALLBACK_LIGHT_BURN)
                   + rigNum('getCoolBurn', 0)
                   + scanDraw;
      burnFuel(standing * dt);
    }

    // Smoothed needle. burnAccum is filled by every burnFuel() call this step,
    // including the ones vehicle.js made for driving and drilling.
    var inst = burnAccum / dt;
    burnRate += (inst - burnRate) * (1 - Math.exp(-4 * dt));
    burnAccum = 0;

    /* --- heat --------------------------------------------------------
     * Ambient is the soft depth gate; drilling heat arrives through addHeat().
     * ------------------------------------------------------------------ */
    var layer = currentLayer();
    var cutting = !!(SM.vehicle.isCutting && SM.vehicle.isCutting());
    var ambient;
    if (SM.mines && SM.mines.heatGainRate && layer) {
      // The shared model: ambient for the layer, plus the drill's own
      // contribution while it is removing hardness.
      ambient = SM.mines.heatGainRate(layer.heat, cutting);
    } else {
      ambient = (depthM / 1000) * HEAT_PER_KM;
      if (layer && typeof layer.heat === 'number') {
        var la = layer.heat * HEAT_AMBIENT_MAX;
        if (la > ambient) ambient = la;
      }
    }
    heat += (ambient - rigNum('getHeatShed', FALLBACK_HEAT_SHED)) * dt;
    if (heat < 0) heat = 0;
    /* AT the cap, not PAST it. addHeat() already clamps, so a machine pinned at
     * the ceiling by drilling heat would otherwise sit there taking no damage
     * at all whenever ambient happened to be below what cooling sheds — which
     * is most of the game. `>=` is what makes "at the cap the hull burns" true. */
    if (heat >= heatCap) {
      heat = heatCap;
      damage(OVERHEAT_DPS * dt, 'heat');
      // damage() can end the run outright (hull 0 -> strand), and everything
      // below this line is run bookkeeping that has no meaning once it has.
      if (state !== 'mine') return;
    }
    var hp = (heatCap > 0 ? heat / heatCap : 0) * 100 | 0;
    if (hp !== heatPctSent) {
      heatPctSent = hp;
      evHeat.pct = heatCap > 0 ? heat / heatCap : 0;
      SM.events.emit('adv:heat', evHeat);
    }

    /* --- fuel warnings and the dry strand ---------------------------- */
    var pct = getFuelPct();
    while (warnIndex < FUEL_WARN.length && pct <= FUEL_WARN[warnIndex]) {
      warnIndex++;
      evFuelLow.pct = pct;
      SM.events.emit('adv:fuellow', evFuelLow);
    }
    /* YOU CANNOT STRAND INSIDE THE LIFT. Being in the cage IS being at the
     * surface end of it: REFUEL is one tap away, so is SELL, and MAP always
     * works — so a dry tank in here is a decision to make, not a run to end. The
     * timer does not even start, which also means a player who limps into the
     * doors on fumes is safe the moment the doors close. (No soft-lock: with no
     * money and no ore, MAP still leaves.) */
    if (fuel <= 0 && !inLift) {
      if (dryTimer < 0) dryTimer = 0;
      dryTimer += dt;
      // The machine is already limp — vehicle.js sees an empty tank — so this
      // is purely the beat between the engine dying and the screen coming up.
      if (dryTimer >= DRY_GRACE) { strand('fuel'); return; }
    } else if (dryTimer >= 0) {
      dryTimer = -1;                    // a dump-and-refuel is not a thing, but
    }                                   // a fuel pile pickup could be one day

    /* --- THE DOORS ARE NOT POLLED HERE ---------------------------------
     * This is where the old code armed the station cages and auto-extracted the
     * moment the machine touched the mouth. Both are gone: there is one door per
     * map, it does nothing on contact, and everything it offers is an explicit
     * tap in the door menu. The HUD asks getBoardable() on its own slow timer,
     * which is the right clock for a question about where the machine is parked —
     * so a fixed step that used to walk the station table now does nothing at
     * all. Do not re-add a contact action here; it is what the menu replaced.
     * ------------------------------------------------------------------ */
  }

  /** Inside the world transform, AFTER effects: scanner marks, then darkness. */
  function renderWorld(ctx) {
    if (SM.scanner && SM.scanner.render) SM.scanner.render(ctx);
    // The darkness composite falls on the terrain, the machine, the debris AND
    // the scanner overlay.
    if (SM.effects && SM.effects.renderDarkness) SM.effects.renderDarkness(ctx);
    /* ...and then the things that are genuinely LIGHTS draw on top of it. The
     * lift's red level boards live here: drawn under the darkness they were
     * crushed to near-black at starter lights, which defeated the one job a
     * level sign has. An LED board is a light source; light sources are exempt
     * from the dark. */
    if (SM.advterrain && SM.advterrain.renderLit) SM.advterrain.renderLit(ctx);
  }

  /* =====================================================================
   * RUN STATE — read by advhud.js, written by vehicle.js and update()
   * ================================================================== */
  /**
   * The mine currently in context: the one being dug, or — between runs — the
   * one the player has selected. Falling back to `selectedId` covers the case
   * where a company is loaded and a mine picked before mineDef has ever been set.
   */
  function getMine() {
    if (mineDef) return mineDef;
    return selectedId ? resolveMine(selectedId) : null;
  }
  function getRunTime() { return runTime; }
  function getDepthM() { return depthM; }
  function getMaxDepthM() { return maxDepthM; }

  /**
   * World units to THIS LEVEL'S DOOR, in a straight line.
   *
   * A map has exactly one exit now, so this is one subtraction and one sqrt —
   * and getReserveNeeded(), the HUD's HOME reading and its TURN BACK warning all
   * inherit the right meaning by doing nothing at all. It is also a smaller
   * number than the shaft era's, on purpose: the way out of a level is across
   * the level, never 900 m up a hole.
   *
   * Called every step by the reserve estimate: no allocation, no loop.
   */
  function getDistanceToExit() {
    if (!SM.vehicle) return 0;
    ensureLevels();
    var dx = SM.vehicle.getX() - lvMouthX;
    var dy = SM.vehicle.getY() - doorY();
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** The same distance in METRES, for gauges. */
  function getDistanceToExitM() { return getDistanceToExit() * A.METERS_PER_UNIT; }

  /**
   * The level you would run for, which is the one you are standing on: there is
   * no other way out of a map. Kept because the HUD and the old lift panel both
   * read it, and because "which exit is nearest" is still a question a future
   * multi-door level would have to answer.
   */
  function getExitLevel() { return runLevel; }

  function getFuel() { return fuel; }
  function getFuelCap() { return fuelCap > 0 ? fuelCap : 1; }
  function getFuelPct() { return fuelCap > 0 ? fuel / fuelCap : 0; }
  function getBurnRate() { return burnRate; }

  /**
   * Rough fuel needed to get home from here. Deliberately pessimistic: the
   * straight line is multiplied out for the tunnel you actually have to drive,
   * and the whole estimate carries a safety margin, because a reserve gauge
   * that is optimistic is worse than no gauge at all.
   */
  /**
   * Is the machine doing anything that should cost fuel?
   *
   * Three tests, cheapest first: is the player ASKING for movement, is the hull
   * still carrying speed, and is the bit in rock. All three feature-detected —
   * a partial build simply bills as it always did rather than handing out free
   * fuel it cannot account for.
   */
  function isWorking() {
    if (SM.input && SM.input.getMove) {
      if (SM.input.getMove().mag > IDLE_STICK) return true;
    }
    if (SM.vehicle && SM.vehicle.getVelX && SM.vehicle.getVelY) {
      var vx = SM.vehicle.getVelX(), vy = SM.vehicle.getVelY();
      if (vx * vx + vy * vy > IDLE_SPEED * IDLE_SPEED) return true;
    }
    if (SM.vehicle && SM.vehicle.isCutting && SM.vehicle.isCutting()) return true;
    return false;
  }

  function getReserveNeeded() {
    if (state !== 'mine') return 0;
    var speed = rigNum('getSpeed', SM.config.VEHICLE_SPEED);
    var seconds = (getDistanceToExit() * RESERVE_PATH) / (speed > 1 ? speed : 1);
    // rig.js exports getBurnEstimate() so that this warning and the prep
    // screen's fuel slider agree with the tank sizes instead of each inventing
    // its own coefficients. Coming home is mostly DRIVING, with the odd cut
    // through a collapsed stretch of your own tunnel: 0.25 drill / 0.95 drive.
    var draw;
    if (SM.rig && SM.rig.getBurnEstimate) draw = SM.rig.getBurnEstimate(0.25, 0.95);
    else {
      draw = rigNum('getIdleBurn', FALLBACK_IDLE_BURN)
           + rigNum('getLightBurn', FALLBACK_LIGHT_BURN);
      if (SM.vehicle && SM.vehicle.getDriveBurnRate) draw += SM.vehicle.getDriveBurnRate();
    }
    return seconds * draw * RESERVE_SAFETY;
  }

  function getCargo() { return cargo; }
  function getCargoCap() { return cargoCap > 0 ? cargoCap : 1; }
  function getCargoPct() { return cargoCap > 0 ? cargo / cargoCap : 0; }
  /** LIVE array [{matIndex, matId, units, value}], richest last. REUSED. */
  function getManifest() { return manifest; }

  /**
   * What ONE COLLECTED FRAGMENT of this material is worth, in dollars — 0 for
   * spoil nobody buys.
   *
   * Exists for js/effects.js, whose value popups were accumulating the CLASSIC
   * value baked into each particle at spawn. That has two problems underground:
   * dirt and stone popped a score they cannot earn, and ore popped a number that
   * did not match the price the hold and the extraction screen quote. Both are
   * answered by asking the run's own economy instead.
   *
   * O(1), no allocation: this is called from the `resource:collected` handler,
   * which is one of the two hottest events in the engine.
   */
  function fragValue(mi) {
    if (!unitPrice || !fragUnits) return 0;
    if (!(mi >= 0) || mi >= matCount) return 0;
    return unitPrice[mi] * fragUnits[mi];
  }

  function getHeat() { return heat; }
  function getHeatPct() { return heatCap > 0 ? heat / heatCap : 0; }
  function getIntegrity() { return hull / HULL_POINTS; }
  function getHullPoints() { return hull; }

  function getCash() { return cash; }
  function getDay() { return day; }
  function getCompany() { return companyName; }
  /** True while the tank is empty and the machine is coasting to its grave. */
  function isDry() { return dryTimer >= 0; }

  /* =====================================================================
   * WRITES — vehicle.js is the only caller of these
   * ================================================================== */

  /** Draw fuel. Returns the amount ACTUALLY drawn (0 when the tank is dry). */
  function burnFuel(units) {
    if (state !== 'mine' || !(units > 0)) return 0;
    var got = units < fuel ? units : fuel;
    if (got <= 0) { fuel = 0; return 0; }
    fuel -= got;
    if (fuel < 0) fuel = 0;
    burnAccum += got;
    return got;
  }

  function addHeat(points) {
    if (state !== 'mine' || !(points > 0)) return;
    heat += points;
    if (heat > heatCap) heat = heatCap;
  }

  /**
   * Chew the hull. `source` is optional and only travels in the event, so
   * advhud.js can say WHAT hit you ('heat', 'grind', 'cavein').
   */
  function damage(points, source) {
    if (!(points > 0) || hull <= 0) return;
    var soak = 1 + rigNum('getArmor', 0) * ARMOR_DIV;
    hull -= points / soak;
    if (hull < 0) hull = 0;

    // Rate gate: this is called every step by continuous wear. Announce on a
    // 1% change or on a real hit, never per tick.
    var pctI = (hull / HULL_POINTS * 100) | 0;
    if (pctI !== dmgPctSent || points >= 1) {
      dmgPctSent = pctI;
      evDamage.integrity = hull / HULL_POINTS;
      evDamage.source = source || '';
      SM.events.emit('adv:damage', evDamage);
    }
    if (hull <= 0 && state === 'mine') strand('hull');
  }

  /**
   * Offer a collected deposit. -> true if it fit, false if the hold is full.
   * HOT: called once per collected fragment. O(1), no allocation.
   */
  function offerCargo(mi) {
    if (state !== 'mine') return false;
    if (!slotOf || mi < 0 || mi >= matCount) return false;

    var price = unitPrice[mi];
    if (price <= 0 && !STORE_WORTHLESS) return true;   // spoil: out the back

    var u = fragUnits[mi];
    if (!(u > 0)) return true;

    /* CRAM IN WHAT FITS, rather than refusing anything that does not fit WHOLE.
     *
     * These two used to disagree, and the disagreement was a permanent loop.
     * vehicle.js shuts the collector off at 99.5% of capacity, but this refused
     * a deposit unless the entire fragment fitted — and a copper deposit is 2
     * units. With 1 unit of room the hold is only 97.9% full, so the collector
     * stayed on, swallowed the copper, had it refused, spat it onto the floor,
     * and swallowed it again: ore visibly raining out of the hopper and being
     * re-picked-up forever, with the tally ticking on every lap.
     *
     * Taking a partial fragment closes it at the source. The hold reaches
     * EXACTLY capacity, so the collector's own test trips, the radius goes to
     * zero and nothing is offered again. The sliver of value lost on the last
     * fragment is worth far less than a hopper that looks broken. */
    var room = cargoCap - cargo;
    if (room <= CARGO_EPS) {
      if (!cargoFullSent) {
        cargoFullSent = true;
        SM.events.emit('adv:cargofull', null);
      }
      return false;
    }
    if (u > room) u = room;
    cargo += u;

    var s = slotOf[mi];
    if (s < 0) s = addManifestEntry(mi);
    var e = manifest[s];
    e.units += u;
    e.value = e.units * price;

    if (cargoCap - cargo <= CARGO_EPS && !cargoFullSent) {
      cargoFullSent = true;
      SM.events.emit('adv:cargofull', null);
    }
    return true;
  }

  /**
   * Create the manifest row for a material. Rare (once per material per run),
   * so it may allocate and re-sort. Sorted by price so the HUD's "richest last"
   * ordering is stable no matter what order the ore arrived in.
   */
  function addManifestEntry(mi) {
    var mat = SM.materials ? SM.materials.get(mi) : null;
    manifest.push({
      matIndex: mi,
      matId: mat ? mat.id : ('mat' + mi),
      units: 0,
      value: 0,
      price: unitPrice[mi]
    });
    manifest.sort(function (a, b) { return a.price - b.price; });
    reindexManifest();
    return slotOf[mi];
  }

  function reindexManifest() {
    var i;
    for (i = 0; i < matCount; i++) slotOf[i] = -1;
    for (i = 0; i < manifest.length; i++) slotOf[manifest[i].matIndex] = i;
  }

  function clearHold() {
    manifest.length = 0;
    cargo = 0;
    cargoFullSent = false;
    if (slotOf) for (var i = 0; i < matCount; i++) slotOf[i] = -1;
  }

  function holdValue() {
    var v = 0;
    for (var i = 0; i < manifest.length; i++) v += manifest[i].value;
    return v;
  }

  /* --- cargo piles ---------------------------------------------------- */
  /** LIVE array of [x, y, matIndex, units]. advterrain.js reads this. */
  function getPiles() { return piles; }

  /** Tip the whole holding of one material onto the floor, here. */
  function dump(matIndex) {
    if (state !== 'mine' || !slotOf) return false;
    if (matIndex < 0 || matIndex >= matCount) return false;
    var s = slotOf[matIndex];
    if (s < 0) return false;
    var e = manifest[s];
    var units = e.units;
    if (units <= 0) return false;

    cargo -= units;
    if (cargo < 0) cargo = 0;
    manifest.splice(s, 1);
    reindexManifest();
    // Space again: re-arm the full warning so the next fill still announces.
    cargoFullSent = false;

    dropPile(matIndex, units, SM.vehicle.getX(), SM.vehicle.getY());
    return true;
  }

  function dropPile(matIndex, units, x, y) {
    piles.push([x, y, matIndex, units]);
    evDumped.matIndex = matIndex;
    evDumped.units = units;
    evDumped.x = x;
    evDumped.y = y;
    SM.events.emit('adv:dumped', evDumped);
    markDirty();
  }

  /** advterrain.js: this pile has been re-spawned as particles, forget it. */
  function consumePile(i) {
    if (i < 0 || i >= piles.length) return false;
    piles.splice(i, 1);
    markDirty();
    return true;
  }

  /* =====================================================================
   * THE LEDGER — advui.js drives these; nothing else moves money
   * ================================================================== */
  function canAfford(amount) { return cash >= amount; }

  function moveCash(delta, reason) {
    cash += delta;
    if (cash < 0) cash = 0;
    var r = saveRecord();
    if (r) { r.cash = cash; markDirty(); }
    evCash.cash = cash;
    evCash.delta = delta;
    evCash.reason = reason || '';
    SM.events.emit('adv:cash', evCash);
  }

  function buyRights(mineId) {
    if (state === 'mine') return false;
    var def = resolveMine(mineId);
    if (!def) return false;
    if (ownsRights(def.id)) return false;
    var price = def.price || 0;
    if (!canAfford(price)) return false;

    moveCash(-price, 'rights');
    rightsHeld[def.id] = true;
    if (SM.save && SM.save.setOwned) SM.save.setOwned(def.id, true);
    evRights.mineId = def.id;
    evRights.price = price;
    SM.events.emit('adv:rights', evRights);
    flushSave();
    return true;
  }

  /**
   * Buy fuel into the tank. Charges only for what actually FITS — a slider
   * that lets you pay for litres the tank cannot hold is a bug, not a lesson.
   */
  function buyFuel(units) {
    if (state === 'mine' || !(units > 0)) return false;
    var cap = rigNum('getFuelCap', 100);
    fuelCap = cap;
    var room = cap - tank;
    if (room <= 0) return false;
    if (units > room) units = room;

    var price = 1;
    if (SM.mines && SM.mines.fuelPrice) {
      var p = SM.mines.fuelPrice();
      if (typeof p === 'number' && p > 0) price = p;
    }
    /* ASK SM.mines FOR THE COST; never multiply it out here. fuelCost() rounds
     * UP, and 100 * 0.55 is 55.000000000000006 in binary floating point, so a
     * price computed independently of the one the prep screen quoted can differ
     * from it by a dollar — in the direction of overcharging the player. One
     * function, one answer. */
    var cost = quoteFuel(units, price);
    if (!canAfford(cost)) {
      // Buy what the money reaches rather than refusing outright: the prep
      // screen's slider is allowed to be optimistic. Whole units, so the
      // rounding-up in fuelCost() can never land above the cash on hand.
      units = Math.floor(cash / price);
      if (units < 1) return false;
      cost = quoteFuel(units, price);
      // Cash can be fractional after a sale; shave one unit if the ceil bit.
      if (cost > cash) { units -= 1; cost = quoteFuel(units, price); }
      if (units < 1 || cost > cash) return false;
    }
    tank += units;
    moveCash(-cost, 'fuel');
    return true;
  }

  /** Dollars for `units` of fuel, exactly as the prep screen quotes it. */
  function quoteFuel(units, price) {
    if (SM.mines && SM.mines.fuelCost) return SM.mines.fuelCost(units);
    return Math.ceil(units * price);
  }

  function getTank() { return tank; }

  function buyPart(partKey) {
    if (state === 'mine' || !SM.rig) return false;
    var cost = SM.rig.nextCost ? SM.rig.nextCost(partKey) : -1;
    if (!(cost >= 0)) return false;
    /* RUNNING GEAR BEFORE POWER. An engine the tracks cannot carry is refused
     * outright — rig.js owns the rule (fitCheck), this just enforces it, so the
     * money cannot move on a fitting that will not happen. Feature-detected:
     * an older rig.js without fitCheck simply has no prerequisites. */
    if (SM.rig.canFit && !SM.rig.canFit(partKey)) return false;
    if (!canAfford(cost)) return false;
    var tier = (SM.rig.getTier ? SM.rig.getTier(partKey) : 0) + 1;
    if (SM.rig.setTier) SM.rig.setTier(partKey, tier);

    moveCash(-cost, 'part');
    // NOT r.rig = SM.rig.getState() — js/save.js snapshots the rig itself in
    // flush(), and installs it in load()/newGame(). Two writers, one field, is
    // how a machine ends up half a tier behind its own save.
    markDirty();
    evRig.partKey = partKey;
    evRig.tier = tier;
    SM.events.emit('adv:rig', evRig);
    flushSave();
    return true;
  }

  /**
   * Repair the hull. Buys as many POINTS as the money reaches rather than
   * refusing a partial job — a broke player with a wrecked machine must always
   * have a way forward, even if it is a bad one.
   */
  function buyRepair() {
    if (state === 'mine') return false;
    var missing = HULL_POINTS - hull;
    if (missing <= 0.01) return false;
    var price = 1;
    if (SM.mines && SM.mines.repairPrice) {
      var p = SM.mines.repairPrice();
      if (typeof p === 'number' && p > 0) price = p;
    }
    /* UNITS TRAP: repairPrice() is dollars per point on a 0..100 scale while
     * getIntegrity() reports 0..1, so anything that multiplies the fraction by
     * the price is out by 100x. repairCost(frac) is the quoted price of the
     * whole job and is what the workshop shows, so a full repair is charged
     * exactly that; a partial one falls back to the per-POINT price. */
    var full = (SM.mines && SM.mines.repairCost)
      ? SM.mines.repairCost(hull / HULL_POINTS) : Math.ceil(missing * price);
    var points, cost;
    if (canAfford(full)) {
      points = missing;
      cost = full;
    } else {
      points = Math.floor(cash / price);
      if (points < 1) return false;
      cost = points * price;
      if (cost > cash) { points -= 1; cost = points * price; }
      if (points < 1) return false;
    }

    hull += points;
    if (hull > HULL_POINTS) hull = HULL_POINTS;
    moveCash(-cost, 'repair');
    var r = saveRecord();
    if (r) { r.integrity = hull / HULL_POINTS; markDirty(); }
    evDamage.integrity = hull / HULL_POINTS;
    evDamage.source = 'repair';
    SM.events.emit('adv:damage', evDamage);
    return true;
  }

  /**
   * Sell the extracted hold. Also the DAY ROLLOVER: one expedition is one day,
   * and it ticks when the company banks the run rather than when it starts one,
   * so an aborted descent is not a lost day on top of a lost hold.
   *
   * IT DOES NOT NAVIGATE. Selling used to step straight back to the world map,
   * which made "sell" and "leave" the same action and forced a trip through the
   * map to do the thing players do most: bank the load, top the tank up and go
   * back down the same hole. The extraction screen now stays put and offers
   * SELL / REFUEL / WORKSHOP / MAP as four separate one-tap choices.
   *
   * Selling twice is refused rather than merely empty, because the second call
   * would roll the day over again on a hold worth nothing.
   */
  function sell() {
    if (state !== 'results') return null;
    if (soldThisRun) return null;
    soldThisRun = true;
    /* ONE BANKING FUNCTION, TWO DOORS INTO IT. bankRun() is the only place a
     * run's ore becomes money, the day rolls and the lifetime stats are written;
     * this is the results screen's way in and sellAtDoor() is the door's. Two
     * copies of that arithmetic is how a ledger drifts.
     *
     * `requireValue` false: this screen's own once-per-run gate is above, and a
     * strand with nothing secured still has to be tappable without pretending
     * the sale was refused.
     *
     * Deliberately stays on 'results'. The screen repaints off `adv:sold` and
     * the player picks where to go next. */
    return bankRun('results', false);
  }

  /** True once this run's hold has been banked. The screen greys SELL out. */
  function isSold() { return soldThisRun; }

  /** The results payload for the extraction screen. Set by escape()/strand(). */
  function getResults() { return results; }

  /** vehicle.js: use free-roam 2D driving instead of the classic auto-advance. */
  function isDriving() { return state === 'mine'; }

  return {
    init: init,
    isActive: isActive,
    isInMine: isInMine,
    holdsSim: holdsSim,
    getState: getState,
    open: open,
    close: close,
    startCompany: startCompany,
    openMap: openMap,
    openGarage: openGarage,
    selectMine: selectMine,
    backToMap: backToMap,
    enterMine: enterMine,
    escape: escape,
    strand: strand,
    abort: abort,
    restart: restart,
    update: update,
    renderWorld: renderWorld,
    getMine: getMine,
    getRunTime: getRunTime,
    getDepthM: getDepthM,
    getMaxDepthM: getMaxDepthM,
    getDistanceToExit: getDistanceToExit,
    getFuel: getFuel,
    getFuelCap: getFuelCap,
    getFuelPct: getFuelPct,
    getBurnRate: getBurnRate,
    getReserveNeeded: getReserveNeeded,
    getCargo: getCargo,
    getCargoCap: getCargoCap,
    getCargoPct: getCargoPct,
    getManifest: getManifest,
    fragValue: fragValue,
    getHeat: getHeat,
    getHeatPct: getHeatPct,
    getIntegrity: getIntegrity,
    getCash: getCash,
    getDay: getDay,
    burnFuel: burnFuel,
    addHeat: addHeat,
    damage: damage,
    offerCargo: offerCargo,
    getPiles: getPiles,
    dump: dump,
    consumePile: consumePile,
    canAfford: canAfford,
    buyRights: buyRights,
    buyFuel: buyFuel,
    buyPart: buyPart,
    buyRepair: buyRepair,
    sell: sell,
    isSold: isSold,
    getResults: getResults,
    isDriving: isDriving,

    /* --- Agent-1 additions (safe to call; nothing above depends on them) --
     * getTank()       fuel bought but not yet descended with — the prep gauge
     * getHullPoints() integrity in the same points repairPrice() is quoted in
     * getCompany()    the company name, for the map header
     * isDry()         the tank is empty and the machine is coasting
     * ownsRights()    has this company bought into that mine
     * getFirstMineId() the starter mine, catalogue or fallback
     */
    getTank: getTank,
    getHullPoints: getHullPoints,
    getCompany: getCompany,
    isDry: isDry,
    ownsRights: ownsRights,
    getFirstMineId: firstMineId,

    /* --- THE LIFT: LEVELS AS MAPS (ARCHITECTURE.md §7) --------------------
     * getLevels()     LIVE band table for the mine in context, level 1 first:
     *                 [{i, name, depthTopM, depthBotM, price, widthU, owned}]
     *                 plus the extras depthM (= depthTopM) and y (band top, in
     *                 world units). NO SURFACE ENTRY. Empty with no mine.
     * getLevel()      the level map the run is ON (1-based)
     * getLevelDef(i)  one band entry by 1-based index, or null
     * buyLevel(i)     buy the NEXT unowned level (i >= 2; level 1 comes with the
     *                 rights). -> bool. Emits lift:bought. Legal from the map,
     *                 the prep screen AND the door menu. Does not move the
     *                 machine — ride to it.
     * rideTo(L)       change level map, hold intact, free. Only from the door
     *                 circle. Emits lift:ride {from,to} BEFORE the swap.
     * getBoardable()  this level's index while the machine is in the DOOR CIRCLE
     *                 (proximity — this is what makes advterrain's doors open),
     *                 else -1. No arming: the menu replaced auto-extraction.
     * isAtDoor()      the same question as a bool
     * isInLift()      the machine has driven INTO the cage: it is hidden
     *                 (js/vehicle.js reads this), it cannot be driven, and the
     *                 DOOR MENU is up. True on arrival from a descent or a ride.
     * exitLift()      roll out: re-park below the doors and give control back.
     *                 Also what dismissing the door menu means.
     * lift:entered {level, reason}  / lift:exited {level}   are the events
     * getDoorX/Y()    door centre (aliases of getStationX/Y, which js/vehicle.js
     *                 already reads)
     * sellAtDoor()    bank hold + secured, roll the day, stay in the mine.
     *                 -> the sale record, or null when there was nothing to sell
     * refuelAtDoor()  fill the tank at the SURFACE price. -> {units, cost}|null
     * getDoorFuelQuote()  REUSED {units, cost} for what that fill would cost
     * leaveToMap()    end the expedition: banks anything aboard, then -> map
     * getDistanceToExitM()  getDistanceToExit() in metres, for gauges
     * getExitLevel()  the level you would run for (= getLevel(): one door)
     * ownedLevels(id) how many levels this company holds in a mine, level 1
     *                 included — so it is >= 1 for any mine with rights
     */
    getLevels: getLevels,
    getLevel: getLevel,
    getLevelDef: getLevelDef,
    buyLevel: buyLevel,
    rideTo: rideTo,
    getBoardable: getBoardable,
    isAtDoor: isAtDoor,
    isInLift: isInLift,
    exitLift: exitLift,
    getStationX: getStationX,
    getStationY: getStationY,
    getDoorX: getDoorX,
    getDoorY: getDoorY,
    sellAtDoor: sellAtDoor,
    refuelAtDoor: refuelAtDoor,
    getDoorFuelQuote: getDoorFuelQuote,
    leaveToMap: leaveToMap,
    getDistanceToExitM: getDistanceToExitM,
    getExitLevel: getExitLevel,
    ownedLevels: ownedLevels,

    /* --- THE RAILS -----------------------------------------------------
     * getCheckpoints(L)     LIVE [{k, outM, x, y, price, owned}] for level L of
     *                       the mine in context, k >= 1 and outward. Empty for
     *                       the surface and for an invalid level. Returned for
     *                       levels the company does not own, all `owned` false.
     * buyCheckpoint(L, k)   buy the NEXT unowned checkpoint outward on level L.
     *                       -> bool. Emits rail:bought. Legal from the map, the
     *                       prep screen AND from inside the mine. Refuses unless
     *                       the LEVEL is owned.
     * getServiceable()      {level, k} of the checkpoint cage the machine is
     *                       standing in, else null. REUSED object.
     * refuelHere()          full-tank top-up at SM.mines.railFuelMarkup();
     *                       charges what the cash reaches. Emits rail:fuel.
     * depositHere()         move the whole hold into the SECURED ledger. Emits
     *                       rail:deposit. The hold is then empty and refillable.
     * getSecured()          {value, units} secured this run. REUSED object.
     * getSecuredLines()     LIVE per-material breakdown of the same. REUSED.
     * ownedCheckpoints(id, L)  how many checkpoints are owned on that level
     */
    getCheckpoints: getCheckpoints,
    buyCheckpoint: buyCheckpoint,
    getServiceable: getServiceable,
    refuelHere: refuelHere,
    depositHere: depositHere,
    getSecured: getSecured,
    getSecuredLines: getSecuredLines,
    ownedCheckpoints: ownedCheckpoints
  };
})();
