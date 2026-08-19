/* =============================================================================
 * SUPERMINE ADVENTURE — js/camera.js
 * -----------------------------------------------------------------------------
 * Omnidirectional follow camera with a velocity lead, fixed framing, zoom
 * punches and trauma-based shake (translation + a whisper of roll).
 *
 * >>> THE ZOOM IS A CONSTANT, AND THEN A FIT. <<<
 * There used to be a DERIVED zoom here — a product of the rig's width, the
 * zone it was in and whether overdrive was running — because the time-attack
 * machine grew from 140 units wide to 520 over a single run and the camera had
 * to pull back with it. Nothing about the campaign works that way. ADV.CAM_ZOOM
 * is a shared, frozen constant that the light radius, the streaming window and
 * the joystick scale are all tuned against, so it is not the camera's to have
 * an opinion about; the whole derived stack, and `setZoomTarget()` with it, is
 * gone. Zoom PUNCH still lands, because that is impact feedback, not framing.
 *
 * What the constant cannot do alone is fit a phone, so recomputeScale() runs a
 * portrait fit (reduce-only) on top of it, against an ABSOLUTE working width.
 * The per-level fill floor that used to sit beside it is gone with the walls it
 * framed — a level map is endless east and west now. See the tunables note.
 *
 * NO SLOW MOTION: main.js has no timescale hook. Big moments are sold with
 * punch + shake + effects.screenFlash instead.
 *
 * THE CAMERA ALSO SIZES THE MATERIAL TABLE.
 * How much world is on screen is a camera decision, and it is what decides how
 * many deposits the fixed 7500-particle pool has to cover. The budget is solved
 * HERE, once at load (solveWorldDensity), and handed to materials.js so value
 * and hardness per deposit can be scaled to match. THE MINE'S ECONOMY AND ROCK
 * HARDNESS BOTH DEPEND ON THAT CALL — js/adv.js reads the rebalanced hardness
 * and unit prices straight out of the table. The solve's own arithmetic is
 * phrased in the old lane's terms (it always was; that is what it was measured
 * against) and is left exactly as it was rather than re-derived, because
 * re-baselining it silently repays every mine in the game. Do not "tidy" it.
 *
 * Public API (main.js depends on these signatures — do not change them):
 *   SM.camera.init()
 *   SM.camera.update(dt)
 *   SM.camera.applyTransform(ctx)
 *   SM.camera.shake(strength)        ~3 = rumble, ~35 = big hit
 *   SM.camera.getZoom() / getScale() / getX() / getY()
 *   SM.camera.getViewBounds()        REUSED object
 *   SM.camera.worldToScreen(x,y) / screenToWorld(x,y)   REUSED object
 *   SM.camera.setViewport(w,h)
 *   SM.camera.reset()
 * Additions: punch(a), shakeFloor(s), getTrauma(),
 *            getWorldSpacing(), getMaxViewHeight()
 * ========================================================================== */

var SM = SM || {};

SM.camera = (function () {
  'use strict';

  /* =====================================================================
   * PRESENTATION TUNABLES
   * ================================================================== */

  /* --- THE DENSITY SOLVE ------------------------------------------------
   * Everything from here down to solveWorldDensity() is ONE system, and it is
   * the only survivor of the old lane-based framing. It does not frame
   * anything any more — recomputeScale() no longer calls widestScaleFor() —
   * but its answer is handed to materials.js, which rewrites value and
   * hardness per deposit against it, and the campaign's whole economy is
   * priced on the result. It is kept verbatim for that reason. The constants
   * below are the geometry it was MEASURED against, not a description of the
   * world the player now drives in.
   * ------------------------------------------------------------------ */

  // How much bedrock wall the old lane framing was willing to show on EACH
  // side before refusing to zoom out further. Now only an input to the solve.
  var MAX_WALL_VISIBLE = 300;

  /* --- LANE FIT vs TERRAIN DENSITY (the portrait/mobile problem) --------
   * `scale` used to be normalised on HEIGHT alone, which is fine on any
   * landscape screen and quietly disastrous on a portrait one: measured at
   * 390x844 only 34% of the 1280-unit lane was on screen, so both halves of a
   * paired gate could not be seen at once and the walls never appeared.
   *
   * LANE_FIT_MARGIN caps the scale so the whole lane, plus a sliver of wall
   * on each side, fits across the viewport. 40 units a side reads as "there
   * IS a wall there" without wasting screen: portrait lands at 1360/1280 =
   * 106% of the lane.
   *
   * THE REASON THAT WAS NOT ENOUGH ON ITS OWN
   * Fitting 1280 units into a 390px-wide screen means showing ~2940 units of
   * world HEIGHT, and terrain.js streams the FULL visible height. At the
   * authored grid pitch of 19 that is ~11 600 deposits against a 7500
   * particle pool: streaming runs dry, generateBand() starts refusing, and
   * the world comes out full of holes. The previous fix bounded the fit with
   * a flat MAX_VIEW_HEIGHT of 1500 and a portrait phone got about half the
   * lane — better than a third, still not the lane.
   *
   * WHAT WE DO INSTEAD
   * Stop treating the grid pitch as a constant. There is really only one
   * equation here — deposits = laneWidth * streamedHeight / spacing^2 — and
   * three knobs in it, so pick the two that matter (the whole lane is
   * visible; the pool is never starved) and SOLVE FOR SPACING. A portrait
   * phone gets a coarser, chunkier mine; a desktop is untouched because at a
   * landscape aspect the solve lands below the authored pitch and clamps.
   *
   * Roughly 82% of grid cells actually produce a deposit — pockets carve
   * voids, corridor floors and barrier doorways are open, gates are carved
   * out — measured as 3839 live solids against 4641 cells at 1280x800 and
   * 5354 against 6524 at 390x844, i.e. 0.827 and 0.821. CELL_BUDGET is
   * therefore counted in CELLS, and 7200 of them is ~5900 live deposits:
   * that leaves ~1500 pool slots against a bandBudget() demand of ~900
   * (DEBRIS_RESERVE 700 plus one band), so a heavy debris torrent slows
   * streaming rather than stopping it, ~1600 units in front of the machine
   * where nobody can see it happen.
   *
   * SPACING_MIN is terrain.js's authored 19 — the world never gets FINER
   * than it is today, only coarser. SPACING_MAX 30 is where a deposit
   * (diameter 22 at most, SPRITE_MAX_RADIUS being 11 and frozen) stops
   * reading as packed ground and starts reading as scattered pebbles;
   * viewports narrow enough to want more than that get the old bounded fit
   * back instead. Spacing is rounded UP to SPACING_STEP so the rounding
   * error is always spent on pool headroom.
   *
   * THE SOLVE RUNS ONCE, AT LOAD, AND IS THEN LATCHED — see solveWorldDensity().
   * ------------------------------------------------------------------ */
  var LANE_FIT_MARGIN = 40;      // world units of wall to keep beside the lane
  var CELL_BUDGET     = 7200;    // grid cells we can afford to stream at once
  var SPACING_MIN     = 19.0;    // terrain.js's authored pitch; never go finer
  var SPACING_MAX     = 30.0;    // beyond this the ground reads as scattered
  var SPACING_STEP    = 0.5;

  // A viewport whose short side is this or less belongs to something you can
  // physically turn over. See viewportCanRotate().
  var ROTATABLE_MAX_SHORT_SIDE = 900;

  var worldSpacing = SPACING_MIN;   // solved once, handed to materials.js
  var budgetViewHeight = 1500;      // tallest world view the solved grid fills

  /* --- end of the density solve's constants ------------------------------ */

  // Zoom punch: instantaneous, decays fast, applied on top of the smoothed
  // base. The only caller left is the ram lurch in vehicle.js.
  var PUNCH_DECAY      = 7.5;
  var PUNCH_MAX        = 0.28;

  // Shake. Trauma is squared for the amplitude, so small values stay subtle.
  //
  // TWO KINDS OF SHAKE, and the distinction is the whole reason this does not
  // saturate. `shake()` is ADDITIVE and belongs to rare, discrete moments.
  // `shakeFloor()` only RAISES trauma to a level and is used for anything that
  // can repeat every single step — impact:heavy fires up to 60x/second while
  // drilling dense rock, and accumulating that pins the camera at max trauma
  // forever. A floor gives a steady rumble that discrete hits still punch
  // through, and it can never run away.
  //
  // Note that vehicle.js also calls shake() directly on the ram lurch and the
  // stall. The values below are deliberately modest so the SUM stays inside a
  // sensible range.
  var SHAKE_ROLL_MAX       = 0.011;  // radians at full trauma (~0.63 deg)
  var SHAKE_TRAUMA_CAP     = 1.25;
  var SHAKE_EVENT_HEAVY    = 16;     // FLOOR at impact:heavy strength 1
  var SHAKE_EVENT_HEAVY_MIN = 2.2;
  var SHAKE_GRIND_GAIN     = 5.0;    // continuous rumble from cutter resistance

  /* =====================================================================
   * FRAMING TUNABLES
   * ---------------------------------------------------------------------
   * The campaign asks the camera three different questions and everything
   * below exists to answer them:
   *
   * 1. THE ZOOM IS FIXED, AND THEN FITTED. ADV.CAM_ZOOM is a shared, frozen
   *    constant the whole game is framed around, so desiredZoom() simply
   *    returns it. Zoom PUNCH still lands, because that is impact feedback,
   *    not framing.
   *
   *    But a constant alone is wrong on a phone, and this mode is thumb-driven.
   *    ADV.CAM_ZOOM normalises on HEIGHT (like the classic zoom), so a 390x844
   *    portrait viewport lands at scale 0.75 and shows about 520 of the shaft's
   *    1760 units — under a third of the width the player is steering around in.
   *    So the adventure scale is additionally FITTED: never so zoomed in that
   *    less than ADV_FIT_SHAFT of the shaft is across the screen. It can only
   *    ever zoom OUT from the tuned value, so desktop framing is untouched
   *    (measured: 1440x813 stays at 0.723, exactly as before), while portrait
   *    settles near 0.49 and shows ~790 units — about the diameter of the
   *    starting headlamp, which is the most of the mine a phone can usefully
   *    light anyway.
   *
   * 2. THE LOOK-AHEAD HAS TO ROTATE. The classic lead is hard-coded to -y
   *    because the classic machine only ever drives that way. Here the player
   *    picks the direction, so the lead is a VECTOR along the velocity, eased
   *    as a vector so that turning around swings the framing instead of
   *    snapping it. It is expressed as a fraction of the visible half-height
   *    for the same reason the classic one is: framing that survives a resize.
   *
   * 3. recomputeScale() HAS NO WIDTH TO SOLVE AGAINST ANY MORE, and that is a
   *    simplification rather than a loss. It used to carry two clamps written
   *    against LANE_HALF_WIDTH (640) which fought the shaft in opposite
   *    directions. Both are gone:
   *      * the lane-FIT ceiling ("never so zoomed in that the lane runs off the
   *        sides") was always wrong underground — the world is MEANT to run off
   *        the sides, you are in a tunnel, not a lane — and forcing it across a
   *        390 px phone would zoom to 0.21, put the machine on screen at eight
   *        pixels and multiply the streamed area by twenty. The adventure branch
   *        never applied it.
   *      * the lane-FILL floor stopped bedrock showing beside the walls. There
   *        are no walls: a level map is endless east and west (ARCHITECTURE.md
   *        §7), so what that clamp enforced is true by construction.
   *    What is left is ADV_FIT_WIDTH and an absolute floor — an ABSOLUTE working
   *    width, in world units, which is what the rule was always protecting.
   * ================================================================== */

  /* WORKING WIDTH, IN WORLD UNITS — the whole of the framing solve, and the one
   * number every device is framed by.
   *
   * It was once "0.45 of the shaft's width", which only worked while the shaft
   * was narrower than a screen: a fraction-of-the-world fit means every extra
   * metre of world zooms the player further out to frame walls nowhere near
   * them, and at 2600 half-width it drove desktop scale from 0.72 to 0.615 and
   * portrait to 0.167. On a world that is now endless in both directions the
   * fraction is not merely wrong, it has no value at all.
   *
   * What the rule was always protecting is "enough ground across the screen to
   * drive and aim", which is an ABSOLUTE distance. 792 is exactly 0.45 x the
   * original 1760-wide shaft, so every device frames the game precisely as it
   * always did. */
  var ADV_FIT_WIDTH = 792;
  // ...and a hard floor, so a freak viewport cannot zoom out into abstraction.
  // At 0.30 the starting machine is still ~45 px wide.
  var ADV_MIN_SCALE = 0.30;
  // Lead, as a fraction of the visible half-height, at full drive speed.
  var ADV_LEAD_FRAC = 0.20;
  var ADV_LEAD_LERP = 2.0;
  /* HOW MUCH BEDROCK MAY SHOW BEYOND THE LEVEL'S ONE EDGE. Keeping the camera
   * inside this means the ceiling reads as the edge of the world rather than as a
   * place the view falls off — and showing SOME of it is the point: a level whose
   * roof you have seen is a level you understand the shape of.
   *
   * THERE USED TO BE TWO OF THESE and they covered four edges. A level map is
   * endless east, west and south now, so there is nothing to peek past in three
   * directions and ADV_WALL_PEEK is gone with them. The surviving figure is
   * inherited from ADV_SKY_PEEK, the daylight allowance over the old mine mouth,
   * and it is generous on purpose: the machine spends the start and the end of
   * every run parked under the ceiling, and a camera that stopped a screen short
   * of it would frame the lift against nothing. */
  var ADV_EDGE_PEEK = 420;
  /* How far off the view centre the machine may ever be pushed by the peek above,
   * as a fraction of the visible half-extent. The machine drives right up to the
   * ceiling, so the edge clamp and the follow are in direct conflict there — see
   * the note in updateAdvFollow() for the measurement and for why this one wins. */
  var ADV_WALL_OFFSET = 0.34;

  /* THE ACTIVE LEVEL'S EXTENT, or null (a world module older than this file).
   * REUSED by js/advterrain.js — read it, never stash a field of it.
   *
   * `botY` and `halfW` are Infinity: the map is endless east, west and south
   * (ARCHITECTURE.md §7), so the only finite edge is the ceiling and that is what
   * the guard tests. */
  function advBounds() {
    if (SM.advterrain && SM.advterrain.getLevelBounds) {
      var b = SM.advterrain.getLevelBounds();
      if (b && isFinite(b.topY)) return b;
    }
    return null;
  }

  /* ================================================================== */

  var C = SM.config;
  var A = SM.config.ADV;

  var advLeadX = 0, advLeadY = 0;

  var x = 0, y = 0;                 // camera centre in world space
  var zoomBase = A.CAM_ZOOM;        // smoothed, punch-free
  var zoom = A.CAM_ZOOM;            // what everything else sees

  var punch = 0;

  var trauma = 0;                   // 0..SHAKE_TRAUMA_CAP, decays exponentially
  var shakeX = 0, shakeY = 0, shakeRot = 0;
  var shakeTime = 0;

  var vpW = 1, vpH = 1;             // CSS pixels
  var scale = 1;                    // combined zoom * resolution factor

  var boundsOut = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  var pointOut = { x: 0, y: 0 };

  var subscribed = false;

  /* =====================================================================
   * WORLD DENSITY  (the material-balance solve — read the note by the tunables)
   * ================================================================== */

  /**
   * Can this viewport swap its width and height while the page is open?
   * It matters because the density solve is LATCHED (see below): a phone must
   * be sized for the orientation it is worst in, or rotating mid-run would
   * change the grid underneath an economy that can no longer follow.
   *
   * `pointer: coarse` is the honest signal and is all a phone or tablet needs.
   * maxTouchPoints is the fallback for browsers that do not report it, gated
   * on the short side of the viewport so that a touch-screen LAPTOP — which
   * has fingers but does not get turned over — is not quietly given a
   * portrait phone's grid on a 1080-tall screen.
   */
  function viewportCanRotate() {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
    var short = Math.min(window.innerWidth || 0, window.innerHeight || 0);
    return (navigator.maxTouchPoints | 0) > 0 && short > 0 && short <= ROTATABLE_MAX_SHORT_SIDE;
  }

  /**
   * The SMALLEST scale (= widest view) the OLD lane framing could legally
   * settle on for a given viewport. It ran the same three clamps the classic
   * recomputeScale() did, in the same order, because anything else would have
   * been sizing the grid for a view the camera never actually showed.
   *
   * The camera no longer frames anything this way, but this is the function
   * the material table was balanced through. Changing it repays every mine.
   */
  function widestScaleFor(w, h) {
    // Furthest out the zoom logic itself can go (update() clamps zoom to
    // CAM_ZOOM_MIN * 0.9), then the lane-fit ceiling, then the lane-fill floor.
    var s = C.CAM_ZOOM_MIN * 0.9 * (h / C.CAM_REFERENCE_HEIGHT);
    var fit = w / (C.LANE_HALF_WIDTH * 2 + LANE_FIT_MARGIN * 2);
    if (s > fit) s = fit;
    var lo = w / (C.LANE_HALF_WIDTH * 2 + MAX_WALL_VISIBLE * 2);
    if (s < lo) s = lo;
    return s;
  }

  /**
   * Solve `deposits = laneWidth * streamedHeight / spacing^2` for spacing,
   * then hand the answer to materials.js so value and hardness per deposit
   * can be scaled to match. RUN ONCE, FROM THE MODULE BODY (see the call at
   * the bottom of this file), and never again.
   *
   * WHY ONCE, when the brief for this was "recompute on orientationchange"?
   * Because the economy cannot follow. particles.js bakes value and hardness
   * into flat typed arrays in buildMaterialCache(), that runs in
   * particles.init(), and nothing rebuilds it — so a grid that changed on
   * rotation would be paying out at whatever density the page happened to
   * load in. The fix is to make the answer ORIENTATION-INVARIANT instead: on
   * anything that can rotate we solve for the portrait orientation, which is
   * always the demanding one, and a phone then has the same mine, the same
   * money and the same rock whichever way up it is held.
   *
   * That leaves one loose end — a DESKTOP window dragged from landscape to a
   * narrow portrait shape, which no longer qualifies for the rotation
   * treatment. Nothing breaks: budgetViewHeight is the tallest view the
   * SOLVED grid can fill, recomputeScale() refuses to fit past it, and such a
   * window simply gets the old bounded fit (less than the full lane) rather
   * than a starved pool and a world full of holes. A reload gives it the
   * full lane back.
   */
  function solveWorldDensity() {
    var w = window.innerWidth || 1;
    var h = window.innerHeight || 1;
    if (viewportCanRotate()) {
      var shortSide = w < h ? w : h;
      var longSide = w < h ? h : w;
      w = shortSide; h = longSide;              // solve for portrait
    }

    var rawH = h / widestScaleFor(w, h);
    var laneW = C.LANE_HALF_WIDTH * 2;
    var streamH = rawH + C.STREAM_VIEW_MARGIN * 2;   // terrain streams past the edge

    var sp = Math.sqrt(laneW * streamH / CELL_BUDGET);
    sp = Math.ceil(sp / SPACING_STEP) * SPACING_STEP;   // round UP: spend it on headroom
    if (sp < SPACING_MIN) sp = SPACING_MIN;
    if (sp > SPACING_MAX) sp = SPACING_MAX;
    worldSpacing = sp;

    // How tall a view that grid can actually fill. Equal to rawH except when
    // SPACING_MAX bit, and that is exactly when the fit has to be bounded.
    var affordableH = CELL_BUDGET * sp * sp / laneW - C.STREAM_VIEW_MARGIN * 2;
    budgetViewHeight = rawH < affordableH ? rawH : affordableH;

    if (SM.materials && SM.materials.applyWorldDensity) {
      SM.materials.applyWorldDensity(sp, SPACING_MIN);
    }
  }

  /* =====================================================================
   * SETUP
   * ================================================================== */
  function init() {
    if (!subscribed) {
      subscribed = true;
      // ALL shake lives here. effects.js deliberately does not call shake().
      // FLOOR, not accumulation: this event repeats every step while mining.
      SM.events.on('impact:heavy', function (p) {
        shakeFloor(SHAKE_EVENT_HEAVY_MIN + (p && p.strength ? p.strength : 0) * SHAKE_EVENT_HEAVY);
      });
      /* ONE SUBSCRIPTION LEFT. The others were all time-attack ceremony —
       * upgrade applied, gate passed, zone entered, overdrive, level complete —
       * and every one of them is an event nothing emits any more. What the
       * campaign shakes for is impact, and impact comes from the particle
       * system in both worlds. The ram lurch and the stall call shake()
       * directly from vehicle.js rather than through an event.
       *
       * NOTE: deliberately NOT subscribed to 'run:reset'. main.js already calls
       * camera.reset() early in restart(), and re-resetting afterwards would
       * clobber the snap onto a machine that has just been parked. */
    }
    reset();
  }

  function setViewport(w, h) {
    vpW = w > 1 ? w : 1;
    vpH = h > 1 ? h : 1;
    recomputeScale();
  }

  /**
   * The scale. Two clamps — a portrait fit and the level-fill floor, solved
   * per level — and deliberately NO lane-fit ceiling. See point 3 of the
   * tunables note above for why that would be wrong here.
   */
  function recomputeScale() {
    scale = zoom * (vpH / C.CAM_REFERENCE_HEIGHT);

    /* THE PORTRAIT FIT. Only ever reduces the scale, so a landscape desktop —
     * where the tuned framing already shows more than the whole shaft — is
     * untouched, and a narrow screen is widened until it can see enough of the
     * shaft to drive in. Note that this is deliberately applied to `scale` and
     * not to `zoom`: update() clamps zoom at CAM_ZOOM_MIN * 0.9 (0.558) and a
     * portrait fit needs ~0.52, so routing it through the zoom would be silently
     * clamped back. getZoom() therefore stays the nominal ADV.CAM_ZOOM, which is
     * also what keeps particles.js's LOW_DETAIL_ZOOM switch from flipping the
     * whole mine to cheap squares on exactly the devices that most want the
     * detail. */
    var fit = vpW / ADV_FIT_WIDTH;
    if (scale > fit) scale = fit;

    /* THE LEVEL-FILL FLOOR IS GONE, and it is worth saying why rather than
     * leaving a reader to notice the gap. It existed to stop the view showing
     * more than ADV_WALL_VISIBLE of bedrock beside a level's side walls by zooming
     * IN until the rock filled the screen. A level map has no side walls any more
     * — there is always rock out to the horizon in both directions — so the rule
     * it enforced is now true by construction and the clamp could only ever fire
     * on a viewport so wide that it would fight ADV_FIT_WIDTH.
     *
     * ADV_WALL_VISIBLE went with it. What is left is the portrait fit above and
     * the absolute floor below, which is the whole of the framing solve. */
    if (scale < ADV_MIN_SCALE) scale = ADV_MIN_SCALE;
    if (scale < 0.05) scale = 0.05;
  }

  /* =====================================================================
   * ZOOM
   * ================================================================== */

  /** Snappy transient. Positive punches IN, negative kicks OUT. */
  function doPunch(a) {
    punch += a;
    if (punch > PUNCH_MAX) punch = PUNCH_MAX;
    if (punch < -PUNCH_MAX) punch = -PUNCH_MAX;
  }

  /**
   * FIXED FRAMING. ADV.CAM_ZOOM is a shared constant every other module is
   * tuned against — the light radius, the streaming window, the joystick
   * scale — so the camera does not get an opinion about it. The fit to the
   * actual viewport happens downstream, on `scale`, in recomputeScale().
   *
   * It stays a function rather than becoming a constant because update()
   * still eases toward it: zoom is smoothed and then punched, and a punch on
   * a raw constant would have nothing to settle back to.
   */
  function desiredZoom() { return A.CAM_ZOOM; }

  /* =====================================================================
   * SHAKE
   * ================================================================== */

  /** Additive trauma. Multiple hits in one frame stack, then saturate.
   *  For DISCRETE events only — see the note by the tunables. */
  function shake(strength) {
    if (!(strength > 0)) return;
    trauma += strength / C.CAM_SHAKE_MAX;
    if (trauma > SHAKE_TRAUMA_CAP) trauma = SHAKE_TRAUMA_CAP;
  }

  /** Raise trauma TO a level without accumulating. For repeating sources. */
  function shakeFloor(strength) {
    if (!(strength > 0)) return;
    var t = strength / C.CAM_SHAKE_MAX;
    if (t > SHAKE_TRAUMA_CAP) t = SHAKE_TRAUMA_CAP;
    if (trauma < t) trauma = t;
  }

  /* =====================================================================
   * ADVENTURE FOLLOW
   * ---------------------------------------------------------------------
   * A follow for a machine that can travel in any direction. The lead is a
   * vector along the velocity, eased AS A VECTOR so a 180-degree turn swings
   * the framing round instead of teleporting it through zero, and the target is
   * then clamped so the view never slides off the shaft or up into the sky.
   * The clamp is applied to the TARGET, exactly as the classic lane-slack clamp
   * is, so the camera eases into its limit rather than hitting a wall.
   * ================================================================== */
  var advTargetX = 0, advTargetY = 0;

  function updateAdvFollow(dt) {
    if (!SM.vehicle || !SM.vehicle.getY) return;
    var vxv = SM.vehicle.getVelX ? SM.vehicle.getVelX() : 0;
    var vyv = SM.vehicle.getVelY ? SM.vehicle.getVelY() : 0;
    var sp = Math.sqrt(vxv * vxv + vyv * vyv);

    var halfH = (vpH * 0.5) / scale;

    var lx = 0, ly = 0;
    if (sp > 1) {
      var ref = (SM.rig && SM.rig.getSpeed) ? SM.rig.getSpeed() : C.VEHICLE_SPEED;
      if (!(ref > 1)) ref = C.VEHICLE_SPEED;
      var t = sp / ref;
      if (t > 1) t = 1;
      var mag = t * ADV_LEAD_FRAC * halfH;
      lx = (vxv / sp) * mag;
      ly = (vyv / sp) * mag;
    }
    var k = 1 - Math.exp(-ADV_LEAD_LERP * dt);
    advLeadX += (lx - advLeadX) * k;
    advLeadY += (ly - advLeadY) * k;

    advTargetX = SM.vehicle.getX() + advLeadX;
    advTargetY = SM.vehicle.getY() + advLeadY;

    /* THERE IS NOTHING TO CLAMP X AGAINST ANY MORE. This used to keep bedrock off
     * the sides by pinning the view inside the mine's half-width, and then a
     * second clamp (ADV_WALL_OFFSET) existed purely to stop the first one fighting
     * the follow when the machine drove up to a wall — measured at 1440x900, the
     * bare wall clamp put the hull 69% off centre and it got worse the further
     * west you drove.
     *
     * A level map is endless east and west, so there is never bedrock at the sides
     * to keep off screen and the whole pair is gone. The camera simply follows.
     * That is one fewer thing the framing can get wrong, and it is why driving a
     * thousand units east now feels the same as driving a hundred.
     *
     * ...AND THE LEVEL'S ROOF, WHICH IS THE ONE BOUND LEFT. -y is up, so the roof
     * is a lower bound on the target. A camera that slid past it would frame a
     * screen of bedrock and answer the one question the seal exists to answer —
     * "is there anything up there?" — with a picture that says maybe.
     *
     * BOUND FIRST, THEN THE FOLLOW GUARANTEE, in that order: the machine parks
     * under the ceiling at the start and end of every run, and it sliding off the
     * top of the screen is a playability failure where visible bedrock is a
     * cosmetic one. */
    var lb = advBounds();
    var top = (lb ? lb.topY : A.MINE_CEILING_Y) - ADV_EDGE_PEEK + halfH;
    if (advTargetY < top) advTargetY = top;
    if (lb) {
      var maxOffY = halfH * ADV_WALL_OFFSET;
      var vy0 = SM.vehicle.getY();
      if (advTargetY < vy0 - maxOffY) advTargetY = vy0 - maxOffY;
      else if (advTargetY > vy0 + maxOffY) advTargetY = vy0 + maxOffY;
    }
  }

  /* =====================================================================
   * UPDATE
   * ================================================================== */
  function update(dt) {
    /* --- follow target ------------------------------------------------ */
    updateAdvFollow(dt);

    // Exponential smoothing — frame-rate independent.
    var k = 1 - Math.exp(-C.CAM_FOLLOW * dt);
    x += (advTargetX - x) * k;
    y += (advTargetY - y) * k;

    /* --- zoom --------------------------------------------------------- */
    var target = desiredZoom();
    var kz = 1 - Math.exp(-C.CAM_ZOOM_LERP * dt);
    zoomBase += (target - zoomBase) * kz;

    // Punch is applied AFTER the smoothing, so it lands on the same frame the
    // event fired instead of being eaten by the zoom lerp.
    punch -= punch * Math.min(1, PUNCH_DECAY * dt);
    if (punch < 0.0004 && punch > -0.0004) punch = 0;
    zoom = zoomBase * (1 + punch);
    if (zoom < C.CAM_ZOOM_MIN * 0.9) zoom = C.CAM_ZOOM_MIN * 0.9;
    if (zoom > C.CAM_ZOOM_MAX * 1.1) zoom = C.CAM_ZOOM_MAX * 1.1;
    recomputeScale();

    /* --- shake -------------------------------------------------------- */
    // Continuous low rumble while the cutter is loaded. This is a TARGET floor,
    // not an accumulation, so it can never saturate the trauma budget.
    if (SM.vehicle && SM.vehicle.getResistance) {
      shakeFloor(Math.min(1, SM.vehicle.getResistance() * 0.0045) * SHAKE_GRIND_GAIN);
    }

    shakeTime += dt;
    if (trauma > 0.0001) {
      trauma -= trauma * C.CAM_SHAKE_DECAY * dt;
      if (trauma < 0.0001) trauma = 0;
      // Squared trauma feels punchier than linear.
      var t2 = trauma * trauma;
      var amp = t2 * C.CAM_SHAKE_MAX;
      // Cheap pseudo-noise: two out-of-phase sines per axis + a random kick.
      shakeX = amp * (Math.sin(shakeTime * 61.7) * 0.42 +
                      Math.sin(shakeTime * 23.1 + 2.3) * 0.22 +
                      (Math.random() * 2 - 1) * 0.36);
      shakeY = amp * (Math.sin(shakeTime * 47.3 + 1.7) * 0.42 +
                      Math.sin(shakeTime * 17.9 + 0.6) * 0.22 +
                      (Math.random() * 2 - 1) * 0.36);
      // A whisper of roll. Kept tiny: any more and the bedrock walls tilt
      // visibly and the whole frame reads as broken rather than impactful.
      shakeRot = t2 * SHAKE_ROLL_MAX * Math.sin(shakeTime * 31.4 + 0.9);
    } else {
      shakeX = 0; shakeY = 0; shakeRot = 0;
    }
  }

  /**
   * Multiply the world transform onto ctx.
   * main.js has already applied the devicePixelRatio base transform, so we
   * work in CSS pixels here.
   */
  function applyTransform(ctx) {
    ctx.translate(vpW * 0.5, vpH * 0.5);
    if (shakeRot !== 0) ctx.rotate(shakeRot);
    ctx.scale(scale, scale);
    ctx.translate(-x + shakeX / scale, -y + shakeY / scale);
  }

  /** Visible world rectangle. Reused object — never cache the reference. */
  function getViewBounds() {
    var hw = (vpW * 0.5) / scale;
    var hh = (vpH * 0.5) / scale;
    // Slack for shake translation and for the corner sweep caused by roll, so
    // culling/streaming never pops content in at the edge of a big hit.
    var slack = (Math.abs(shakeX) + Math.abs(shakeY)) / scale +
                Math.abs(shakeRot) * (hw + hh);
    boundsOut.minX = x - hw - slack;
    boundsOut.maxX = x + hw + slack;
    boundsOut.minY = y - hh - slack;
    boundsOut.maxY = y + hh + slack;
    return boundsOut;
  }

  function worldToScreen(wx, wy) {
    pointOut.x = (wx - x) * scale + vpW * 0.5 + shakeX;
    pointOut.y = (wy - y) * scale + vpH * 0.5 + shakeY;
    return pointOut;
  }

  function screenToWorld(sx, sy) {
    pointOut.x = (sx - vpW * 0.5 - shakeX) / scale + x;
    pointOut.y = (sy - vpH * 0.5 - shakeY) / scale + y;
    return pointOut;
  }

  function reset() {
    punch = 0;
    trauma = 0;
    shakeX = shakeY = shakeRot = 0;
    advLeadX = advLeadY = 0;
    zoom = zoomBase = A.CAM_ZOOM;

    /* SNAP ONTO THE MACHINE. adv.enterMine() and adv.rideTo() have both already
     * parked the vehicle by the time they call this, so the position is
     * available — and without the snap a descent would open with the camera
     * flying in from wherever the last one left it. */
    x = (SM.vehicle && SM.vehicle.getX) ? SM.vehicle.getX() : 0;
    y = (SM.vehicle && SM.vehicle.getY) ? SM.vehicle.getY() : A.MINE_CEILING_Y;
    advTargetX = x;
    advTargetY = y;

    recomputeScale();
  }

  /* --- density solve, right here in the module body -------------------------
   * Deliberately NOT in init(), and this is not tidiness. main.js runs
   * particles.init() BEFORE camera.init(), and particles.init() bakes hardness
   * and value into typed arrays that nothing ever rebuilds — so materials.js
   * has to be told the grid pitch while the page is still parsing scripts.
   * camera.js is script 5: SM.config and SM.materials exist and
   * window.innerWidth is readable. This is the only window that works.
   * ---------------------------------------------------------------------- */
  solveWorldDensity();

  return {
    init: init,
    update: update,
    applyTransform: applyTransform,
    shake: shake,
    getZoom: function () { return zoom; },
    getScale: function () { return scale; },
    getX: function () { return x; },
    getY: function () { return y; },
    getViewBounds: getViewBounds,
    worldToScreen: worldToScreen,
    screenToWorld: screenToWorld,
    setViewport: setViewport,
    reset: reset,
    // additions
    shakeFloor: shakeFloor,
    punch: doPunch,
    getTrauma: function () { return trauma; },

    /* --- world density, solved once at load (see solveWorldDensity) ----
     * materials.js has already been handed this number and has re-balanced
     * value and hardness against it, which is why the solve cannot simply be
     * deleted now that nothing frames itself with it. Exposed for measurement
     * and for whatever asks next; js/advterrain.js sizes its own grid from
     * ADV.SPACING and does not consult this. */
    getWorldSpacing: function () { return worldSpacing; },
    /** Tallest world view the solved grid can fill, in world units. */
    getMaxViewHeight: function () { return budgetViewHeight; }
  };
})();
