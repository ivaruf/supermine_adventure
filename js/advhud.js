/* =============================================================================
 * SUPERMINE ADVENTURE — js/advhud.js
 * -----------------------------------------------------------------------------
 * THE IN-MINE INSTRUMENT PANEL. Everything the player needs to answer one
 * question without ever opening a menu: CAN I GET HOME FROM HERE?
 *
 * ---------------------------------------------------------------------------
 * WHAT IT SHOWS
 *   FUEL       the primary gauge. Big, and it changes character as it drains:
 *              healthy -> a reserve warning when what is left is close to what
 *              getting home costs (SM.adv.getReserveNeeded()) -> alarm.
 *   CARGO      a fill bar plus a compact manifest of what is actually in the
 *              hold, so "dump the coal" is a decision made from the HUD.
 *   DEPTH      metres, and the company balance beside it.
 *   HEAT       only once cooling matters — no dead gauge in Old Creek.
 *   HULL       ALWAYS, including at 100%. It carries between descents and it
 *              costs money to repair, so it has to be checkable before it is a
 *              problem rather than appearing once you are already in one.
 *   SCANNER    the headline contact from SM.scanner.getBest(), as a bearing and
 *              a distance in metres.
 *
 * WHERE IT ALL SITS — TWO LAYOUTS, ONE SET OF INSTRUMENTS
 *
 *   This used to read "the whole panel is a stack pinned to the TOP edge, on
 *   every viewport", and the argument for it was the thumb: the joystick's
 *   origin floats to wherever it lands, so the bottom of the screen is under
 *   the player's own hand. That half of the reasoning still holds. The other
 *   half was wrong, and on a phone it was wrong about the most important thing
 *   on the screen:
 *
 *       THE MINE MOUTH IS UP. -y is the surface. Climbing out means driving
 *       towards the top of the screen at the exact moment the tank is lowest
 *       and the decision matters most — and a 210 px full-width stack on an
 *       844 px phone put a quarter of the glass, opaque, over the shaft the
 *       player is trying to climb.
 *
 *   So the top belongs to the mine and the bottom belongs to the thumb, and
 *   the instruments go where NEITHER of them is: the two side edges.
 *
 *   COMPACT / PORTRAIT — THE RAILS  (.sm-compact, which ui.js publishes for
 *   any phone in either orientation and for a small desktop window)
 *     LEFT RAIL    FUEL. A 48 px vertical plate: the percentage, the state
 *                  word, and a tall bar that fills from the BOTTOM like a tank
 *                  with the reserve mark struck across it. Long and thin is
 *                  the right shape for this gauge — the taller the bar, the
 *                  more precisely you can read the level against the mark.
 *     RIGHT RAIL   HOLD. Fill level, capacity and worth, always visible; the
 *                  manifest is behind the count button at its foot and opens
 *                  INWARDS over the rock (see THE HOLD DRAWER below).
 *     BOTTOM EDGE  one line: DEPTH · FUNDS · HULL · HEAT, inside the
 *                  safe-area inset, BELOW where a thumb sits on the stick.
 *     ABOVE IT     the scanner contact, between the rails.
 *     TOP EDGE     nothing but the sound and pause plates in the corner. The
 *                  shaft, and the daylight at the end of it, is clear.
 *
 *   WIDE — THE STACK, UNCHANGED. At 1440x900 the stack is a 560 px column
 *   pinned top-LEFT while the machine is centred: it never covers the shaft,
 *   it has room for the fuel arithmetic in full (BURN, SECONDS LEFT) and for
 *   the manifest with no drawer. There was nothing to fix, so nothing changed.
 *
 *   Both layouts are the SAME DOM. Everything above is done in the stylesheet
 *   off ui.js's existing .sm-compact switch; no JS branch, no measuring, and
 *   no second set of elements to keep in step.
 *
 * HARD RULES INHERITED FROM ui.js — these are not style preferences
 *   1. update() RUNS INSIDE THE FIXED STEP, so it can be called several times
 *      per rendered frame. EVERY DOM write goes through the setText/setStyle/
 *      setClass/setVar helpers below, which skip the write when the value has
 *      not changed. The manifest and the scanner line are additionally rebuilt
 *      on a SLOW TIMER (SLOW_HZ), because deciding whether they changed means
 *      walking an array.
 *   2. Never measure. There is not one offsetWidth/getBoundingClientRect read
 *      in this file. Bars are driven by a --var and scaled by the stylesheet.
 *   3. Read-only. This module polls SM.adv and SM.scanner. The only writes are
 *      user actions: the pause button, and a two-tap confirm on a manifest row
 *      that calls SM.adv.dump() — "dump the coal" is the decision the manifest
 *      exists to support, and making it from the HUD is the whole point.
 *
 * PAUSE
 *   This module owns the pause card. It offers RESUME, ABORT RUN
 *   (SM.adv.abort() — costs the hold, like a strand) and LEAVE EXPEDITION,
 *   which aborts and then closes the campaign back to the title screen.
 *   The simulation is gated with SM.main.setPaused(true/false) as usual.
 * ========================================================================== */

var SM = SM || {};

SM.advhud = (function () {
  'use strict';

  /* ----- Tunables live here ----------------------------------- */

  var SLOW_HZ        = 8;      // manifest + scanner refreshes per second
  var ALERT_TIME     = 2.4;    // default banner seconds
  /* EVERY MATERIAL IN THE HOLD GETS A ROW. There are 12 sellable minerals in the
   * whole game (js/mines.js), so 12 means the "+N MORE" line is a safety net
   * that should never actually appear rather than a routine truncation. It used
   * to be 5, which quietly folded the cheap ore into a summary line — and the
   * cheap ore is exactly what a dump decision is about. */
  var MANIFEST_ROWS  = 12;     // rows shown before the "+N MORE" line
  var DUMP_CONFIRM   = 2.6;    // seconds an armed DUMP stays armed

  /* Fuel gauge character. RESERVE is what SM.adv says getting home costs; the
   * warning has to arrive BEFORE the tank hits it, or the instrument is just
   * announcing a failure that already happened. WARN_MARGIN is that head start,
   * expressed as a multiple of the reserve. */
  var WARN_MARGIN    = 1.75;   // fuel <= reserve * this  -> amber, "TURN BACK"
  var CRIT_MARGIN    = 1.05;   // fuel <= reserve * this  -> red, alarm
  var LOW_PCT        = 0.15;   // ...and never look healthy under this either

  var HEAT_SHOW      = 0.02;   // heat fraction below which the gauge is absent
  // (INTEG_SHOW removed: the hull gauge is now always shown — see update().)

  var ALERT_GAP      = 1.2;    // seconds between banners of the same kind

  /* THE RIDE DIP. Black lands instantly and holds for RIDE_HOLD_MS with the
   * level's name on it, then fades off over RIDE_FADE_MS (the transition is in
   * the stylesheet; this number only has to agree with it). ~1 s in total: long
   * enough to read "LEVEL 3 — SILVER VEINS", short enough that a player hopping
   * two levels to fetch a pile is not sitting through a cutscene twice. */
  var RIDE_HOLD_MS   = 420;
  var RIDE_FADE_MS   = 600;
  var MAP_CONFIRM    = 3.0;    // seconds the door menu's LEAVE stays armed

  var M_PER_UNIT = (SM.config && SM.config.ADV) ? SM.config.ADV.METERS_PER_UNIT : 0.1;

  /* ---------------------------------------------------------------------
   * GLYPHS — same 24x24 line-art discipline as ui.js's control icons. They
   * are copied rather than shared because ui.js does not export them and is
   * frozen; four path strings is a cheaper price than a change to a frozen
   * file.
   * ------------------------------------------------------------------ */
  var ICONS = {
    pause: '<rect x="7.2" y="4.6" width="3.7" height="14.8" rx="1.1" fill="currentColor" stroke="none"/>' +
           '<rect x="13.1" y="4.6" width="3.7" height="14.8" rx="1.1" fill="currentColor" stroke="none"/>',
    play: '<path d="M7.8 4.7 19.4 12 7.8 19.3z" fill="currentColor" stroke="none"/>',
    home: '<path d="M3.4 20.4h17.2"/><path d="M12 3.6v7.2"/>' +
          '<path d="M6.6 10.8h10.8v9.6H6.6z"/><path d="m7.4 3.6 9.2 7.2M16.6 3.6 7.4 10.8"/>',
    abort: '<path d="M12 3.2 21 19.4H3z"/><path d="M12 9v5"/>' +
           '<circle cx="12" cy="16.8" r="1.1" fill="currentColor" stroke="none"/>',
    sound_on: '<path d="M4.4 9.4h3.3l4.9-4.1v13.4l-4.9-4.1H4.4z"/>' +
              '<path d="M15.7 9.2a3.9 3.9 0 0 1 0 5.6"/><path d="M18.3 6.5a7.6 7.6 0 0 1 0 11"/>',
    sound_off: '<path d="M4.4 9.4h3.3l4.9-4.1v13.4l-4.9-4.1H4.4z"/>' +
               '<path d="m16.2 9.6 5.2 4.8M21.4 9.6l-5.2 4.8"/>',
    /* The manifest drawer's handle. A stack of lines is the one glyph that
     * reads as "a list of what is in there" at 12 px on a 48 px rail. */
    manifest: '<path d="M4.6 6.4h14.8M4.6 12h14.8M4.6 17.6h14.8"/>',
    /* Dismiss the lift panel. A cross, because the panel is an OFFER and the
     * player is allowed to ignore it and keep drilling. */
    close: '<path d="m6.6 6.6 10.8 10.8M17.4 6.6 6.6 17.4"/>'
  };

  function glyph(inner) {
    return '<svg class="sm-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
           'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
           inner + '</svg>';
  }

  /* ------------------------------------------------------------------ */

  var els = {};
  var built = false;
  var visible = false;
  var subscribed = false;
  var pauseOpen = false;

  var last = {};             // the "did it change?" cache, exactly as ui.js
  var slowTimer = 0;
  var alertTimer = 0;
  var alertClock = {};       // kind -> seconds since that kind last fired
  var dumpArmed = -1;        // matIndex with an armed confirm, -1 = none
  var dumpTimer = 0;

  var manifestRows = [];     // pooled row elements
  var manifestSig = '';
  var lodeHold = 0;          // seconds the banner keeps its motherlode dress

  var liftRows = [];         // pooled station rows
  var liftSig = '';
  var liftAt = -2;           // getBoardable() as of the last slow tick, -2 = never asked
  var liftOpen = false;
  var liftDismissed = -1;    // station whose panel the player waved away
  /* THE UNLOCK NOTICE, for the life of ONE panel session. adv.js persists the
   * fact that the rung was revealed and hands the box over exactly once; these
   * three hold it on screen until the player leaves the cage. 0 = no box. */
  var liftUnlock = 0;
  /* THE WORKSHOP ROUND TRIP. True from the frame the workshop opens over a live
   * run until the frame the lift panel is back. It exists for exactly one
   * reason — see hideLift() — and it must be cleared on the way back in, or the
   * unlock notice becomes immortal. */
  var shopTrip = false;
  var liftUnlockName = '';
  var liftUnlockPrice = 0;

  /* =====================================================================
   * DOM helpers — the ui.js discipline, one cache per module
   * ================================================================== */
  function el(tag, cls, parent, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }

  function setText(key, node, str) {
    if (!node || last[key] === str) return;
    last[key] = str;
    node.textContent = str;
  }

  function setClass(key, node, cls, on) {
    if (!node) return;
    var v = on ? 1 : 0;
    if (last[key] === v) return;
    last[key] = v;
    if (on) node.classList.add(cls); else node.classList.remove(cls);
  }

  /** Guarded custom-property write. style[prop] does not reach `--vars`. */
  function setVar(key, node, prop, val) {
    if (!node || last[key] === val) return;
    last[key] = val;
    node.style.setProperty(prop, val);
  }

  function retrigger(node, cls) {
    if (!node) return;
    node.classList.remove(cls);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { node.classList.add(cls); });
    } else node.classList.add(cls);
  }

  function fmt(n) {
    n = Math.round(n) | 0;
    if (n < 1000) return '' + n;
    var s = '' + n, out = '', c = 0;
    for (var i = s.length - 1; i >= 0; i--) {
      out = s.charAt(i) + out;
      if (++c === 3 && i > 0) { out = ' ' + out; c = 0; }
    }
    return out;
  }

  function iconButton(parent, cls, icon, title) {
    var b = el('button', 'sm-btn sm-iconbtn ' + cls, parent);
    b.setAttribute('type', 'button');
    b.setAttribute('title', title);
    b.setAttribute('aria-label', title);
    b.innerHTML = glyph(icon);
    return b;
  }

  /**
   * One plate in the door menu: a label that never changes and a value line
   * under it that does. Two spans rather than one string so the stylesheet can
   * stack them on a phone and put them side by side on a wide screen, and so the
   * label is never the thing that moves — see paintDoorActs().
   */
  function doorButton(parent, cls, label, fn) {
    var b = el('button', 'sm-ah-doorbtn ' + cls, parent);
    b.setAttribute('type', 'button');
    b.smLabel = el('span', 'sm-ah-doorlbl', b, label);
    b.smVal = el('span', 'sm-ah-doorval', b, '');
    b.addEventListener('click', function (e) {
      e.preventDefault();
      b.blur();
      if (b.disabled) return;
      fn();
    }, false);
    return b;
  }

  function menuButton(parent, cls, icon, label) {
    var b = el('button', 'sm-btn sm-pause-btn ' + cls, parent);
    b.setAttribute('type', 'button');
    var ico = el('span', 'sm-pause-ico', b);
    ico.innerHTML = glyph(icon);
    el('span', 'sm-pause-label', b, label);
    return b;
  }

  /* =====================================================================
   * SAFE READS ACROSS THE SEAM
   * Every getter here belongs to another agent and may be a stub returning a
   * placeholder while they work. num() is the difference between a HUD that
   * shows 0 and a HUD that throws.
   * ================================================================== */
  function num(v, dflt) {
    return (typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity) ? v : dflt;
  }

  function A() { return SM.adv; }

  /** {name, color} for a material index, from whichever module can answer. */
  var dispOut = { name: '', color: '#8e9bab' };
  function displayOf(matIndex, matId) {
    dispOut.name = '';
    dispOut.color = '#8e9bab';
    var d = null;
    if (SM.mines && SM.mines.displayOf && matId) d = SM.mines.displayOf(matId);
    if (d) {
      dispOut.name = String(d.name || matId || '');
      dispOut.color = String(d.color || d.colour || dispOut.color);
      return dispOut;
    }
    var m = null;
    if (SM.materials) {
      if (typeof matIndex === 'number' && SM.materials.get) m = SM.materials.get(matIndex);
      if (!m && matId && SM.materials.getById) m = SM.materials.getById(matId);
    }
    if (m) {
      dispOut.name = String(m.name || m.id || '');
      dispOut.color = (m.colors && m.colors[0]) ? m.colors[0] : dispOut.color;
    } else {
      dispOut.name = String(matId || 'UNKNOWN');
    }
    return dispOut;
  }

  /* =====================================================================
   * BUILD
   * ================================================================== */
  function build() {
    var root = document.getElementById('ui-root');
    if (!root) return;
    built = true;

    els.root = el('div', 'sm-ah', root);

    /* THE INFO BAR WRAPPER.
     *
     * On a phone the readings share one bar, and the two halves must be able to
     * NEGOTIATE width: the strip takes exactly what its text needs and the fuel
     * slice gives up whatever is left. Absolute positioning with a fixed fuel
     * width could not do that, and the failure was invisible on a Mac — the font
     * stack resolves to SF Mono there and to Roboto Mono or Droid Sans Mono on
     * Android, which are WIDER at the same px size, so HULL and DEPTH squashed on
     * real hardware while Chrome's device emulation (which swaps the viewport but
     * not the fonts) looked perfect.
     *
     * In the WIDE layout this wrapper is `display: contents`, so the stack sees
     * exactly the children it always did and nothing about the desktop HUD moves.
     */
    els.topbar = el('div', 'sm-ah-top', els.root);

    /* --- row 1: where am I, and how far back is the door ---------------- */
    var strip = el('div', 'sm-panel sm-ah-strip', els.topbar);
    el('div', 'sm-stripe', strip);

    /* THE CELL COUNTS TO THE DOOR, NOT DOWN FROM THE SURFACE.
     *
     * It read DEPTH — absolute metres below the mouth — and that was the right
     * number when the mouth was the only way out. The lift changed what "out"
     * means: with a station bought at 240 m, a machine at 260 m is twenty metres
     * from a ride home, and printing "260 m" invited exactly the wrong call at
     * exactly the wrong moment.
     *
     * So this is now the distance to the NEAREST OWNED STATION, which is the
     * number every fuel decision is actually made against — the same number the
     * reserve mark on the fuel bar is measured from. The label says EXIT so it
     * cannot be read as depth, and absolute depth has a better home: the lift's
     * own display in the world, where it belongs.
     *
     * `sm-ah-depth` stays on the element. Six stylesheet rules place this cell by
     * that name and renaming it would be a cosmetic change with a layout bug in
     * it; `sm-ah-exit` is added alongside for anything that wants the new name. */
    var dep = el('div', 'sm-ah-cell sm-ah-depth sm-ah-exit', strip);
    el('div', 'sm-ah-lbl', dep, 'EXIT');
    els.depth = el('div', 'sm-ah-val', dep, '0 m');

    /* FUNDS, where TO SURFACE used to be.
     *
     * TO SURFACE was the same number as DEPTH — the mine mouth is depth zero, so
     * "how deep am I" and "how far back is the door" are one measurement wearing
     * two labels, and printing it twice just cost a slot.
     *
     * The company balance is genuinely useful down here instead: what the hold is
     * worth only means something next to what you already have, and it is the
     * number behind every "push on or go home" call. */
    /* THE BALANCE IS A SIBLING OF THE STRIP, NOT A CELL INSIDE IT.
     * On a phone it belongs on its own line UNDER the sound and pause plates,
     * while HULL and DEPTH sit beside FUEL in the info bar — and a cell cannot be
     * in two containers at once. Being a direct child of the root lets the
     * stylesheet put it anywhere in the window without a second DOM node and
     * without a second guarded write. */
    var fu = el('div', 'sm-ah-cell sm-ah-funds', els.root);
    el('div', 'sm-ah-lbl', fu, 'FUNDS');
    els.funds = el('div', 'sm-ah-val', fu, '$0');

    // HEAT and INTEGRITY are absent, not zeroed, until they mean something.
    els.heatCell = el('div', 'sm-ah-cell sm-ah-heat', strip);
    el('div', 'sm-ah-lbl', els.heatCell, 'HEAT');
    els.heat = el('div', 'sm-ah-val', els.heatCell, '0%');
    els.heatBar = el('div', 'sm-ah-mini', els.heatCell);
    el('div', 'sm-ah-mini-fill', els.heatBar);

    els.integCell = el('div', 'sm-ah-cell sm-ah-integ', strip);
    el('div', 'sm-ah-lbl', els.integCell, 'HULL');
    els.integ = el('div', 'sm-ah-val', els.integCell, '100%');
    els.integBar = el('div', 'sm-ah-mini', els.integCell);
    el('div', 'sm-ah-mini-fill', els.integBar);

    /* --- row 2: FUEL, the primary gauge -------------------------------- */
    els.fuelPanel = el('div', 'sm-panel sm-ah-fuel', els.topbar);
    var fhead = el('div', 'sm-ah-fuel-head', els.fuelPanel);
    el('div', 'sm-ah-lbl', fhead, 'FUEL');
    els.fuelPct = el('div', 'sm-ah-fuel-pct', fhead, '0%');
    els.fuelNote = el('div', 'sm-ah-fuel-note', fhead, '');
    var fbar = el('div', 'sm-ah-bar sm-ah-bar-fuel', els.fuelPanel);
    els.fuelFill = el('div', 'sm-ah-bar-fill', fbar);
    // The reserve MARK is the whole instrument: it turns an abstract percentage
    // into "that much is the way home". Positioned by a CSS var, never by JS.
    els.fuelMark = el('div', 'sm-ah-bar-mark', fbar);

    /* THE SUB LINE IS FOUR SPANS, NOT ONE STRING.
     * On a wide screen it reads as one sentence — HOME 5u · BURN 0.5/s · 88s
     * LEFT — which is the arithmetic the player would otherwise do in their
     * head. It will not fit in a 48 px rail, and the piece that has to survive
     * is the FIRST one: what the trip home costs. Splitting it lets the
     * stylesheet drop BURN and SECONDS LEFT on a phone and stack HOME over its
     * value, with the separators supplied by CSS ::before so an empty span
     * leaves no orphaned dot. Still one guarded write per span. */
    els.fuelSub = el('div', 'sm-ah-sub', els.fuelPanel);
    el('span', 'sm-ah-sub-k', els.fuelSub, 'HOME ');
    els.fuelHome = el('span', 'sm-ah-sub-home', els.fuelSub, '');
    els.fuelBurn = el('span', 'sm-ah-sub-burn', els.fuelSub, '');
    els.fuelLeft = el('span', 'sm-ah-sub-left', els.fuelSub, '');

    /* --- row 3: the hold ----------------------------------------------- */
    els.cargoPanel = el('div', 'sm-panel sm-ah-cargo', els.root);
    var chead = el('div', 'sm-ah-fuel-head', els.cargoPanel);
    el('div', 'sm-ah-lbl', chead, 'HOLD');
    /* "0 / 48" is two spans for the same reason as the fuel sub line: inline on
     * a wide screen, and the capacity dropped onto its own line in the rail. */
    els.cargoVal = el('div', 'sm-ah-cargo-val', chead);
    els.cargoNow = el('span', 'sm-ah-cargo-now', els.cargoVal, '0');
    els.cargoCap = el('span', 'sm-ah-cargo-cap', els.cargoVal, ' / 0');
    els.cargoWorth = el('div', 'sm-ah-fuel-note', chead, '');
    var cbar = el('div', 'sm-ah-bar sm-ah-bar-cargo', els.cargoPanel);
    els.cargoFill = el('div', 'sm-ah-bar-fill', cbar);

    /* THE MANIFEST LIVES IN A DRAWER.
     * On a wide screen the drawer is an ordinary block and the manifest is just
     * part of the stack, exactly as it always was. In the rail layout the
     * stylesheet lifts it out of the 48 px column and opens it inwards across
     * the rock on a tap — see THE HOLD DRAWER. The wrapper exists so that one
     * CSS rule moves the rows AND the "+N MORE" line together. */
    els.drawer = el('div', 'sm-ah-drawer', els.cargoPanel);
    els.manifest = el('div', 'sm-ah-manifest', els.drawer);
    els.manifestMore = el('div', 'sm-ah-more', els.drawer, '');

    /* The handle. Hidden on a wide screen, where there is nothing to unfold. */
    els.holdBtn = el('button', 'sm-ah-holdbtn', els.cargoPanel);
    els.holdBtn.setAttribute('type', 'button');
    els.holdBtn.setAttribute('title', 'Manifest — tap a row twice to dump it');
    els.holdBtn.setAttribute('aria-label', 'Manifest');
    els.holdIco = el('span', 'sm-ah-holdico', els.holdBtn);
    els.holdIco.innerHTML = glyph(ICONS.manifest);
    els.holdCount = el('span', 'sm-ah-holdnum', els.holdBtn, '0');
    els.holdBtn.addEventListener('click', function (e) {
      e.preventDefault();
      els.holdBtn.blur();
      toggleDrawer();
    }, false);

    /* --- the scanner line ----------------------------------------------- */
    els.scan = el('div', 'sm-ah-scan', els.root);
    els.scanArrow = el('div', 'sm-ah-scan-arrow', els.scan);
    els.scanArrow.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 3.4v17.2"/><path d="M5.6 9.8 12 3.4l6.4 6.4"/></svg>';
    els.scanText = el('div', 'sm-ah-scan-text', els.scan, '');
    els.scanDist = el('div', 'sm-ah-scan-dist', els.scan, '');

    /* --- alert banner --------------------------------------------------- */
    els.alert = el('div', 'sm-ah-alert', els.root);
    els.alertTitle = el('div', 'sm-ah-alert-title', els.alert, '');
    els.alertSub = el('div', 'sm-ah-alert-sub', els.alert, '');

    /* --- THE DOOR MENU --------------------------------------------------
     * The lift is BIG CLOSED DOORS at the top-centre of the level (ARCHITECTURE.md
     * §7). Drive into them and this opens: SELL the haul, REFUEL, the level
     * list, RETURN TO MINE, LEAVE. It is the whole surface, reached without
     * leaving the mine, and it is what replaced BOTH the old in-mine station
     * panel and the surface round trip — there is no auto-extraction to be
     * surprised by any more, only plates that each do one named thing.
     *
     * IT IS A PLACE AND IT IS SIZED LIKE ONE. See THE DOOR MENU section below
     * for the layout argument; the short version is that the machine is parked
     * inside a lift and nothing else is happening, so the panel is allowed to
     * take the screen it needs to make the numbers legible.
     *
     * It is a SIBLING of .sm-ah rather than a child for the same reason the
     * pause card is: in the wide layout .sm-ah is a content-height column
     * pinned top-left, so an absolute child of it cannot reach the bottom of the
     * window. Hanging off #ui-root gives the panel one containing block in both
     * layouts.
     *
     * IT IS DISMISSIBLE, AND DISMISSING IT IS A MOVE. There is a cross on it and
     * a RETURN TO MINE plate, and both run the same undocking — a player who
     * waves the panel away wants to be back in the rock, not sitting in a cage
     * with no controls.
     *
     * WHERE IT SITS. Dead centre, sized like the room it is (style-adventure.css
     * §12). It used to hug the bottom edge and dodge the hold box by arithmetic,
     * because it could appear while the player was still driving; it cannot any
     * more — it opens only once the machine is INSIDE the cage — so there is
     * nothing to dodge and nothing to measure. */
    els.lift = el('div', 'sm-ah-lift', root);
    var lhead = el('div', 'sm-ah-lift-head', els.lift);
    el('div', 'sm-ah-lbl', lhead, 'LIFT');
    els.liftWhere = el('div', 'sm-ah-lift-where', lhead, '');
    els.liftClose = el('button', 'sm-ah-lift-close', lhead);
    /* (the cross is wired below; the rest of the panel is built after it) */
    els.liftClose.setAttribute('type', 'button');
    els.liftClose.setAttribute('title', 'Roll out — back to the rock');
    els.liftClose.setAttribute('aria-label', 'Leave the lift');
    els.liftClose.innerHTML = glyph(ICONS.close);
    /* DISMISSING THE MENU MEANS LEAVING THE CAGE. There is no "keep the machine
     * in the lift with the panel shut" state to want: the machine is invisible
     * and immobile in there, so a shut panel would be a soft-lock with no
     * on-screen way out. Same handler as the OUT plate. */
    els.liftClose.addEventListener('click', function (e) {
      e.preventDefault();
      els.liftClose.blur();
      onDoorOut();
    }, false);

    /* --- THE TRADE PLATES: SELL AND REFUEL ------------------------------
     * The two verbs the player came up for, and the redesign's first rule is
     * that their NUMBERS have to be readable at a glance — you are standing at
     * the surface deciding whether to bank $1 240 and whether $37 of diesel is
     * worth it, and both of those are the whole decision. So they get half the
     * panel width each and their value line is the biggest type in here.
     *
     * They keep their labels and grey out through :disabled; the reason always
     * goes in the note line at the foot, never on the plate. */
    els.doorActs = el('div', 'sm-ah-door-acts', els.lift);
    els.doorSell = doorButton(els.doorActs, 'sm-ah-door-sell', 'SELL', onDoorSell);
    els.doorFuel = doorButton(els.doorActs, 'sm-ah-door-fuel', 'REFUEL', onDoorRefuel);
    /* --- ...AND THE WORKSHOP -------------------------------------------
     * OWNER: "workshop needs to be a button on the lift menu."
     *
     * IT BELONGS IN THIS ROW AND NOT IN THE FOOT. The three plates here are the
     * three things the surface is FOR — bank the load, fill the tank, fit a
     * better machine — and every one of them is a purchase made against the
     * money on screen. The foot is navigation: back to the rock, or out. Putting
     * a shop verb next to LEAVE would file it as a way of ending the run, which
     * is exactly the trip it exists to save.
     *
     * IT COSTS NO HEIGHT. The row is a two-column grid and a third child would
     * otherwise WRAP onto a second row, taking its height out of the level
     * ladder — which on a landscape phone has 50px to give (see the measurement
     * in style-adventure.css §12). Three columns instead of two is a change of
     * width, and width is the thing this panel has spare.
     *
     * It is never disabled. An empty wallet is a thing you find out by looking
     * at the prices, and the workshop is also where the machine is INSPECTED. */
    els.doorShop = doorButton(els.doorActs, 'sm-ah-door-shop', 'WORKSHOP', onDoorShop);

    /* --- THE UNLOCK NOTICE ----------------------------------------------
     * THE PROGRESSION GATE'S ONE PIECE OF TEACHING (js/adv.js's note above
     * buyLevel). When the player has finally worked enough of this level and has
     * the money, the next one down stops being invisible — and that is a big
     * enough change to the game that it is told rather than left to be noticed.
     *
     * IT LIVES HERE, IN THE LIFT, and that is the whole reason it can be a
     * quiet box instead of a modal. The owner's constraint was "noticed without
     * interrupting driving": a banner over the rock would either be missed at 60
     * km/h or would have to stop the machine to be read. The lift is where the
     * player is already stationary, already reading numbers, and already looking
     * at the list the notice is about — so it appears directly above that list,
     * once, and the very next thing under the player's thumb is the row it is
     * talking about.
     *
     * ONE PANEL SESSION. refreshLift() takes it from adv.getUnlockNotice() and
     * clears it there and then — adv.js has already persisted the fact, so it
     * cannot come back after a reload — and hideLift() drops it, so leaving the
     * cage and coming back does not re-teach a lesson already given. */
    els.unlock = el('div', 'sm-ah-unlock', els.lift);
    els.unlockTitle = el('div', 'sm-ah-unlock-title', els.unlock, '');
    els.unlockBody = el('div', 'sm-ah-unlock-body', els.unlock, '');

    els.liftList = el('div', 'sm-ah-lift-list', els.lift);
    /* The panel text. Where every reason lives: what SELL would bank, why
     * REFUEL is dim, how short the ledger is of the next level. */
    els.liftNote = el('div', 'sm-ah-lift-note', els.lift, '');

    /* --- THE FOOT: THE CALL TO ACTION, AND THE WAY OUT -------------------
     * RETURN TO MINE IS THE PRIMARY, AND IT IS THE OWNER'S WORDING. The machine
     * is INSIDE the lift while this panel is up — hidden, parked, with no
     * controls — so the single most likely thing the player wants is to be back
     * in the rock, and the panel should say so in the largest, lowest, most
     * thumb-reachable plate it has. It used to be one of four equal squares
     * labelled OUT with "TO THE ROCK" underneath, which made the most common
     * action in the menu look like the third choice on a list.
     *
     * LEAVE IS SECONDARY AND STAYS TWO-TAP. It ends the expedition, which is the
     * rare choice, so it is a small quiet plate beside the big one — and its
     * confirm still rides in the VALUE line, because the label is not allowed to
     * move (see the results footer's rule).
     *
     * The cross in the head does exactly what RETURN TO MINE does; both are the
     * undocking, and dismissing the panel has always meant leaving the cage. */
    els.doorFoot = el('div', 'sm-ah-door-foot', els.lift);
    els.doorOut = doorButton(els.doorFoot, 'sm-ah-door-return', 'RETURN TO MINE', onDoorOut);
    els.doorMap = doorButton(els.doorFoot, 'sm-ah-door-map', 'LEAVE', onDoorMap);

    /* --- THE RIDE TRANSITION -------------------------------------------
     * A level is its own map, so a ride has to READ as a load: the screen goes
     * black, the level announces itself, and the world is already the new one
     * when the light comes back. See dipToLevel() for the timing and for why
     * this is DOM and not js/effects.js. */
    els.ride = el('div', 'sm-ah-ride', root);
    els.rideInner = el('div', 'sm-ah-ride-inner', els.ride);
    els.rideKicker = el('div', 'sm-ah-ride-kicker', els.rideInner, 'LIFT');
    els.rideTitle = el('div', 'sm-ah-ride-title', els.rideInner, '');
    els.rideSub = el('div', 'sm-ah-ride-sub', els.rideInner, '');

    /* --- top-right controls --------------------------------------------- */
    var btns = el('div', 'sm-ah-btns', root);
    els.btns = btns;
    /* Own class names, NOT ui.js's sm-btn-sound / sm-btn-pause: both HUDs are
     * in the DOM at the same time and a shared class would make
     * querySelector('.sm-btn-pause') a coin toss for anything that looks. */
    els.mute = iconButton(btns, 'sm-ah-sound', ICONS.sound_on, 'Sound on / off');
    els.pauseBtn = iconButton(btns, 'sm-ah-pausebtn', ICONS.pause, 'Pause');
    els.mute.addEventListener('click', function (e) {
      e.preventDefault();
      if (SM.sound && SM.sound.toggleMute) SM.sound.toggleMute();
      refreshMute();
      els.mute.blur();
    });
    els.pauseBtn.addEventListener('click', function (e) {
      e.preventDefault();
      els.pauseBtn.blur();
      openPause();
    });

    /* --- the adventure pause card ---------------------------------------
     * Deliberately a sibling of the HUD, not a child: the HUD dims behind it
     * (see .sm-ah-paused in style-adventure.css) and a dimmed parent cannot
     * hold an undimmed card. */
    els.pause = el('div', 'sm-ah-pause', root);
    var card = el('div', 'sm-panel sm-ah-pause-card', els.pause);
    el('div', 'sm-stripe', card);
    el('div', 'sm-pause-kicker', card, 'ENGINE IDLING');
    el('div', 'sm-pause-title', card, 'PAUSED');
    els.pauseStats = el('div', 'sm-ah-pause-stats', card);
    els.psDepth = statCell(els.pauseStats, 'DEPTH', '0 m');
    els.psFuel = statCell(els.pauseStats, 'FUEL', '0%');
    els.psHold = statCell(els.pauseStats, 'HOLD', '0%');

    els.btnResume = menuButton(card, 'sm-btn-primary', ICONS.play, 'RESUME');
    els.btnAbort = menuButton(card, 'sm-ah-danger', ICONS.abort, 'ABORT RUN');
    els.btnLeave = menuButton(card, '', ICONS.home, 'LEAVE EXPEDITION');
    els.abortNote = el('div', 'sm-ah-pause-note', card,
      'Aborting drops the hold where it stands, exactly like running dry.');

    els.btnResume.addEventListener('click', function (e) {
      e.preventDefault(); els.btnResume.blur(); closePause();
    });
    // ABORT and LEAVE both throw a run away, so both are two-tap.
    armConfirm(els.btnAbort, 'ABORT RUN', 'CONFIRM — LOSE THE HOLD', function () {
      closePause();
      if (SM.adv && SM.adv.abort) SM.adv.abort();
    });
    armConfirm(els.btnLeave, 'LEAVE EXPEDITION', 'CONFIRM — BACK TO TITLE', function () {
      closePause();
      if (SM.adv && SM.adv.abort) SM.adv.abort();
      if (SM.adv && SM.adv.close) SM.adv.close();
    });
  }

  function statCell(parent, label, value) {
    var cell = el('div', 'sm-cell', parent);
    el('div', 'sm-cell-label', cell, label);
    return el('div', 'sm-cell-value', cell, value);
  }

  /**
   * Two-tap confirm on a destructive button. The label changes, so there is no
   * modal on top of a modal and no dialog to mis-tap through — and it re-arms
   * itself on a timer so a stale CONFIRM can never be sitting there waiting.
   */
  function armConfirm(btn, label, confirmLabel, run) {
    var armed = false, t = 0;
    var lbl = btn.querySelector('.sm-pause-label');
    function disarm() {
      armed = false;
      if (t) { clearTimeout(t); t = 0; }
      btn.classList.remove('sm-ah-armed');
      if (lbl) lbl.textContent = label;
    }
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      btn.blur();
      if (!armed) {
        armed = true;
        btn.classList.add('sm-ah-armed');
        if (lbl) lbl.textContent = confirmLabel;
        if (SM.sound && SM.sound.play) SM.sound.play('ui');
        t = setTimeout(disarm, 3200);
        return;
      }
      disarm();
      run();
    }, false);
    btn.smDisarm = disarm;
  }

  function refreshMute() {
    if (!els.mute) return;
    var muted = !!(SM.sound && SM.sound.isMuted && SM.sound.isMuted());
    els.mute.innerHTML = glyph(muted ? ICONS.sound_off : ICONS.sound_on);
    setClass('mute', els.mute, 'sm-btn-off', muted);
  }

  /* =====================================================================
   * PAUSE
   * ================================================================== */
  function openPause() {
    if (pauseOpen || !visible) return;
    // main.js returns the RESULTING state, so a refused pause is visible on
    // the spot. Only an explicit false is a refusal; a partial merge that
    // returns nothing must still get a working card.
    if (SM.main && SM.main.setPaused && SM.main.setPaused(true) === false) return;
    pauseOpen = true;
    if (SM.joystick && SM.joystick.reset) SM.joystick.reset();   // never freeze mid-push
    if (SM.sound && SM.sound.play) SM.sound.play('ui');
    els.pause.classList.add('sm-ah-pause-on');
    els.root.classList.add('sm-ah-paused');
    paintPauseStats();
  }

  function closePause(silent) {
    if (!pauseOpen) return;
    pauseOpen = false;
    if (els.btnAbort && els.btnAbort.smDisarm) els.btnAbort.smDisarm();
    if (els.btnLeave && els.btnLeave.smDisarm) els.btnLeave.smDisarm();
    if (silent !== true && SM.sound && SM.sound.play) SM.sound.play('ui');
    if (SM.main && SM.main.setPaused) SM.main.setPaused(false);
    els.pause.classList.remove('sm-ah-pause-on');
    els.root.classList.remove('sm-ah-paused');
  }

  function paintPauseStats() {
    var a = A();
    if (!a) return;
    setText('psd', els.psDepth, fmt(num(a.getDepthM && a.getDepthM(), 0)) + ' m');
    setText('psf', els.psFuel, Math.round(num(a.getFuelPct && a.getFuelPct(), 0) * 100) + '%');
    setText('psh', els.psHold, Math.round(num(a.getCargoPct && a.getCargoPct(), 0) * 100) + '%');
  }

  /**
   * ESC / P. ui.js owns the same keys but refuses to act while adventure is
   * active (canPause() returns false) and returns WITHOUT preventDefault, so
   * this listener is the only one that answers them underground.
   */
  function onKeyDown(e) {
    if (!e || !visible) return;
    var k = e.key;
    if (k === 'Escape' || k === 'Esc' || k === 'p' || k === 'P') {
      e.preventDefault();
      if (pauseOpen) closePause(); else openPause();
    }
  }

  /** Somebody else paused us. Mirror it; never call setPaused() back. */
  function onGamePaused(p) {
    var on = !!(p && p.paused);
    if (!visible || on === pauseOpen) return;
    if (on) openPause(); else closePause(true);
  }

  /* =====================================================================
   * THE HOLD DRAWER
   * ---------------------------------------------------------------------
   * The manifest may collapse on a phone; it may not disappear. The FILL LEVEL
   * is what you steer by and it is never hidden — bar, units and worth are all
   * on the rail. The MANIFEST is different: it is only needed at the one moment
   * you decide to tip the coal out, so it hides behind the count button at the
   * foot of the rail and opens inwards over the rock when asked.
   *
   * The state is a single class on the wrapper. On a wide screen the drawer is
   * always open because the stylesheet never closes it, so the class is inert
   * there and a resize between the two layouts needs no bookkeeping.
   * ================================================================== */
  var drawerOpen = false;

  function paintDrawer() {
    setClass('drawon', els.drawer, 'sm-ah-drawer-on', drawerOpen);
    setClass('drawbtn', els.holdBtn, 'sm-ah-holdbtn-on', drawerOpen);
  }

  function toggleDrawer() {
    drawerOpen = !drawerOpen;
    // Closing it must also disarm a pending DUMP, or the confirm is sitting
    // there behind a shut door waiting for a tap that means something else now.
    if (!drawerOpen && dumpArmed >= 0) {
      dumpArmed = -1;
      dumpTimer = 0;
      paintDumpArm();
    }
    paintDrawer();
    if (SM.sound && SM.sound.play) SM.sound.play('ui');
  }

  /* =====================================================================
   * THE MANIFEST
   * ---------------------------------------------------------------------
   * Rows are pooled and only rebuilt when the SIGNATURE of the hold changes,
   * which is checked on the slow timer — walking the manifest array is the
   * one thing in this file that is not O(1), so it does not happen 60 times a
   * second.
   * ================================================================== */
  function manifestRow(i) {
    var r = manifestRows[i];
    if (r) return r;
    var node = el('button', 'sm-ah-mrow', els.manifest);
    node.setAttribute('type', 'button');
    r = {
      node: node,
      sw: el('span', 'sm-ah-msw', node),
      name: el('span', 'sm-ah-mname', node, ''),
      units: el('span', 'sm-ah-munits', node, ''),
      val: el('span', 'sm-ah-mval', node, ''),
      matIndex: -1
    };
    node.addEventListener('click', function (e) {
      e.preventDefault();
      node.blur();
      onDumpTap(r);
    }, false);
    manifestRows[i] = r;
    return r;
  }

  /**
   * Tap a row to dump it, twice to mean it. A hold full of coal in front of a
   * gold seam is the best decision the mode offers and it has to be makeable
   * without opening anything — but one stray tap must never bin the gold.
   */
  function onDumpTap(r) {
    if (r.matIndex < 0) return;
    if (dumpArmed !== r.matIndex) {
      dumpArmed = r.matIndex;
      dumpTimer = DUMP_CONFIRM;
      paintDumpArm();
      if (SM.sound && SM.sound.play) SM.sound.play('ui');
      return;
    }
    dumpArmed = -1;
    dumpTimer = 0;
    paintDumpArm();
    if (SM.adv && SM.adv.dump) SM.adv.dump(r.matIndex);
    alert('JETTISONED', String(r.name.textContent || '') + ' tipped onto the floor', 1.8);
  }

  function paintDumpArm() {
    for (var i = 0; i < manifestRows.length; i++) {
      var r = manifestRows[i];
      if (!r) continue;
      var on = (r.matIndex >= 0 && r.matIndex === dumpArmed);
      setClass('darm' + i, r.node, 'sm-ah-mrow-armed', on);
      // SAME cache key as refreshManifest() writes with, or the two would
      // shadow each other and leave a row stuck reading DUMP?.
      setText('mu' + i, r.units, on ? 'DUMP?' : (r.unitsText || ''));
    }
  }

  function refreshManifest() {
    var a = A();
    var list = (a && a.getManifest) ? a.getManifest() : null;
    if (!list || typeof list.length !== 'number') list = [];

    // Cheapest honest change-detector: index + units of every line.
    var sig = '', i, ln;
    for (i = 0; i < list.length; i++) {
      ln = list[i];
      if (!ln) continue;
      sig += (ln.matIndex === undefined ? ln.matId : ln.matIndex) + ':' + Math.round(num(ln.units, 0)) + '|';
    }
    if (sig === manifestSig) return;
    manifestSig = sig;

    var shown = Math.min(list.length, MANIFEST_ROWS);
    var hiddenUnits = 0, worth = 0;

    // Richest last in the source array, so the HUD walks it backwards: the
    // line worth protecting is the first one the eye lands on.
    var used = 0;
    for (i = list.length - 1; i >= 0; i--) {
      ln = list[i];
      if (!ln) continue;
      worth += num(ln.value, 0);
      if (used >= shown) { hiddenUnits += num(ln.units, 0); continue; }
      var idx = used++;
      var r = manifestRow(idx);
      var d = displayOf(ln.matIndex, ln.matId);
      r.matIndex = (typeof ln.matIndex === 'number') ? ln.matIndex : -1;
      r.node.style.display = '';
      setVar('msw' + idx, r.sw, '--sm-ah-sw', d.color);
      setText('mn' + idx, r.name, d.name.toUpperCase());
      r.unitsText = fmt(num(ln.units, 0)) + 'u';
      setText('mu' + idx, r.units, (r.matIndex === dumpArmed) ? 'DUMP?' : r.unitsText);
      setText('mv' + idx, r.val, num(ln.value, 0) > 0 ? ('$' + fmt(ln.value)) : '—');
    }
    for (i = used; i < manifestRows.length; i++) {
      if (manifestRows[i]) {
        manifestRows[i].node.style.display = 'none';
        manifestRows[i].matIndex = -1;
      }
    }

    setText('mmore', els.manifestMore,
            hiddenUnits > 0 ? ('+ ' + fmt(hiddenUnits) + 'u OF OTHER MATERIAL') : '');
    setClass('mmoreon', els.manifestMore, 'sm-ah-more-on', hiddenUnits > 0);
    setText('mworth', els.cargoWorth, worth > 0 ? ('$' + fmt(worth)) : '');
    setClass('mempty', els.manifest, 'sm-ah-manifest-empty', used === 0);
    /* The drawer handle says how many DIFFERENT materials are aboard, which is
     * the number that decides whether opening it is worth a tap. It is written
     * here, on the slow timer, because it is a by-product of the one array walk
     * this file does — never a separate count. */
    setText('hnum', els.holdCount, '' + used);
    setClass('hbempty', els.holdBtn, 'sm-ah-holdbtn-empty', used === 0);
    /* THE HOLD'S HEIGHT USED TO BE PUBLISHED HERE, as --sm-ah-hold-rows, so the
     * stylesheet could stack the lift panel clear above this box without anyone
     * measuring anything. The lift is a CENTRED PLACE now (style-adventure.css
     * §12) and it only ever opens with the machine parked inside the cage, so
     * there is no longer a panel that has to dodge the manifest — and SELL states
     * the hold's whole worth on its own plate, which was the number the manifest
     * was being consulted for. The write is gone with the rule that read it;
     * removing it also takes one guarded DOM write off the slow timer. */
  }

  /* =====================================================================
   * THE DOOR MENU
   * ---------------------------------------------------------------------
   * The doors are the only way in or out of a level map, so standing in them is
   * the only place any of this can be acted on: SM.adv.getBoardable() is what
   * raises the panel, polled on the SLOW timer, because it is a question about
   * position that changes at walking pace and not per fixed step.
   *
   * IT IS A PLACE, NOT A POPUP — that is the redesign, in one line. The lift is
   * somewhere the player has DRIVEN TO and it is where every decision between
   * two descents gets made, so it takes the room a room deserves and it is laid
   * out in the order those decisions actually happen:
   *
   *   1. THE TRADE, at the top and in the biggest type in the panel. SELL and
   *      REFUEL side by side, each a label over ONE NUMBER — $1 240 to bank, $37
   *      to fill — because that pair IS the decision and it has to be readable
   *      at a glance, not parsed.
   *   2. THE LADDER, in the middle. Where you can go, where you are, and — only
   *      once it has been earned — what the next rung costs.
   *   3. THE WAY OUT, at the bottom, where the thumb is. RETURN TO MINE is the
   *      primary and it is the whole reason the panel is dismissible; LEAVE is
   *      the small one beside it.
   *
   * FIVE VERBS, AND NOTHING HAPPENS BY ITSELF.
   *   SELL      adv.sellAtDoor() — banks the hold AND the secured ledger, rolls
   *             the day, and leaves the machine where it is. Greyed when there is
   *             nothing aboard to sell.
   *   REFUEL    adv.refuelAtDoor() — a full tank at the SURFACE price, quoted
   *             through mines.fuelCost() so the number matches every other
   *             screen. Greyed when the tank is full or the ledger is empty.
   *   the LEVELS  owned rows RIDE (adv.rideTo, free, hold intact); the next one
   *             down carries BUY and its price (adv.buyLevel) ONLY once the
   *             progression gate has opened on it — before that it is not drawn
   *             at all, and neither is anything below it. See js/adv.js's note
   *             above buyLevel for the rule and the unlock notice that announces
   *             it.
   *   RETURN TO MINE  adv.exitLift() — the primary. Opens the doors and drives
   *             the machine back out to the park; the cross in the head is the
   *             same verb.
   *   LEAVE     adv.leaveToMap() — ends the expedition. Two-tap, because it is
   *             the one plate here that throws a run away.
   *
   * Everything about the API is feature-detected. Until adv.js exports the door
   * there is no panel, nothing is polled, and this section costs one `if` per
   * eighth of a second.
   * ================================================================== */
  function liftLabel(L, i) {
    if (L && L.name) return String(L.name).toUpperCase();
    return 'LEVEL ' + i;
  }

  /**
   * A LEVEL'S DEPTH, AND IT IS ONE NUMBER NOW.
   *
   * A level map is unbounded east, west and south (ARCHITECTURE.md §7), so the
   * only depth it has is where its lift sits — `depthBotM` is written equal to
   * `depthTopM` and there is no width to quote either. This used to print a band
   * ("0–135 m") and it still can, for a catalogue that ever says bot > top; on
   * everything the game ships it collapses to "0 m" on its own, which is the
   * graceful presentation the world pass asked for rather than a special case.
   */
  function bandText(L) {
    if (!L) return '';
    var top = Math.round(num(L.depthTopM, num(L.depthM, 0)));
    var bot = Math.round(num(L.depthBotM, top));
    return bot > top ? (fmt(top) + '–' + fmt(bot) + ' m') : (fmt(top) + ' m');
  }

  /**
   * HAS THE PROGRESSION GATE OPENED ON THIS LEVEL? js/adv.js owns the rule; the
   * live entry already carries the answer as `offered`, and isLevelOffered() is
   * the fallback for a build where adv.js has the verb but not the field.
   */
  function levelOffered(L, i) {
    if (L && typeof L.offered === 'boolean') return L.offered;
    var a = A();
    if (a && a.isLevelOffered) return !!a.isLevelOffered(i);
    return false;
  }

  function liftRow(i) {
    var r = liftRows[i];
    if (r) return r;
    var node = el('div', 'sm-ah-liftrow', els.liftList);
    r = { node: node, level: -1 };
    /* THE ROW IS A BUTTON WITH A BUTTON BESIDE IT, not a button inside one.
     * The ride action and BUY are two different verbs on one station, and nesting
     * them would be invalid markup that behaves differently in every browser. */
    r.go = el('button', 'sm-ah-liftgo', node);
    r.go.setAttribute('type', 'button');
    r.sw = el('span', 'sm-ah-liftsw', r.go);
    r.name = el('span', 'sm-ah-liftname', r.go, '');
    r.dep = el('span', 'sm-ah-liftdep', r.go, '');
    r.tag = el('span', 'sm-ah-lifttag', r.go, '');
    r.buy = el('button', 'sm-ah-liftbuy', node, 'BUY');
    r.buy.setAttribute('type', 'button');
    r.go.addEventListener('click', function (e) {
      e.preventDefault();
      r.go.blur();
      onLiftRide(r);
    }, false);
    r.buy.addEventListener('click', function (e) {
      e.preventDefault();
      r.buy.blur();
      onLiftBuy(r);
    }, false);
    liftRows[i] = r;
    return r;
  }

  function onLiftRide(r) {
    var a = A();
    if (!a || !a.rideTo || r.level < 0) return;
    if (SM.sound && SM.sound.play) SM.sound.play('ui');
    if (!a.rideTo(r.level)) {
      alert('THE LIFT WILL NOT MOVE', 'Drive into the doorway first', 2.0);
      return;
    }
    /* The machine is now standing in ANOTHER MAP's doorway, so the panel it is
     * looking at is about a different level: force the poll and let the next slow
     * tick rebuild the list around where it actually is. The dip to black is
     * already running — dipToLevel() answers `lift:ride` directly. */
    liftAt = -2;
    liftSig = '';
  }

  /**
   * BUY THE NEXT LEVEL, FROM THE DOORWAY.
   *
   * This used to be unreachable — a level bought at depth had no station room
   * carved for it, so the plate was greyed unconditionally. Levels are separate
   * maps now: buying one does not touch the map you are standing in at all, it
   * just adds a stop the lift will accept. So BUY is live whenever the money is
   * there, it greys only on cash, its label never changes, and the shortfall goes
   * in the note line — the same rule the workshop and the prep screen follow.
   */
  function onLiftBuy(r) {
    var a = A();
    if (!a || !a.buyLevel || r.level < 0) return;
    if (SM.sound && SM.sound.play) SM.sound.play('ui');
    if (a.buyLevel(r.level)) {
      alert('LEVEL OPENED', String(r.name.textContent || '') + ' — the lift will take you down', 2.4);
      if (SM.effects && SM.effects.screenFlash) SM.effects.screenFlash(0.12, 255, 210, 120);
    } else {
      alert('THE SALE WAS REFUSED', 'The ledger will not cover it', 2.0);
    }
    liftSig = '';
  }

  /* --- the three surface verbs ---------------------------------------- */

  /** What SELL would bank right now: the hold plus anything already secured. */
  function doorSellValue() {
    var a = A();
    if (!a) return 0;
    var v = 0, i, list = (a.getManifest) ? a.getManifest() : null;
    if (list && typeof list.length === 'number') {
      for (i = 0; i < list.length; i++) if (list[i]) v += num(list[i].value, 0);
    }
    var sec = (a.getSecured) ? a.getSecured() : null;
    if (sec) v += num(sec.value, 0);
    return v;
  }

  function onDoorSell() {
    var a = A();
    if (!a || !a.sellAtDoor) return;
    var res = a.sellAtDoor();
    if (SM.sound && SM.sound.play) SM.sound.play('ui');
    if (!res) {
      alert('NOTHING TO SELL', 'The hold is empty', 1.8);
      return;
    }
    alert('BANKED', '$' + fmt(num(res.gross, 0)) + ' into the company account', 2.6);
    if (SM.effects && SM.effects.screenFlash) SM.effects.screenFlash(0.10, 255, 214, 120);
    liftSig = '';
    paintDoorActs();
  }

  function onDoorRefuel() {
    var a = A();
    if (!a || !a.refuelAtDoor) return;
    var got = a.refuelAtDoor();
    if (SM.sound && SM.sound.play) SM.sound.play('ui');
    if (!got) {
      alert('CANNOT REFUEL', 'The tank is full, or the ledger is empty', 2.0);
      return;
    }
    // Partial fills are legitimate: adv.js buys what the cash reaches.
    alert('REFUELLED', '$' + fmt(num(got.cost, 0)) + ' of diesel', 2.2);
    liftSig = '';
    paintDoorActs();
  }

  /**
   * LEAVE. Two-tap, because it is the only plate on this panel that ends the
   * expedition — and unlike ABORT it is not destructive (adv.leaveToMap() banks
   * whatever is aboard on the way out), so the confirm is about the navigation
   * and not about the money.
   */
  /**
   * ROLL OUT. adv.exitLift() opens the doors and drives the machine out to the
   * park, handing the stick back about a second later; the panel goes down NOW,
   * because the manoeuvre is the answer to the tap and nothing should be drawn
   * over it. (adv.js emits `lift:undocking` in the same call, which takes the
   * panel down on its own — this is belt and braces for a build where that event
   * does not exist yet.) In a build where adv.js has no lift interior at all,
   * this falls back to the old dismissal: the panel is an offer either way, and a
   * player who waves it away wants to be drilling.
   */
  function onDoorOut() {
    var a = A();
    if (SM.sound && SM.sound.play) SM.sound.play('ui');
    mapArmed = 0;
    if (a && a.exitLift && a.exitLift()) {
      liftAt = -2;
      liftSig = '';
      hideLift();
      return;
    }
    liftDismissed = liftAt;
    hideLift();
  }

  var mapArmed = 0;
  function onDoorMap() {
    var a = A();
    if (!a || !a.leaveToMap) return;
    if (SM.sound && SM.sound.play) SM.sound.play('ui');
    if (!mapArmed) {
      mapArmed = MAP_CONFIRM;
      paintDoorActs();
      return;
    }
    mapArmed = 0;
    if (!a.leaveToMap()) alert('THE LIFT WILL NOT MOVE', 'Drive into the doorway first', 2.0);
    // Leaving changes state, so onState() takes the whole HUD down from here.
  }

  /**
   * Paint the three plates. Called on the slow timer and after every verb, so it
   * is all guarded writes — the labels never move, only the value lines and the
   * disabled flags.
   */
  function paintDoorActs() {
    var a = A();
    if (!els.doorSell || !a) return;

    /* THE TWO NUMBERS THAT ARE THE DECISION. Both plates carry money and nothing
     * else, because that is what is being weighed — the manifest is already on
     * screen in the hold box and the tank is already a gauge. */
    var sellV = doorSellValue();
    setText('dsellv', els.doorSell.smVal, sellV > 0 ? ('$' + fmt(sellV)) : 'HOLD EMPTY');
    els.doorSell.disabled = !(sellV > 0);

    var q = (a.getDoorFuelQuote) ? a.getDoorFuelQuote() : null;
    var cost = num(q && q.cost, 0);
    var cash = num(a.getCash && a.getCash(), 0);
    setText('dfuelv', els.doorFuel.smVal, cost > 0 ? ('$' + fmt(cost)) : 'TANK FULL');
    els.doorFuel.disabled = !(cost > 0) || cash < 1;

    /* THE CALL TO ACTION SAYS WHERE IT PUTS YOU. "RETURN TO MINE" is the label
     * and it never moves; the value line names the level the doors are about to
     * open onto, which is the one fact a player about to be handed the controls
     * back actually wants confirmed. */
    var at = num(a.getLevel && a.getLevel(), 0);
    var hereL = (a.getLevelDef && at >= 1) ? a.getLevelDef(at) : null;
    setText('doutv', els.doorOut.smVal,
            at >= 1 ? ('L' + fmt(at) + '  ' + liftLabel(hereL, at)) : 'BACK TO THE ROCK');

    /* THE WORKSHOP PLATE CARRIES A PRICE TOO, so the row reads as three money
     * decisions rather than two and a door. The number is the CHEAPEST thing on
     * sale — "is there anything in here I can act on" is the question a player
     * standing in a lift is asking, and the cheapest price is the only single
     * number that answers it. It is not filtered by what they can afford: a shop
     * that hides its prices when you are broke is a shop you stop visiting. */
    if (els.doorShop) setText('dshopv', els.doorShop.smVal, cheapestPart());

    /* LEAVE is the one plate whose VALUE line changes, because the confirm has to
     * be visible somewhere and the label is not allowed to move. */
    setText('dmapv', els.doorMap.smVal, mapArmed > 0 ? 'CONFIRM' : 'TO THE MAP');
    setClass('dmaparm', els.doorMap, 'sm-ah-door-armed', mapArmed > 0);
  }

  /**
   * The lowest next-tier price across the eight part categories, as the
   * workshop plate's value line. 'ALL FITTED' when the machine is maxed out.
   *
   * Eight nextCost() calls, on the SLOW tick (8 Hz) and only while the lift
   * panel is up — this is not on any hot path. `canFit` is respected so a plate
   * cannot advertise an engine the tracks will refuse.
   */
  function cheapestPart() {
    var R = SM.rig;
    if (!R || !R.PART_KEYS || !R.nextCost) return 'FIT PARTS';
    var best = -1;
    for (var i = 0; i < R.PART_KEYS.length; i++) {
      var k = R.PART_KEYS[i];
      if (R.canFit && !R.canFit(k)) continue;
      var c = num(R.nextCost(k), -1);
      if (c < 0) continue;
      if (best < 0 || c < best) best = c;
    }
    return best < 0 ? 'ALL FITTED' : ('FROM $' + fmt(best));
  }

  /**
   * OPEN THE WORKSHOP WITHOUT ENDING THE RUN. adv.js owns whether that is legal
   * (it insists the machine is actually in the cage and not mid-manoeuvre); all
   * this does is ask, and say so if the answer is no.
   */
  function onDoorShop() {
    var a = A();
    if (!a || !a.openGarage) return;
    if (SM.sound && SM.sound.play) SM.sound.play('ui');
    if (!a.openGarage()) {
      alertKind('shop', 'NOT YET', 'Wait for the lift to finish docking', 1.8);
    }
  }

  function showLift() {
    if (liftOpen) return;
    liftOpen = true;
    setClass('lifton', els.lift, 'sm-ah-lift-on', true);
    // The banner has to move: it lives in this same band, and CARGO FULL over
    // the lift panel would cover the row that answers it.
    setClass('liftbump', els.root, 'sm-ah-lift-on', true);
    if (SM.sound && SM.sound.play) SM.sound.play('ui');
  }

  function hideLift() {
    if (!liftOpen) return;
    liftOpen = false;
    setClass('lifton', els.lift, 'sm-ah-lift-on', false);
    setClass('liftbump', els.root, 'sm-ah-lift-on', false);
    /* ONE PANEL SESSION PER UNLOCK. The box has been read (or waved away, which
     * is the player's right); coming back into the cage must not re-teach it.
     * adv.js has already persisted the reveal, so the ROW stays either way —
     * only the teaching goes.
     *
     * ...EXCEPT ACROSS A WORKSHOP TRIP, which is not the player leaving the
     * cage. The panel goes down because the whole HUD does, and adv.js has
     * ALREADY handed the notice over and cleared it at the source — so dropping
     * it here would destroy the progression gate's one piece of teaching,
     * permanently, for that rung, for the crime of tapping WORKSHOP while it was
     * on screen. `shopTrip` is that one exception and nothing else sets it. */
    if (liftUnlock && !shopTrip) { liftUnlock = 0; liftSig = ''; }
  }

  function refreshLift() {
    var a = A();
    // No door in this build: no panel, and nothing else in here ever runs.
    if (!a || !a.getBoardable || !a.getLevels) { hideLift(); return; }

    /* THE MENU BELONGS TO BEING INSIDE, NOT TO BEING NEAR.
     *
     * The owner's call, and it is the difference between a menu that pops at
     * arm's length and a lift you drive into: proximity only opens the doors
     * (js/advterrain.js animates that off the machine's distance), and the panel
     * waits for the machine to be IN the cage. adv.isInLift() is the flag; a
     * build without it falls back to the door circle so this file still works
     * against a half-landed seam.
     *
     * AND "IN THE CAGE" NOW MEANS "the docking manoeuvre finished". That flag is
     * false for the whole second the lift spends driving the machine in, and
     * false again from the frame it starts driving it out, so this poll raises
     * the panel on the frame the doors finish closing and drops it on the frame
     * they start to open — without knowing that either thing exists. */
    var at = -1;
    if (a.isInLift) at = a.isInLift() ? num(a.getLevel && a.getLevel(), 1) : -1;
    else at = num(a.getBoardable(), -1);
    if (at !== liftAt) {
      liftAt = at;
      /* Leaving the cage and stepping back into it is a NEW visit: a dismissal
       * only ever applied to the one it was made on. (With adv.exitLift() wired,
       * dismissal IS leaving, so this is belt and braces.) */
      liftDismissed = -1;
      liftSig = '';
      mapArmed = 0;
    }
    if (at < 0 || liftDismissed === at) { hideLift(); return; }

    var levels = a.getLevels();
    if (!levels || typeof levels.length !== 'number' || !levels.length) { hideLift(); return; }
    showLift();

    // The three plates are cheap and their numbers move with every collected
    // fragment, so they repaint on every slow tick rather than off the signature.
    paintDoorActs();

    /* THE UNLOCK NOTICE, TAKEN AND CLEARED IN ONE MOVE.
     *
     * adv.js has already written and saved the fact that this rung is revealed,
     * so clearing it here cannot lose anything — and taking it the moment the
     * panel is up is what makes the box "one time per unlock" rather than "every
     * time you open the lift". It is held in `liftUnlock` for the life of this
     * panel session and dropped by hideLift().
     *
     * The player can be told OUT of the cage — a strand's results screen can bank
     * the sale that opens the gate — so a pending notice simply waits until they
     * are somewhere it is actionable, which is here. */
    if (a.getUnlockNotice) {
      var un = a.getUnlockNotice();
      if (un && num(un.level, 0) >= 1) {
        liftUnlock = num(un.level, 0);
        liftUnlockName = String(un.name || '').toUpperCase();
        liftUnlockPrice = num(un.price, 0);
        liftSig = '';
        if (a.clearUnlockNotice) a.clearUnlockNotice();
        if (SM.sound && SM.sound.play) SM.sound.play('sparkle');
      }
    }

    var cash = num(a.getCash && a.getCash(), 0);
    var i, L, nextI = -1;
    for (i = 0; i < levels.length; i++) {
      if (levels[i] && !levels[i].owned) { nextI = num(levels[i].i, i + 1); break; }
    }
    var nextL = (nextI >= 1) ? levels[nextI - 1] : null;
    var nextPrice = nextL ? num(nextL.price, 0) : 0;
    /* THE PROGRESSION GATE. Until it opens on the next level down, that level —
     * and every level under it — is not on this list at all: no row, no price,
     * no greyed tease. See js/adv.js's note above buyLevel for the rule, and
     * js/advui.js's paintPrepLift for why the whole unowned tail goes rather
     * than just its head (a list with a hole in it teases louder than the row it
     * replaced). */
    var gateOpen = !!(nextL && levelOffered(nextL, nextI));

    /* The change-detector, same discipline as the manifest: one cheap string
     * covering everything a repaint could alter, so the array walk below only
     * happens when the list has actually moved. Affordability is in it because
     * BUY greys out on cash, which the player can change from this very panel;
     * the gate is in it because it changes which rows EXIST. */
    var sig = at + '/' + levels.length + '/' + nextI + '/' + (cash >= nextPrice ? 'y' : 'n') +
              '/' + (gateOpen ? 'g' : '-') + '/' + liftUnlock + '/';
    for (i = 0; i < levels.length; i++) {
      L = levels[i];
      if (!L) continue;
      sig += (L.owned ? 'o' : 'x') + Math.round(num(L.depthTopM, num(L.depthM, 0))) +
             ':' + Math.round(num(L.price, 0)) + '|';
    }
    if (sig === liftSig) return;
    liftSig = sig;

    var here = levels[at - 1];
    /* THE HEAD NAMES THE PLACE. A level reads as one depth now, so the header is
     * where you are and how deep that is — the same string shape the rows use. */
    setText('liftwhere', els.liftWhere,
            'LEVEL ' + fmt(at) + '  ·  ' + liftLabel(here, at) + '  ·  ' + bandText(here));

    /* THE INSTRUCTION BOX. Written before the list, because it is about the list
     * and the eye should meet it first. */
    setClass('unlockon', els.unlock, 'sm-ah-unlock-on', liftUnlock >= 1);
    if (liftUnlock >= 1) {
      setText('unlockt', els.unlockTitle, 'THE LIFT WILL GO DEEPER');
      setText('unlockb', els.unlockBody,
              'You have worked this level and the ledger covers it. LEVEL ' +
              fmt(liftUnlock) + ' — ' + liftUnlockName + ' is now for sale at $' +
              fmt(liftUnlockPrice) + '. Buy it below, then ride down: richer rock, ' +
              'same lift.');
    }

    var used = 0, r, lvl;

    /* THE LEVELS YOU CAN GO TO, IN LIFT ORDER — the ones you own ride, and the
     * next one down is for sale ONLY once the gate has opened on it. Everything
     * below that is SEALED and is a read, not a control. There is no surface row
     * any more: the surface is UI, and the trade plates above are what it used to
     * be for. */
    for (i = 0; i < levels.length; i++) {
      L = levels[i];
      if (!L) continue;
      lvl = num(L.i, i + 1);
      var owned = !!L.owned;
      var isNext = (lvl === nextI);
      // THE GATE, IN ONE LINE: an unowned level is not drawn at all until the
      // next one down has been earned.
      if (!owned && !gateOpen) continue;
      // Nothing past the next one is offered: the lift is extended downward, so
      // there is no skipping ahead to pay for. Deeper rows are a READ.
      var dress = owned ? (lvl === at ? ' sm-ah-liftrow-here' : '')
                        : (isNext ? ' sm-ah-liftrow-next' : ' sm-ah-liftrow-sealed');

      r = liftRow(used++);
      var kx = used - 1;
      r.level = lvl;
      r.node.style.display = '';
      r.node.className = 'sm-ah-liftrow' + dress;
      setText('lfn' + kx, r.name, 'L' + fmt(lvl) + '  ' + liftLabel(L, lvl));
      setText('lfd' + kx, r.dep, bandText(L));
      setText('lft' + kx, r.tag,
              owned ? (lvl === at ? 'HERE' : 'RIDE')
                    : (isNext ? ('$' + fmt(num(L.price, 0))) : 'SEALED'));
      // You cannot ride to the level you are standing in, and an unowned level
      // is not a destination at all — only its BUY takes a tap.
      r.go.disabled = !owned || lvl === at;
      if (isNext) {
        r.buy.style.display = '';
        /* BUY IS LIVE FROM DOWN HERE. A level is its own map now, so buying one
         * does not touch the map the machine is standing in — it just adds a
         * stop the lift accepts. It greys only on cash, the label never changes,
         * and the shortfall goes in the note line. getLevel() deliberately does
         * not move: the new level has to be RIDDEN to, and the repaint (the
         * signature covers ownership) puts the ridable row up the moment the
         * purchase lands. */
        r.buy.disabled = (nextPrice - cash) > 0;
      } else {
        r.buy.style.display = 'none';
      }
    }

    /* THE NOTE LINE IS WHERE EVERY REASON GOES. Priority order: what the ledger
     * is short of, then what the next level costs, then what the doors are for. */
    /* ONE LEAD AND ONE TAIL, AND NEITHER IS ALLOWED TO REPEAT THE OTHER.
     *
     * The lead is what the hold is worth, because that is the live number and it
     * changes with every fragment collected. The tail is the standing reason —
     * what the ledger is short of, or what the doors are for.
     *
     * THE TAIL MUST NOT LEAK THE GATE. While the next level is hidden there is
     * nothing to be short of and nothing to save for; quoting a shortfall would
     * put the price on screen by the back door, which is the exact thing the
     * gate exists to prevent. And on the one visit where the unlock box is up,
     * the box has already said the name, the price and what to do about it in
     * bigger type and in gold — so the tail stands down entirely rather than
     * saying it again six pixels lower in grey.
     *
     * The generic "the doors are the surface" line is the tail ONLY when the
     * lead is absent: with a hold to sell, "SELL BANKS $600" has already made
     * the same point better, and printing both puts the word SELL on the line
     * twice. */
    var sellV = doorSellValue();
    var lead = sellV > 0 ? ('SELL BANKS $' + fmt(sellV) + ' AND ROLLS THE DAY.') : '';
    var tail;
    if (!nextL) tail = 'EVERY LEVEL OF THIS MINE IS OPEN.';
    else if (!gateOpen || liftUnlock >= 1) tail = '';
    else if ((nextPrice - cash) > 0) {
      tail = 'NEED $' + fmt(nextPrice - cash) + ' MORE FOR ' + liftLabel(nextL, nextI) + '.';
    } else {
      tail = liftLabel(nextL, nextI) + ' COSTS $' + fmt(nextPrice) + ' — BUY IT FROM HERE.';
    }
    if (!lead && !tail) tail = 'THE DOORS ARE THE SURFACE — SELL, REFUEL, AND BACK TO WORK.';
    setText('liftnote', els.liftNote,
            (lead && tail) ? (lead + '  ' + tail) : (lead || tail));

    for (i = used; i < liftRows.length; i++) {
      if (liftRows[i]) {
        liftRows[i].node.style.display = 'none';
        liftRows[i].level = -1;
      }
    }
  }

  /* =====================================================================
   * THE RIDE TRANSITION
   * ---------------------------------------------------------------------
   * A ride between levels is a MAP LOAD, and it has to read as one or the world
   * appears to teleport: same machine, same doorway, different rock.
   *
   * IT GOES BLACK INSTANTLY AND THEN FADES BACK. Not a fade to black — a dip.
   * adv.js emits `lift:ride` BEFORE it swaps the band, so the class lands in the
   * same JS turn as the swap and no frame of the new world is ever shown
   * un-blacked. Then the splash holds, then the black fades off over ~0.6 s.
   *
   * WHY DOM AND NOT js/effects.js. effects.screenFlash() is ADDITIVE (measured:
   * effects.js:1479 composites 'lighter'), so it can only ever brighten the
   * screen — a black flash there is a no-op. This is one absolutely-positioned
   * div with a CSS transition, it costs nothing while it is off, and it can carry
   * the level's name, which a canvas flash cannot.
   *
   * THE TIMERS ARE setTimeout, NOT THE FIXED STEP. update() is gated by the
   * simulation, and the one thing this must survive is the player hitting PAUSE
   * halfway through a ride — a transition frozen at full black with no way out is
   * a bug report, not an effect.
   * ================================================================== */
  var rideT1 = 0, rideT2 = 0;

  function dipToLevel(p) {
    if (!built || !els.ride) return;
    var a = A();
    var to = num(p && p.to, 0);
    var L = (a && a.getLevelDef) ? a.getLevelDef(to) : null;
    if (!L && a && a.getLevels) {
      var list = a.getLevels();
      if (list && list.length && to >= 1 && to <= list.length) L = list[to - 1];
    }

    els.rideKicker.textContent = 'LIFT  ·  LEVEL ' + fmt(to);
    els.rideTitle.textContent = L ? liftLabel(L, to) : ('LEVEL ' + fmt(to));
    els.rideSub.textContent = L ? bandText(L) : '';

    if (rideT1) { clearTimeout(rideT1); rideT1 = 0; }
    if (rideT2) { clearTimeout(rideT2); rideT2 = 0; }

    /* BLACK NOW, no transition: .sm-ah-ride-cut kills the transition for exactly
     * as long as it takes the class to apply, so the swap underneath is never
     * visible. The fade-out is the transition on .sm-ah-ride-on coming off. */
    els.ride.classList.add('sm-ah-ride-cut');
    els.ride.classList.add('sm-ah-ride-on');
    if (SM.sound && SM.sound.play) SM.sound.play('ui');

    rideT1 = setTimeout(function () {
      rideT1 = 0;
      els.ride.classList.remove('sm-ah-ride-cut');
      els.ride.classList.remove('sm-ah-ride-on');
    }, RIDE_HOLD_MS);
    rideT2 = setTimeout(function () {
      rideT2 = 0;
      // Belt and braces: if a class write was lost to a reset mid-ride, the
      // overlay must not be the thing left covering the mine.
      els.ride.classList.remove('sm-ah-ride-cut');
      els.ride.classList.remove('sm-ah-ride-on');
    }, RIDE_HOLD_MS + RIDE_FADE_MS + 120);
  }

  function clearRide() {
    if (rideT1) { clearTimeout(rideT1); rideT1 = 0; }
    if (rideT2) { clearTimeout(rideT2); rideT2 = 0; }
    if (els.ride) {
      els.ride.classList.remove('sm-ah-ride-cut');
      els.ride.classList.remove('sm-ah-ride-on');
    }
  }

  /* =====================================================================
   * THE SCANNER LINE
   * ================================================================== */
  /**
   * THE SCANNER HAS NO HUD LINE ANY MORE.
   *
   * It used to show the headline contact as a bearing arrow and a distance just
   * above the hold. Combined with the banner it raised, the instrument spent most
   * of its time obscuring the very readout you consult in order to act on it.
   *
   * Everything it said is now said better in the world: js/scanner.js draws a
   * labelled arrow out of the machine per contact, boldest for the most valuable,
   * pointing at where the ore actually is. This function stays as a no-op rather
   * than being deleted so the slow-timer call site and the element cache do not
   * have to change shape.
   */
  function refreshScanner() {
    if (els.scan) setClass('scanon', els.scan, 'sm-ah-scan-on', false);
    return;
    /* eslint-disable no-unreachable */
    var s = SM.scanner;
    var best = (s && s.isEnabled && s.isEnabled() && s.getBest) ? s.getBest() : null;
    if (!best) return;

    var d = displayOf(best.matIndex, best.matId);
    setText('scant', els.scanText, (d.name || 'SIGNATURE').toUpperCase() + ' SIGNATURE');
    var dist = num(best.dist, 0) * M_PER_UNIT;
    setText('scand', els.scanDist, Math.round(dist) + ' m');
    // bearing is radians, 0 = straight down the shaft the machine is facing.
    var deg = Math.round(num(best.bearing, 0) * 180 / Math.PI);
    setVar('scanb', els.scanArrow, '--sm-ah-bearing', deg + 'deg');
    setVar('scanc', els.scan, '--sm-ah-sw', d.color);
  }

  /* =====================================================================
   * ALERTS — the short banner
   * ================================================================== */
  /** A short banner: 'CARGO FULL', 'FUEL RESERVE', 'UNKNOWN SIGNATURE'. */
  function alert(title, sub, seconds) {
    if (!built || !els.alert) return;
    els.alertTitle.textContent = title || '';
    els.alertSub.textContent = sub || '';
    retrigger(els.alert, 'sm-ah-alert-on');
    alertTimer = seconds || ALERT_TIME;
  }

  /** Rate-limited alert, one clock per kind. Events underground are bursty. */
  function alertKind(kind, title, sub, seconds) {
    if (alertClock[kind] !== undefined && alertClock[kind] < ALERT_GAP) return;
    alertClock[kind] = 0;
    alert(title, sub, seconds);
  }

  /* =====================================================================
   * LIFECYCLE
   * ================================================================== */
  function init() {
    if (!built) build();
    if (!subscribed) {
      subscribed = true;
      /* The HUD (and the joystick with it) follows the state machine rather
       * than waiting to be told: adv.js may well call show()/hide() as well,
       * and both are idempotent, so whichever arrives first wins and the
       * other is free. */
      SM.events.on('adv:state', onState);
      SM.events.on('game:paused', onGamePaused);
      SM.events.on('sound:muted', refreshMute);
      SM.events.on('adv:cargofull', function () {
        alertKind('full', 'HOLD FULL', 'Dump the spoil or head for the surface', 2.6);
      });
      SM.events.on('adv:fuellow', function (p) {
        var pct = Math.round(num(p && p.pct, 0) * 100);
        alertKind('fuel', 'FUEL LOW', pct + '% left  ·  check the reserve mark', 2.8);
      });
      SM.events.on('adv:damage', function (p) {
        alertKind('dmg', 'HULL DAMAGE', String((p && p.source) || 'impact').toUpperCase(), 1.8);
      });
      SM.events.on('adv:heat', function (p) {
        if (num(p && p.pct, 0) < 0.9) return;
        alertKind('heat', 'OVERHEATING', 'Back off the rock and let it cool', 2.2);
      });
      SM.events.on('mine:layer', function (p) {
        if (!p || !p.name) return;
        alertKind('layer', String(p.name).toUpperCase(),
                  Math.round(num(p.depthM, 0)) + ' m  ·  new stratum', 2.2);
      });
      /* --- "TOO HARD FOR THIS DRILL" -------------------------------------
       * The one thing in the mine that a player cannot work out by looking at
       * it. Sparks and a dead stop say "something is wrong"; only a caption can
       * say WHICH rock, WHY, and that there is a fix and where it is sold.
       *
       * IT IS A BANNER AND NOT A PANEL, deliberately. The machine is still
       * driveable — the correct response is usually to steer around the thing —
       * so anything modal would be taking the wheel away to tell the player they
       * still have it. This is the same short amber banner as a low tank.
       *
       * THE RATE LIMIT IS THE EMITTER'S, NOT OURS. vehicle.js fires
       * `drill:toohard` once per contact episode and never twice for the same
       * material inside its quiet period (see ADV_TOOHARD_SAY there), so the
       * banner, the clank and the bounce sparks cannot disagree about how often
       * the game mentions this. alertKind()'s own 1.2 s floor stays as a net.
       *
       * Building strings here is fine and would not be in a hot handler: this
       * fires on the order of once every several seconds at worst, against
       * `material:destroyed`'s ~150 per step.
       *
       * TWO WALLS, TWO SENTENCES. A cap refusal is an invitation to spend money.
       * The level SEAL is not — no drill in the shop cuts it, the lift is the
       * only way through — so telling the player to upgrade there would be
       * selling them something that does not exist. vehicle.js flags which. */
      SM.events.on('drill:toohard', function (p) {
        if (!p) return;
        var d = displayOf(p.matIndex, null);
        var name = (d.name || 'THIS ROCK').toUpperCase();
        if (p.seal) {
          alertKind('seal', name + ' — THE LEVEL ENDS HERE',
                    'The lift is the only way between levels', 2.6);
          return;
        }
        var h = num(p.hardness, 0), cap = num(p.cap, 0);
        /* The sub carries the two numbers because "too hard" on its own is a
         * verdict and these are the evidence — and because they are what the
         * workshop's drill card is quoting when the player gets there. Kept
         * short enough to hold ONE line on a phone; see the compact banner rule
         * in style-adventure.css for the width it has to live inside. */
        alertKind('toohard', name + ' — TOO HARD FOR THIS DRILL',
                  'Hardness ' + h.toFixed(1) + ' · bit cuts ' + cap.toFixed(1)
                  + ' · upgrade in the workshop', 2.8);
      });
      /* NO SCANNER BANNERS. `scan:contact` and `mine:lode` used to raise the
       * alert banner, and between them they fired often enough to sit over the
       * hold more or less permanently in ore-rich ground — so the instrument was
       * covering the readout the player needed in order to act on it.
       *
       * The scanner now speaks ONLY through the arrows js/scanner.js draws out of
       * the machine: direction, mineral and distance, in the world, where the ore
       * actually is. Nothing about it interrupts the HUD.
       *
       * The events are deliberately left un-subscribed rather than deleted at the
       * source: advterrain.js and scanner.js still emit them, so anything else
       * (a future log, a sound cue) can listen without re-plumbing. The
       * motherlode keeps its screen flash, which is in the world and not over the
       * hold — losing the payoff moment entirely would be a worse trade. */
      SM.events.on('mine:lode', function () {
        if (SM.effects && SM.effects.screenFlash) SM.effects.screenFlash(0.16, 255, 214, 120);
        if (SM.sound && SM.sound.play) SM.sound.play('ui');
      });
      /* THE RIDE. adv.js emits this BEFORE it swaps the band, so the screen is
       * already black by the time the new level exists — see dipToLevel(). */
      SM.events.on('lift:ride', dipToLevel);
      /* ENTERING THE CAGE. The menu is the signal — no banner, because the panel
       * arriving IS the announcement and a banner on top of it would be the
       * instrument covering the readout again (see the scanner note below). The
       * poll would find this within an eighth of a second anyway; forcing the
       * signature makes the panel land on the frame the doors close. */
      SM.events.on('lift:entered', function () {
        liftAt = -2;
        liftSig = '';
        mapArmed = 0;
      });
      /* LEAVING THE CAGE STARTS WHEN THE DOORS DO, not when the machine is out.
       * `lift:undocking` is the frame the leaves begin to part, and the panel has
       * to be gone by then — it is a menu about a lift you are no longer standing
       * in, drawn over the one shot the manoeuvre exists to show. Waiting for the
       * poll would leave it up for an eighth of a second of that second, which is
       * exactly the frames the doors are opening in.
       *
       * `lift:exited` still clears too. The two are not redundant: an undocking
       * can be abandoned (a strand, a teardown) without ever exiting, and an
       * arrival exits without this file having seen an entry. Clearing on both is
       * what makes either order safe. */
      SM.events.on('lift:undocking', function () {
        liftAt = -2;
        liftSig = '';
        mapArmed = 0;
        hideLift();
      });
      SM.events.on('lift:exited', function () {
        liftAt = -2;
        liftSig = '';
        mapArmed = 0;
        hideLift();
      });
      /* A LEVEL BOUGHT ANYWHERE REPAINTS THE LIST. The purchase can only come
       * from this panel today, but the prep screen and the map own the same verb
       * and the signature is what keeps them in step. */
      SM.events.on('lift:bought', function () { liftSig = ''; });
      window.addEventListener('keydown', onKeyDown, false);
      window.addEventListener('blur', function () {
        if (els.btnAbort && els.btnAbort.smDisarm) els.btnAbort.smDisarm();
      }, false);
    }
    refreshMute();
  }

  function onState(p) {
    var st = (p && p.state) || (SM.adv && SM.adv.getState ? SM.adv.getState() : 'off');
    /* THE WORKSHOP OVER A LIVE RUN IS A ROUND TRIP, not an exit. Latched BEFORE
     * hide() runs, because hide() is what would otherwise eat the unlock notice
     * on the way down (see hideLift()). Cleared as the panel comes back up. */
    if (st === 'garage' && SM.adv && SM.adv.isShopHold && SM.adv.isShopHold()) {
      shopTrip = true;
    }
    if (st === 'mine') {
      show();
      if (SM.joystick && SM.joystick.show) SM.joystick.show();
      /* COMING BACK FROM THE WORKSHOP, THE PANEL HAS TO COME BACK WITH US. The
       * player left it up; they did not dismiss it, and dropping them back into
       * a cage with no menu would be a soft lock with a machine they cannot see.
       * show() -> reset() already clears liftDismissed and the signature, so all
       * this has to do is stop suppressing the notice; the next slow tick
       * (<=125 ms) finds isInLift() still true and raises the panel. */
      shopTrip = false;
    } else {
      hide();
      if (SM.joystick && SM.joystick.hide) SM.joystick.hide();
    }
  }

  /** Build/attach and reveal. Called when a descent begins. */
  function show() {
    if (!built) build();
    if (!els.root || visible) return;
    visible = true;
    reset();
    els.root.classList.add('sm-ah-on');
    els.btns.classList.add('sm-ah-on');
    refreshMute();
  }

  function hide() {
    if (!built) return;
    visible = false;
    closePause(true);
    // The door menu and the ride overlay are SIBLINGS of .sm-ah, so neither
    // fades out with it — a run that ends mid-transition must not leave the
    // world map behind a black screen.
    hideLift();
    clearRide();
    els.root.classList.remove('sm-ah-on');
    els.btns.classList.remove('sm-ah-on');
  }

  function reset() {
    last = {};
    manifestSig = ' ';       // not '' — an empty hold must still repaint
    alertTimer = 0;
    alertClock = {};
    lodeHold = 0;
    dumpArmed = -1;
    dumpTimer = 0;
    slowTimer = 0;
    if (els.alert) els.alert.classList.remove('sm-ah-alert-on');
    // A fresh descent starts with the drawer shut over a clear view of the
    // shaft. paintDrawer() runs AFTER last = {} above, so the write lands.
    drawerOpen = false;
    paintDrawer();
    /* THE DOOR MENU STARTS THE RUN CLOSED — AND STAYS CLOSED.
     * -2 rather than -1 so the very first poll always registers as a change and
     * the panel is painted from scratch. A descent no longer lands in the cage:
     * it lands IN IT and immediately drives OUT (js/adv.js undocks the arrival),
     * so isInLift() is false from the first poll onward and the run opens on the
     * rock rather than on a panel. The menu is what ENTERING the lift looks like,
     * and the player has not entered anything yet.
     * liftOpen is forced true so the hideLift() below writes through the
     * freshly-cleared `last` cache instead of being guarded out. */
    liftAt = -2;
    liftSig = '';
    liftDismissed = -1;
    liftOpen = true;
    mapArmed = 0;
    hideLift();
    clearRide();
  }

  /* =====================================================================
   * UPDATE — inside the fixed step. Read the rules at the top of the file.
   * ================================================================== */
  function update(dt) {
    if (!visible || !built) return;
    var a = A();
    if (!a) return;

    /* --- timers ------------------------------------------------------- */
    if (alertTimer > 0) {
      alertTimer -= dt;
      if (alertTimer <= 0) els.alert.classList.remove('sm-ah-alert-on');
    }
    if (lodeHold > 0) {
      lodeHold -= dt;
      if (lodeHold <= 0) setClass('lode', els.alert, 'sm-ah-alert-lode', false);
    }
    for (var k in alertClock) if (alertClock.hasOwnProperty(k)) alertClock[k] += dt;
    if (dumpArmed >= 0) {
      dumpTimer -= dt;
      if (dumpTimer <= 0) { dumpArmed = -1; paintDumpArm(); }
    }
    // The door menu's LEAVE confirm re-arms itself, exactly as ABORT does: a
    // stale CONFIRM sitting there waiting for a tap is how a player leaves a run
    // they meant to keep.
    if (mapArmed > 0) {
      mapArmed -= dt;
      if (mapArmed <= 0) { mapArmed = 0; paintDoorActs(); }
    }

    /* --- how far back the door is, and the company balance -------------- */
    /* THREE SOURCES, BEST FIRST. adv.js exports getDistanceToExitM() precisely
     * so a gauge does not have to know about METERS_PER_UNIT; getDistanceToExit()
     * in world units is the same number needing one multiply; and DEPTH is the
     * last resort, because a partial adv.js without either getter would otherwise
     * pin this cell to 0 m and quietly tell the player they are standing in the
     * doorway. Before the lift the two were the same thing anyway — the mouth was
     * the only exit. */
    var exitM = num(a.getDistanceToExitM && a.getDistanceToExitM(), -1);
    if (exitM < 0) {
      var toExit = num(a.getDistanceToExit && a.getDistanceToExit(), -1);
      exitM = (toExit >= 0) ? toExit * M_PER_UNIT : num(a.getDepthM && a.getDepthM(), 0);
    }
    setText('depth', els.depth, fmt(exitM) + ' m');
    /* Was TO SURFACE, which is the same number as DEPTH — the mouth is depth 0.
     *
     * The save record is a FALLBACK on purpose. Every other reading here comes
     * from one place, but a stale cached adv.js that predates getCash() would
     * make this the only gauge on the panel silently pinned to $0, and the
     * company balance is also written on the record, so there is a second
     * source available for free. */
    var cashNow = num(a.getCash && a.getCash(), -1);
    if (cashNow < 0) {
      var rec = (SM.save && SM.save.get) ? SM.save.get() : null;
      cashNow = num(rec && rec.cash, 0);
    }
    setText('funds', els.funds, '$' + fmt(cashNow));

    /* --- FUEL, the gauge the whole mode turns on ----------------------- */
    var cap = num(a.getFuelCap && a.getFuelCap(), 1);
    if (cap <= 0) cap = 1;
    var fuel = num(a.getFuel && a.getFuel(), 0);
    var pct = num(a.getFuelPct && a.getFuelPct(), fuel / cap);
    if (pct < 0) pct = 0; else if (pct > 1) pct = 1;
    var reserve = num(a.getReserveNeeded && a.getReserveNeeded(), 0);
    var burn = num(a.getBurnRate && a.getBurnRate(), 0);

    setText('fpct', els.fuelPct, Math.round(pct * 100) + '%');
    setVar('ffill', els.fuelFill, '--sm-ah-fill', pct.toFixed(3));
    var resFrac = reserve / cap;
    if (resFrac < 0) resFrac = 0; else if (resFrac > 1) resFrac = 1;
    setVar('fmark', els.fuelMark, '--sm-ah-mark', resFrac.toFixed(3));
    setClass('fmarkon', els.fuelMark, 'sm-ah-bar-mark-on', reserve > 0);

    var crit = (reserve > 0 && fuel <= reserve * CRIT_MARGIN) || pct <= 0.06;
    var warnState = !crit && ((reserve > 0 && fuel <= reserve * WARN_MARGIN) || pct <= LOW_PCT);
    setClass('fwarn', els.fuelPanel, 'sm-ah-warn', warnState);
    setClass('fcrit', els.fuelPanel, 'sm-ah-crit', crit);
    setText('fnote', els.fuelNote,
            crit ? 'RESERVE SPENT' : (warnState ? 'TURN BACK' : ''));

    // The sub line is the arithmetic the player would otherwise do in their
    // head: what the trip home costs, and how long the tank lasts at this draw.
    // Three writes rather than one string, so the rail can keep the first part
    // and drop the rest — the separators come from CSS (see build()).
    setText('fhome', els.fuelHome, fmt(reserve) + 'u');
    setText('fburn', els.fuelBurn, burn > 0.001 ? ('BURN ' + burn.toFixed(1) + '/s') : '');
    setText('fleft', els.fuelLeft, burn > 0.001 ? (Math.round(fuel / burn) + 's LEFT') : '');

    /* --- the hold ------------------------------------------------------ */
    var ccap = num(a.getCargoCap && a.getCargoCap(), 1);
    if (ccap <= 0) ccap = 1;
    var cargo = num(a.getCargo && a.getCargo(), 0);
    var cpct = num(a.getCargoPct && a.getCargoPct(), cargo / ccap);
    if (cpct < 0) cpct = 0; else if (cpct > 1) cpct = 1;
    setText('cnow', els.cargoNow, fmt(cargo));
    setText('ccap', els.cargoCap, ' / ' + fmt(ccap));
    setVar('cfill', els.cargoFill, '--sm-ah-fill', cpct.toFixed(3));
    setClass('cfull', els.cargoPanel, 'sm-ah-full', cpct > 0.995);

    /* --- heat and integrity: absent until they matter ------------------ */
    var hpct = num(a.getHeatPct && a.getHeatPct(), 0);
    var heatLive = hpct > HEAT_SHOW;
    setClass('hon', els.heatCell, 'sm-ah-live', heatLive);
    if (heatLive) {
      setText('hval', els.heat, Math.round(hpct * 100) + '%');
      setVar('hfill', els.heatBar, '--sm-ah-fill', hpct.toFixed(3));
      setClass('hhot', els.heatCell, 'sm-ah-hot', hpct > 0.8);
    }
    /* HULL IS ALWAYS ON SHOW, even at 100%.
     * It used to appear only once damaged, on the same "no dead gauges" rule as
     * HEAT. That reasoning does not hold for the hull: unlike heat, it does not
     * reset between descents, repairing it costs money at the surface, and going
     * down at 100% is a materially different proposition from going down at 40%.
     * A player needs to be able to check it BEFORE it becomes a problem, and a
     * gauge that only exists once you are already in trouble cannot be checked. */
    var integ = num(a.getIntegrity && a.getIntegrity(), 1);
    setClass('ion', els.integCell, 'sm-ah-live', true);
    setText('ival', els.integ, Math.round(integ * 100) + '%');
    setVar('ifill', els.integBar, '--sm-ah-fill', integ.toFixed(3));
    setClass('ihot', els.integCell, 'sm-ah-hot', integ < 0.35);

    /* --- the array walkers, on their own clock ------------------------- */
    slowTimer += dt;
    if (slowTimer >= 1 / SLOW_HZ) {
      slowTimer = 0;
      refreshManifest();
      /* THE LIFT IS POLLED HERE AND NOWHERE ELSE. getBoardable() is a question
       * about where the machine is standing; asking it 60 times a second would
       * cost an array walk per fixed step to answer a question that changes at
       * crawling speed. refreshManifest() runs first on purpose — it publishes
       * the hold's height, which is what keeps the panel off the hold. */
      refreshLift();
      refreshScanner();
      if (pauseOpen) paintPauseStats();
    }
  }

  function isVisible() { return visible; }
  function isPaused() { return pauseOpen; }

  return {
    init: init,
    show: show,
    hide: hide,
    reset: reset,
    update: update,
    isVisible: isVisible,
    alert: alert,
    /* --- additions ---------------------------------------------------- */
    isPaused: isPaused,
    openPause: openPause,
    closePause: closePause
  };
})();
