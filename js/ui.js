/* =============================================================================
 * SUPERMINE ADVENTURE — js/ui.js
 * -----------------------------------------------------------------------------
 * The SHELL around the campaign: the title gate, the responsive-layout switch
 * every other UI module rides on, the fps readout, and the service worker.
 *
 * This file used to be the whole time-attack HUD — score strip, countdown,
 * upgrade rail, haul tally, pause card, run summary, local top-ten. None of
 * that survives the split: adventure has no clock and no score, `js/advhud.js`
 * owns the in-mine instruments and `js/advui.js` owns every meta screen. What
 * is left here is the three things that are nobody else's job.
 *
 * 1. THE TITLE GATE.  The browser will not start WebAudio, and main.js will
 *    not step the simulation, until the player has touched the page once. So
 *    there is a full-screen overlay at boot whose only job is to collect that
 *    one gesture and then hand the screen to SM.adv.open(). It is deliberately
 *    plain — see buildTitle(), which is where the real splash goes.
 *
 * 2. THE LAYOUT SWITCH.  applyCompact() publishes `sm-compact` / `sm-tiny` /
 *    `sm-portrait` on #ui-root, and style-adventure.css hangs the entire phone
 *    layout off those three classes. Nothing else sets them. It is the least
 *    glamorous function in the file and the one that must not be deleted.
 *
 * 3. THE PWA.  sw.js precaches the whole build under one versioned cache; a
 *    new worker parks in WAITING and only takes over when the player taps
 *    UPDATE READY on the title screen. See the PWA section at the bottom.
 *
 * #ui-root IS WIPED HERE, in build(), and main.js calls SM.ui.init() BEFORE
 * advterrain/scanner/joystick/advhud/advui/adv. Every one of those appends to
 * #ui-root, so that ordering is a contract: anything that wipes the root after
 * they have built would erase the campaign's whole interface.
 *
 * `sm-adv` IS PERMANENT. In the two-mode build it was toggled on the way into
 * the campaign; here there is nothing else to be, so build() sets it once and
 * never removes it. style-adventure.css scopes every adventure layer to it
 * (`#ui-root:not(.sm-adv) .sm-av { display:none }`), so dropping it hides the
 * entire interface — which is exactly the bug it is documented here to prevent.
 *
 * DOM WRITE DISCIPLINE — still not optional. update() runs inside the FIXED
 * STEP and can be called several times per rendered frame. Every write goes
 * through setText(), which skips the write when the value has not changed.
 *
 * Public API
 *   SM.ui.init() / reset() / update(dt)
 *   SM.ui.showTitle() / leaveAdventure()   -- adv.close() calls the latter
 * ========================================================================== */

var SM = SM || {};

SM.ui = (function () {
  'use strict';

  /* =====================================================================
   * Tunables
   * ================================================================== */
  var COMPACT_W       = 900;    // px viewport width that switches to compact
  var COMPACT_H       = 520;
  var TINY_W          = 420;

  /* The build stamp shown on the title screen. It lives HERE rather than in
   * config.js because config.js is frozen, and ui.js is the only module that
   * ever displays it. Replaced at runtime by whatever the SERVICE WORKER
   * reports — this is only the fallback for a file:// or first-visit load. */
  var GAME_VERSION    = 'v2.1.0';

  var C = SM.config;

  var root = null;
  var els = {};
  var built = false;
  var subscribed = false;

  /* True while the title overlay owns the screen. It is ui.js's own latch, not
   * a mirror of SM.adv's state: the service worker's reload gate reads it, and
   * "is the title up" has to be answerable in the window between the tap and
   * SM.adv.open() actually landing. */
  var titleUp = true;

  // style.css hides the debug readout on anything small; update() reads this so
  // it does not spend a DOM write per step on a node nobody can see. Measured:
  // 60 mutations a second, on a phone, for nothing.
  var hudSmall = false;

  var lastStrings = {};

  /* =====================================================================
   * DOM helpers
   * ================================================================== */
  function el(tag, cls, parent, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }

  function setText(key, node, str) {
    if (!node || lastStrings[key] === str) return;
    lastStrings[key] = str;
    node.textContent = str;
  }

  /* =====================================================================
   * BUILD
   * ================================================================== */
  function build() {
    root = document.getElementById('ui-root');
    if (!root) return;
    root.innerHTML = '';
    built = true;

    /* PERMANENT. There is only one mode now — see the header note. */
    root.classList.add('sm-adv');

    buildTitle();

    els.debug = el('div', 'sm-debug', root, '');
    if (!C.DEBUG_STATS) els.debug.style.display = 'none';

    applyCompact();
  }

  /* ---------------------------------------------------------------------
   * THE TITLE GATE — the front door of the game
   * ---------------------------------------------------------------------
   * A dark shaft, a headlight sweeping across it, ore catching the light, and
   * the wordmark sitting in the middle of it. Everything is DOM and CSS: no
   * images, no canvas, no JS animation loop — the sweep, the twinkles and the
   * button's glow are CSS keyframes on transform/opacity/box-shadow, so this
   * screen costs the compositor a few percent and the main thread nothing.
   * The styling lives in the START OVERLAY section of style.css.
   *
   * THREE THINGS HERE ARE LOAD-BEARING and the previous version of this
   * function was commented to say so. They all survive, in the same shapes:
   *
   *   1. `els.start` is still the overlay node, still classed `sm-start`, and
   *      showTitle()/hideTitle() still fade it with `sm-start-off`. Everything
   *      decorative is a CHILD of it, so one class still dismisses the lot —
   *      and style.css pauses every animation under `.sm-start-off`, because a
   *      dismissed overlay is opacity-0, not gone, and a twinkling ore field
   *      nobody can see is pure battery drain 600 m underground.
   *   2. beginAdventure() is bound to the overlay itself AND to the START
   *      button AND to Enter/Space (see onTitleKey). All three are real user
   *      gestures, which is what unlocks WebAudio and releases main.js's
   *      simulation gate; the function is idempotent, so the pairs of events a
   *      single keystroke or tap can produce cost nothing.
   *   3. `els.update` and `els.version` are still on this overlay and still
   *      written to by the service-worker code at the bottom of this file.
   *
   * The overlay is REACHABLE AGAIN: leaving the campaign brings it back, so
   * this is a title screen and not a one-shot boot splash. Nothing in here may
   * assume it is built once and discarded.
   * ------------------------------------------------------------------ */
  function buildTitle() {
    els.start = el('div', 'sm-start', root);

    /* --- the stage: everything behind the panel ------------------------
     * Purely decorative and pointer-events:none, so a tap anywhere on it
     * still lands on the overlay's own click handler and starts the game. */
    var stage = el('div', 'sm-start-stage', els.start);
    el('div', 'sm-start-sweep', stage);
    var field = el('div', 'sm-start-field', stage);
    for (var i = 0; i < 7; i++) el('i', 'sm-ore sm-ore-' + i, field);

    var sc = el('div', 'sm-start-inner', els.start);

    var brand = el('div', 'sm-start-brand', sc);
    buildMark(brand);

    var head = el('div', 'sm-start-head', brand);
    el('div', 'sm-start-logo', head, 'SUPERMINE');
    el('div', 'sm-start-sub', head, 'ADVENTURE');

    el('div', 'sm-start-pick', sc, 'RUN A MINING COMPANY');

    els.startBtn = el('button', 'sm-btn sm-btn-big sm-start-go', sc, 'START');
    els.startBtn.setAttribute('type', 'button');

    /* NON-BREAKING SPACE BEFORE EACH SEPARATOR. This line wraps to two rows on
     * a phone, and with ordinary spaces the wrap point landed in front of a
     * "·", orphaning the bullet onto the head of the second line. Tying each
     * separator to the word it follows means a break can only happen AFTER it,
     * which is the only place it looks deliberate. */
    el('div', 'sm-start-tag', sc,
      'DIG DEEP · FILL THE HOLD · GET BACK TO THE LIFT');

    /* Runs of spaces COLLAPSE in HTML, so the columns the old copy tried to set
     * up with whitespace all closed up into one ragged line. Explicit
     * separators, and caps, like every other label in the game. */
    var keys = el('div', 'sm-start-keys', sc);
    el('div', 'sm-keys-desk', keys,
      'W A S D / ARROWS — DRIVE   ·   M — MUTE   ·   ENTER — START');
    el('div', 'sm-keys-touch', keys,
      'DRAG ANYWHERE TO DRIVE');

    /* --- opt-in update, shown only when a new build is parked and waiting --- */
    els.update = el('button', 'sm-update', sc, 'UPDATE READY — TAP TO INSTALL');
    els.update.setAttribute('type', 'button');
    els.update.style.display = 'none';
    els.update.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();          // the overlay itself starts the game
      applyUpdate();
    });

    els.version = el('div', 'sm-start-version', els.start, GAME_VERSION);

    /* CLICK, not pointerdown. A pointerdown+click pair on the same element
     * fires twice, and the second one arrived after the overlay had already
     * been taken down — which is how the campaign used to get opened twice. */
    els.start.addEventListener('click', beginAdventure);
    els.startBtn.addEventListener('click', beginAdventure);
  }

  /**
   * THE MARK — the app icon, rebuilt out of eight divs.
   *
   * icons/*.png is the same drawing: a small tracked rig at the top of a black
   * shaft with its headlight falling away into rock, gold and cyan deposits
   * catching the edge of the beam. Redrawing it here rather than <img>-ing the
   * PNG is not stubbornness — the icon is 512px of raster tuned for a launcher
   * tile, this has to scale from 74px to 120px and animate, and the house rule
   * is that everything visual is procedural. tools/make-icons.py is the other
   * half of this identity; the two are meant to be edited together.
   *
   * Every dimension inside the mark is a PERCENTAGE of it, so the whole thing
   * is driven by one custom property (`--sm-mark`) and the breakpoints resize
   * it with a single declaration.
   */
  function buildMark(parent) {
    var mark = el('div', 'sm-mark', parent);
    mark.setAttribute('aria-hidden', 'true');

    el('div', 'sm-mark-rock', mark);      // strata, below the light line
    el('div', 'sm-mark-beam', mark);      // the headlight cone
    el('i', 'sm-mark-gem sm-mark-gem-a', mark);
    el('i', 'sm-mark-gem sm-mark-gem-b', mark);
    el('i', 'sm-mark-gem sm-mark-gem-c', mark);

    var rig = el('div', 'sm-mark-rig', mark);   // tracks are its ::before/::after
    el('div', 'sm-mark-eye', rig);
    el('div', 'sm-mark-band', rig);
    el('div', 'sm-mark-lamp', rig);

    return mark;
  }

  /**
   * ENTER / SPACE starts the game.
   *
   * The overlay's own click handler is the canonical path; this exists so a
   * desktop player never has to find the button with a mouse, and so the title
   * answers a keyboard the same way every other menu in the game does.
   *
   * Two details that are not decoration:
   *   * The UPDATE button is excluded. It is a real focusable button on this
   *     overlay, and without this test tabbing to it and pressing Enter would
   *     start the campaign instead of installing the build that is waiting.
   *   * No double-fire guard is needed beyond beginAdventure()'s own
   *     `if (!titleUp) return;` — a focused button turns the same keystroke
   *     into a synthetic click, and the second call simply returns.
   */
  function onTitleKey(e) {
    if (!titleUp || !e) return;
    if (els.update && e.target === els.update) return;
    var k = e.key;
    if (k !== 'Enter' && k !== ' ' && k !== 'Spacebar') return;
    beginAdventure(e);
  }

  /* =====================================================================
   * TITLE <-> CAMPAIGN
   * ================================================================== */
  /**
   * The one gesture that starts everything.
   *
   * ORDER MATTERS. `titleUp` is cleared BEFORE noteGesture(), because
   * noteGesture() fires `input:firstgesture` synchronously and the service
   * worker's reload gate reads the latch — a reload landing in that window
   * would throw away the tap. Then the overlay goes, then SM.adv.open().
   */
  function beginAdventure(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!titleUp) return;
    if (!SM.adv || !SM.adv.open) return;

    titleUp = false;
    if (SM.sound && SM.sound.play) SM.sound.play('ui');
    // The canonical gesture path: unlocks audio and releases main.js's
    // simulation gate for everyone, not just this module.
    if (SM.input && SM.input.noteGesture) SM.input.noteGesture();

    hideTitle();
    SM.adv.open();
  }

  function showTitle() {
    titleUp = true;
    if (els.start) els.start.classList.remove('sm-start-off');
  }

  function hideTitle() {
    if (els.start) els.start.classList.add('sm-start-off');
  }

  /**
   * Called by SM.adv.close() when the player leaves the campaign.
   *
   * In the two-mode build this restored the classic main menu. There is no
   * such thing here, so leaving the campaign returns to the TITLE GATE — the
   * one screen that is always a legal place to be, and the one the branding
   * pass owns. adv.close() calls SM.main.restart() straight afterwards, which
   * empties the pool, so what sits behind the title is a clean black world
   * rather than the mine the player just walked out of.
   */
  function leaveAdventure() {
    showTitle();
  }

  /* =====================================================================
   * RESPONSIVE SWITCH
   * ================================================================== */
  /** One class toggle drives every responsive rule in both stylesheets. */
  function applyCompact() {
    if (!root) return;
    var w = window.innerWidth || 1024;
    var h = window.innerHeight || 768;
    var compact = (w < COMPACT_W || h < COMPACT_H);
    hudSmall = compact || (h > w);
    if (compact) root.classList.add('sm-compact');
    else root.classList.remove('sm-compact');
    if (w < TINY_W) root.classList.add('sm-tiny');
    else root.classList.remove('sm-tiny');

    /* PORTRAIT IS ITS OWN SWITCH, not a synonym for compact. A phone in
     * landscape is compact and has almost no vertical room; a tablet held
     * upright is not compact at all but still wants the stick and the gauges
     * on the edges. The two questions are genuinely different, so they get
     * two classes. */
    if (h > w) root.classList.add('sm-portrait');
    else root.classList.remove('sm-portrait');
  }

  var resizePending = false;
  function onResize() {
    if (resizePending) return;
    resizePending = true;
    // Coalesce bursts of resize events into one layout pass.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { resizePending = false; applyCompact(); });
    } else {
      resizePending = false;
      applyCompact();
    }
  }

  /* =====================================================================
   * LIFECYCLE
   * ================================================================== */
  function init() {
    build();
    if (!subscribed) {
      subscribed = true;
      window.addEventListener('resize', onResize, false);
      window.addEventListener('orientationchange', onResize, false);
      /* Registered ONCE here rather than in buildTitle(), which build() could
       * in principle run again — a second listener would be harmless (the call
       * is idempotent) but this is the file's existing discipline. */
      window.addEventListener('keydown', onTitleKey, false);
    }
    initPWA();
  }

  function reset() { /* nothing of this module's survives a run */ }

  /**
   * Called from inside the FIXED STEP by main.js, so possibly several times
   * per rendered frame. The only thing left in here is the fps readout, and
   * it is behind a change-guard and a "can anyone see it" check.
   */
  function update(dt) {
    if (!built) return;
    if (C.DEBUG_STATS && !hudSmall) {
      var s = SM.particles.getStats();
      setText('dbg', els.debug,
        SM.main.getFps() + ' fps  ' + SM.main.getStepMs().toFixed(2) + ' ms  |  ' +
        s.active + ' p (' + s.solid + 's ' + s.loose + 'l)  |  fx ' + SM.effects.getCount() +
        '  |  z ' + SM.camera.getZoom().toFixed(2));
    }
  }

  /* =====================================================================
   * PWA — install, offline play, and OPT-IN updates
   * ---------------------------------------------------------------------
   * sw.js precaches the whole build under one versioned cache. Registering
   * with { updateViaCache: 'none' } plus reg.update() on load means a bumped
   * sw.js VERSION is noticed at launch and precached in the background — but
   * the new worker then WAITS. It only takes over when the player taps UPDATE
   * READY on the title screen, and the reload that follows happens ONLY from
   * the title screen.
   *
   * That restraint matters more here than it did in the time attack. A
   * campaign is hours of play across three save slots; a worker that swapped
   * itself in mid-descent would drop a loaded hold, and reloading the page to
   * install a patch is a genuinely hostile thing to do to someone 600 m down
   * with a full tank of fuel they paid for.
   *
   * Everything here is best-effort. The game must keep working when there is
   * no service worker at all — which is exactly the case when index.html is
   * opened straight off the disk over file://, where registration throws.
   * ================================================================== */
  var swReg = null;

  /** Ask a worker which build it is. Resolves null if it does not answer. */
  function swVersion(worker) {
    return new Promise(function (resolve) {
      if (!worker || typeof MessageChannel !== 'function') { resolve(null); return; }
      var ch = new MessageChannel();
      var bail = setTimeout(function () { resolve(null); }, 1500);
      ch.port1.onmessage = function (ev) {
        clearTimeout(bail);
        resolve((ev.data && ev.data.version) || null);
      };
      try { worker.postMessage({ type: 'GET_VERSION' }, [ch.port2]); }
      catch (e) { clearTimeout(bail); resolve(null); }
    });
  }

  function setVersionTag(v) {
    if (v && els.version) setText('ver', els.version, v);
  }

  function offerUpdate(version) {
    if (!els.update) return;
    els.update.textContent = (version ? version + ' READY' : 'UPDATE READY') +
                             ' — TAP TO INSTALL';
    els.update.style.display = '';
    els.update.classList.add('sm-update-on');
  }

  function applyUpdate() {
    if (!swReg || !swReg.waiting) return;
    if (SM.sound && SM.sound.play) SM.sound.play('ui');
    els.update.textContent = 'INSTALLING…';
    els.update.disabled = true;
    swReg.waiting.postMessage({ type: 'SKIP_WAITING' });
  }

  /**
   * A FIRST install activates immediately and must never prompt — there is
   * nothing to upgrade from. Only offer when something already controls the
   * page, which is exactly the "this is an update" case.
   */
  function offerIfWaiting() {
    if (!swReg || !swReg.waiting || !navigator.serviceWorker.controller) return;
    swVersion(swReg.waiting).then(offerUpdate);
  }

  function initPWA() {
    if (!('serviceWorker' in navigator)) return;
    // Opened straight off the disk. Service workers need a secure context, so
    // registration would reject AND the sw.js version fetch would be blocked by
    // CORS — two red console errors for something that was never going to work.
    // Bail early and let the title show the compiled-in GAME_VERSION instead.
    if (location.protocol === 'file:') return;

    var hadController = !!navigator.serviceWorker.controller;

    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then(function (reg) {
        swReg = reg;
        reg.update()['catch'](function () {});
        offerIfWaiting();              // one may be parked from a past launch
        reg.addEventListener('updatefound', function () {
          var w = reg.installing;
          if (!w) return;
          w.addEventListener('statechange', function () {
            if (w.state === 'installed') offerIfWaiting();
          });
        });
      })['catch'](function () { /* file:// or unsupported — the game is fine */ });

    // Show the build that is really serving us. On a first visit nothing
    // controls the page yet, so read the version straight out of sw.js.
    swVersion(navigator.serviceWorker.controller).then(function (v) {
      if (v) { setVersionTag(v); return; }
      fetch('sw.js').then(function (r) { return r.text(); }).then(function (t) {
        var m = t.match(/VERSION = '([^']+)'/);
        if (m) setVersionTag(m[1]);
      })['catch'](function () {});
    });

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      // `titleUp` is true only while the title gate owns the screen. Never
      // reload into a live company, and never mid-descent.
      if (hadController && titleUp) location.reload();
    });
  }

  return {
    init: init,
    reset: reset,
    update: update,

    /* --- the title gate (js/adv.js calls leaveAdventure) --------------- */
    showTitle: showTitle,
    leaveAdventure: leaveAdventure,
    isTitleUp: function () { return titleUp; },
    getRoot: function () { return root; }
  };
})();
