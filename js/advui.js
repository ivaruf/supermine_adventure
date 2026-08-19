/* =============================================================================
 * SUPERMINE ADVENTURE — js/advui.js
 * -----------------------------------------------------------------------------
 * EVERYTHING THAT IS NOT THE MINE. Five screens, all DOM, all built at runtime
 * into #ui-root exactly the way js/ui.js builds the classic HUD.
 *
 * ---------------------------------------------------------------------------
 * THE SCREENS
 *
 * SLOTS — three mining companies.
 *     NEW GAME, or resume a slot showing company / day / cash / machine tier /
 *     mines owned. Erase needs a confirm. This is the first thing a player sees
 *     after tapping ADVENTURE, so it reads like a ledger, not a settings dialog.
 *
 * MAP — the interactive world map, and the heart of the meta game.
 *     Pins for every mine in SM.mines.getAll(), placed at mapX/mapY, over
 *     regions that reveal themselves as the company grows. A pin you own reads
 *     differently from one you can buy, and one you cannot afford differently
 *     again. Tapping a pin opens the mine card, which puts the player's ACTUAL
 *     drill power next to the recommendation — "you can enter, but it will
 *     hurt" is a more interesting message than a locked door. The map is also
 *     where the WORKSHOP door lives.
 *
 * GARAGE — the workshop, and it is not a list of stat lines.
 *     The machine is DRAWN, large, and the eight parts are hotspots ON it.
 *     The drawing is the REAL vehicle renderer (SM.vehicle.render) called into
 *     a garage transform, not a second illustration: js/vehicle.js already
 *     builds every part off SM.rig.getPartFlags(), so this screen cannot drift
 *     from the machine the player actually drives — and watching the pathetic
 *     starting drill become an industrial monster IS the progression.
 *
 * PREP — the last screen before the dark.
 *     Buy fuel on a slider, read the strata you are about to drive through,
 *     repair the hull, and commit. DESCEND is the point of no return.
 *
 * RESULTS — the payoff.
 *     The manifest, line by line, counting up into a total, because this is the
 *     screen that has to make a full hold feel good. And it is honest about a
 *     bad run: a strand shows what was lost and how deep, because that is what
 *     turns "I'll come back for it" into a plan.
 *
 * ---------------------------------------------------------------------------
 * HOW IT IS DRIVEN
 *   js/adv.js owns the state machine and emits `adv:state` {state, prev} on
 *   every transition. This module reacts to THAT and nothing else: a button
 *   calls a verb on SM.adv and the resulting `adv:state` is what opens the next
 *   screen. One direction of control, one source of truth.
 *
 *   THE ONE CONCESSION: a 4 Hz watchdog reconciles the visible screen against
 *   SM.adv.getState() while the campaign is active. It is not a second state
 *   machine — it holds no state of its own and only ever copies adv's — it is
 *   there because a missed or late event would otherwise leave the player
 *   looking at a black screen with no way back, which is the single worst
 *   failure this module can have.
 *
 *   Unlike advhud.js these screens are STATIC between clicks and main.js is not
 *   stepping the simulation behind them (SM.adv.holdsSim()), so they may
 *   measure and allocate freely. The results count-up runs its own rAF loop for
 *   exactly that reason.
 * ========================================================================== */

var SM = SM || {};

SM.advui = (function () {
  'use strict';

  /* ----- Tunables live here ----------------------------------- */

  var TOAST_TIME     = 2.6;    // seconds a toast lingers
  var SYNC_MS        = 250;    // watchdog period (see "HOW IT IS DRIVEN")
  var GARAGE_VIEW_H  = 420;    // world units of machine framed by the garage
  var GARAGE_MIN_S   = 0.22;   // never shrink the machine past this scale
  var COUNT_ROW_MS   = 460;    // count-up duration for one manifest line
  var COUNT_STAGGER  = 105;    // ms between lines starting
  var CONFIRM_MS     = 3200;   // how long a two-tap confirm stays armed
  var PIN_INSET      = 0.07;   // map margin the 0..1 pin coordinates fold into
  /* How close to affording a region's cheapest rights counts as "surveyed".
   * Above 1 so the next region appears BEFORE it is affordable — the map has
   * to show the player what they are saving for. */
  var REVEAL_REACH   = 1.6;

  /* Fallbacks used ONLY when the module that owns the number is still a stub.
   * They keep the screens legible during the parallel build; every one of them
   * is shadowed the moment the real getter returns something sane. */
  var FALLBACK_FUEL_PRICE = 1;

  var COMPANY_NAMES = [
    'DEEP ROCK LTD', 'IRONMOUTH MINING', 'BLACKSEAM & CO',
    'HOLLOW HILL CO', 'GRANITE UNION', 'LOWLIGHT DIGGING'
  ];

  /* ---------------------------------------------------------------------
   * THE EIGHT PARTS, AS THE WORKSHOP DRAWS THEM
   *
   * `lx`/`ly` are the hotspot's position in the MACHINE'S OWN LOCAL SPACE, as
   * a multiple of its half-width and of its body length — not as a percentage
   * of the canvas. drawRig() converts them with the same transform it draws
   * the machine through, so a tag stays welded to its subassembly at any
   * canvas size AND as the hull grows: buy wider treads and the TRACKS tag
   * moves out with them. Orientation is vehicle.js's: -y is forward, so the
   * blade is at negative ly and the hopper at positive.
   *
   * `stat` is read through rig.js's derived getters, so the number under a
   * hotspot is the number the game actually uses.
   * ------------------------------------------------------------------ */
  var PARTS = [
    { key: 'drill',   title: 'DRILL',   lx: 0,     ly: -0.86, unit: '',
      blurb: 'Harder rock, faster. Every tier crosses a real hardness threshold.',
      stat: 'POWER',  get: function () { return rigNum('getDrillPower', 0); } },
    { key: 'lights',  title: 'LIGHTS',  lx: -1.28, ly: -0.50, unit: ' m',
      blurb: 'The cavern you cannot see is the cavern you drive into.',
      stat: 'REACH',  get: function () { return rigNum('getLightRadius', 0) * MPU; } },
    { key: 'scanner', title: 'SCANNER', lx: 1.28,  ly: -0.50, unit: ' m',
      blurb: 'Reads ore signatures through rock you have not touched yet.',
      stat: 'RANGE',  get: function () { return rigNum('getScanRange', 0) * MPU; } },
    { key: 'engine',  title: 'ENGINE',  lx: 0,     ly: 0.10,  unit: '',
      blurb: 'Speed, and the shove to push loose debris out of the way.',
      stat: 'SPEED',  get: function () { return rigNum('getSpeed', 0); } },
    { key: 'tracks',  title: 'TRACKS',  lx: -1.05, ly: 0.14,  unit: '',
      blurb: 'Grip and turn rate. A digger that cannot turn cannot come back.',
      stat: 'TURN',   get: function () { return rigNum('getTurnRate', 0); } },
    { key: 'cooling', title: 'COOLING', lx: 1.05,  ly: 0.14,  unit: '',
      blurb: 'The deep is hot. Cooling is what makes the bottom survivable.',
      stat: 'SHED',   get: function () { return rigNum('getHeatShed', 0); } },
    { key: 'fuel',    title: 'FUEL',    lx: -0.78, ly: 0.62,  unit: 'u',
      blurb: 'Every extra unit is another minute you can spend down there.',
      stat: 'TANK',   get: function () { return rigNum('getFuelCap', 0); } },
    { key: 'cargo',   title: 'CARGO',   lx: 0.78,  ly: 0.62,  unit: 'u',
      blurb: 'Fewer return trips. The hold is the whole reason to go down.',
      stat: 'HOLD',   get: function () { return rigNum('getCargoCap', 0); } }
  ];

  var MPU = (SM.config && SM.config.ADV) ? SM.config.ADV.METERS_PER_UNIT : 0.1;

  /* ------------------------------------------------------------------ */

  var els = {};
  var screens = {};
  var built = false;
  var subscribed = false;
  var current = '';          // the screen that is up, '' = none
  var toastTimer = 0;

  var slotRows = [];
  var pins = [];
  var regions = [];          // derived from the catalogue, see rebuildPins()
  var revealed = {};         // region key -> true, once surveyed it stays so
  var mapSeen = false;       // suppresses the reveal fanfare on the first paint
  var pinCount = -1;
  var selMine = null;        // mine id shown on the map card
  var lastRec = null;        // save record the surveyed set was read from —
                             // a different record is a different company,
                             // and its chart must not inherit this one's fog
  var roadOrder = [];        // pins sorted by rights price — the haulage ladder
  var plateCv = null;        // baked chart (sea, land, fog) — repainted rarely
  var maskCv = null;         // continent silhouette scratch
  var paintCv = null;        // land painting scratch
  var plateKey = '';         // '' forces a re-bake on the next drawMapArt()
  var selPart = 'drill';     // hotspot shown in the workshop
  var partTags = {};
  /* WHICH LIFT STATION THE DESCENT STARTS AT. -1 means "no choice made yet",
   * which paintPrepLift() resolves to the deepest station the company owns —
   * the one the player almost always wants, because it is the one they paid to
   * stop walking back to. It is reset whenever the mine changes. */
  var prepLevel = -1;
  var prepLevelMine = '';    // the mine prepLevel was chosen for
  var prepLevelOwned = -1;   // ...and how many levels were held at the time
  var countRaf = 0;
  var syncTimer = 0;
  var nameEditing = -1;
  var lastSale = 0;            // last banked gross, for the results note line      // slot index whose name field is open

  /* =====================================================================
   * DOM + FORMAT HELPERS
   * ================================================================== */
  function el(tag, cls, parent, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }

  function fmt(n) {
    n = Math.round(n) | 0;
    var neg = n < 0;
    if (neg) n = -n;
    var s = '' + n, out = '', c = 0;
    for (var i = s.length - 1; i >= 0; i--) {
      out = s.charAt(i) + out;
      if (++c === 3 && i > 0) { out = ' ' + out; c = 0; }
    }
    return (neg ? '-' : '') + out;
  }

  function money(n) { return '$' + fmt(n); }

  function num(v, dflt) {
    return (typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity) ? v : dflt;
  }

  function rigNum(fn, dflt) {
    if (SM.rig && SM.rig[fn]) return num(SM.rig[fn](), dflt);
    return dflt;
  }

  function advNum(fn, dflt) {
    if (SM.adv && SM.adv[fn]) return num(SM.adv[fn](), dflt);
    return dflt;
  }

  function button(parent, cls, label) {
    var b = el('button', 'sm-btn ' + (cls || ''), parent, label);
    b.setAttribute('type', 'button');
    return b;
  }

  function onTap(node, fn) {
    node.addEventListener('click', function (e) {
      e.preventDefault();
      if (node.blur) node.blur();
      if (node.disabled) return;
      if (SM.sound && SM.sound.play) SM.sound.play('ui');
      fn(e);
    }, false);
    return node;
  }

  /**
   * Two-tap confirm for anything that destroys progress. Same device as the
   * pause card's ABORT: the button relabels itself instead of stacking a modal,
   * and it disarms on a timer so a stale CONFIRM is never left sitting there.
   */
  function confirmTap(node, label, confirmLabel, fn) {
    var armed = false, t = 0;
    function disarm() {
      armed = false;
      if (t) { clearTimeout(t); t = 0; }
      node.classList.remove('sm-av-armed');
      node.textContent = label;
    }
    node.smDisarm = disarm;
    onTap(node, function () {
      if (!armed) {
        armed = true;
        node.classList.add('sm-av-armed');
        node.textContent = confirmLabel;
        t = setTimeout(disarm, CONFIRM_MS);
        return;
      }
      disarm();
      fn();
    });
    return node;
  }

  /** Material display, from whichever module can answer. */
  var dispOut = { name: '', color: '#8e9bab' };
  function displayOf(matId, matIndex) {
    dispOut.name = '';
    dispOut.color = '#8e9bab';
    var d = null;
    if (SM.mines && SM.mines.displayOf && matId) d = SM.mines.displayOf(matId);
    if (d) {
      dispOut.name = String(d.name || matId);
      dispOut.color = String(d.color || d.colour || dispOut.color);
      return dispOut;
    }
    var m = null;
    if (SM.materials) {
      if (matId && SM.materials.getById) m = SM.materials.getById(matId);
      if (!m && typeof matIndex === 'number' && SM.materials.get) m = SM.materials.get(matIndex);
    }
    if (m) {
      dispOut.name = String(m.name || m.id);
      dispOut.color = (m.colors && m.colors[0]) ? m.colors[0] : dispOut.color;
    } else {
      dispOut.name = String(matId === undefined ? 'UNKNOWN' : matId);
    }
    return dispOut;
  }

  function mineList() {
    var l = (SM.mines && SM.mines.getAll) ? SM.mines.getAll() : null;
    return (l && typeof l.length === 'number') ? l : [];
  }

  function ownsMine(m) {
    if (!m) return false;
    if (num(m.price, 0) <= 0) return true;                 // the starter mine
    if (SM.save && SM.save.isOwned) return !!SM.save.isOwned(m.id);
    return false;
  }

  function mineStateOf(id) {
    if (SM.save && SM.save.mineState) {
      var s = SM.save.mineState(id);
      if (s) return s;
    }
    return null;
  }

  /**
   * MAY THIS COMPANY REACH THE WORLD MAP? js/adv.js owns the rule (see THE MAP
   * IS EARNED there): the map is what owning the whole of the starter mine buys,
   * and until then PREPARE DESCENT is the home between runs.
   *
   * EVERY MAP ROUTE ON THESE SCREENS ASKS THIS, and a screen that gets false
   * does not draw the route at all — a dead plate is a worse answer than no
   * plate, and the map's own verbs refuse anyway. Feature-detected to TRUE, so a
   * build whose adv.js predates the rule behaves exactly as it always did.
   */
  function mapUnlocked() {
    if (SM.adv && SM.adv.isMapUnlocked) return !!SM.adv.isMapUnlocked();
    return true;
  }

  /* =====================================================================
   * THE LIFT — READING THE LEVEL LIST ACROSS THE SEAM
   * ---------------------------------------------------------------------
   * LEVELS ARE SEPARATE MAPS (ARCHITECTURE.md §7). SM.adv.getLevels() answers with
   * the LIVE BAND table for the mine it has IN CONTEXT:
   *
   *     [{i, name, depthTopM, depthBotM, price, widthU, owned}, ...]
   *
   * levels are 1-BASED and entry k describes level k+1. There is NO SURFACE
   * ENTRY any more — the surface is UI, you never drive it, and level 1 comes
   * with the mining rights. Its entry objects are reused and mutated in place, so
   * a picker built off it cannot show a stale price, which is why it wins
   * whenever it is about the right mine.
   *
   * The MAP CARD, though, asks about every pin on the chart, and only one of them
   * is ever in context. Two other exports cover the rest between them:
   * SM.mines.levelsOf(id) prices the bands of ANY mine (it is the catalogue's own
   * price list, level 1 included at price 0) and SM.adv.ownedLevels(id) says how
   * many of them this company holds — which is at least 1 wherever it holds the
   * rights. Assembling the same shape from those two is honest, it is the same
   * arithmetic adv.js does, and it means the card can talk about a mine the
   * player has never opened.
   * ================================================================== */
  function liftLevels(mineId) {
    var id = mineId || currentMineId();
    if (!id) return null;

    if (SM.adv && SM.adv.getLevels && id === currentMineId()) {
      var live = SM.adv.getLevels();
      if (live && typeof live.length === 'number' && live.length) return live;
    }

    var tbl = (SM.mines && SM.mines.levelsOf) ? SM.mines.levelsOf(id) : null;
    if (!tbl || !tbl.length) return null;
    var owned = (SM.adv && SM.adv.ownedLevels) ? num(SM.adv.ownedLevels(id), 1) : 1;
    // Freshly built rather than pooled: these screens are static between clicks
    // and a shared scratch array aliased between two painters is a bug waiting.
    var out = [];
    for (var k = 0; k < tbl.length; k++) {
      var L = tbl[k] || {};
      var top = num(L.depthTopM, num(L.depthM, 0));
      out.push({ i: k + 1, name: L.name || ('LEVEL ' + (k + 1)),
                 depthTopM: top, depthBotM: num(L.depthBotM, top), depthM: top,
                 price: num(L.price, 0), widthU: num(L.widthU, 0),
                 owned: (k + 1) <= owned,
                 /* THE PROGRESSION GATE. Only adv.js can answer this, and only
                  * about the mine it has in context — which this branch is by
                  * definition not. A card describing some other pin on the chart
                  * never offers a purchase, so `false` is both safe and true. */
                 offered: false });
    }
    return out;
  }

  /** The mine adv.js is holding: the one being dug, or the one selected. */
  function currentMineId() {
    var m = (SM.adv && SM.adv.getMine) ? SM.adv.getMine() : null;
    return (m && m.id) ? m.id : (selMine || '');
  }

  /** Deepest LEVEL the company owns (1-based). Never 0: level 1 is free. */
  function deepestOwned(levels) {
    var best = 1;
    if (!levels) return best;
    for (var k = 0; k < levels.length; k++) {
      if (levels[k] && levels[k].owned) best = num(levels[k].i, k + 1);
    }
    return best;
  }

  /** The one level that is purchasable: the first unowned one, 1-based, or -1. */
  function nextUnowned(levels) {
    if (!levels) return -1;
    for (var k = 0; k < levels.length; k++) {
      if (levels[k] && !levels[k].owned) return num(levels[k].i, k + 1);
    }
    return -1;
  }

  /**
   * HAS THE PROGRESSION GATE OPENED ON LEVEL i? js/adv.js owns the rule (see its
   * note above buyLevel) and every screen asks it rather than re-deriving it;
   * the entry's own `offered` is preferred because it is the same answer already
   * baked into the live table, and isLevelOffered() is the fallback for a table
   * assembled from the catalogue.
   */
  function levelOffered(levels, i) {
    var L = levelAt(levels, i);
    if (L && typeof L.offered === 'boolean') return L.offered;
    if (SM.adv && SM.adv.isLevelOffered) return !!SM.adv.isLevelOffered(i);
    return false;
  }

  function ownedCount(levels) {
    var n = 0;
    if (!levels) return 0;
    for (var k = 0; k < levels.length; k++) if (levels[k] && levels[k].owned) n++;
    return n;
  }

  /** One entry by 1-based level index, or null. */
  function levelAt(levels, i) {
    if (!levels || !(i >= 1) || i > levels.length) return null;
    return levels[i - 1] || null;
  }

  /** 'SILVER VEINS' / 'LEVEL 3', preferring whatever name adv.js gave the band. */
  function levelLabel(L) {
    if (!L) return '';
    if (L.name) return String(L.name).toUpperCase();
    return 'LEVEL ' + num(L.i, 0);
  }

  /** "0–135 m" — the band, because a level IS a band now. */
  function bandText(L) {
    if (!L) return '';
    var top = Math.round(num(L.depthTopM, num(L.depthM, 0)));
    var bot = Math.round(num(L.depthBotM, top));
    return bot > top ? (fmt(top) + '–' + fmt(bot) + ' m') : (fmt(top) + ' m');
  }

  /** "480 m WIDE" — the other half of what a level purchase buys. */
  function widthText(L) {
    var w = L ? num(L.widthU, 0) : 0;
    if (!(w > 0)) return '';
    return fmt(Math.round(w * MPU)) + ' m WIDE';
  }

  /* =====================================================================
   * BUILD — one shell, five screens, built once
   * ================================================================== */
  function build() {
    var root = document.getElementById('ui-root');
    if (!root) return;
    built = true;

    els.wrap = el('div', 'sm-av', root);

    /* --- the ledger strip, common to every meta screen ------------------ */
    var led = el('div', 'sm-panel sm-av-ledger', els.wrap);
    el('div', 'sm-stripe', led);
    els.ledCompany = el('div', 'sm-av-led-co', led, 'SUPERMINE');
    var ledRight = el('div', 'sm-av-led-right', led);
    els.ledDay = el('div', 'sm-av-led-cell', ledRight, 'DAY 1');
    els.ledTier = el('div', 'sm-av-led-cell', ledRight, 'MK I');
    els.ledCash = el('div', 'sm-av-led-cash', ledRight, '$0');

    els.stage = el('div', 'sm-av-stage', els.wrap);

    buildSlots();
    buildMap();
    buildGarage();
    buildPrep();
    buildResults();

    els.toast = el('div', 'sm-av-toast', els.wrap);
    els.toastTitle = el('div', 'sm-av-toast-title', els.toast, '');
    els.toastSub = el('div', 'sm-av-toast-sub', els.toast, '');
  }

  /** A screen shell: header, scrolling body, and a footer that never scrolls. */
  function makeScreen(key, kicker, title) {
    var s = el('div', 'sm-av-screen sm-av-' + key, els.stage);
    var head = el('div', 'sm-av-head', s);
    var k = el('div', 'sm-av-kicker', head, kicker);
    var t = el('div', 'sm-av-title', head, title);
    var body = el('div', 'sm-av-body', s);
    var foot = el('div', 'sm-av-foot', s);
    screens[key] = { node: s, kicker: k, title: t, body: body, foot: foot };
    return screens[key];
  }

  /* ---------------------------------------------------------------------
   * SLOTS
   * ------------------------------------------------------------------ */
  function buildSlots() {
    var s = makeScreen('slots', 'THREE COMPANIES · ONE LEDGER EACH', 'MINING COMPANIES');
    var n = (SM.config && SM.config.ADV) ? SM.config.ADV.SAVE_SLOTS : 3;
    for (var i = 0; i < n; i++) slotRows.push(makeSlotRow(s.body, i));
    onTap(button(s.foot, '', 'TITLE SCREEN'), function () {
      if (SM.adv && SM.adv.close) SM.adv.close();
    });
  }

  function makeSlotRow(parent, i) {
    var r = { index: i };
    r.node = el('div', 'sm-panel sm-av-slot', parent);
    el('div', 'sm-stripe', r.node);
    var top = el('div', 'sm-av-slot-top', r.node);
    r.no = el('div', 'sm-av-slot-no', top, 'SLOT ' + (i + 1));
    r.name = el('div', 'sm-av-slot-name', top, 'EMPTY');
    r.stats = el('div', 'sm-av-slot-stats', r.node);
    r.cash = statCell(r.stats, 'CASH', '$0');
    r.day = statCell(r.stats, 'DAY', '1');
    r.tier = statCell(r.stats, 'MACHINE', 'MK I');
    r.mines = statCell(r.stats, 'MINES', '0');

    /* The name editor. Its keydown is stopped from reaching window, because
     * js/input.js (frozen) restarts the run on 'r' and mutes on 'm' — typing
     * IRONMOUTH would otherwise restart the game mid-entry. preventDefault is
     * NOT called, so the character still lands in the field. */
    r.form = el('div', 'sm-av-slot-form', r.node);
    r.input = el('input', 'sm-av-input', r.form);
    r.input.setAttribute('type', 'text');
    r.input.setAttribute('maxlength', '18');
    r.input.setAttribute('placeholder', 'COMPANY NAME');
    r.input.setAttribute('autocomplete', 'off');
    r.input.setAttribute('spellcheck', 'false');
    r.input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); startCompany(r); }
    }, false);
    r.input.addEventListener('keyup', function (e) { e.stopPropagation(); }, false);
    r.input.addEventListener('keypress', function (e) { e.stopPropagation(); }, false);
    r.input.addEventListener('input', function () {
      var v = r.input.value.toUpperCase();
      if (v !== r.input.value) r.input.value = v;
    }, false);
    r.confirm = button(r.form, 'sm-btn-primary', 'SIGN THE PAPERS');
    onTap(r.confirm, function () { startCompany(r); });

    var acts = el('div', 'sm-av-slot-acts', r.node);
    r.primary = button(acts, 'sm-btn-primary', 'NEW COMPANY');
    onTap(r.primary, function () {
      var list = safeSlots();
      if (list[i] && !list[i].empty) {
        if (SM.save && SM.save.load) SM.save.load(i);
        enterCompany(i);
      } else {
        openNameEditor(i);
      }
    });
    r.erase = confirmTap(button(acts, 'sm-av-quiet', 'ERASE'), 'ERASE', 'ERASE FOR GOOD', function () {
      if (SM.save && SM.save.erase) SM.save.erase(i);
      if (SM.save && SM.save.flush) SM.save.flush();
      nameEditing = -1;
      paintSlots();
      toast('SLOT ERASED', 'Slot ' + (i + 1) + ' is empty again', 1.8);
    });
    return r;
  }

  function statCell(parent, label, value) {
    var cell = el('div', 'sm-cell', parent);
    el('div', 'sm-cell-label', cell, label);
    return el('div', 'sm-cell-value', cell, value);
  }

  function safeSlots() {
    var list = (SM.save && SM.save.listSlots) ? SM.save.listSlots() : null;
    if (!list || typeof list.length !== 'number') list = [];
    var n = (SM.config && SM.config.ADV) ? SM.config.ADV.SAVE_SLOTS : 3;
    while (list.length < n) list.push({ index: list.length, empty: true });
    return list;
  }

  function openNameEditor(i) {
    nameEditing = i;
    paintSlots();
    var r = slotRows[i];
    if (!r) return;
    if (!r.input.value) {
      r.input.value = COMPANY_NAMES[(Math.random() * COMPANY_NAMES.length) | 0];
    }
    try { r.input.focus(); r.input.select(); } catch (e) { /* focus is optional */ }
  }

  function startCompany(r) {
    var name = (r.input.value || '').trim() || COMPANY_NAMES[0];
    if (SM.save && SM.save.newGame) SM.save.newGame(r.index, name);
    if (SM.save && SM.save.flush) SM.save.flush();
    nameEditing = -1;
    enterCompany(r.index);
  }

  /**
   * The slot is loaded; hand over to the state machine. The index is passed as
   * well as being already loaded, so adv.js can use either — see the report.
   */
  function enterCompany(i) {
    if (SM.adv && SM.adv.startCompany) SM.adv.startCompany(i);
    // If adv.js has not moved us on (it is still a stub, or a load failed),
    // the watchdog will put the slot screen back rather than leave a blank.
  }

  function paintSlots() {
    var list = safeSlots();
    for (var i = 0; i < slotRows.length; i++) {
      var r = slotRows[i], d = list[i] || { empty: true };
      var empty = !!d.empty;
      r.node.classList[empty ? 'add' : 'remove']('sm-av-slot-empty');
      r.name.textContent = empty ? 'EMPTY' : String(d.company || 'UNNAMED CO');
      r.cash.textContent = money(num(d.cash, 0));
      r.day.textContent = fmt(num(d.day, 1));
      r.tier.textContent = 'MK ' + roman(num(d.tier, 1));
      r.mines.textContent = fmt(num(d.mines, 0));
      r.stats.style.display = empty ? 'none' : '';
      r.erase.style.display = empty ? 'none' : '';
      if (r.erase.smDisarm) r.erase.smDisarm();
      r.primary.textContent = empty ? 'NEW COMPANY' : 'CONTINUE';
      var editing = (nameEditing === i);
      r.form.style.display = editing ? '' : 'none';
      r.primary.style.display = editing ? 'none' : '';
    }
  }

  function roman(n) {
    var R = ['0', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
    n = Math.round(n) | 0;
    return R[n] || ('' + n);
  }

  /* ---------------------------------------------------------------------
   * MAP
   * ------------------------------------------------------------------ */
  function buildMap() {
    var s = makeScreen('map', 'MINING RIGHTS · CHOOSE YOUR GROUND', 'THE FIELD');
    els.map = el('div', 'sm-av-mapart', s.body);
    /* THE LAND IS DRAWN, not built out of divs. A canvas is what makes a
     * frozen shaft look frozen and a volcanic coast look volcanic — see
     * drawMapArt(). The pins stay DOM on top of it, because they are buttons
     * with labels and hit targets, which canvas is bad at. */
    els.mapCanvas = el('canvas', 'sm-av-map-canvas', els.map);
    /* The survey lamp: one soft light drifting over the plate, CSS-animated
     * (transform only). Created BEFORE the region and pin layers so it can
     * never sit over a button — stacking here is pure DOM order. */
    els.mapLight = el('div', 'sm-av-maplight', els.map);
    els.mapRegions = el('div', 'sm-av-regions', els.map);
    els.mapPins = el('div', 'sm-av-pins', els.map);
    els.mapEmpty = el('div', 'sm-av-map-empty', els.map, 'NO SURVEY DATA');

    /* --- the mine card -------------------------------------------------- */
    var c = el('div', 'sm-panel sm-av-minecard', s.body);
    els.card = c;
    el('div', 'sm-stripe', c);
    var chead = el('div', 'sm-av-card-head', c);
    els.cardName = el('div', 'sm-av-card-name', chead, '');
    els.cardRegion = el('div', 'sm-av-card-region', chead, '');
    els.cardBlurb = el('div', 'sm-av-card-blurb', c, '');
    var grid = el('div', 'sm-av-card-grid', c);
    els.cardPrice = statCell(grid, 'MINING RIGHTS', '$0');
    els.cardDrill = statCell(grid, 'REC. DRILL', '0');
    els.cardDepth = statCell(grid, 'EST. DEPTH', '0 m');
    els.cardBest = statCell(grid, 'DEEPEST RUN', '—');
    /* THE PROFILE ROW. Two mines can cost nearly the same and be completely
     * different propositions — one with no heat in any layer and one that is a
     * gamble all the way down — and that difference is the most interesting
     * decision on this screen. It is read off the LAYER TABLE, so it cannot
     * disagree with what the mine actually does to the machine. */
    els.cardProfile = el('div', 'sm-av-profile', c);
    /* WHAT THE LIFT HAS REACHED. One line, off getLevels(): a mine you have cut
     * four stations into is a completely different proposition from one you have
     * only ever entered at the mouth, and that is the difference between a
     * twenty-second descent and a five-minute climb. */
    els.cardLift = el('div', 'sm-av-liftline', c, '');
    els.cardWarn = el('div', 'sm-av-warn', c, '');
    els.cardRes = el('div', 'sm-av-chips', c);
    els.cardHaz = el('div', 'sm-av-haz', c, '');

    /* The mine's own action lives in the FOOTER, not in the card: the card is
     * the read, and a read can be long enough to scroll. BUY RIGHTS must never
     * be the thing that scrolled away. */
    els.cardBtn = button(s.foot, 'sm-btn-primary sm-btn-big', 'BUY RIGHTS');
    onTap(els.cardBtn, onMineAction);

    onTap(button(s.foot, '', 'WORKSHOP'), function () {
      if (SM.adv && SM.adv.openGarage) SM.adv.openGarage();
    });
    onTap(button(s.foot, 'sm-av-quiet', 'TITLE SCREEN'), function () {
      if (SM.adv && SM.adv.close) SM.adv.close();
    });
  }

  function paintMap() {
    var list = mineList();
    els.mapEmpty.style.display = list.length ? 'none' : '';

    if (pinCount !== list.length) rebuildPins(list);

    var cash = advNum('getCash', 0);
    var i, p, m;

    /* --- which regions are on the chart at all --------------------------
     * The surveyed set is remembered in the SAVE RECORD, not just in this
     * module: without that, a company that surveyed Frostpeak and then spent
     * the money would find it fogged again after a reload, which reads as the
     * game forgetting something the player did. `seen` is an ADDITION to
     * save.js's schema (adv.js does the same with `integrity`); if a stricter
     * loader ever drops it, the worst case is the fog coming back, never a
     * broken company. */
    var rec = (SM.save && SM.save.get) ? SM.save.get() : null;
    /* A DIFFERENT COMPANY IS A DIFFERENT CHART. save.js hands out one live
     * record object per slot, so a reference change means a slot change —
     * drop the surveyed set and the fanfare latch before merging, or company
     * B starts with company A's fog already lifted. */
    if (rec !== lastRec) { lastRec = rec; revealed = {}; mapSeen = false; }
    if (rec && rec.seen) {
      for (var sk in rec.seen) if (rec.seen.hasOwnProperty(sk)) revealed[sk] = true;
    }
    var newly = [];
    for (i = 0; i < regions.length; i++) {
      var r = regions[i];
      var was = !!revealed[r.key];
      r.owned = 0;
      r.cheapest = Infinity;
      for (var j = 0; j < r.mines.length; j++) {
        var mm = r.mines[j];
        if (ownsMine(mm)) r.owned++;
        var pr = num(mm.price, 0);
        if (pr < r.cheapest) r.cheapest = pr;
      }
      /* A region joins the chart when the company can plausibly reach it: it
       * owns ground there, or the cheapest rights are within REVEAL_REACH of
       * the ledger. Once surveyed it STAYS surveyed — a bad run that empties
       * the account must not un-discover a mountain range. */
      if (!was && (r.owned > 0 || cash >= r.cheapest * REVEAL_REACH)) {
        revealed[r.key] = true;
        if (rec) {
          if (!rec.seen) rec.seen = {};
          rec.seen[r.key] = 1;
          if (SM.save && SM.save.markDirty) SM.save.markDirty();
        }
        if (mapSeen) newly.push(r);      // not on the very first paint
      }
      r.revealed = !!revealed[r.key];
      r.label.textContent = r.revealed ? r.name.toUpperCase() : 'UNSURVEYED';
      r.label.classList[r.revealed ? 'remove' : 'add']('sm-av-region-fog');
      r.label.classList[r.owned > 0 ? 'add' : 'remove']('sm-av-region-held');
    }

    /* --- the pins ------------------------------------------------------- */
    for (i = 0; i < pins.length; i++) {
      p = pins[i]; m = p.mine;
      var owned = ownsMine(m);
      var afford = cash >= num(m.price, 0);
      var known = !p.region || p.region.revealed;
      p.node.classList[owned ? 'add' : 'remove']('sm-av-pin-owned');
      p.node.classList[(!owned && afford) ? 'add' : 'remove']('sm-av-pin-buy');
      p.node.classList[(!owned && !afford) ? 'add' : 'remove']('sm-av-pin-far');
      p.node.classList[known ? 'remove' : 'add']('sm-av-pin-fog');
      p.node.classList[(selMine === m.id) ? 'add' : 'remove']('sm-av-pin-sel');
      p.tag.textContent = owned ? 'HELD' : (num(m.price, 0) > 0 ? money(m.price) : 'FREE');
      p.name.textContent = known ? String(m.name || m.id).toUpperCase() : 'UNCHARTED SITE';
      /* What the ground IS, not just what it costs: known mines show their
       * depth, held mines show how much of the lift is bought. Both stay
       * blank on fogged ground (CSS hides them too, belt and braces). */
      p.sub.textContent = known ? (fmt(num(m.depth, 0)) + ' M') : '';
      if (owned) {
        /* levelsOf memoises its table and ownedLevels is a plain count, so
         * this stays allocation-free across all seven pins — liftLevels()
         * would rebuild an array per pin per paint for the same ratio. */
        var ltab = (SM.mines && SM.mines.levelsOf) ? SM.mines.levelsOf(m.id) : null;
        var lt = ltab ? ltab.length : 0;
        var lo = (SM.adv && SM.adv.ownedLevels) ? num(SM.adv.ownedLevels(m.id), 1) : 1;
        p.lvl.style.display = lt > 0 ? '' : 'none';
        var pct = (lt > 0 ? Math.round((Math.min(lo, lt) / lt) * 100) : 0) + '%';
        if (p.lvlFill.style.width !== pct) p.lvlFill.style.width = pct;
      } else {
        p.lvl.style.display = 'none';
      }
    }

    if (!selMine && list.length) selMine = firstInteresting(list);
    drawMapArt();
    paintMineCard();

    /* --- and the achievement beat --------------------------------------- */
    for (i = 0; i < newly.length; i++) celebrateRegion(newly[i]);
    mapSeen = true;
  }

  /**
   * A new region joining the chart is the campaign's milestone, so it gets the
   * one piece of theatre on this screen: a survey sweep across the new ground
   * and a toast naming it. Unlocking a region should feel like something.
   */
  function celebrateRegion(r) {
    if (!r || !r.flash) return;
    retrigger(r.flash, 'sm-av-reveal-on');
    toast('REGION SURVEYED', String(r.name).toUpperCase() + ' is on the chart', 3.2);
    if (SM.sound && SM.sound.play) SM.sound.play('ui');
  }

  function retrigger(node, cls) {
    if (!node) return;
    node.classList.remove(cls);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { node.classList.add(cls); });
    } else node.classList.add(cls);
  }

  /** The pin the player most likely wants: the deepest one they own. */
  function firstInteresting(list) {
    var best = list[0].id;
    for (var i = 0; i < list.length; i++) {
      if (ownsMine(list[i])) best = list[i].id;
    }
    return best;
  }

  function rebuildPins(list) {
    pinCount = list.length;
    pins.length = 0;
    regions.length = 0;
    els.mapPins.innerHTML = '';
    els.mapRegions.innerHTML = '';

    /* REGIONS ARE DERIVED FROM THE PINS, never authored twice: a region's land
     * spans the bounding box of its mines, so a mine added in mines.js grows
     * its region automatically and a re-tuned mapX/mapY moves the coastline
     * with it. `art` is matched on the region's NAME (see artFor) so the
     * terrain identity survives a rename or a new region entirely. */
    var byName = {};
    var i, m, r;
    for (i = 0; i < list.length; i++) {
      m = list[i];
      if (!m) continue;
      var name = String(m.region || 'Uncharted');
      r = byName[name];
      if (!r) {
        r = byName[name] = {
          name: name, key: name.toLowerCase(), mines: [],
          minX: 1, minY: 1, maxX: 0, maxY: 0,
          owned: 0, cheapest: Infinity, revealed: false,
          art: artFor(name), seed: hashStr(name)
        };
        regions.push(r);
      }
      var mx = clamp01(num(m.mapX, 0.5)), my = clamp01(num(m.mapY, 0.5));
      r.mines.push(m);
      if (mx < r.minX) r.minX = mx;
      if (mx > r.maxX) r.maxX = mx;
      if (my < r.minY) r.minY = my;
      if (my > r.maxY) r.maxY = my;
    }

    /* THE LOBES — solved ONCE, here, in normalised units, and stored. The
     * canvas coastline, the DOM region box (label + reveal sweep) and the
     * claim hatch are all traced from these same numbers, so they can never
     * disagree — the old build derived the DOM box from the mine bounding
     * box and the coastline from a clamped blob, and the survey sweep ended
     * up a third of the size of the land it was celebrating.
     *
     * Size encodes the campaign: regions are ranked by their cheapest
     * mining rights, and late, expensive ground is simply BIGGER on the
     * chart than the starter claim. Geometry is seeded off the region name
     * and the pin coordinates only — never off save state — so a fresh
     * company and a loaded one always render the identical continent. */
    for (i = 0; i < regions.length; i++) {
      r = regions[i];
      var cheap = Infinity, sx = 0, sy = 0;
      for (var j = 0; j < r.mines.length; j++) {
        var pr = num(r.mines[j].price, 0);
        if (pr < cheap) cheap = pr;
        sx += clamp01(num(r.mines[j].mapX, 0.5));
        sy += clamp01(num(r.mines[j].mapY, 0.5));
      }
      r.cheapRights = cheap;
      r.ax = sx / r.mines.length;      // anchor: centroid of the region's mines
      r.ay = sy / r.mines.length;
      r.lobe = buildLobe(r.seed);
    }
    var order = regions.slice().sort(function (a, b) { return a.cheapRights - b.cheapRights; });
    for (i = 0; i < order.length; i++) {
      r = order[i];
      var t = order.length > 1 ? i / (order.length - 1) : 0.5;
      r.rank = i;
      r.rr = 0.085 + t * 0.065;        // lobe radius, as a fraction of the plate
      /* A region holding several spread-out mines must cover all of them.
       * min/max are raw 0..1 map space; the inset fold shrinks that to
       * (1 - PIN_INSET*2) of the plate, so convert before comparing to rr. */
      var spread = Math.max(r.maxX - r.minX, r.maxY - r.minY)
                   * (1 - PIN_INSET * 2) * 0.62 + 0.045;
      if (spread > r.rr) r.rr = spread;
    }

    for (i = 0; i < regions.length; i++) {
      r = regions[i];
      r.x0 = insetX(r.ax) - r.rr;
      r.x1 = insetX(r.ax) + r.rr;
      r.y0 = insetX(r.ay) - r.rr * LOBE_RY;
      r.y1 = insetX(r.ay) + r.rr * LOBE_RY;

      var box = el('div', 'sm-av-region', els.mapRegions);
      box.style.left = (r.x0 * 100) + '%';
      box.style.top = (r.y0 * 100) + '%';
      box.style.width = ((r.x1 - r.x0) * 100) + '%';
      box.style.height = ((r.y1 - r.y0) * 100) + '%';
      r.box = box;
      r.label = el('div', 'sm-av-region-label', box, r.name.toUpperCase());
      r.label.title = r.name;
      // The survey sweep, parked and invisible until a region is revealed.
      r.flash = el('div', 'sm-av-reveal', box);
    }

    for (i = 0; i < list.length; i++) {
      m = list[i];
      if (!m) continue;
      pins.push(makePin(m, byName[String(m.region || 'Uncharted')]));
    }

    /* The haulage ladder: every road segment walks this order. */
    roadOrder.length = 0;
    for (i = 0; i < pins.length; i++) roadOrder.push(pins[i]);
    roadOrder.sort(function (a, b) { return num(a.mine.price, 0) - num(b.mine.price, 0); });

    plateKey = '';               // geometry changed: the baked plate is stale
  }

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /** Fold a 0..1 map coordinate into the artwork's safe area. */
  function insetX(v) { return PIN_INSET + clamp01(v) * (1 - PIN_INSET * 2); }

  /** Cheap stable string hash — the coastline must not wobble between paints. */
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function makePin(m, region) {
    var node = el('button', 'sm-av-pin', els.mapPins);
    node.setAttribute('type', 'button');
    /* Inset the 0..1 map coordinates: a mine authored at mapX 0.93 would
     * otherwise hang its name label off the right edge of the artwork, which
     * on a phone clips it in half. */
    node.style.left = (insetX(num(m.mapX, 0.5)) * 100) + '%';
    node.style.top = (insetX(num(m.mapY, 0.5)) * 100) + '%';
    el('span', 'sm-av-pin-dot', node);
    var nameEl = el('span', 'sm-av-pin-name', node, String(m.name || m.id || '').toUpperCase());
    var tag = el('span', 'sm-av-pin-tag', node, '');
    var sub = el('span', 'sm-av-pin-sub', node, '');
    var lvl = el('span', 'sm-av-pin-levels', node);
    lvl.style.display = 'none';
    var lvlFill = el('span', 'sm-av-pin-levels-fill', lvl);
    var p = { node: node, tag: tag, name: nameEl, sub: sub, lvl: lvl,
              lvlFill: lvlFill, mine: m, region: region || null };
    onTap(node, function () {
      selMine = m.id;
      paintMap();
    });
    return p;
  }

  /* =====================================================================
   * THE MAP ARTWORK — the company survey plate
   * ---------------------------------------------------------------------
   * ONE CONTINENT, not seven competing islands: every region contributes a
   * lobe anchored at its mines, the lobes are unioned into a single
   * landmass (nonzero winding does the union for free), and each region is
   * a DISTRICT of that landmass with its own terrain hatch. The Rift alone
   * stays out of the union — it is not land, it is a tear in open water at
   * the far end of the chart, which is exactly what the campaign's last
   * ground should look like from the first day.
   *
   * Everything is procedural and deterministic — lobes are seeded off the
   * region NAME and anchored at the pin coordinates, never off save state —
   * so there are no assets, nothing to keep in sync with mines.js, and a
   * fresh company renders the identical coastline to a loaded one.
   *
   * TWO TIERS, because paintMap() runs on every pin tap and on every ledger
   * event: the PLATE (sea, soundings, continent, districts, fog, furniture)
   * is baked into an offscreen canvas keyed on size + the revealed set, and
   * a tap costs one drawImage; the OVERLAY (claim hatch, haulage road,
   * frontier ring, selection brackets) is a few dozen strokes redrawn on
   * top every paint. Nothing here runs per frame.
   * ================================================================== */
  var REGION_ART = {
    hills:     { kind: 'hills',     land: ['#4a5a2c', '#647a38', '#8ba64c'], edge: '#a8bd60', ink: '#e2f2b8' },
    quarry:    { kind: 'quarry',    land: ['#6b3f20', '#8f5527', '#b87738'], edge: '#dda05c', ink: '#ffdcb0' },
    mountains: { kind: 'mountains', land: ['#3a4350', '#556274', '#7c8b9e'], edge: '#b7c5d6', ink: '#e8f1fb' },
    ice:       { kind: 'ice',       land: ['#2b5064', '#3f89a4', '#74bcd2'], edge: '#d2f1fa', ink: '#effeff' },
    lowland:   { kind: 'lowland',   land: ['#26391f', '#3d5730', '#587547'], edge: '#7fa15c', ink: '#d2e6ae' },
    volcanic:  { kind: 'volcanic',  land: ['#32180f', '#5c2716', '#83341a'], edge: '#ff7a2a', ink: '#ffd0a8' },
    rift:      { kind: 'rift',      land: ['#1d1229', '#341a41', '#522a68'], edge: '#c46bff', ink: '#f5daff' },
    desert:    { kind: 'desert',    land: ['#6f5626', '#977433', '#c29a46'], edge: '#e8c46c', ink: '#fff0c4' }
  };

  /* Lobe height/width ratio: lobes stretch WITH the plate (both axes are
   * plate fractions, like the pins), so pin and coastline can never drift
   * apart on resize — a landmass is just a little wider than it is tall. */
  var LOBE_RY = 0.92;

  /** Map-fraction -> plate pixels, through the SAME fold the pins use.
   *  These two are the only positional entry points for the artwork. */
  function mapPX(v, w) { return insetX(num(v, 0.5)) * w; }
  function mapPY(v, h) { return insetX(num(v, 0.5)) * h; }

  /** A region's coastline shape, generated once and stored: unit-circle
   *  points with a jitter factor each. Same angular direction for every
   *  lobe, so the nonzero-winding union can never punch a hole. */
  function buildLobe(seed) {
    var rnd = rngFrom(seed);
    var N = 16, pts = [];
    for (var i = 0; i < N; i++) {
      var a = (i / N) * Math.PI * 2;
      pts.push({ c: Math.cos(a), s: Math.sin(a), j: 0.74 + rnd() * 0.42 });
    }
    return pts;
  }

  /** Trace a region's coast as a SUBPATH (no beginPath here: the continent
   *  mask unions several of these under one fill). grow scales the lobe. */
  function lobeSubpath(ctx, r, w, h, grow) {
    var cx = mapPX(r.ax, w), cy = mapPY(r.ay, h);
    var rx = r.rr * w * grow, ry = r.rr * LOBE_RY * h * grow;
    var p = r.lobe, N = p.length;
    for (var i = 0; i <= N; i++) {
      var a = p[i % N], b = p[(i + 1) % N];
      var ax = cx + a.c * rx * a.j, ay = cy + a.s * ry * a.j;
      var bx = cx + b.c * rx * b.j, by = cy + b.s * ry * b.j;
      var mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
      if (i === 0) ctx.moveTo(mx, my);
      else ctx.quadraticCurveTo(ax, ay, mx, my);
    }
    ctx.closePath();
  }

  /** The plate cache key's reveal component: fog is baked into the plate. */
  function revealSignature() {
    var s = '';
    for (var i = 0; i < regions.length; i++) s += regions[i].revealed ? '1' : '0';
    return s;
  }

  /**
   * Terrain identity from the region's NAME, by keyword. Matching on the name
   * rather than on an id means Agent 2 can add 'Ash Barrens' or 'The Salt Flats'
   * and it lands on plausible art instead of a grey box.
   */
  function artFor(name) {
    var n = String(name).toLowerCase();
    if (/rift|void|abyss|chasm/.test(n)) return REGION_ART.rift;
    if (/frost|ice|glacier|snow|winter|north/.test(n)) return REGION_ART.ice;
    if (/cinder|ash|volcan|ember|fell|fire|coast/.test(n)) return REGION_ART.volcanic;
    if (/hollow|marsh|fen|swamp|low|bog/.test(n)) return REGION_ART.lowland;
    if (/range|peak|mount|alp|crag|spine/.test(n)) return REGION_ART.mountains;
    if (/ridge|quarry|cut|pit|scarp/.test(n)) return REGION_ART.quarry;
    if (/dune|desert|sand|salt|flat|barren/.test(n)) return REGION_ART.desert;
    return REGION_ART.hills;
  }

  /** Deterministic 0..1 stream. One per region, re-seeded on every paint. */
  function rngFrom(seed) {
    var s = (seed || 1) >>> 0;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return (s >>> 8) / 16777216;
    };
  }

  function drawMapArt() {
    var c = els.mapCanvas;
    if (!c || !c.getContext) return;
    var w = c.clientWidth | 0, h = c.clientHeight | 0;
    if (w < 20 || h < 20) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    /* Size is in the key because onResize only repaints the VISIBLE screen:
     * a resize while the map is hidden must be caught on the next show. */
    var key = pw + '|' + ph + '|' + revealSignature();
    if (key !== plateKey || !plateCv) {
      bakePlate(w, h, pw, ph, dpr);
      plateKey = key;
    }
    /* Source is DPR pixels, destination is CSS pixels (ctx is already
     * DPR-transformed) — spell both out or retina renders at half size. */
    ctx.drawImage(plateCv, 0, 0, pw, ph, 0, 0, w, h);
    drawOverlay(ctx, w, h);
  }

  /** Tier 1: everything that survives a pin tap. Expensive is fine here. */
  function bakePlate(w, h, pw, ph, dpr) {
    if (!plateCv) {
      plateCv = document.createElement('canvas');
      maskCv = document.createElement('canvas');
      paintCv = document.createElement('canvas');
    }
    if (plateCv.width !== pw || plateCv.height !== ph) {
      plateCv.width = pw; plateCv.height = ph;
      maskCv.width = pw; maskCv.height = ph;
      paintCv.width = pw; paintCv.height = ph;
    }
    var i, r;
    /* Districts paint cheap-to-expensive, so late ground wins the seams. */
    var land = [];
    for (i = 0; i < regions.length; i++) {
      if (regions[i].art.kind !== 'rift') land.push(regions[i]);
    }
    land.sort(function (a, b) { return a.rank - b.rank; });

    /* --- 1. the continent silhouette: one fill unions every lobe -------- */
    var mc = maskCv.getContext('2d');
    mc.setTransform(dpr, 0, 0, dpr, 0, 0);
    mc.clearRect(0, 0, w, h);
    mc.beginPath();
    for (i = 0; i < land.length; i++) lobeSubpath(mc, land[i], w, h, 1);
    mc.fillStyle = '#fff';
    mc.fill();

    /* --- 2. the land painting, cut to the silhouette --------------------
     * Districts paint SLOPPILY (clipped to a slightly grown lobe, so the
     * seams overlap instead of gapping); the destination-in cut against the
     * mask trims everything back to the true coastline in one op. */
    var pc = paintCv.getContext('2d');
    pc.setTransform(dpr, 0, 0, dpr, 0, 0);
    pc.clearRect(0, 0, w, h);
    for (i = 0; i < land.length; i++) drawDistrict(pc, land[i], w, h);
    pc.globalCompositeOperation = 'destination-in';
    pc.setTransform(1, 0, 0, 1, 0, 0);
    pc.drawImage(maskCv, 0, 0);
    pc.setTransform(dpr, 0, 0, dpr, 0, 0);
    pc.globalCompositeOperation = 'source-over';

    /* --- 3. compose the plate ------------------------------------------- */
    var bc = plateCv.getContext('2d');
    bc.setTransform(dpr, 0, 0, dpr, 0, 0);
    bc.clearRect(0, 0, w, h);
    drawSea(bc, w, h);
    drawGraticule(bc, w, h);              // UNDER the land, where a chart grid belongs

    bc.save();
    bc.setTransform(1, 0, 0, 1, 0, 0);    // device px, so the mask blits 1:1
    /* Continental shelf: the silhouette echoed into the water. */
    for (i = 0; i < 8; i++) {
      var oa = (i / 8) * Math.PI * 2;
      var ox = Math.cos(oa), oy = Math.sin(oa);
      bc.globalAlpha = 0.028;
      bc.drawImage(maskCv, ox * 6.5 * dpr, oy * 6.5 * dpr);
      bc.globalAlpha = 0.042;
      bc.drawImage(maskCv, ox * 3 * dpr, oy * 3 * dpr);
    }
    /* Rim light: a sliver of silhouette peeking out on the lit side... */
    bc.globalAlpha = 0.15;
    bc.drawImage(maskCv, -1.6 * dpr, -1.6 * dpr);
    bc.globalAlpha = 1;
    /* ...then the land itself covers all but that sliver, dropping a soft
     * shadow into the water on the shaded side. One consistent sun. */
    bc.shadowColor = 'rgba(0, 0, 0, 0.55)';
    bc.shadowBlur = 9 * dpr;
    bc.shadowOffsetX = 2 * dpr;
    bc.shadowOffsetY = 3 * dpr;
    bc.drawImage(paintCv, 0, 0);
    bc.restore();

    /* Coastlines and district boundaries. Stroking each lobe individually
     * draws the interior segments too — those read as district borders. */
    for (i = 0; i < land.length; i++) {
      r = land[i];
      bc.save();
      bc.beginPath();
      lobeSubpath(bc, r, w, h, 1);
      if (r.revealed) {
        bc.strokeStyle = 'rgba(214, 232, 248, 0.30)';
        bc.lineWidth = 1.2;
      } else {
        if (bc.setLineDash) bc.setLineDash([3, 5]);
        bc.strokeStyle = 'rgba(150, 170, 200, 0.40)';
        bc.lineWidth = 1;
      }
      bc.stroke();
      bc.restore();
    }

    for (i = 0; i < regions.length; i++) {
      if (regions[i].art.kind === 'rift') drawRift(bc, regions[i], w, h);
    }
    drawChartFurniture(bc, w, h);
  }

  /**
   * A compass rose and a scale bar out in the water. The mines cluster in the
   * middle of the chart, so without these the outer thirds are empty sea; two
   * pieces of instrument furniture are what make that emptiness read as a
   * SURVEY rather than as unused space.
   */
  function drawChartFurniture(ctx, w, h) {
    if (w < 300) return;                       // no room on a phone
    var cx = w - 46, cy = 52, r = 20;
    ctx.save();
    ctx.strokeStyle = 'rgba(200, 224, 245, 0.30)';
    ctx.fillStyle = 'rgba(200, 224, 245, 0.30)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
    ctx.stroke();
    // the needle: north filled, south hollow
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 0.92);
    ctx.lineTo(cx - r * 0.24, cy);
    ctx.lineTo(cx + r * 0.24, cy);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 194, 31, 0.75)';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx, cy + r * 0.92);
    ctx.lineTo(cx - r * 0.24, cy);
    ctx.lineTo(cx + r * 0.24, cy);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(200, 224, 245, 0.45)';
    ctx.stroke();
    ctx.font = '800 8px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(222, 236, 250, 0.55)';
    ctx.textAlign = 'center';
    ctx.fillText('N', cx, cy - r - 4);
    ctx.textAlign = 'start';

    // scale bar, bottom left
    var bx = 22, by = h - 22, bl = Math.min(120, w * 0.16);
    ctx.strokeStyle = 'rgba(222, 236, 250, 0.35)';
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + bl, by);
    ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by + 4);
    ctx.moveTo(bx + bl * 0.5, by - 3); ctx.lineTo(bx + bl * 0.5, by + 3);
    ctx.moveTo(bx + bl, by - 4); ctx.lineTo(bx + bl, by + 4);
    ctx.stroke();
    ctx.font = '800 7.5px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(222, 236, 250, 0.45)';
    ctx.fillText('50 km', bx + bl + 6, by + 3);
    ctx.restore();
  }

  /** Deep water: a lit gradient, long swells, and survey soundings. */
  function drawSea(ctx, w, h) {
    var g = ctx.createLinearGradient(0, 0, w * 0.6, h);
    g.addColorStop(0, '#0c1826');
    g.addColorStop(0.55, '#0d1f2e');
    g.addColorStop(1, '#081320');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // long, lazy swells so the water is not flat
    ctx.strokeStyle = 'rgba(120, 190, 220, 0.05)';
    ctx.lineWidth = 1;
    var rnd = rngFrom(9001);
    var i;
    for (i = 0; i < 5; i++) {
      var y0 = h * (0.10 + i * 0.19) + rnd() * 12;
      ctx.beginPath();
      ctx.moveTo(-10, y0);
      for (var x = 0; x <= w + 10; x += 42) {
        ctx.lineTo(x, y0 + Math.sin((x / w) * 6.2 + i) * (7 + i * 1.6));
      }
      ctx.stroke();
    }

    /* Soundings: the stipple-and-numeral marks of a working chart, kept out
     * of the land by a cheap distance test against the lobes. This is what
     * turns "empty dark space" into "surveyed water". */
    ctx.font = '800 7px ui-monospace, monospace';
    for (i = 0; i < 46; i++) {
      var px = rnd() * w, py = rnd() * h;
      var dp = 60 + ((rnd() * 840) | 0);         // consume rnd unconditionally:
      if (nearLand(px, py, w, h)) continue;      // the stream must stay stable
      if (i % 3 === 0) {
        ctx.fillStyle = 'rgba(150, 195, 225, 0.13)';
        ctx.fillText(String(dp), px, py);
      } else {
        ctx.fillStyle = 'rgba(150, 195, 225, 0.17)';
        ctx.fillRect(px, py, 1.6, 1.6);
      }
    }
  }

  /** Is this plate point on or near a lobe? The rift counts too — it keeps
   *  the sounding stipple out of the glow field. */
  function nearLand(px, py, w, h) {
    for (var i = 0; i < regions.length; i++) {
      var r = regions[i];
      if (!r.lobe) continue;
      var dx = (px - mapPX(r.ax, w)) / (r.rr * w * 1.45);
      var dy = (py - mapPY(r.ay, h)) / (r.rr * LOBE_RY * h * 1.45);
      if (dx * dx + dy * dy < 1) return true;
    }
    return false;
  }

  function drawGraticule(ctx, w, h) {
    ctx.strokeStyle = 'rgba(150, 190, 220, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = w * 0.1; x < w; x += w * 0.1) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (var y = h * 0.125; y < h; y += h * 0.125) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
  }

  /* =====================================================================
   * TIER 2 — THE OVERLAY: the company's working annotations
   * ---------------------------------------------------------------------
   * Redrawn on every paint (a few dozen strokes), on top of the blitted
   * plate. No RNG, no gradients, no canvas allocation — geometry comes from
   * the stored lobes and the pin coordinates.
   * ================================================================== */
  function drawOverlay(ctx, w, h) {
    var i, r, m;

    /* --- claimed ground: gold claim hatch + gold coast ------------------ */
    for (i = 0; i < regions.length; i++) {
      r = regions[i];
      if (!(r.owned > 0)) continue;
      var cx = mapPX(r.ax, w), cy = mapPY(r.ay, h);
      var rx = r.rr * w, ry = r.rr * LOBE_RY * h;
      if (r.art.kind === 'rift') {
        // Owning the rift gets a gold survey ring, not a coastline.
        ctx.save();
        if (ctx.setLineDash) ctx.setLineDash([6, 5]);
        ctx.strokeStyle = 'rgba(255, 194, 31, 0.60)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        if (ctx.ellipse) ctx.ellipse(cx, cy, rx * 0.72, ry * 0.72, 0, 0, Math.PI * 2);
        else ctx.arc(cx, cy, Math.min(rx, ry) * 0.72, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        continue;
      }
      ctx.save();
      ctx.beginPath();
      lobeSubpath(ctx, r, w, h, 1);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255, 194, 31, 0.10)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var t = -ry * 2; t <= rx * 2; t += 9) {
        ctx.moveTo(cx - rx + t, cy + ry);
        ctx.lineTo(cx - rx + t + ry * 2, cy - ry);
      }
      ctx.stroke();
      ctx.restore();
      ctx.beginPath();
      lobeSubpath(ctx, r, w, h, 1);
      ctx.strokeStyle = 'rgba(255, 194, 31, 0.80)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    /* --- the haulage road: the price ladder made visible -----------------
     * Solid, cased gold between claims the company owns, walked in rights-
     * price order; one dashed amber segment from the last claim to the next
     * REVEALED unowned ground (the frontier); nothing past the frontier —
     * the road must answer "I'm here, the next rung is there" at a glance. */
    ctx.save();
    ctx.lineCap = 'round';
    var px0 = -1, py0 = -1, frontier = null;
    for (i = 0; i < roadOrder.length; i++) {
      var pin = roadOrder[i];
      m = pin.mine;
      var mx = mapPX(num(m.mapX, 0.5), w), my = mapPY(num(m.mapY, 0.5), h);
      if (ownsMine(m)) {
        if (px0 >= 0) roadSeg(ctx, px0, py0, mx, my, true);
        px0 = mx; py0 = my;
      } else if (!frontier && (!pin.region || pin.region.revealed)) {
        frontier = pin;
      }
    }
    if (frontier && px0 >= 0) {
      var fx = mapPX(num(frontier.mine.mapX, 0.5), w);
      var fy = mapPY(num(frontier.mine.mapY, 0.5), h);
      roadSeg(ctx, px0, py0, fx, fy, false);
      // the surveyor's target on the next ground
      ctx.strokeStyle = 'rgba(255, 178, 60, 0.55)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(fx, fy, 15, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(fx - 21, fy); ctx.lineTo(fx - 11, fy);
      ctx.moveTo(fx + 11, fy); ctx.lineTo(fx + 21, fy);
      ctx.moveTo(fx, fy - 19); ctx.lineTo(fx, fy - 10);   // no south tick: the
      ctx.stroke();                                       // name label lives there
    }
    ctx.restore();

    /* --- selection brackets: the survey instrument's reticle ------------- */
    if (selMine) {
      for (i = 0; i < pins.length; i++) {
        if (pins[i].mine.id !== selMine) continue;
        m = pins[i].mine;
        var sx = mapPX(num(m.mapX, 0.5), w), sy = mapPY(num(m.mapY, 0.5), h);
        var b = 21, l = 6;
        ctx.strokeStyle = 'rgba(235, 244, 252, 0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx - b, sy - b + l); ctx.lineTo(sx - b, sy - b); ctx.lineTo(sx - b + l, sy - b);
        ctx.moveTo(sx + b - l, sy - b); ctx.lineTo(sx + b, sy - b); ctx.lineTo(sx + b, sy - b + l);
        ctx.moveTo(sx - b, sy); ctx.lineTo(sx - b + l, sy);
        ctx.moveTo(sx + b - l, sy); ctx.lineTo(sx + b, sy);
        ctx.stroke();
        break;
      }
    }
  }

  /** One road segment, bowed like a trail rather than ruled like a border. */
  function roadSeg(ctx, x0, y0, x1, y1, owned) {
    var mx = (x0 + x1) * 0.5, my = (y0 + y1) * 0.5 - Math.abs(x1 - x0) * 0.10 - 6;
    if (owned) {
      if (ctx.setLineDash) ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(10, 8, 2, 0.55)';       // casing first, road on top
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(mx, my, x1, y1); ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 194, 31, 0.66)';
      ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(mx, my, x1, y1); ctx.stroke();
    } else {
      if (ctx.setLineDash) ctx.setLineDash([6, 6]);
      ctx.strokeStyle = 'rgba(255, 178, 60, 0.45)';
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(mx, my, x1, y1); ctx.stroke();
      if (ctx.setLineDash) ctx.setLineDash([]);
    }
  }

  /** One DISTRICT of the continent, painted into the (pre-cut) land layer:
   *  its own lit ground, contour rings, hachured shade slope, and terrain
   *  marks — or, unsurveyed, blank paper and a pencilled query. */
  function drawDistrict(ctx, r, w, h) {
    var cx = mapPX(r.ax, w), cy = mapPY(r.ay, h);
    var rx = r.rr * w, ry = r.rr * LOBE_RY * h;
    var x = cx - rx, y = cy - ry, bw = rx * 2, bh = ry * 2;
    var art = r.art, i;

    ctx.save();
    ctx.beginPath();
    lobeSubpath(ctx, r, w, h, 1.06);
    ctx.clip();

    if (!r.revealed) {
      /* UNSURVEYED: blank paper, a query and a few reported fixes. NO
       * palette, NO terrain, NO depth — the fog must not leak what the
       * ground is; the shape alone is the invitation. */
      ctx.fillStyle = '#141a22';
      ctx.fillRect(x - bw, y - bh, bw * 3, bh * 3);
      var rq = rngFrom(r.seed ^ 0x5f5f);
      ctx.strokeStyle = 'rgba(170, 190, 214, 0.16)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (i = 0; i < 3; i++) {
        var tx = cx + (rq() - 0.5) * bw * 0.6, ty = cy + (rq() - 0.5) * bh * 0.6;
        ctx.moveTo(tx - 3, ty); ctx.lineTo(tx + 3, ty);
        ctx.moveTo(tx, ty - 3); ctx.lineTo(tx, ty + 3);
      }
      ctx.stroke();
      ctx.font = '800 ' + Math.round(Math.min(bw, bh) * 0.34) + 'px ui-monospace, monospace';
      ctx.fillStyle = 'rgba(190, 205, 224, 0.10)';
      ctx.textAlign = 'center';
      ctx.fillText('?', cx, cy + Math.min(bw, bh) * 0.12);
      ctx.textAlign = 'start';
      ctx.restore();
      return;
    }

    // the district's own ground, lit from the top-left like everything else
    var g = ctx.createLinearGradient(x, y, x + bw * 0.45, y + bh);
    g.addColorStop(0, art.land[2]);
    g.addColorStop(0.5, art.land[1]);
    g.addColorStop(1, art.land[0]);
    ctx.fillStyle = g;
    ctx.fillRect(x - bw * 0.5, y - bh * 0.5, bw * 2, bh * 2);

    // relief: contour rings of the district's own coast, in its ink
    ctx.strokeStyle = art.ink;
    ctx.lineWidth = 1;
    for (i = 0; i < 3; i++) {
      ctx.globalAlpha = 0.10 + i * 0.02;
      ctx.beginPath();
      lobeSubpath(ctx, r, w, h, 0.74 - i * 0.20);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // hachures down the shaded (south-east) slope
    var rnd = rngFrom(r.seed ^ 0xbeef);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (i = 0; i < 12; i++) {
      var th = (i / 11) * (Math.PI * 0.75) - Math.PI * 0.05;
      var jr = 0.90 + (rnd() - 0.5) * 0.10;
      var ox = Math.cos(th), oy = Math.sin(th);
      ctx.moveTo(cx + ox * rx * jr, cy + oy * ry * jr);
      ctx.lineTo(cx + ox * rx * (jr - 0.14), cy + oy * ry * (jr - 0.14));
    }
    ctx.stroke();

    drawTerrain(ctx, art.kind, x, y, bw, bh, art, rnd);
    ctx.restore();
  }

  /** THE RIFT — not land: a tear in open water with light coming out of it,
   *  parked at the expensive end of the chart. Unsurveyed it is only a
   *  dashed rumour, so the fog leaks nothing there either. */
  function drawRift(ctx, r, w, h) {
    var cx = mapPX(r.ax, w), cy = mapPY(r.ay, h);
    var rx = r.rr * w * 0.85, ry = r.rr * LOBE_RY * h * 0.85;
    var i;
    ctx.save();
    if (!r.revealed) {
      if (ctx.setLineDash) ctx.setLineDash([3, 6]);
      ctx.strokeStyle = 'rgba(150, 170, 200, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.ellipse) ctx.ellipse(cx, cy, rx * 0.7, ry * 0.7, 0, 0, Math.PI * 2);
      else ctx.arc(cx, cy, Math.min(rx, ry) * 0.7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = '800 ' + Math.round(Math.min(rx, ry) * 0.6) + 'px ui-monospace, monospace';
      ctx.fillStyle = 'rgba(190, 205, 224, 0.10)';
      ctx.textAlign = 'center';
      ctx.fillText('?', cx, cy + Math.min(rx, ry) * 0.2);
      ctx.textAlign = 'start';
      ctx.restore();
      return;
    }
    // the glow field in the water
    var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
    g.addColorStop(0, 'rgba(196, 107, 255, 0.28)');
    g.addColorStop(0.6, 'rgba(196, 107, 255, 0.10)');
    g.addColorStop(1, 'rgba(196, 107, 255, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - rx * 1.3, cy - ry * 1.3, rx * 2.6, ry * 2.6);
    // dark water pulled toward the tear
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.30)';
    ctx.lineWidth = 1.2;
    for (i = 1; i <= 2; i++) {
      ctx.beginPath();
      if (ctx.ellipse) ctx.ellipse(cx, cy, rx * 0.34 * i, ry * 0.30 * i, 0.3, 0, Math.PI * 2);
      else ctx.arc(cx, cy, Math.min(rx, ry) * 0.32 * i, 0, Math.PI * 2);
      ctx.stroke();
    }
    // the tear itself, with a wide soft echo under a hot line
    var rnd = rngFrom(r.seed);
    var n = 7, k;
    for (var pass = 0; pass < 2; pass++) {
      var rr2 = rngFrom(r.seed);              // same jitter both passes
      ctx.strokeStyle = pass === 0 ? 'rgba(196, 107, 255, 0.25)' : 'rgba(245, 218, 255, 0.90)';
      ctx.lineWidth = pass === 0 ? 5 : 1.8;
      ctx.beginPath();
      ctx.moveTo(cx - rx * 0.55, cy - ry * 0.5);
      for (k = 1; k <= n; k++) {
        ctx.lineTo(cx - rx * 0.55 + (k / n) * rx * 1.1 + (rr2() - 0.5) * rx * 0.16,
                   cy - ry * 0.5 + (k / n) * ry * 1.0 + (rr2() - 0.5) * ry * 0.16);
      }
      ctx.stroke();
    }
    // stray shards of light around the tear
    ctx.strokeStyle = 'rgba(196, 107, 255, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (i = 0; i < 5; i++) {
      var sx = cx + (rnd() - 0.5) * rx * 1.5, sy = cy + (rnd() - 0.5) * ry * 1.5;
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + (rnd() - 0.5) * 10, sy + (rnd() - 0.5) * 10);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Kind-specific terrain marks, drawn inside the district clip. Alphas sit
   *  around 0.2-0.5 — a mark that needs squinting for is not a mark — and
   *  every raised thing casts its shadow the same way: down and to the
   *  right, matching the plate's one sun. (The rift never comes through
   *  here; it is drawn offshore by drawRift.) */
  function drawTerrain(ctx, kind, x, y, w, h, art, rnd) {
    var i, n, px, py, s;
    if (kind === 'mountains' || kind === 'ice') {
      // Ridges: back row hazy, front row sharp, snow caps, cast shadows.
      for (var row = 0; row < 2; row++) {
        n = 4 + (row === 0 ? 2 : 0);
        for (i = 0; i < n; i++) {
          var bx = x + w * (0.12 + (i / n) * 0.78) + rnd() * 10;
          var by = y + h * (row === 0 ? 0.46 : 0.68);
          s = h * (row === 0 ? 0.20 : 0.30) * (0.7 + rnd() * 0.6);
          // the shadow the peak throws down-right
          ctx.beginPath();
          ctx.moveTo(bx, by - s);
          ctx.lineTo(bx + s * 0.9, by);
          ctx.lineTo(bx + s * 1.5, by + s * 0.16);
          ctx.closePath();
          ctx.fillStyle = 'rgba(0, 0, 0, 0.20)';
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(bx - s * 0.9, by);
          ctx.lineTo(bx, by - s);
          ctx.lineTo(bx + s * 0.9, by);
          ctx.closePath();
          ctx.fillStyle = row === 0 ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.24)';
          ctx.fill();
          // the lit face
          ctx.beginPath();
          ctx.moveTo(bx - s * 0.9, by);
          ctx.lineTo(bx, by - s);
          ctx.lineTo(bx, by);
          ctx.closePath();
          ctx.fillStyle = 'rgba(255,255,255,0.10)';
          ctx.fill();
          // cap
          ctx.beginPath();
          ctx.moveTo(bx - s * 0.30, by - s * 0.66);
          ctx.lineTo(bx, by - s);
          ctx.lineTo(bx + s * 0.30, by - s * 0.66);
          ctx.closePath();
          ctx.fillStyle = kind === 'ice' ? 'rgba(232,253,255,0.80)' : 'rgba(226,236,248,0.60)';
          ctx.fill();
        }
      }
      if (kind === 'ice') {
        // crevasse cross-hatch and a stippled shelf edge
        ctx.strokeStyle = 'rgba(198, 236, 247, 0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (i = 0; i < 7; i++) {
          px = x + rnd() * w; py = y + h * (0.52 + rnd() * 0.4);
          ctx.moveTo(px, py);
          ctx.lineTo(px + w * 0.10 * (rnd() - 0.5), py + h * 0.10);
          ctx.moveTo(px - 3, py + 4);
          ctx.lineTo(px + 5, py + 2);
        }
        ctx.stroke();
        ctx.fillStyle = 'rgba(232, 253, 255, 0.30)';
        for (i = 0; i < 16; i++) {
          ctx.fillRect(x + rnd() * w, y + h * (0.78 + rnd() * 0.2), 2, 2);
        }
      }
      return;
    }
    if (kind === 'quarry') {
      // Terraced benches with a shadowed cut face, and spoil heaps beside.
      for (i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.ellipse(x + w * 0.5, y + h * (0.62 + i * 0.03),
                    w * (0.34 - i * 0.07), h * (0.20 - i * 0.04), 0, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.lineWidth = 2;
        ctx.stroke();
        // the bench catches light on its upper-left lip
        ctx.strokeStyle = 'rgba(255, 220, 170, 0.28)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(x + w * 0.5, y + h * (0.615 + i * 0.03),
                    w * (0.34 - i * 0.07), h * (0.20 - i * 0.04), 0, Math.PI * 1.05, Math.PI * 1.85);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255, 220, 170, 0.06)';
        ctx.beginPath();
        ctx.ellipse(x + w * 0.5, y + h * (0.62 + i * 0.03),
                    w * (0.34 - i * 0.07), h * (0.20 - i * 0.04), 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
      for (i = 0; i < 9; i++) {
        px = x + w * (0.12 + rnd() * 0.76); py = y + h * (0.24 + rnd() * 0.2);
        ctx.beginPath();
        ctx.arc(px, py, 1.6 + rnd() * 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    if (kind === 'volcanic') {
      // The cone, its shadow, a hot throat, fissures and an ash fall.
      var vx = x + w * 0.5, vy = y + h * 0.62, vs = h * 0.36;
      ctx.beginPath();                              // cast shadow first
      ctx.moveTo(vx, vy - vs);
      ctx.lineTo(vx + vs, vy);
      ctx.lineTo(vx + vs * 1.7, vy + vs * 0.2);
      ctx.closePath();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.26)';
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(vx - vs, vy);
      ctx.lineTo(vx - vs * 0.22, vy - vs);
      ctx.lineTo(vx + vs * 0.22, vy - vs);
      ctx.lineTo(vx + vs, vy);
      ctx.closePath();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.50)';
      ctx.fill();
      ctx.beginPath();                              // the throat
      ctx.moveTo(vx - vs * 0.22, vy - vs);
      ctx.lineTo(vx + vs * 0.22, vy - vs);
      ctx.lineTo(vx, vy - vs * 0.78);
      ctx.closePath();
      ctx.fillStyle = art.edge;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 122, 42, 0.70)';  // glowing fissures
      ctx.lineWidth = 1.6;
      for (i = 0; i < 5; i++) {
        px = x + w * (0.18 + rnd() * 0.64);
        py = y + h * (0.60 + rnd() * 0.3);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + w * 0.09 * (rnd() - 0.5), py + h * 0.09);
        ctx.lineTo(px + w * 0.16 * (rnd() - 0.5), py + h * 0.16);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(0, 0, 0, 0.24)';         // ash falling down-wind
      for (i = 0; i < 20; i++) {
        ctx.fillRect(vx + rnd() * w * 0.42, vy - vs + rnd() * h * 0.5, 2, 2);
      }
      return;
    }
    if (kind === 'lowland') {
      // Standing water, then the chart-symbol marsh: rows of short dashes.
      for (i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.ellipse(x + w * (0.2 + rnd() * 0.6), y + h * (0.45 + rnd() * 0.42),
                    w * (0.06 + rnd() * 0.10), h * (0.03 + rnd() * 0.05), 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(105, 170, 185, 0.40)';
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.30)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (i = 0; i < 22; i++) {
        px = x + w * (0.10 + rnd() * 0.78);
        py = y + h * (0.30 + rnd() * 0.6);
        ctx.moveTo(px - 4, py); ctx.lineTo(px + 4, py);
        ctx.moveTo(px - 1.5, py - 2.5); ctx.lineTo(px + 1.5, py - 2.5);
      }
      ctx.stroke();
      return;
    }
    if (kind === 'desert') {
      ctx.strokeStyle = 'rgba(255, 238, 192, 0.32)';
      ctx.lineWidth = 1.4;
      for (i = 0; i < 6; i++) {
        py = y + h * (0.40 + i * 0.09);
        ctx.beginPath();
        ctx.moveTo(x + w * 0.10, py);
        ctx.quadraticCurveTo(x + w * 0.5, py - h * 0.06, x + w * 0.9, py);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
      for (i = 0; i < 18; i++) {
        ctx.fillRect(x + rnd() * w, y + h * (0.3 + rnd() * 0.6), 2, 2);
      }
      return;
    }
    // hills: folded arcs with a shadowed underside, and copses of dots
    for (i = 0; i < 5; i++) {
      py = y + h * (0.40 + i * 0.10);
      var midx = x + w * (0.3 + rnd() * 0.4);
      ctx.beginPath();
      ctx.moveTo(x + w * 0.08, py);
      ctx.quadraticCurveTo(midx, py - h * 0.13, x + w * 0.92, py);
      ctx.strokeStyle = 'rgba(255, 255, 255, ' + (0.22 - i * 0.02).toFixed(3) + ')';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + w * 0.08, py + 2);
      ctx.quadraticCurveTo(midx, py - h * 0.13 + 2, x + w * 0.92, py + 2);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.16)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
    for (i = 0; i < 20; i++) {
      ctx.fillRect(x + rnd() * w, y + h * (0.35 + rnd() * 0.55), 2, 2);
    }
  }

  function paintMineCard() {
    var m = (SM.mines && SM.mines.get) ? SM.mines.get(selMine) : null;
    if (!m) {
      els.card.classList.remove('sm-av-minecard-on');
      return;
    }
    els.card.classList.add('sm-av-minecard-on');

    var owned = ownsMine(m);
    var price = num(m.price, 0);
    var cash = advNum('getCash', 0);
    var rec = num(m.recDrill, 0);
    var mine = mineStateOf(m.id);
    var yours = rigNum('getDrillPower', 0);

    els.cardName.textContent = String(m.name || m.id).toUpperCase();
    els.cardRegion.textContent = String(m.region || '').toUpperCase();
    els.cardBlurb.textContent = String(m.blurb || '');
    els.cardPrice.textContent = owned ? 'HELD' : money(price);
    els.cardPrice.className = 'sm-cell-value' + (owned ? ' sm-av-good' : '');
    els.cardDrill.textContent = rec > 0 ? (fmt(rec) + '+   YOURS ' + fmt(yours)) : ('YOURS ' + fmt(yours));
    els.cardDrill.className = 'sm-cell-value' + ((rec > 0 && yours < rec) ? ' sm-av-bad' : '');
    els.cardDepth.textContent = fmt(num(m.depth, 0)) + ' m';
    els.cardBest.textContent = (mine && num(mine.deepestM, 0) > 0)
      ? (fmt(mine.deepestM) + ' m' + (num(mine.visits, 0) ? ('  ·  ' + fmt(mine.visits) + ' RUNS') : ''))
      : '—';

    paintProfile(m);

    var levels = liftLevels(m.id);
    if (levels) {
      var lo = ownedCount(levels), lt = levels.length;
      var deep = levelAt(levels, deepestOwned(levels));
      els.cardLift.textContent = 'LIFT   ' + fmt(lo) + ' OF ' + fmt(lt) + ' LEVELS' +
        (deep ? ('   ·   DEEPEST ' + levelLabel(deep) + ' ' + bandText(deep)) : '');
      els.cardLift.style.display = '';
    } else {
      els.cardLift.textContent = '';
      els.cardLift.style.display = 'none';
    }

    /* "You can enter, but it will hurt" — the honest message, not a locked
     * door. Under-gunned is slow and expensive, never refused. */
    var warn = '';
    if (rec > 0 && yours < rec * 0.7) warn = 'Your drill will stall in this rock. Expect to burn fuel for every metre.';
    else if (rec > 0 && yours < rec) warn = 'Under-gunned for this ground. Workable, but slow and thirsty.';
    // Endurance against depth: the other half of "can I get home from here?",
    // and the thing that actually separates two mines at the same price.
    var end = rigNum('getEndurance', 0);
    if (!warn && end > 0 && num(m.depth, 0) > 0) {
      var climb = num(m.depth, 0) / (rigNum('getSpeed', 200) * MPU);   // seconds, straight up
      if (climb * 2.6 > end) warn = 'A full tank barely covers the round trip at this depth. Fit a bigger tank first.';
    }
    els.cardWarn.textContent = warn;
    els.cardWarn.style.display = warn ? '' : 'none';

    els.cardRes.innerHTML = '';
    chipRow(els.cardRes, 'COMMON', m.common);
    chipRow(els.cardRes, 'RARE', m.rare);
    var haz = (m.hazards && m.hazards.length) ? m.hazards.join('  ·  ') : '';
    els.cardHaz.textContent = haz ? ('HAZARDS   ' + haz.toUpperCase()) : '';
    els.cardHaz.style.display = haz ? '' : 'none';

    var b = els.cardBtn;
    b.disabled = false;
    b.classList.remove('sm-av-cant');
    if (owned) {
      b.textContent = 'PREPARE DESCENT';
    } else if (cash >= price) {
      b.textContent = 'BUY RIGHTS  ' + money(price);
    } else {
      b.textContent = 'NEED ' + money(price - cash) + ' MORE';
      b.disabled = true;
      b.classList.add('sm-av-cant');
    }
  }

  /**
   * HEAT · GROUND · PAY, straight off the layer table.
   *
   * This is the row that makes a fork in the catalogue legible: two mines can
   * be within a few thousand dollars of each other and be a safe bet and a
   * gamble respectively, and the only honest way to say so is to read the
   * layers the player is about to drive through. A mine with no `layers` (or a
   * catalogue that has not landed yet) simply gets no row.
   */
  function paintProfile(m) {
    var box = els.cardProfile;
    box.innerHTML = '';
    var layers = (m && m.layers && m.layers.length) ? m.layers : null;
    if (!layers) { box.style.display = 'none'; return; }
    box.style.display = '';

    var heat = 0, hard = 0, i, L;
    for (i = 0; i < layers.length; i++) {
      L = layers[i];
      if (!L) continue;
      if (num(L.heat, 0) > heat) heat = num(L.heat, 0);
      if (num(L.hardnessScale, 1) > hard) hard = num(L.hardnessScale, 1);
    }

    var heatWord = heat <= 0.001 ? 'NONE' : (heat < 0.35 ? 'MILD' : (heat < 0.7 ? 'HOT' : 'SEVERE'));
    var heatTone = heat <= 0.001 ? 'good' : (heat < 0.7 ? 'warn' : 'bad');
    var groundWord = hard <= 1.0 ? 'SOFT' : (hard < 1.12 ? 'FIRM' : 'HARD');
    var groundTone = hard <= 1.0 ? 'good' : (hard < 1.12 ? 'warn' : 'bad');

    // The best thing in the ground, by price — what the trip is actually for.
    var payId = '', payVal = -1;
    var pool = (m.rare && m.rare.length) ? m.rare : m.common;
    if (pool) {
      for (i = 0; i < pool.length; i++) {
        var v = (SM.mines && SM.mines.priceOf) ? num(SM.mines.priceOf(pool[i]), 0) : 0;
        if (v > payVal) { payVal = v; payId = pool[i]; }
      }
    }

    profileCell(box, 'HEAT', heatWord, heatTone);
    profileCell(box, 'GROUND', groundWord, groundTone);
    if (payId) {
      var d = displayOf(payId);
      var c = profileCell(box, 'PAYS FOR', d.name.toUpperCase(), '');
      c.style.setProperty('--sm-av-chip', d.color);
      c.classList.add('sm-av-prof-ore');
    }
  }

  function profileCell(parent, label, value, tone) {
    var cell = el('div', 'sm-av-prof' + (tone ? (' sm-av-prof-' + tone) : ''), parent);
    el('span', 'sm-av-prof-label', cell, label);
    el('span', 'sm-av-prof-value', cell, value);
    return cell;
  }

  function chipRow(parent, label, ids) {
    if (!ids || !ids.length) return;
    var row = el('div', 'sm-av-chiprow', parent);
    el('span', 'sm-av-chiplabel', row, label);
    for (var i = 0; i < ids.length; i++) {
      var d = displayOf(ids[i]);
      var chip = el('span', 'sm-av-chip', row, d.name.toUpperCase());
      chip.style.setProperty('--sm-av-chip', d.color);
    }
  }

  function onMineAction() {
    var m = (SM.mines && SM.mines.get) ? SM.mines.get(selMine) : null;
    if (!m) return;
    if (ownsMine(m)) {
      if (SM.adv && SM.adv.selectMine) SM.adv.selectMine(m.id);
      return;
    }
    var ok = !!(SM.adv && SM.adv.buyRights && SM.adv.buyRights(m.id));
    if (ok) {
      toast('RIGHTS ACQUIRED', String(m.name || m.id).toUpperCase() + ' is yours to dig', 2.4);
      refresh();
    } else {
      toast('PURCHASE REFUSED', 'The ledger will not cover it', 2.0);
    }
  }

  /* ---------------------------------------------------------------------
   * GARAGE
   * ------------------------------------------------------------------ */
  function buildGarage() {
    var s = makeScreen('garage', 'THE WORKSHOP · EIGHT SUBASSEMBLIES', 'YOUR MACHINE');

    var stage = el('div', 'sm-av-rig', s.body);
    els.rigStage = stage;
    els.rigCanvas = el('canvas', 'sm-av-rig-canvas', stage);
    els.rigHots = el('div', 'sm-av-hots', stage);
    for (var i = 0; i < PARTS.length; i++) partTags[PARTS[i].key] = makeHotspot(PARTS[i]);

    var d = el('div', 'sm-panel sm-av-part', s.body);
    els.part = d;
    el('div', 'sm-stripe', d);
    var head = el('div', 'sm-av-card-head', d);
    els.partName = el('div', 'sm-av-card-name', head, '');
    els.partTier = el('div', 'sm-av-card-region', head, '');
    els.partBlurb = el('div', 'sm-av-card-blurb', d, '');
    els.partPips = el('div', 'sm-av-pips', d);
    var grid = el('div', 'sm-av-card-grid', d);
    els.partStat = statCell(grid, 'FITTED', '0');
    els.partNext = statCell(grid, 'NEXT TIER', '—');
    /* WHAT THE NEXT TIER LETS YOU DO. rig.js writes one line of sales copy per
     * tier and that line is the only thing the workshop should ever be
     * selling — a stat delta says "12% more drill", this says "the Rift locks
     * open". Shown in the warn slot's styling because it is the pitch. */
    els.partSell = el('div', 'sm-av-warn sm-av-sell', d, '');
    els.partDelta = el('div', 'sm-av-sub sm-av-delta', d, '');

    els.partBtn = button(s.foot, 'sm-btn-primary sm-btn-big', 'INSTALL');
    onTap(els.partBtn, onBuyPart);

    /* STRAIGHT BACK DOWN FROM HERE TOO.
     * Fitting a part is something you do BETWEEN descents, on the mine you are
     * already working — so making the workshop a dead end that only exits to the
     * world map put the same detour back in that the extraction screen just
     * lost. Only offered when there is a mine to go back to. */
    els.garageDive = button(s.foot, '', 'BACK TO MINE');
    onTap(els.garageDive, onBackToMine);

    els.garageMap = button(s.foot, '', 'BACK TO THE MAP');
    onTap(els.garageMap, function () {
      if (SM.adv && SM.adv.backToMap) SM.adv.backToMap();
      else if (SM.adv && SM.adv.openMap) SM.adv.openMap();
    });

    /* --- THE ONE WAY OUT WHEN A RUN IS STILL UNDERNEATH -----------------
     * Opened from the lift menu (SM.adv.openGarage() with the machine in the
     * cage), this screen is a DETOUR and not a destination: the hold, the tank
     * and the tunnels are all still live one state below it, and the only honest
     * exit is back into the lift the player is standing in.
     *
     * The other two plates are HIDDEN rather than disabled for that trip, and
     * that is deliberate — both of them mean "start something else", and both
     * are refused by adv.js while a run is held (see the shopHold note there).
     * A greyed-out BACK TO MINE beside a live expedition would be the screen
     * asking a question that has no answer. */
    els.garageLift = button(s.foot, 'sm-btn-primary sm-btn-big', 'BACK TO THE LIFT');
    onTap(els.garageLift, function () {
      if (SM.adv && SM.adv.closeShop) SM.adv.closeShop();
    });
  }

  /** The mine a BACK TO MINE button would descend into, or '' if there is none. */
  function lastMineId() {
    var r = (SM.adv && SM.adv.getResults) ? SM.adv.getResults() : null;
    if (r && r.mineId) return r.mineId;
    var m = (SM.adv && SM.adv.getMine) ? SM.adv.getMine() : null;
    if (m && m.id) return m.id;
    return selMine || '';
  }

  function makeHotspot(part) {
    var node = el('button', 'sm-av-hot', els.rigHots);
    node.setAttribute('type', 'button');
    node.setAttribute('title', part.title);
    // Position is written by drawRig(), which is the only place that knows the
    // garage transform. A sane default keeps them on-screen before the first
    // paint (e.g. if the canvas has no size yet).
    node.style.left = '50%';
    node.style.top = '50%';
    el('span', 'sm-av-hot-dot', node);
    var lbl = el('span', 'sm-av-hot-lbl', node, part.title);
    var lv = el('span', 'sm-av-hot-lv', node, '');
    onTap(node, function () {
      selPart = part.key;
      paintGarage();
    });
    return { node: node, label: lbl, lv: lv, part: part };
  }

  function paintGarage() {
    var i, t, p;
    for (i = 0; i < PARTS.length; i++) {
      p = PARTS[i];
      t = partTags[p.key];
      var tier = rigTier(p.key);
      var maxed = rigMaxed(p.key);
      t.lv.textContent = tier > 0 ? ('MK ' + roman(tier + 1)) : '';
      t.node.classList[selPart === p.key ? 'add' : 'remove']('sm-av-hot-sel');
      t.node.classList[maxed ? 'add' : 'remove']('sm-av-hot-max');
      var cost = rigCost(p.key);
      var can = cost >= 0 && advNum('getCash', 0) >= cost;
      t.node.classList[can ? 'add' : 'remove']('sm-av-hot-buy');
    }
    paintPart();
    drawRig();

    /* THE FOOTER IS ONE OF TWO SHAPES, and which one depends on whether there
     * is a live expedition parked under this screen. See buildGarage(). */
    var held = !!(SM.adv && SM.adv.isShopHold && SM.adv.isShopHold());
    if (els.garageLift) els.garageLift.style.display = held ? '' : 'none';
    if (els.garageMap) {
      els.garageMap.style.display = held ? 'none' : '';
      /* ...AND THE PLATE NAMES WHERE IT ACTUALLY GOES. adv.backToMap() means
       * "out to the place between runs" and that is PREPARE DESCENT until the
       * map is earned (js/adv.js's THE MAP IS EARNED), so the label follows the
       * destination rather than promising a chart the company has not got. */
      els.garageMap.textContent = mapUnlocked() ? 'BACK TO THE MAP' : 'PREPARE DESCENT';
    }

    /* BACK TO MINE only exists when there is somewhere to go back to, and it
     * says whether the tank can actually do it — the alternative is a button
     * that drops you into a shaft on an empty tank and ends the run instantly. */
    if (els.garageDive) {
      var id = lastMineId();
      var aboard = advNum('getTank', 0);
      els.garageDive.style.display = (id && !held) ? '' : 'none';
      if (id && !held) {
        // Label stays put; an empty tank just greys it out. See paintResFooter().
        els.garageDive.textContent = 'BACK TO MINE';
        if (aboard < 1) els.garageDive.setAttribute('disabled', 'disabled');
        else els.garageDive.removeAttribute('disabled');
      }
    }
  }

  function rigTier(key) { return (SM.rig && SM.rig.getTier) ? num(SM.rig.getTier(key), 0) : 0; }
  function rigMaxed(key) { return !!(SM.rig && SM.rig.isMaxed && SM.rig.isMaxed(key)); }
  function rigCost(key) { return (SM.rig && SM.rig.nextCost) ? num(SM.rig.nextCost(key), -1) : -1; }
  function rigMax(key) { return (SM.rig && SM.rig.maxTier) ? num(SM.rig.maxTier(key), 0) : 0; }

  function partMeta(key) {
    for (var i = 0; i < PARTS.length; i++) if (PARTS[i].key === key) return PARTS[i];
    return PARTS[0];
  }

  /** The tier descriptor at an absolute index, however rig.js exposes it. */
  function tierInfo(key, n) {
    if (SM.rig && SM.rig.getTierInfo) {
      var t = SM.rig.getTierInfo(key, n);
      if (t) return t;
    }
    var rec = (SM.rig && SM.rig.getPart) ? SM.rig.getPart(key) : null;
    if (rec && rec.tiers && rec.tiers[n]) return rec.tiers[n];
    return null;
  }

  /**
   * 'POWER 21 -> 35   ·   CAP 14 -> 20'.
   * rig.js names the fields that matter for a part in `stats`, and each tier
   * descriptor carries them, so the delta is read off the real table rather
   * than guessed at — and a part table without `stats` simply prints nothing
   * instead of inventing numbers.
   */
  function statDelta(key, rec, tier, maxed) {
    if (!rec || !rec.stats || !rec.stats.length) return '';
    var a = tierInfo(key, tier);
    var b = maxed ? null : tierInfo(key, tier + 1);
    if (!a) return '';
    var out = [];
    for (var i = 0; i < rec.stats.length; i++) {
      var s = rec.stats[i];
      var av = a[s];
      if (typeof av !== 'number') continue;
      var line = String(s).toUpperCase() + ' ' + trim1(av);
      if (b && typeof b[s] === 'number' && b[s] !== av) line += ' → ' + trim1(b[s]);
      out.push(line);
    }
    return out.join('   ·   ');
  }

  /** One decimal, but only when there is one — 8.5 stays 8.5, 21.0 reads 21. */
  function trim1(v) {
    var r = Math.round(v * 10) / 10;
    return (r === (r | 0)) ? ('' + (r | 0)) : r.toFixed(1);
  }

  function paintPart() {
    var p = partMeta(selPart);
    var tier = rigTier(p.key);
    var cost = rigCost(p.key);
    var maxed = rigMaxed(p.key);
    var nextName = (SM.rig && SM.rig.nextName) ? SM.rig.nextName(p.key) : null;

    /* rig.js may or may not have a rich part record yet. Whatever it has is
     * preferred over the local copy; the local copy is what keeps the screen
     * readable while Agent 2 is still building the table. */
    var rec = (SM.rig && SM.rig.getPart) ? SM.rig.getPart(p.key) : null;
    var title = (rec && rec.title) ? rec.title : p.title;
    var blurb = (rec && rec.blurb) ? rec.blurb : p.blurb;

    /* The FITTED tier's own name, when rig.js has one — 'WORN AUGER BIT' tells
     * the player what is bolted to their machine; 'MK I' tells them nothing. */
    var cur = tierInfo(p.key, tier);
    els.partName.textContent = String(title).toUpperCase();
    els.partTier.textContent = 'FITTED: ' + (cur && cur.name ? String(cur.name).toUpperCase()
                                                            : ('MK ' + roman(tier + 1)));
    els.partBlurb.textContent = blurb;

    els.partStat.textContent = p.stat + '  ' + fmt(p.get()) + p.unit;
    els.partNext.textContent = maxed ? 'FULLY UPGRADED' : (nextName ? String(nextName).toUpperCase() : 'NEXT TIER');

    // The pitch, and then the arithmetic under it.
    var sell = (!maxed && SM.rig && SM.rig.nextBlurb) ? SM.rig.nextBlurb(p.key) : null;
    els.partSell.textContent = sell ? String(sell) : '';
    els.partSell.style.display = sell ? '' : 'none';
    els.partDelta.textContent = statDelta(p.key, rec, tier, maxed);

    // Tier pips: the progression at a glance, and the only place the machine's
    // remaining headroom is visible.
    var max = rigMax(p.key);
    var want = max + 1;
    if (want < 1) want = 1;
    if (els.partPips.childNodes.length !== want) {
      els.partPips.innerHTML = '';
      for (var i = 0; i < want; i++) el('span', 'sm-av-pip', els.partPips);
    }
    for (var j = 0; j < els.partPips.childNodes.length; j++) {
      els.partPips.childNodes[j].className = 'sm-av-pip' + (j <= tier ? ' sm-av-pip-on' : '');
    }

    /* THE BUTTON KEEPS ITS NAME AND GREYS OUT; the REASON goes in the panel.
     * A control that renames itself to "NOTHING LEFT TO FIT" or "NEED $2 000
     * MORE" is a status readout wearing a button's clothes, and the label moves
     * under the player's thumb. INSTALL always says INSTALL and what it costs;
     * why it is unavailable is written above it, where there is room to say it
     * properly. */
    var fit = (SM.rig && SM.rig.fitCheck) ? SM.rig.fitCheck(p.key) : { ok: true };
    var short = cost >= 0 ? (cost - advNum('getCash', 0)) : 0;
    var b = els.partBtn;
    b.disabled = false;
    b.classList.remove('sm-av-cant');
    b.textContent = (!maxed && cost >= 0) ? ('INSTALL  ' + money(cost)) : 'INSTALL';

    var block = '';
    if (maxed || cost < 0) {
      block = '';                                  // the pips already say it
      b.disabled = true;
      b.classList.add('sm-av-cant');
    } else if (!fit.ok) {
      /* RUNNING GEAR BEFORE POWER. Name the actual part the player has to buy,
       * not the rule — "REQUIRES WIDE STEEL TRACKS" is a shopping instruction,
       * "prerequisite not met" is a error message. */
      var needTitle = fit.needKey ? String(fit.needKey).toUpperCase() : 'RUNNING GEAR';
      block = 'REQUIRES ' + needTitle +
              (fit.needName ? (': ' + String(fit.needName).toUpperCase()) : '') +
              ' — the tracks cannot carry this engine yet.';
      b.disabled = true;
      b.classList.add('sm-av-cant');
    } else if (short > 0) {
      block = 'NEED ' + money(short) + ' MORE IN THE ACCOUNT.';
      b.disabled = true;
      b.classList.add('sm-av-cant');
    }
    if (block) {
      els.partSell.textContent = block;
      els.partSell.style.display = '';
    }
  }

  function onBuyPart() {
    var p = partMeta(selPart);
    var before = rigTier(p.key);
    var ok = !!(SM.adv && SM.adv.buyPart && SM.adv.buyPart(p.key));
    if (ok || rigTier(p.key) !== before) {
      toast(String(p.title) + ' UPGRADED', 'MK ' + roman(rigTier(p.key) + 1) + ' fitted and bolted down', 2.4);
      if (SM.effects && SM.effects.screenFlash) SM.effects.screenFlash(0.10, 255, 210, 120);
      refresh();
    } else {
      toast('INSTALL REFUSED', 'The ledger will not cover it', 2.0);
    }
  }

  /**
   * THE MACHINE, DRAWN BY THE REAL RENDERER.
   * vehicle.render() draws in world space around SM.vehicle.getX/getY with -y
   * forward, so the garage transform is: centre the canvas, scale to frame
   * GARAGE_VIEW_H world units, then translate the machine's own position back
   * to the origin. No second illustration to drift out of step, and every part
   * flag rig.js sets shows up here the moment it is bought.
   */
  function drawRig() {
    var c = els.rigCanvas;
    if (!c || !c.getContext) return;
    var w = c.clientWidth | 0;
    var h = c.clientHeight | 0;
    if (w < 20 || h < 20) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }

    var ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    /* --- the shop floor: a plate, a grid and a pool of work light -------- */
    var g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(24,27,33,0.92)');
    g.addColorStop(1, 'rgba(10,11,14,0.96)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(120,140,165,0.09)';
    ctx.lineWidth = 1;
    var step = 34;
    ctx.beginPath();
    for (var gx = (w * 0.5) % step; gx < w; gx += step) { ctx.moveTo(gx, 0); ctx.lineTo(gx, h); }
    for (var gy = (h * 0.5) % step; gy < h; gy += step) { ctx.moveTo(0, gy); ctx.lineTo(w, gy); }
    ctx.stroke();
    var lamp = ctx.createRadialGradient(w * 0.5, h * 0.42, 10, w * 0.5, h * 0.42, Math.max(w, h) * 0.62);
    lamp.addColorStop(0, 'rgba(255,214,140,0.16)');
    lamp.addColorStop(1, 'rgba(255,214,140,0)');
    ctx.fillStyle = lamp;
    ctx.fillRect(0, 0, w, h);

    /* THE GARAGE TRANSFORM. GARAGE_VIEW_H is how many world units of machine
     * fill the frame's height; the width term keeps a very wide blade inside a
     * narrow canvas. Everything below — the machine and the eight hotspots —
     * goes through these same three numbers, which is why a tag cannot drift
     * off its subassembly. */
    var cx = w * 0.5, cy = h * 0.52;
    var s = h / GARAGE_VIEW_H;
    var sw = w / (GARAGE_VIEW_H * 1.15);
    if (sw < s) s = sw;
    if (s < GARAGE_MIN_S) s = GARAGE_MIN_S;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    var vx = 0, vy = 0;
    if (SM.vehicle && SM.vehicle.getX) { vx = num(SM.vehicle.getX(), 0); vy = num(SM.vehicle.getY(), 0); }
    ctx.translate(-vx, -vy);
    placeHotspots(cx, cy, s);
    try {
      /* `true` = SHOWROOM PASS. Without it the machine is invisible whenever the
       * workshop is opened from inside the lift: vehicle.render()'s first two
       * lines are "the cage has the machine, draw nothing", which is right in
       * the world and wrong on this screen. It also drops the heading and the
       * bank, so the portrait is the machine and not the last frame of a turn. */
      if (SM.vehicle && SM.vehicle.render) SM.vehicle.render(ctx, true);
    } catch (e) {
      // The renderer belongs to another agent and may be mid-edit. A workshop
      // that cannot draw the machine is a bad screen; one that throws takes
      // the whole campaign down with it.
      ctx.restore();
      ctx.fillStyle = 'rgba(255,90,72,0.65)';
      ctx.font = '600 12px ' + 'ui-monospace, monospace';
      ctx.fillText('MACHINE PREVIEW UNAVAILABLE', 14, h - 14);
      return;
    }
    ctx.restore();
  }

  /**
   * Put the eight tags on the machine, in canvas pixels, using the garage
   * transform and the machine's CURRENT geometry. vehicle.js publishes the two
   * numbers that matter (getWidth() is the hull's full width, getBladeFrontY()
   * the nose in local space); both grow with upgrades, so the tags spread out
   * as the machine does instead of being authored once against the starter rig.
   */
  function placeHotspots(cx, cy, s) {
    var bl = (SM.config && SM.config.VEHICLE_BODY_LENGTH) ? SM.config.VEHICLE_BODY_LENGTH : 158;
    var hw = 48;
    if (SM.vehicle && SM.vehicle.getWidth) {
      var wd = num(SM.vehicle.getWidth(), 96);
      if (wd > 10) hw = wd * 0.5;
    }
    var nose = -bl * 0.5 - 40;
    if (SM.vehicle && SM.vehicle.getBladeFrontY) {
      var f = num(SM.vehicle.getBladeFrontY(), nose);
      if (f < 0) nose = f;
    }
    /* Keep every tag inside the frame. A fully upgraded hull with the magnet
     * arms deployed is wide enough to push the LIGHTS and SCANNER tags off a
     * 372 px phone canvas, and half a clipped word names nothing. */
    var w = els.rigCanvas ? (els.rigCanvas.clientWidth | 0) : 0;
    var h = els.rigCanvas ? (els.rigCanvas.clientHeight | 0) : 0;
    var mx = 34, my = 18;
    for (var i = 0; i < PARTS.length; i++) {
      var p = PARTS[i], t = partTags[p.key];
      if (!t) continue;
      // ly is in body lengths, except the drill, which rides the actual nose.
      var ly = (p.key === 'drill') ? (nose * 1.02) : (p.ly * bl * 0.5);
      var lx = p.lx * hw;
      var px = cx + lx * s, py = cy + ly * s;
      if (w > mx * 2) px = Math.max(mx, Math.min(w - mx, px));
      if (h > my * 2) py = Math.max(my, Math.min(h - my, py));
      t.node.style.left = Math.round(px) + 'px';
      t.node.style.top = Math.round(py) + 'px';
    }
  }

  /* ---------------------------------------------------------------------
   * PREP
   * ------------------------------------------------------------------ */
  function buildPrep() {
    var s = makeScreen('prep', 'LAST CHECKS BEFORE THE DARK', 'PREPARE DESCENT');

    var top = el('div', 'sm-panel sm-av-prep-mine', s.body);
    el('div', 'sm-stripe', top);
    els.prepName = el('div', 'sm-av-card-name', top, '');
    els.prepMeta = el('div', 'sm-av-card-region', top, '');
    els.prepStrata = el('div', 'sm-av-strata', top);

    /* NO FUEL WIDGET. There used to be a slider here, with EMPTY / HALF / FILL
     * THE TANK under it and a line of arithmetic under that — four controls and
     * a readout for a decision nobody was ever really making. Descending on a
     * part tank is not a strategy, it is a way to lose a run, and the one number
     * that mattered (what the trip costs) is on the DESCEND button anyway.
     *
     * So the descent buys the tank out, adv.enterMine() does the buying, and the
     * screen went from three panels to two. What is left here is the two things
     * a player genuinely chooses between runs: WHERE THE LIFT DROPS THEM, and
     * whether to weld the hull up first. */
    buildPrepLift(s);

    /* THE HULL IS ONE ROW, AND ONLY WHEN IT IS BROKEN.
     * A full panel — heading, percentage, bar, button — for a gauge that reads
     * 100% on most visits is furniture. Damaged, it is a decision; intact, it is
     * not even a sentence. So it collapses to a single line that is simply
     * absent at full integrity, and the HUD carries the reading underground. */
    els.repairRow = el('div', 'sm-panel sm-av-repair', s.body);
    el('div', 'sm-stripe', els.repairRow);
    el('div', 'sm-av-repair-lbl', els.repairRow, 'HULL');
    els.hullPct = el('div', 'sm-av-repair-pct', els.repairRow, '100%');
    var hbar = el('div', 'sm-av-bar sm-av-repair-bar', els.repairRow);
    els.hullFill = el('div', 'sm-av-bar-fill', hbar);
    els.repairBtn = button(els.repairRow, 'sm-av-repair-btn', 'REPAIR');
    onTap(els.repairBtn, function () {
      var ok = !!(SM.adv && SM.adv.buyRepair && SM.adv.buyRepair());
      toast(ok ? 'HULL REPAIRED' : 'REPAIR REFUSED',
            ok ? 'Plates welded, seams checked' : 'The ledger will not cover it', 2.0);
      refresh();
    });

    els.descend = button(s.foot, 'sm-btn-primary sm-btn-big sm-av-descend', 'DESCEND');
    onTap(els.descend, onDescend);

    /* --- THIS SCREEN IS THE HOME NOW, UNTIL THE MAP IS EARNED -------------
     * js/adv.js's THE MAP IS EARNED: a new company lands here, leaves the mine
     * back to here, and does not see the world map until it owns the whole of
     * the starter mine. So for that stretch this footer has to be a HOME screen's
     * footer and not a sub-screen's, which means two changes and only two.
     *
     * THE WORKSHOP DOOR MOVES HERE WITH IT. It has always lived on whichever
     * screen was home (the map's footer carries it, and the lift menu carries it
     * mid-run); without this, a company that has not earned the map could only
     * reach the workshop by descending first, which turns "fit the drill you
     * just saved for" into a round trip through a mine. It is hidden again once
     * the map is open, because the map is home again and already has it — one
     * door, one place, never two.
     *
     * AND BACK BECOMES THE WAY OUT OF THE GAME. There is nothing behind this
     * screen to go back TO while the map is locked, and a BACK that goes nowhere
     * is the worst button on any screen. So it says TITLE SCREEN and does what
     * the map's own quiet plate does — the ledger is already saved, so it is a
     * safe exit to the slot picker and not a discarded company. See paintPrep()
     * for both swaps; the handler asks the question fresh on every tap, so it
     * cannot be left pointing at the wrong verb by a repaint that did not run. */
    els.prepShop = button(s.foot, '', 'WORKSHOP');
    onTap(els.prepShop, function () {
      if (SM.adv && SM.adv.openGarage) SM.adv.openGarage();
    });

    els.prepBack = button(s.foot, 'sm-av-quiet', 'BACK');
    onTap(els.prepBack, function () {
      if (!SM.adv) return;
      if (mapUnlocked()) {
        if (SM.adv.backToMap) SM.adv.backToMap();
        return;
      }
      if (SM.adv.close) SM.adv.close();
    });
  }

  function fuelPrice() {
    var p = (SM.mines && SM.mines.fuelPrice) ? num(SM.mines.fuelPrice(), FALLBACK_FUEL_PRICE) : FALLBACK_FUEL_PRICE;
    return p > 0 ? p : FALLBACK_FUEL_PRICE;
  }

  /**
   * How much fuel the descent is about to buy: the room left in the tank,
   * clamped by what the company can actually pay for.
   *
   * The clamp is what keeps DESCEND honest. adv.buyFuel() already buys what the
   * money reaches rather than refusing outright, so quoting the price of a FULL
   * tank to a player who cannot afford one would put a number on the button that
   * the ledger never charges.
   *
   * getTANK, not getFuel: what is bought and aboard, NOT the in-run gauge.
   * getFuel() still reads the level the last descent ended on, so sizing the
   * purchase against it would top up only what the previous run had burnt.
   */
  function fuelMax() {
    var cap = rigNum('getFuelCap', 100);
    var have = advNum('getTank', 0);
    var room = cap - have;
    if (room < 0) room = 0;
    var afford = Math.floor(advNum('getCash', 0) / fuelPrice());
    return Math.min(room, afford);
  }

  /** What the tank costs to fill. mines.fuelCost() owns the rounding. */
  function descendCost() {
    var u = fuelMax();
    if (u <= 0) return 0;
    return (SM.mines && SM.mines.fuelCost) ? num(SM.mines.fuelCost(u), u * fuelPrice())
                                           : u * fuelPrice();
  }

  /* ---------------------------------------------------------------------
   * THE LEVEL PICKER
   * ---------------------------------------------------------------------
   * EACH LEVEL IS ITS OWN MAP (ARCHITECTURE.md §7) and the lift is the only way
   * between them, so this is not a shortcut menu — it is the list of PLACES this
   * company can work. Buying one is the campaign's real progression: a new
   * stratum, and a bigger map to work it in.
   *
   * So a row quotes both halves of what it is: the BAND it covers ("270–690 m")
   * and how WIDE that map is ("440 m WIDE"), because deeper is bigger and the
   * size is part of the purchase.
   *
   * The panel does two jobs and keeps them visibly separate. The rows a company
   * OWNS are a choice — tap one and the descent lands at that level's doors.
   * The first row it does NOT own is a purchase, with its price and a BUY beside
   * it, and nothing past it is offered at all: the lift is extended downward, so
   * skipping a level is not a thing you can pay for.
   * ------------------------------------------------------------------ */
  function buildPrepLift(s) {
    els.prepLift = el('div', 'sm-panel sm-av-prep-lift', s.body);
    el('div', 'sm-stripe', els.prepLift);
    var head = el('div', 'sm-av-card-head', els.prepLift);
    el('div', 'sm-av-card-name', head, 'THE LIFT');
    els.liftCount = el('div', 'sm-av-card-region', head, '');
    els.liftList = el('div', 'sm-av-levels', els.prepLift);
    /* THE PANEL TEXT, WHICH IS WHERE EVERY REASON GOES.
     * Where the descent starts, and — when BUY is greyed — why. The button keeps
     * its name and dims; it never renames itself into a status message. */
    els.liftNote = el('div', 'sm-av-sub sm-av-lift-note', els.prepLift, '');
  }

  function paintPrepLift(m) {
    var id = (m && m.id) ? m.id : selMine;
    var levels = liftLevels(id);
    els.liftList.innerHTML = '';

    /* NO LIFT TABLE, NO PANEL. adv.js may not have levels for this mine yet (or
     * at all, while the lift is still being built), and an empty box that says
     * nothing is worse than no box. The descent still works: enterMine() with no
     * level starts at the mouth, exactly as it always did. */
    if (!levels) {
      els.prepLift.style.display = 'none';
      els.liftNote.textContent = '';
      return;
    }
    els.prepLift.style.display = '';

    var owned = ownedCount(levels);
    var deepest = deepestOwned(levels);      // 1-based, never 0
    var nextI = nextUnowned(levels);         // 1-based, or -1

    /* WHEN THE SELECTION GOES BACK TO THE DEEPEST STATION.
     *
     * A choice the player made by hand is worth keeping between visits — but only
     * while it still means the same thing. Two events invalidate it:
     *
     *   THE MINE CHANGED. Level 3 of Old Creek is not level 3 of The Rift, and
     *   carrying the index across would silently descend into the wrong hole.
     *
     *   A LEVEL WAS BOUGHT OR LOST. Somebody who has just paid for a station
     *   at 1 140 m wants to start there, not at whatever they picked last time;
     *   and a slot switch or a reload can take a level away again. Comparing the
     *   OWNED COUNT catches both, and it catches purchases made anywhere — the
     *   BUY on this screen, a future one on the map — without either caller
     *   having to remember to reset anything.
     */
    if (prepLevelMine !== id || prepLevelOwned !== owned) {
      prepLevelMine = id;
      prepLevelOwned = owned;
      prepLevel = deepest;
    }
    // Belt and braces: never leave the selection on ground that is not held.
    var selCheck = levelAt(levels, prepLevel);
    if (prepLevel < 1 || !selCheck || !selCheck.owned) prepLevel = deepest;

    els.liftCount.textContent = fmt(owned) + ' OF ' + fmt(levels.length) + ' LEVELS';

    var cash = advNum('getCash', 0);
    var blocked = '';
    /* THE PROGRESSION GATE (js/adv.js's note above buyLevel). Until the player
     * has worked the level they are on AND can afford the next one, the next one
     * DOES NOT EXIST on this screen — no row, no price, no greyed tease.
     *
     * AND NEITHER DO THE ONES BELOW IT, which is the only way to keep the ladder
     * honest: a list that hid L2 and still showed L3 as SEALED would have a hole
     * in it, and a hole is a louder tease than the row it replaced. So the
     * unowned tail is drawn only once the gate has opened on its head — and then
     * it is drawn in full, price and all, because at that point the shape of the
     * ladder is exactly what the player has earned the right to shop. */
    var gateOpen = !!(nextI > 0 && levelOffered(levels, nextI));
    for (var k = 0; k < levels.length; k++) {
      var L = levels[k];
      if (!L) continue;
      var i = num(L.i, k + 1);
      if (!L.owned && !gateOpen) continue;
      var state = L.owned ? 'owned' : (i === nextI ? 'next' : 'locked');
      var short = makeLevelRow(L, i, state, cash);
      if (short) blocked = short;
    }

    var selL = levelAt(levels, prepLevel) || levels[0];
    /* WHERE THE LIFT PUTS YOU DOWN, and what that place is. Both halves, because
     * a level is a map: the band it covers and how wide it is. */
    var line = 'DESCEND TO ' + levelLabel(selL) + '   ·   ' + bandText(selL);
    var w = widthText(selL);
    if (w) line += '   ·   ' + w;
    if (nextI < 0) line += '   ·   EVERY LEVEL IS OPEN';
    els.liftNote.textContent = blocked ? (line + '\n' + blocked) : line;
  }

  /**
   * One station. Returns the blocking reason when its BUY had to be greyed out,
   * so the caller can put it in the panel text rather than on the button.
   */
  function makeLevelRow(L, i, state, cash) {
    var row = el('div', 'sm-av-level sm-av-level-' + state, els.liftList);
    if (state === 'owned' && i === prepLevel) row.classList.add('sm-av-level-sel');

    var go = el('button', 'sm-av-level-go', row);
    go.setAttribute('type', 'button');
    el('span', 'sm-av-level-i', go, 'L' + i);
    el('span', 'sm-av-level-name', go, levelLabel(L));
    /* THE VALUE PROPOSITION IS THE MAP ITSELF: the band, then how wide it is.
     * A width in the same cell as the depth would fight it for space on a phone,
     * so the width rides in the depth cell only when there is a number for it —
     * one string, one write, no second column to negotiate. */
    var dep = bandText(L);
    var w = widthText(L);
    el('span', 'sm-av-level-depth', go, w ? (dep + '  ·  ' + w) : dep);
    var tag = el('span', 'sm-av-level-tag', go, '');

    if (state === 'owned') {
      tag.textContent = (i === prepLevel) ? 'START' : 'HELD';
      onTap(go, function () {
        prepLevel = i;
        paintPrep();
      });
      return '';
    }

    // Not owned: the row is a read, not a control. Only its BUY takes a tap.
    go.disabled = true;
    var price = num(L.price, 0);
    if (state === 'locked') {
      tag.textContent = 'SEALED';
      return '';
    }
    tag.textContent = money(price);

    /* BUY keeps its name and greys out; the shortfall goes in the panel text.
     * :disabled does the greying (see the stylesheet's UNAVAILABLE rule), so the
     * older sm-av-cant class is deliberately not used here — one mechanism. */
    var b = button(row, 'sm-av-level-buy', 'BUY');
    onTap(b, function () { onBuyLevel(i, L); });
    var short = price - cash;
    if (short > 0) {
      b.disabled = true;
      return 'NEED ' + money(short) + ' MORE FOR ' + levelLabel(L) + '.';
    }
    return '';
  }

  function onBuyLevel(i, L) {
    var ok = !!(SM.adv && SM.adv.buyLevel && SM.adv.buyLevel(i));
    if (ok) {
      /* THE FIELD MAY HAVE OPENED ON THIS TAP, and if it has, that is the bigger
       * news (js/adv.js's THE MAP IS EARNED). Its home is the gold box in the
       * lift — which is where this purchase is usually made — but it can be made
       * from THIS screen too, and a notice that only ever appears in a place the
       * player may not go next is a notice that can be missed entirely. So the
       * pending box is taken here as a toast: same fact, same moment, in this
       * screen's own chrome, and cleared at the source so the lift does not
       * repeat it. The BACK plate turns into the route the toast is talking
       * about on the refresh() below. */
      var mn = (SM.adv && SM.adv.getMapNotice) ? SM.adv.getMapNotice() : null;
      if (mn) {
        toast('THE FIELD IS OPEN',
              'Every level here is yours — the world map is open. BACK takes you out to it.',
              4.0);
        if (SM.adv.clearMapNotice) SM.adv.clearMapNotice();
      } else {
        toast('LEVEL OPENED', levelLabel(L) + '   ·   ' + bandText(L) +
                              (widthText(L) ? ('   ·   ' + widthText(L)) : ''), 2.6);
      }
      if (SM.effects && SM.effects.screenFlash) SM.effects.screenFlash(0.10, 255, 210, 120);
      // The new level is almost certainly where the player now wants to start.
      prepLevel = i;
    } else {
      toast('THE SALE WAS REFUSED', 'The ledger will not cover it', 2.0);
    }
    refresh();
  }

  function paintPrep() {
    var m = (SM.adv && SM.adv.getMine) ? SM.adv.getMine() : null;
    if (!m && SM.mines && SM.mines.get) m = SM.mines.get(selMine);
    var name = m ? String(m.name || m.id) : 'THE MINE';
    els.prepName.textContent = name.toUpperCase();
    els.prepMeta.textContent = m
      ? (String(m.region || '').toUpperCase() + '   ·   EST. ' + fmt(num(m.depth, 0)) + ' m   ·   REC. DRILL ' +
         fmt(num(m.recDrill, 0)) + '   ·   YOURS ' + fmt(rigNum('getDrillPower', 0)))
      : '';

    /* THE GEOLOGICAL REPORT. The layer table is the honest version of "what am
     * I driving into": one band per layer, deepest last, in the bulk material's
     * own colour, with the ore that band can pay out. */
    els.prepStrata.innerHTML = '';
    var layers = (m && m.layers && m.layers.length) ? m.layers : null;
    if (layers) {
      var from = 0;
      for (var i = 0; i < layers.length; i++) {
        var L = layers[i];
        if (!L) continue;
        var row = el('div', 'sm-av-stratum', els.prepStrata);
        var d = displayOf(L.fill);
        row.style.setProperty('--sm-av-chip', d.color);
        el('span', 'sm-av-stratum-sw', row);
        el('span', 'sm-av-stratum-name', row, String(L.name || d.name).toUpperCase());
        el('span', 'sm-av-stratum-depth', row, fmt(from) + '–' + fmt(num(L.toDepth, 0)) + ' m');
        var ores = [];
        if (L.weights) for (var k in L.weights) if (L.weights.hasOwnProperty(k)) ores.push(displayOf(k).name);
        el('span', 'sm-av-stratum-ore', row, ores.length ? ores.join(', ').toUpperCase() : '—');
        from = num(L.toDepth, from);
      }
    } else if (m) {
      var line = el('div', 'sm-av-sub', els.prepStrata, '');
      var bits = [];
      if (m.common && m.common.length) bits.push('COMMON ' + m.common.join(', ').toUpperCase());
      if (m.rare && m.rare.length) bits.push('RARE ' + m.rare.join(', ').toUpperCase());
      if (m.hazards && m.hazards.length) bits.push('HAZARDS ' + m.hazards.join(', ').toUpperCase());
      line.textContent = bits.join('   ·   ') || 'NO SURVEY ON FILE';
    }

    paintPrepLift(m);

    /* THE HULL ROW, WHICH IS ABSENT AT FULL INTEGRITY.
     * mines.repairCost() takes the 0..1 fraction adv.js reports and returns the
     * dollars for a FULL repair — the units are easy to get wrong by hand
     * (integrity is 0..100 points inside mines.js), so let it do it. */
    var integ = advNum('getIntegrity', 1);
    var needsRepair = integ < 0.999;
    els.repairRow.style.display = needsRepair ? '' : 'none';
    if (needsRepair) {
      els.hullPct.textContent = Math.round(integ * 100) + '%';
      els.hullFill.style.setProperty('--sm-av-fill', integ.toFixed(3));
      els.hullFill.className = 'sm-av-bar-fill' + (integ < 0.4 ? ' sm-av-bar-bad' : '');
      els.repairRow.classList[integ < 0.4 ? 'add' : 'remove']('sm-av-repair-bad');
      var full = (SM.mines && SM.mines.repairCost) ? num(SM.mines.repairCost(integ), 0)
        : Math.round((1 - integ) * 100 * ((SM.mines && SM.mines.repairPrice) ? num(SM.mines.repairPrice(), 0) : 0));
      els.repairBtn.textContent = full > 0 ? ('REPAIR  ' + money(full)) : 'REPAIR';
      // Label stays, the plate greys: the reason is the percentage next to it.
      if (full > advNum('getCash', 0)) els.repairBtn.setAttribute('disabled', 'disabled');
      else els.repairBtn.removeAttribute('disabled');
    }

    /* DESCEND CARRIES THE WHOLE BILL, because there is nothing else left to
     * price: the tank is bought out on the way down, so this is the entire cost
     * of the expedition and the player commits to it with one tap. */
    var cost = descendCost();
    els.descend.textContent = cost > 0 ? ('DESCEND  ·  ' + money(cost)) : 'DESCEND';

    /* THE FOOTER IS ONE OF TWO SHAPES — see buildPrep(). Home screen while the
     * map is locked (WORKSHOP + TITLE SCREEN), and the sub-screen it has always
     * been once the map is open (BACK, to the chart). */
    var toMap = mapUnlocked();
    if (els.prepShop) els.prepShop.style.display = toMap ? 'none' : '';
    if (els.prepBack) els.prepBack.textContent = toMap ? 'BACK' : 'TITLE SCREEN';
  }

  function onDescend() {
    var m = (SM.adv && SM.adv.getMine) ? SM.adv.getMine() : null;
    var id = (m && m.id) ? m.id : selMine;
    /* THE TANK IS FILLED BY THE DESCENT, not by this screen.
     * `fuel` is passed anyway and adv.enterMine() clamps it to the room left, so
     * whichever side of the seam does the topping up, the money moves exactly
     * once — and the descent is never launched on the empty tank a part-built
     * enterMine() would have given it.
     *
     * The order is snapshotted BEFORE the call because buying moves money, which
     * emits `adv:cash`, which repaints this very screen and re-clamps fuelMax()
     * against a tank that is now full. */
    var units = fuelMax();
    /* `level` IS ALWAYS SENT.
     * enterMine() defaults an absent level to the DEEPEST level the company
     * owns, which is the right default for BACK TO MINE — but on this screen the
     * player has just picked one, and a player who picked LEVEL 1 on purpose (to
     * work the shallow coal, or because the hold fills before the deep rock is
     * worth the drive) must not be dropped four bands down instead. Levels are
     * 1-based now, so there is no legitimate 0 to lose. */
    var opts = { fuel: units, level: (prepLevel >= 1 ? prepLevel : 1) };
    if (SM.adv && SM.adv.enterMine) SM.adv.enterMine(id, opts);
  }

  /* ---------------------------------------------------------------------
   * RESULTS
   * ------------------------------------------------------------------ */
  function buildResults() {
    var s = makeScreen('results', 'EXTRACTION', 'THE HAUL');
    var card = el('div', 'sm-panel sm-av-res', s.body);
    el('div', 'sm-stripe', card);
    els.resHeadline = el('div', 'sm-av-res-headline', card, '');
    var hero = el('div', 'sm-av-res-hero', card);
    /* THE HERO LABEL MOVES, BECAUSE THE HERO NUMBER IS NOT ALWAYS THE SAME THING.
     * This screen is a STRAND screen now (the good ending happens at the doors,
     * without leaving the mine), and on a strand the big number is either what
     * the rails SECURED — the whole payout of a bad run — or, when nothing was
     * secured, what was LEFT BEHIND. Labelling both "HOLD VALUE" would have been
     * the one lie the screen cannot afford. */
    els.resHeroLabel = el('div', 'sm-av-res-hero-label', hero, 'SECURED');
    els.resTotal = el('div', 'sm-av-res-total', hero, '$0');
    els.resLines = el('div', 'sm-av-res-lines', card);
    els.resNote = el('div', 'sm-av-warn', card, '');
    var grid = el('div', 'sm-av-card-grid', card);
    els.resDepth = statCell(grid, 'DEPTH REACHED', '0 m');
    els.resTime = statCell(grid, 'TIME UNDER', '0:00');
    els.resFuel = statCell(grid, 'FUEL LEFT', '0%');
    els.resDay = statCell(grid, 'DAY', '1');

    /* FOUR BUTTONS, ONE JOB EACH.
     * What a player does at the surface is: bank the load, top the tank up, and
     * go back down. Selling used to also walk you out to the world map, so the
     * common case cost a detour through a screen you did not want. Each of these
     * now does exactly the one thing it is named after, and SELL does not
     * navigate at all — you stay here and choose. */
    els.resBtn = button(s.foot, 'sm-btn-primary sm-btn-big', 'SELL THE HAUL');
    onTap(els.resBtn, onSell);
    /* REFUEL HAPPENS HERE, not on the prep screen.
     * Sending the player to prep to buy fuel and press DESCEND put a whole
     * screen in the middle of the one loop they repeat all game: come up, sell,
     * fill up, go back down. It buys a full tank in place and says what it cost. */
    els.resFuel2 = button(s.foot, '', 'REFUEL');
    onTap(els.resFuel2, onRefuelHere);

    /* ...and BACK TO MINE descends straight from here. */
    els.resDive = button(s.foot, '', 'BACK TO MINE');
    onTap(els.resDive, onBackToMine);
    els.resShop = button(s.foot, '', 'WORKSHOP');
    onTap(els.resShop, function () {
      if (SM.adv && SM.adv.openGarage) SM.adv.openGarage();
    });
    els.resMap = button(s.foot, '', 'MAP');
    onTap(els.resMap, function () {
      if (SM.adv && SM.adv.backToMap) SM.adv.backToMap();
    });
  }

  /**
   * Normalise whatever adv.js hands back into one shape:
   *   { stranded, gross, lines:[{name,color,units,value}], depthM, reason }
   * getResults() is the documented source; the live manifest is the fallback so
   * the screen is never empty just because the payload shape moved.
   */
  function readResults() {
    var r = (SM.adv && SM.adv.getResults) ? SM.adv.getResults() : null;
    var out = { stranded: false, gross: 0, lines: [], depthM: 0, reason: '',
                mineName: '', runTime: -1, fuelPct: -1, day: -1,
                /* THE STRAND-ERA ADDITIONS. `secured` is what the run keeps and
                 * SELL banks; `lost` is what is lying on the floor of a level
                 * map waiting to be fetched; `level`/`levelName` say WHICH map. */
                secured: 0, securedLines: [], lost: 0, level: 0, levelName: '' };
    var raw = null, i, ln;

    if (r) {
      out.secured = num(r.secured, 0);
      out.lost = num(r.lost, 0);
      out.level = num(r.level, 0);
      out.levelName = String(r.levelName || '');
      var sraw = r.securedLines;
      if (sraw && typeof sraw.length === 'number') {
        for (i = 0; i < sraw.length; i++) {
          ln = sraw[i];
          if (!ln) continue;
          var sd = displayOf(ln.matId, ln.matIndex);
          out.securedLines.push({ name: sd.name.toUpperCase(), color: sd.color,
                                  units: num(ln.units, 0), value: num(ln.value, 0) });
        }
        out.securedLines.sort(function (a, b) { return b.value - a.value; });
      }
      out.reason = String(r.reason || '');
      /* adv.js reports `kind` ('extracted' | 'stranded'); the reason strings and
       * a `lost` figure are the fallbacks, so an older or partial payload still
       * lands on the right treatment. */
      out.stranded = (r.kind === 'stranded') || !!(r.stranded) ||
                     out.reason === 'stranded' || out.reason === 'fuel' ||
                     out.reason === 'hull' || out.reason === 'abort' ||
                     (r.kind === undefined && !!r.lost);
      out.gross = num(r.gross, 0);
      out.depthM = num(r.depthM, num(r.maxDepthM, 0));
      out.mineName = String(r.mineName || '');
      out.runTime = num(r.runTime, -1);
      out.day = num(r.day, -1);
      // The run is already torn down by the time this screen opens, so the
      // record's own numbers are the truthful ones — the live getters have
      // been reset.
      if (typeof r.fuelLeft === 'number') {
        var cap = advNum('getFuelCap', 0);
        out.fuelPct = cap > 0 ? (r.fuelLeft / cap) : -1;
      }
      raw = r.lines || r.cargo || r.manifest;
      if (raw && typeof raw.length !== 'number') raw = null;
    }
    if (!raw) {
      var man = (SM.adv && SM.adv.getManifest) ? SM.adv.getManifest() : null;
      raw = (man && typeof man.length === 'number') ? man : [];
    }
    if (!out.depthM) out.depthM = advNum('getMaxDepthM', advNum('getDepthM', 0));

    for (i = 0; i < raw.length; i++) {
      ln = raw[i];
      if (!ln) continue;
      var d = displayOf(ln.matId, ln.matIndex);
      var v = num(ln.value, 0);
      if (!v && SM.mines && SM.mines.priceOf && ln.matId) v = num(SM.mines.priceOf(ln.matId), 0) * num(ln.units, 0);
      out.lines.push({ name: d.name.toUpperCase(), color: d.color, units: num(ln.units, 0), value: v });
    }
    // Richest first: the line that made the run should be the one at the top.
    out.lines.sort(function (a, b) { return b.value - a.value; });
    if (!out.gross) {
      for (i = 0; i < out.lines.length; i++) out.gross += out.lines[i].value;
    }
    return out;
  }

  /* ---------------------------------------------------------------------
   * THIS IS A STRAND SCREEN NOW
   * ---------------------------------------------------------------------
   * The good ending does not come through here any more. A run that goes well
   * ends AT THE DOORS: SELL banks the haul, REFUEL fills the tank, and the player
   * drives back into the rock or takes MAP — all without leaving the mine, and
   * without a screen in between (adv.sellAtDoor / refuelAtDoor / leaveToMap).
   *
   * So what is left for this screen is the run that ENDED BADLY: dry tank, dead
   * hull, or an abort. Its job is therefore not celebration, it is two facts and
   * one button:
   *
   *   WHAT YOU KEPT.  The secured ledger, if the run deposited anything. On a bad
   *                   run that is the ENTIRE payout, and SELL has to stay live
   *                   for it — that immunity is the only reason the verb exists.
   *   WHAT IS DOWN THERE, AND WHERE.  The hold is lying on the floor OF THAT
   *                   LEVEL as piles. With levels as separate maps a depth in
   *                   metres is not an address on its own, so the note names the
   *                   level: that is what makes "go back for it" a plan.
   *
   * The 'extracted' dress is kept intact underneath, because adv.escape() still
   * exists and still produces that shape (see its note in adv.js). Nothing in the
   * game calls it; if something ever does, this screen still reads correctly.
   * ------------------------------------------------------------------ */
  function paintResults() {
    var r = readResults();
    var sc = screens.results;
    var strand = r.stranded;

    /* ONCE IT IS SOLD, THERE IS NOTHING LEFT TO SELL — so show that.
     * The stored payload still lists everything that WAS aboard or secured, and
     * leaving the total sitting there after the money had moved read as the sale
     * not having happened. The figure is not lost: it moves to the note line as
     * the amount banked, which is the thing worth remembering anyway. */
    var sold = !!(SM.adv && SM.adv.isSold && SM.adv.isSold());

    /* WHAT THE BIG NUMBER IS. Secured ore on a strand (it is the payout), the
     * hold on a legacy extraction, and what was LEFT BEHIND when a strand
     * secured nothing — labelled as such, never as money. */
    var heroLabel, heroLines, heroTotal;
    if (strand && r.secured > 0) {
      heroLabel = 'SECURED';
      heroLines = r.securedLines;
      heroTotal = r.secured;
    } else if (strand) {
      heroLabel = 'LEFT BEHIND';
      heroLines = r.lines;
      heroTotal = r.lost > 0 ? r.lost : r.gross;
    } else {
      heroLabel = 'HOLD VALUE';
      heroLines = r.lines;
      heroTotal = r.gross;
    }
    if (sold) { heroLines = []; heroTotal = 0; }
    r.lines = heroLines;
    r.gross = heroTotal;

    sc.node.classList[strand ? 'add' : 'remove']('sm-av-res-strand');
    /* THE HERO IS MONEY YOU KEPT, NOT MONEY YOU LOST — say so in the dress.
     * The strand treatment paints the hero red and appends "— LOST" to its
     * label, which is right for the hold on the floor and exactly wrong for the
     * secured ledger sitting there waiting to be banked. One class, and the
     * stylesheet re-dresses it green. */
    sc.node.classList[(strand && heroLabel === 'SECURED') ? 'add' : 'remove']('sm-av-res-kept');
    sc.kicker.textContent = (strand ? 'THE MINE KEPT IT' : 'EXTRACTION COMPLETE') +
                            (r.mineName ? ('  ·  ' + r.mineName.toUpperCase()) : '');
    sc.title.textContent = strand ? 'STRANDED' : 'THE HAUL';
    els.resHeroLabel.textContent = heroLabel;
    els.resHeadline.textContent = strand
      ? reasonLine(r.reason, r.depthM, r)
      : (sold ? 'Sold. The hold is empty and the money is in the account.'
              : (r.lines.length ? 'Back at the surface with the hold intact.'
                                : 'Back at the surface. The hold is empty.'));

    /* THE NOTE LINE: where the load is, and what the sale did. Both can be true
     * at once — a run that secured ore, stranded, and has now banked it still
     * has a pile waiting on that level. */
    var note = '';
    if (strand) {
      note = 'The load is on ' + levelWord(r) + ' at ' + fmt(r.depthM) + ' m' +
             (r.lost > 0 ? (' — ' + money(r.lost) + ' of it') : '') +
             '. Descend to that level to pick it up.';
    }
    if (sold && lastSale > 0) {
      note = (note ? (note + '  ') : '') + 'BANKED ' + money(lastSale) + ' into the company account.';
    }
    els.resNote.textContent = note;
    els.resNote.style.display = note ? '' : 'none';

    els.resDepth.textContent = fmt(r.depthM) + ' m';
    els.resTime.textContent = clock(r.runTime >= 0 ? r.runTime : advNum('getRunTime', 0));
    els.resFuel.textContent = Math.round((r.fuelPct >= 0 ? r.fuelPct : advNum('getFuelPct', 0)) * 100) + '%';
    els.resDay.textContent = fmt(r.day >= 0 ? r.day : advNum('getDay', 1));

    /* SELL is live whenever there is anything to bank — which on a strand means
     * the SECURED ledger, and nothing else. paintResFooter() owns that test. */
    paintResFooter();

    buildResultLines(r);
    startCountUp(r);
  }

  /** 'LEVEL 3 (SILVER VEINS)' / 'that level' — the address of a dropped load. */
  function levelWord(r) {
    if (!(r.level >= 1)) return 'that level';
    return 'LEVEL ' + fmt(r.level) + (r.levelName ? (' · ' + r.levelName.toUpperCase()) : '');
  }

  function reasonLine(reason, depth, r) {
    var where = (r && r.level >= 1) ? (' on ' + levelWord(r)) : '';
    if (reason === 'fuel') return 'The tank ran dry at ' + fmt(depth) + ' m' + where + '.';
    if (reason === 'hull') return 'The hull gave out at ' + fmt(depth) + ' m' + where + '.';
    if (reason === 'abort') return 'You walked away from the dig at ' + fmt(depth) + ' m' + where + '.';
    return 'The machine stopped at ' + fmt(depth) + ' m' + where + '.';
  }

  function clock(t) {
    t = Math.max(0, Math.round(num(t, 0)));
    var m = (t / 60) | 0, s = t - m * 60;
    return m + ':' + (s < 10 ? '0' + s : '' + s);
  }

  function buildResultLines(r) {
    els.resLines.innerHTML = '';
    if (!r.lines.length) {
      el('div', 'sm-av-res-empty', els.resLines,
         r.stranded ? 'NOTHING WAS SECURED' : 'NOTHING IN THE HOLD');
      return;
    }
    for (var i = 0; i < r.lines.length; i++) {
      var L = r.lines[i];
      var row = el('div', 'sm-av-res-row', els.resLines);
      row.style.setProperty('--sm-av-chip', L.color);
      el('span', 'sm-av-res-sw', row);
      el('span', 'sm-av-res-name', row, L.name);
      el('span', 'sm-av-res-units', row, fmt(L.units) + 'u');
      L.node = el('span', 'sm-av-res-val', row, '$0');
      L.row = row;
    }
  }

  /**
   * THE COUNT-UP. This is the screen that has to make a full hold feel good, so
   * it gets the only animation loop in the module: each line lands in turn with
   * its value rolling up, and the total rolls with them. The simulation is held
   * while this screen is up, so a rAF loop here costs nothing that matters.
   */
  function startCountUp(r) {
    stopCountUp();
    var t0 = (typeof performance === 'object' && performance.now) ? performance.now() : +new Date();
    var span = COUNT_ROW_MS + COUNT_STAGGER * Math.max(0, r.lines.length - 1);

    function frame() {
      var now = (typeof performance === 'object' && performance.now) ? performance.now() : +new Date();
      var t = now - t0;
      var i, done = true;
      for (i = 0; i < r.lines.length; i++) {
        var L = r.lines[i];
        var lt = (t - i * COUNT_STAGGER) / COUNT_ROW_MS;
        if (lt < 0) { lt = 0; done = false; }
        else if (lt < 1) { done = false; }
        else lt = 1;
        var e = 1 - (1 - lt) * (1 - lt) * (1 - lt);      // ease-out cubic
        if (L.node) L.node.textContent = money(L.value * e);
        if (L.row && lt > 0) L.row.classList.add('sm-av-res-row-in');
      }
      var gt = Math.min(1, t / Math.max(1, span));
      var ge = 1 - (1 - gt) * (1 - gt) * (1 - gt);
      els.resTotal.textContent = money(r.gross * ge);
      if (done && gt >= 1) {
        countRaf = 0;
        els.resTotal.classList.remove('sm-av-res-total-pop');
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(function () { els.resTotal.classList.add('sm-av-res-total-pop'); });
        }
        return;
      }
      countRaf = requestAnimationFrame(frame);
    }
    if (typeof requestAnimationFrame === 'function') countRaf = requestAnimationFrame(frame);
    else els.resTotal.textContent = money(r.gross);
  }

  function stopCountUp() {
    if (countRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(countRaf);
    countRaf = 0;
    if (els.resTotal) els.resTotal.classList.remove('sm-av-res-total-pop');
  }

  function onSell() {
    var before = advNum('getCash', 0);
    var res = (SM.adv && SM.adv.sell) ? SM.adv.sell() : null;
    var gained = advNum('getCash', 0) - before;
    if (res && num(res.gross, 0) > 0) gained = num(res.gross, gained);
    // Remembered for the note line, because the hold itself is zeroed on repaint.
    if (gained > 0) lastSale = gained;
    if (gained > 0) toast('BANKED', money(gained) + ' into the company account', 2.6);
    // sell() deliberately does NOT navigate any more, so repaint in place: the
    // ledger in the header has moved and SELL has nothing left to sell.
    paintSold();
    refresh();
  }

  /** Units of fuel needed to top the tank right up, from what is aboard. */
  function refuelUnits() {
    var cap = rigNum('getFuelCap', 100);
    var have = advNum('getTank', 0);
    var room = cap - have;
    return room > 0.5 ? Math.floor(room) : 0;
  }

  /** Buy a full tank without leaving the extraction screen. */
  function onRefuelHere() {
    var want = refuelUnits();
    if (want <= 0) { toast('TANK FULL', 'Nothing to top up', 1.8); paintResFooter(); return; }
    var quoted = (SM.mines && SM.mines.fuelCost) ? num(SM.mines.fuelCost(want), 0) : 0;
    var before = advNum('getCash', 0);
    var ok = !!(SM.adv && SM.adv.buyFuel && SM.adv.buyFuel(want));
    var spent = before - advNum('getCash', 0);
    if (!ok || spent <= 0) {
      toast('CANNOT REFUEL', 'Not enough in the account for ' + money(quoted), 2.4);
    } else {
      // Partial fills are legitimate: adv.buyFuel() buys what the cash reaches.
      toast('REFUELLED', money(spent) + ' of diesel', 2.2);
    }
    paintResFooter();
    refresh();
  }

  /**
   * Straight back down the same shaft, with no screen in between.
   *
   * The tank is checked FIRST and the descent refused if it is dry, because
   * enterMine() will happily launch on nothing and the run would be over before
   * the player's thumb left the glass — the failure needs to happen up here,
   * next to the REFUEL button that fixes it.
   */
  function onBackToMine() {
    var id = lastMineId();
    if (!id) { if (SM.adv && SM.adv.backToMap) SM.adv.backToMap(); return; }

    var aboard = advNum('getTank', 0);
    if (aboard < 1) {
      toast('TANK IS EMPTY', 'Refuel before you go back down', 2.6);
      return;
    }
    /* BACK TO THE LEVEL THE LOAD IS ON, not to the deepest one owned.
     * A strand drops the hold as piles on ONE level map, and the reason a player
     * taps this button after a strand is to go and get it. Defaulting to the
     * deepest level would drop them in the wrong map with a full tank. */
    var opts = {};
    var res = (SM.adv && SM.adv.getResults) ? SM.adv.getResults() : null;
    if (res && res.kind === 'stranded' && num(res.level, 0) >= 1) opts.level = num(res.level, 1);
    if (SM.adv && SM.adv.enterMine && SM.adv.enterMine(id, opts)) return;
    toast('CANNOT DESCEND', 'Check the mining rights for this site', 2.4);
    if (SM.adv && SM.adv.backToMap) SM.adv.backToMap();
  }

  /**
   * The footer follows the loop: SELL leads, then REFUEL, then BACK TO MINE.
   * Whichever step you have not done yet is the one wearing the bright plate, so
   * the screen always has exactly one obvious next tap.
   */
  function paintResFooter() {
    var sold = !!(SM.adv && SM.adv.isSold && SM.adv.isSold());
    var r = (SM.adv && SM.adv.getResults) ? SM.adv.getResults() : null;
    var strand = !!(r && r.kind === 'stranded');
    /* WHAT IS LEFT TO SELL. A strand's hold is on the floor of a level map, so
     * `gross` is 0 — but the SECURED ledger survived, and on a bad run it is the
     * entire payout. That is the case the verb exists for, so SELL is enabled by
     * "is there value" and NOT by "did the run go well". */
    var toSell = num(r && r.secured, 0) + (strand ? 0 : num(r && r.gross, 0));
    var need = refuelUnits();
    var cost = (need > 0 && SM.mines && SM.mines.fuelCost) ? num(SM.mines.fuelCost(need), 0) : 0;

    function primary(node, on) {
      if (!node) return;
      if (on) node.classList.add('sm-btn-primary'); else node.classList.remove('sm-btn-primary');
    }

    /* A BUTTON KEEPS ITS NAME. An action that is unavailable greys out; it does
     * not rename itself to a status message. "BANKED" and "TANK FULL" made the
     * footer's labels move around under the player's thumb, and a control that
     * says something different every time you look at it is harder to learn than
     * one that is simply dim. The greying is done in style-adventure.css against
     * :disabled, so the state lives in one place. */
    if (els.resBtn) {
      els.resBtn.textContent = 'SELL THE HAUL';
      if (sold || !(toSell > 0)) els.resBtn.setAttribute('disabled', 'disabled');
      else els.resBtn.removeAttribute('disabled');
    }
    if (els.resFuel2) {
      els.resFuel2.textContent = need > 0 ? ('REFUEL  ·  ' + money(cost)) : 'REFUEL';
      if (need > 0) els.resFuel2.removeAttribute('disabled');
      else els.resFuel2.setAttribute('disabled', 'disabled');
    }
    /* THE WAY OFF THIS SCREEN THAT IS NOT A DESCENT, and it is not always the
     * map (js/adv.js's THE MAP IS EARNED). It is KEPT rather than hidden while
     * the map is locked, because it is the only plate here that always works: a
     * player who stranded broke, with a dry tank and nothing secured, has SELL,
     * REFUEL and BACK TO MINE all greyed, and this is what walks them back to
     * PREPARE DESCENT instead of leaving them on a dead screen. */
    if (els.resMap) els.resMap.textContent = mapUnlocked() ? 'MAP' : 'PREPARE DESCENT';

    /* WHICHEVER STEP IS NEXT WEARS THE BRIGHT PLATE. Bank what survived, fill
     * the tank, go back down for the pile — in that order, so the screen always
     * has exactly one obvious next tap. */
    var canSell = !sold && toSell > 0;
    primary(els.resBtn, canSell);
    primary(els.resFuel2, !canSell && need > 0);
    primary(els.resDive, !canSell && need <= 0);
  }

  /** Kept as the old name so existing call sites stay valid. */
  function paintSold() { paintResFooter(); }

  /* =====================================================================
   * SCREEN SWITCHING — driven by adv:state
   * ================================================================== */
  function onState(p) {
    var st = (p && p.state) || (SM.adv && SM.adv.getState ? SM.adv.getState() : 'off');
    sync(st);
  }

  function sync(st) {
    if (st === current) return;

    if (!screens[st]) {                     // 'off', 'mine', anything unknown
      current = '';
      closeAll();
      return;
    }
    current = st;
    stopCountUp();
    els.wrap.classList.add('sm-av-on');
    for (var k in screens) {
      if (!screens.hasOwnProperty(k)) continue;
      screens[k].node.classList[k === st ? 'add' : 'remove']('sm-av-screen-on');
    }
    // The ledger strip is meaningless before a company exists.
    els.wrap.classList[st === 'slots' ? 'add' : 'remove']('sm-av-noledger');
    if (SM.joystick && SM.joystick.hide) SM.joystick.hide();
    refresh();
  }

  /** Hide everything this module owns. Called when a descent begins. */
  function closeAll() {
    if (!built) return;
    current = '';
    stopCountUp();
    nameEditing = -1;
    els.wrap.classList.remove('sm-av-on');
    for (var k in screens) {
      if (screens.hasOwnProperty(k)) screens[k].node.classList.remove('sm-av-screen-on');
    }
  }

  /** Re-read the ledger and repaint whatever screen is currently up. */
  function refresh() {
    if (!built || !current) return;
    paintLedger();
    if (current === 'slots') paintSlots();
    else if (current === 'map') paintMap();
    else if (current === 'garage') paintGarage();
    else if (current === 'prep') paintPrep();
    else if (current === 'results') paintResults();
  }

  function paintLedger() {
    var rec = (SM.save && SM.save.get) ? SM.save.get() : null;
    els.ledCompany.textContent = (rec && rec.company) ? String(rec.company).toUpperCase() : 'NO COMPANY';
    els.ledDay.textContent = 'DAY ' + fmt(advNum('getDay', 1));
    els.ledCash.textContent = money(advNum('getCash', 0));
    els.ledTier.textContent = 'MK ' + roman(rigNum('getMachineTier', 1));
  }

  /* =====================================================================
   * TOAST + LIFECYCLE
   * ================================================================== */
  function toast(title, sub, seconds) {
    if (!els.toast) return;
    els.toastTitle.textContent = title || '';
    els.toastSub.textContent = sub || '';
    els.toast.classList.remove('sm-av-toast-on');
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { els.toast.classList.add('sm-av-toast-on'); });
    } else els.toast.classList.add('sm-av-toast-on');
    toastTimer = (seconds || TOAST_TIME) * 1000;
    if (els.toast.smTimer) clearTimeout(els.toast.smTimer);
    els.toast.smTimer = setTimeout(function () {
      els.toast.smTimer = 0;
      els.toast.classList.remove('sm-av-toast-on');
    }, toastTimer);
  }

  function init() {
    if (!built) build();
    if (!subscribed) {
      subscribed = true;
      SM.events.on('adv:state', onState);
      // Anything that moves the ledger repaints the screen that is showing it.
      SM.events.on('adv:cash', refresh);
      SM.events.on('adv:rig', refresh);
      SM.events.on('adv:rights', refresh);
      SM.events.on('adv:day', refresh);
      /* A LEVEL BOUGHT ANYWHERE REPAINTS EVERY SCREEN THAT COUNTS THEM.
       * The purchase can come from this screen's own BUY or from the in-mine lift
       * panel, and the map card and the prep picker both show a count — so the
       * event is what keeps them in step rather than either caller remembering to
       * ask for a repaint. */
      SM.events.on('lift:bought', refresh);
      window.addEventListener('resize', onResize, false);
      window.addEventListener('orientationchange', onResize, false);

      /* THE WATCHDOG. See "HOW IT IS DRIVEN" at the top of the file: this is
       * not a second state machine, it is a copy of adv.js's own answer, and
       * it exists so a missed transition cannot leave the player staring at a
       * blank screen with no way back to the menu. */
      if (!syncTimer) {
        syncTimer = setInterval(function () {
          if (!(SM.adv && SM.adv.isActive && SM.adv.isActive())) {
            if (current) sync('off');
            return;
          }
          var st = SM.adv.getState ? SM.adv.getState() : '';
          if (st && st !== current) sync(st);
        }, SYNC_MS);
      }
    }
  }

  function onResize() {
    if (current === 'garage') drawRig();
    else if (current === 'map') drawMapArt();
  }

  /** Any adventure screen is up. */
  function isOpen() { return !!current; }
  function getScreen() { return current; }

  return {
    init: init,
    isOpen: isOpen,
    closeAll: closeAll,
    refresh: refresh,
    toast: toast,
    /* --- additions ---------------------------------------------------- */
    getScreen: getScreen,
    /** Repaint the workshop canvas (adv.js may call it after a morph). */
    redrawRig: drawRig
  };
})();
