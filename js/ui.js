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
 * is left here is the things that are nobody else's job.
 *
 * 1. THE TITLE GATE.  The browser will not start WebAudio, and main.js will
 *    not step the simulation, until the player has touched the page once. So
 *    there is a full-screen overlay at boot whose only job is to collect that
 *    one gesture and then hand the screen to SM.adv.open(). It is deliberately
 *    plain — see buildTitle(), which is where the real splash goes.
 *
 * 1b. THE CORNER AND THE MENU PANEL are built here and belong to the PAGE,
 *    not to that gate. The corner is the hub's three plates, the same in every
 *    cabinet (CLAUDE.md §2, "The corner: three plates, on every screen, and
 *    nothing else up there"): MENU (three bars), SOUND (a live mute) and
 *    FULLSCREEN, left to right, on the title, in the slot picker, on the map,
 *    in the workshop, on the prep screen, on results and underground. MENU
 *    opens the game's one menu: underground that is advhud's pause card, which
 *    stops the run; everywhere else it is this file's SETTINGS face of the same
 *    menu — ENGINE and EFFECTS, the language, Back, and the way out. Until
 *    2026-10-11 the corner was a speaker that opened a volume panel, and a
 *    run added its own mute and PAUSE beside it: four plates, two of them
 *    speakers meaning different things. They are in THIS file rather than a
 *    module of their own because index.html is frozen and this file already
 *    builds every control on this screen — and the screen toggle is
 *    deliberately NOT in a file named for its API, which would be blocked
 *    across the whole of github.io by a blocker's default list. See
 *    buildCorner() and the FILLING THE SCREEN section for both arguments.
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
  /* KEEP THIS IN STEP WITH sw.js's VERSION. It had drifted three releases
   * behind (v2.8.0 against sw.js's v2.9.1), which only ever shows on a
   * file:// or first-visit load — exactly the two cases where nobody can
   * check it against anything, so a wrong number there is worse than none. */
  var GAME_VERSION    = 'v2.15.0';

  /* TESTER MODE — the title-gate cheat code, old-school. Typed on the title
   * screen it reveals the TESTER MODE button; the unlock persists in
   * localStorage so a tester enters it once per device, not once per launch.
   * NOTE Enter is the 9th key AND the title's own start key — the tracker
   * swallows it while the sequence is genuinely under way (see onTitleKey). */
  var TESTER_CODE = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
                     'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight',
                     'Enter', 'Shift'];
  var TESTER_FLAG = 'supermine.adventure.tester';
  var TESTER_GRANT = 1000000;    // dollars per tap of the money button
  var TESTER_NAME = 'TEST RIG';  // the tester company's fixed name

  /* ---------------------------------------------------------------------
   * GLYPHS — the hub's corner set, TO THE PATH DATA (CLAUDE.md §2, "The
   * corner: three plates"), on a 24x24 viewBox, stroked with fill:none.
   * ---------------------------------------------------------------------
   * They used to be this game's own drawings — a chunkier speaker, corners
   * cut a little differently — and a player crossing from the next cabinet
   * was looking at a family resemblance rather than the same object. The
   * colour, the gold-on-dark plate and the stroke width are still the mine's;
   * the shapes are everybody's.
   *
   * BOTH STATES OF EACH TOGGLE LIVE IN ONE <svg>. The waves and the slash are
   * both drawn into the speaker, the expand and the contract both into the
   * screen plate, and style.css picks between them off aria-pressed —
   * `.sm-g-up` is drawn while the plate is not pressed (audible, windowed),
   * `.sm-g-down` while it is (muted, filling the screen) — which
   * the JS writes in the same breath as the label, so what is engraved and
   * what a screen reader hears cannot drift apart. advhud.js keeps its own
   * set for the pause card's actions; nothing there draws a corner plate.
   * ------------------------------------------------------------------ */
  var UI_ICONS = {
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',

    sound: '<path d="M11 5 6 9H3v6h3l5 4Z"/>' +
           '<path class="sm-g-up" d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>' +
           '<path class="sm-g-down" d="m15.5 9.5 6 5m0-5-6 5"/>',

    screen: '<path class="sm-g-up" d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/>' +
            '<path class="sm-g-down" d="M3 9h6V3M21 9h-6V3M3 15h6v6M21 15h-6v6"/>',

    /* The way out of the game: the hub's shared back arrow, TO THE PATH DATA
     * (CLAUDE.md §2, "One button, and it looks and behaves the same in every
     * game"). advhud.js draws the same path on the pause card's twin. */
    back: '<path d="M19 12H5m6-6-6 6 6 6"/>'
  };

  function glyph(inner) {
    return '<svg class="sm-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
           'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
           inner + '</svg>';
  }

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

  /* --- TESTER MODE state --- */
  var testerUnlocked = false;   // the code has been entered (persisted)
  var testerOpen = false;       // the tester panel is up over the title
  var codeAt = 0;               // progress through TESTER_CODE
  var wipeTimer = 0;            // two-tap confirm on WIPE

  /* --- the settings face of the menu, behind the three-bar plate --- */
  var menuOpen = false;

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

  /* SPEAKING, through js/i18n.js. elT() is el() for a node whose words never
   * change except with the language: it carries data-i18n, so I18N.paintStatic
   * repaints it on a switch with no code here. Everything this file writes
   * later (the update button, the tester card, the fullscreen label, the way
   * out) is repainted by onLang() instead. */
  function T() { return I18N.t.apply(null, arguments); }

  function elT(tag, cls, parent, key) {
    var n = el(tag, cls, parent, T(key));
    n.setAttribute('data-i18n', key);
    return n;
  }

  function setText(key, node, str) {
    if (!node || lastStrings[key] === str) return;
    lastStrings[key] = str;
    node.textContent = str;
  }

  /** A square glyph plate. Art carries the meaning here, so the title is not
   *  optional and neither is the aria-label — same helper shape as advhud's. */
  function iconButton(parent, cls, icon, key) {
    var b = el('button', 'sm-btn sm-iconbtn ' + cls, parent);
    b.setAttribute('type', 'button');
    b.setAttribute('data-i18n-label', key);
    b.setAttribute('title', T(key));
    b.setAttribute('aria-label', T(key));
    b.innerHTML = glyph(icon);
    return b;
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

    /* Entered once per device: the tester unlock survives reloads. */
    try { testerUnlocked = localStorage.getItem(TESTER_FLAG) === '1'; }
    catch (e) { testerUnlocked = false; }

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

    elT('div', 'sm-start-pick', sc, 'title.pick');

    /* PLAY, not START: the way in says the hub's one word for it (CLAUDE.md
     * §2, "Menus speak plainly"), in this game's brass caps. */
    els.startBtn = elT('button', 'sm-btn sm-btn-big sm-start-go', sc, 'menu.play');
    els.startBtn.setAttribute('type', 'button');

    /* NON-BREAKING SPACE BEFORE EACH SEPARATOR. This line wraps to two rows on
     * a phone, and with ordinary spaces the wrap point landed in front of a
     * "·", orphaning the bullet onto the head of the second line. Tying each
     * separator to the word it follows means a break can only happen AFTER it,
     * which is the only place it looks deliberate. */
    elT('div', 'sm-start-tag', sc, 'title.tag');

    /* Runs of spaces COLLAPSE in HTML, so the columns the old copy tried to set
     * up with whitespace all closed up into one ragged line. Explicit
     * separators, and caps, like every other label in the game. */
    var keys = el('div', 'sm-start-keys', sc);
    elT('div', 'sm-keys-desk', keys, 'title.keysDesk');
    elT('div', 'sm-keys-touch', keys, 'title.keysTouch');

    /* --- opt-in update, shown only when a new build is parked and waiting --- */
    els.update = el('button', 'sm-update', sc, T('update.offer', null));
    els.update.setAttribute('type', 'button');
    els.update.style.display = 'none';
    els.update.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();          // the overlay itself starts the game
      applyUpdate();
    });

    els.version = el('div', 'sm-start-version', els.start, GAME_VERSION);

    /* No language row here. It stood on this screen, above the way out, from
     * 2026-10-11 until the same day's evening, when the hub settled that
     * language and sound are settings and live behind the three bars — which
     * are on this screen too, one tap from a stranger who cannot read it. The
     * title spends its room on the way in and the way out. */
    buildArcadeExit(sc);
    buildCorner();
    buildTester();
    /* The corner and the menu are built HERE, with the rest of this screen's
     * controls, but they are appended to #ui-root rather than to the overlay —
     * they outlive it. DOM order no longer decides what paints over what
     * (advhud and advui append to the same root long after this runs), so both
     * carry a real z-index; see .sm-corner and .sm-sound in style.css. The
     * tester card is still a child of the overlay and still never opens
     * alongside the menu — each opener closes the other. */
    buildMenuPanel();

    /* CLICK, not pointerdown. A pointerdown+click pair on the same element
     * fires twice, and the second one arrived after the overlay had already
     * been taken down — which is how the campaign used to get opened twice. */
    els.start.addEventListener('click', beginAdventure);
    els.startBtn.addEventListener('click', beginAdventure);
  }

  /* ---------------------------------------------------------------------
   * THE WAY OUT OF THE GAME, ON THE SCREEN YOU ARRIVE ON
   * ---------------------------------------------------------------------
   * advhud.js has carried this on the pause card since the arcade learned to
   * frame us, and that covers a player who is underground. It does not cover
   * anybody else: the pause card is behind a run, and the title gate, the slot
   * picker, the world map, the workshop and the prep screen had nothing to
   * press at all. Inside the arcade's iframe there is no tab strip and no
   * visible back button either, so that was a room with no door — the FLOOR
   * pill is the launcher's safety net for a game that never heard of exit.js,
   * not for one that loads it and then hides the way out behind a descent.
   *
   * ONE DOOR, IN ONE PLACE. It goes here rather than on all five meta screens
   * because every one of them already routes back here in a tap or two (the
   * map, the slots and the prep screen all carry TITLE SCREEN), and two
   * different ways out of the same game is how they end up disagreeing.
   *
   * Built only when there is somewhere to go back TO — exitOffered() below,
   * not a bare `window.ArcadeExit`: that file is another repo's and is allowed
   * to be missing, and a player who typed this address never came from the
   * arcade and should not be handed a door into it. What it SAYS is exit.js's
   * answer, because a button must not offer to close a tab no script may close.
   *
   * DELIBERATELY SILENT, unlike its twin on the pause card. This is the one
   * screen where the audio graph has not been unlocked yet — the START gesture
   * is what does that — and spinning up an AudioContext to click on the way
   * out of the game would be the only thing it ever got used for.
   * ------------------------------------------------------------------ */
  /**
   * WHETHER TO DRAW A WAY OUT AT ALL, which is not the same question as
   * whether quit() could do something. In a plain tab it could — the arcade is
   * a URL and a navigation always works — but somebody who typed this game's
   * address, or followed a link to it, never came from the arcade and may
   * never have heard of it. So: a launcher behind us, or an installed window
   * that can genuinely close itself.
   *
   * ASKED THROUGH framed()/standalone() AND NOT THROUGH offers(), even though
   * offers() exists in exit.js and says exactly this in one call. exit.js is
   * ANOTHER REPOSITORY'S FILE and the copy that answers may be older than this
   * line: it is fetched from /arcade/, and a service worker on this shared
   * origin can hand back a version cached long before offers() was written. A
   * guard built on the new name fails CLOSED when that happens — the way out
   * silently disappears, inside the arcade, where it is the one control that
   * matters. These two predicates have been in exit.js since it existed.
   */
  function exitOffered() {
    var x = window.ArcadeExit;
    if (!x || !x.framed || !x.standalone) return false;
    try { return !!(x.framed() || x.standalone()); }
    catch (e) { return false; }   // a cross-origin parent is not a crash
  }

  /* exit.js picks the case and we supply the words, in whichever language is
   * current — and again on every switch (onLang), so the door is never left
   * speaking the language the page opened in. */
  var quitRefused = false;
  function exitWord() {
    return window.ArcadeExit.verb({
      arcade: T('menu.exitArcade'),
      app: T('menu.close'),
    });
  }

  function buildArcadeExit(parent) {
    if (!exitOffered()) return;

    /* PLAIN WORDS, NOT THE MINE'S, AND NOT THE MINE'S CAPITALS EITHER. A way
     * out of the game is not a place in the fiction, so it does not get a name
     * from one: "Back to arcade" when the launcher framed us, "Close" when we
     * are an installed app closing our own window. Since 2026-10-11 it does
     * not even keep this game's all-caps — the hub makes this one control the
     * same object in every cabinet, case, glyph and place (CLAUDE.md §2), so
     * the strings arrive in sentence case and nothing here raises them.
     * `tab` is legacy in exit.js and deliberately not passed.
     *
     * THE LAST THING IN THE TITLE'S COLUMN, as wide as PLAY above it. It used
     * to be a small plate pinned to the overlay's top-left corner, so that it
     * could not scroll away on a short phone; the hub fixed its place in the
     * column instead, and the column fits a sideways phone with room over. */
    els.startQuit = el('button', 'sm-btn sm-start-quit', parent, '');
    els.startQuit.setAttribute('type', 'button');
    el('span', 'sm-start-quit-ico', els.startQuit).innerHTML = glyph(UI_ICONS.back);
    els.startQuitLabel = el('span', 'sm-start-quit-label', els.startQuit, exitWord());
    els.startQuit.addEventListener('click', function (e) {
      e.preventDefault();
      /* els.start's own click handler starts the campaign, and this button is
       * sitting on top of it. Leaving must never launch a run on the way. */
      e.stopPropagation();
      els.startQuit.blur();
      startQuit();
    });
  }

  /** The title's way out. The button, Escape on the title and the menu's
   *  copy all come through here, so they are one action and cannot drift. */
  function startQuit() {
    if (!els.startQuit || els.startQuit.disabled) return;
    window.ArcadeExit.quit().then(function (how) {
      // Refused means the browser would not close a tab it did not open.
      // Say so where the buttons are, rather than leaving them looking dead —
      // both of this file's copies, the title's and the menu's.
      if (how !== 'refused') return;
      quitRefused = true;
      paintQuitLabels();
      els.startQuit.disabled = true;
      if (els.menuQuit) els.menuQuit.disabled = true;
    });
  }

  /* ---------------------------------------------------------------------
   * THE CORNER — THREE PLATES, PERMANENT, FIXED TO THE PAGE
   * ---------------------------------------------------------------------
   * MENU, SOUND, FULLSCREEN, reading left to right, so fullscreen is the one
   * in the actual corner (CLAUDE.md §2). Three kinds of thing, and that is the
   * whole shape: fullscreen changes the window, sound changes the sound, and
   * only the menu touches the game.
   *
   *   MENU   opens the one menu. Underground it is advhud's pause card, which
   *          stops the run and carries RESUME; anywhere else it is the
   *          settings face below, which has nothing to resume. It IS pause —
   *          there is no other pause plate in this game any more.
   *   SOUND  mutes and unmutes, one tap, live: nothing opens, nothing pauses,
   *          focus does not move. A player silencing the room because
   *          somebody walked in must not lose the descent they are on.
   *   SCREEN as described in FILLING THE SCREEN below.
   *
   * WHAT WENT. Until 2026-10-11 this corner held a speaker that OPENED a
   * volume panel, and from the first descent advhud parked its own mute and
   * PAUSE beside it — four plates, two of them speakers that meant different
   * things. The owner's screenshot read it exactly: "one mute and one sound
   * menu" side by side. The speaker is a mute now, the volumes live in the
   * menu, and advhud's pair is gone outright, so nothing on this edge changes
   * between the title and 600 m down.
   *
   * IT IS A CHILD OF #ui-root, `position: fixed` and above every layer this
   * game has (see .sm-corner in style.css), because a control that goes away
   * when the screen changes is not a corner; it is a menu item that happens
   * to sit in one. It reuses `.sm-iconbtn` — the game's own gold-on-dark
   * plate with the hazard sliver — which is what keeps a 42px button from
   * reading as generic mobile chrome.
   *
   * SAFE AREAS ARE ARITHMETIC, not inheritance: `fixed` positions against the
   * viewport, so #ui-root's padding does not apply and .sm-corner adds both
   * insets back by hand.
   * ------------------------------------------------------------------ */
  function buildCorner() {
    els.corner = el('div', 'sm-corner', root);
    /* Nothing under this cluster should start a descent: the crack between
     * two plates is still a click on a container, and swallowing it costs one
     * line. */
    els.corner.addEventListener('click', function (e) { e.stopPropagation(); });

    els.menuBtn = iconButton(els.corner, 'sm-btn-menu', UI_ICONS.menu, 'menu.menu');
    els.menuBtn.setAttribute('aria-haspopup', 'dialog');
    els.menuBtn.setAttribute('aria-expanded', 'false');
    els.menuBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      els.menuBtn.blur();
      onMenuPlate();
    });

    /* Its words follow its state, so refreshMute() owns them, not paintStatic. */
    els.muteBtn = iconButton(els.corner, 'sm-btn-mute', UI_ICONS.sound, 'menu.mute');
    els.muteBtn.removeAttribute('data-i18n-label');
    els.muteBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      /* blur, not focus elsewhere: the plate is the thing that was pressed and
       * nothing else on screen asked for the keyboard. */
      els.muteBtn.blur();
      if (SM.sound && SM.sound.toggleMute) SM.sound.toggleMute();
      refreshMute();
    });
    refreshMute();

    /* HIDDEN IN THE MARKUP THIS BUILDS, and un-hidden by initScreenToggle()
     * only once a working request/exit PAIR has answered. Safari on iPhone has
     * no element fullscreen at all, and a plate that does nothing when pressed
     * is worse than no plate. A two-plate corner is a fine outcome. */
    els.screen = iconButton(els.corner, 'sm-btn-screen', UI_ICONS.screen, 'menu.fullscreen');
    /* Its words follow its state, not a fixed key — refreshScreenToggle()
     * owns them, and paintStatic must not put "Fullscreen" back on a plate
     * that is currently offering the way out of it. */
    els.screen.removeAttribute('data-i18n-label');
    els.screen.setAttribute('aria-pressed', 'false');
    els.screen.hidden = true;
  }

  /** The speaker's one writer: aria-pressed (which CSS reads to pick waves or
   *  slash) and the words, in the same breath, so they cannot drift. Also
   *  called off `sound:muted`, because the M key and a slider drag both
   *  change the mute without touching this plate. */
  function refreshMute() {
    if (!els.muteBtn) return;
    var muted = !!(SM.sound && SM.sound.isMuted && SM.sound.isMuted());
    var label = T(muted ? 'menu.unmute' : 'menu.mute');
    els.muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    els.muteBtn.setAttribute('aria-label', label);
    els.muteBtn.setAttribute('title', label);
    els.muteBtn.classList.toggle('sm-btn-off', muted);
  }

  /**
   * THE THREE BARS. One plate, one menu, whichever screen it is pressed on.
   *
   * Underground the menu is advhud's pause card: it pauses (this game is
   * always yours to pause — there is no network here), and pressing the plate
   * again closes it, exactly as Escape does. openPause() refuses itself when
   * the HUD is not up, and says so by returning false, which is how this
   * knows to fall through to the settings face on every other screen.
   */
  function onMenuPlate() {
    var hud = SM.advhud;
    if (hud && hud.isPaused && hud.isPaused()) { hud.closePause(); return; }
    if (menuOpen) { closeMenu(); return; }
    if (hud && hud.openPause && hud.openPause() === true) return;
    openMenu();
  }

  /** advhud tells us when its card opens and closes, so the plate's
   *  aria-expanded is right whichever face of the menu is up. */
  function paintMenuPlate() {
    if (!els.menuBtn) return;
    var hudOpen = !!(SM.advhud && SM.advhud.isPaused && SM.advhud.isPaused());
    els.menuBtn.setAttribute('aria-expanded', (menuOpen || hudOpen) ? 'true' : 'false');
  }

  /* ---------------------------------------------------------------------
   * THE MENU, SETTINGS FACE — ENGINE, EFFECTS, LANGUAGE, BACK, THE WAY OUT
   * ---------------------------------------------------------------------
   * What the three bars open on every screen that is not a live descent: the
   * title, the slot picker, the map, the workshop, prep, results. It is the
   * same menu as advhud's pause card with nothing to resume, so it carries the
   * same settings rows (built by buildVolumes() below for both) and the same
   * way out, last, with a little more air above it.
   *
   * IT IS A CHILD OF #ui-root, NOT OF .sm-start: the plate that opens it is on
   * every screen, and a panel the title overlay's `.sm-start-off` could take
   * down with it would make that plate a button that does nothing on six
   * screens out of seven. It still stops click propagation once at its root,
   * which covers every control inside it, and tapping the backdrop closes it.
   *
   * WHY TWO SLIDERS AND NOT ONE SWITCH. The mine had a single mute: you could
   * kill the whole thing or live with it, and there was no way to keep the
   * engine down while the rock still answered. ENGINE is the drone and the
   * cutter — the two permanently-running nodes that hum under every second of a
   * descent. EFFECTS is everything discrete. js/sound.js's header carries the
   * full argument, including why this game's `music` key governs an engine.
   *
   * DELIBERATELY SILENT TO OPEN AND TO CLOSE: play() rate-limits on a clock
   * that only advances inside the fixed step, and the fixed step is held while
   * the title is up, so a 'ui' blip here would sound exactly once per session
   * and then stop. The sliders make their own noise through SM.sound.preview(),
   * which throttles on wall time instead.
   * ------------------------------------------------------------------ */
  function buildMenuPanel() {
    els.menuPanel = el('div', 'sm-sound', root);
    els.menuPanel.setAttribute('role', 'dialog');
    els.menuPanel.setAttribute('aria-modal', 'true');
    els.menuPanel.addEventListener('click', function (e) {
      e.stopPropagation();          // nothing in here may start the campaign...
      if (e.target === els.menuPanel) closeMenu();   // ...and the backdrop closes
    });

    var card = el('div', 'sm-panel sm-sound-card', els.menuPanel);
    el('div', 'sm-stripe', card);
    elT('div', 'sm-sound-kicker', card, 'sound.kicker');
    elT('div', 'sm-sound-title', card, 'menu.settings');

    buildVolumes(card, 'menu');
    elT('div', 'sm-sound-hint', card, 'sound.hint');

    /* The menu's copy of the language row; `menu` keeps its flag ids apart
     * from the title's and the pause card's. */
    I18N.langRow(card, 'menu');

    els.menuBack = elT('button', 'sm-btn sm-sound-back', card, 'menu.back');
    els.menuBack.setAttribute('type', 'button');
    els.menuBack.addEventListener('click', function (e) {
      e.preventDefault();
      els.menuBack.blur();
      closeMenu();
    });

    buildMenuExit(card);
  }

  /**
   * THE WAY OUT, ON THE SETTINGS FACE — the same button as the title's and the
   * pause card's, last in the column (CLAUDE.md §2, "One button..."). Same
   * guard (exitOffered), same words (exitWord), same refusal handling.
   *
   * ONE CASE ASKS FOR A SECOND TAP: the workshop opened from the lift, where
   * a run is HELD rather than over (adv.isShopHold()). Leaving there drops the
   * hold exactly as the pause card's copy warns, so it arms the same way; on
   * every other screen this face can be open on, the company is already saved
   * and leaving costs nothing.
   */
  var menuQuitArmed = false;
  var menuQuitTimer = 0;
  function buildMenuExit(parent) {
    if (!exitOffered()) return;
    els.menuQuit = el('button', 'sm-btn sm-start-quit sm-menu-quit', parent, '');
    els.menuQuit.setAttribute('type', 'button');
    el('span', 'sm-start-quit-ico', els.menuQuit).innerHTML = glyph(UI_ICONS.back);
    els.menuQuitLabel = el('span', 'sm-start-quit-label', els.menuQuit, exitWord());
    els.menuQuit.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      els.menuQuit.blur();
      if (els.menuQuit.disabled) return;
      var held = !!(SM.adv && SM.adv.isShopHold && SM.adv.isShopHold());
      if (held && !menuQuitArmed) {
        menuQuitArmed = true;
        els.menuQuit.classList.add('sm-ah-armed');
        els.menuQuitLabel.textContent = T('pause.confirmLose');
        menuQuitTimer = setTimeout(disarmMenuQuit, 3200);
        return;
      }
      disarmMenuQuit();
      if (SM.save && SM.save.flush) { try { SM.save.flush(); } catch (err) { /* best effort */ } }
      startQuit();
    });
  }

  function disarmMenuQuit() {
    menuQuitArmed = false;
    if (menuQuitTimer) { clearTimeout(menuQuitTimer); menuQuitTimer = 0; }
    if (!els.menuQuit) return;
    els.menuQuit.classList.remove('sm-ah-armed');
    paintQuitLabels();
  }

  /** Both of this file's copies of the way out say the same thing, always. */
  function paintQuitLabels() {
    if (!window.ArcadeExit) return;
    var word = quitRefused ? T('menu.closeTab') : exitWord();
    if (els.startQuitLabel) els.startQuitLabel.textContent = word;
    if (els.menuQuitLabel && !menuQuitArmed) els.menuQuitLabel.textContent = word;
  }

  /**
   * ENGINE AND EFFECTS, for whichever menu asks — this file's settings face
   * and advhud's pause card both call it, so the two copies are one control
   * built once and cannot drift. Every copy is remembered, so paintVolumes()
   * keeps all of them on the level the graph is actually at. `uid` keeps the
   * input ids (and so the label `for`s) unique per copy.
   *
   * ENGINE and EFFECTS, not THE RIG and THE ROCK, and the first row is ENGINE
   * and NOT "music" — the one place this game departs from every other in the
   * hub. There is no music down here: the rhythm grid died with the
   * time-attack zones, and the continuous layer this slider governs is the
   * drone and the cutter. A row labelled MUSIC would name something that does
   * not exist. js/sound.js's header says why the stored key is still
   * `vol.music.v1` (§6: a key that works is not renamed).
   */
  var volumeSets = [];
  function buildVolumes(parent, uid) {
    var set = {
      music: volumeRow(parent, 'sm-vol-rig-' + uid, 'menu.engine'),
      sfx: volumeRow(parent, 'sm-vol-rock-' + uid, 'menu.effects')
    };
    /* Only ever on "input", never on "change": a level you cannot hear until
     * you let go of the thumb is not a volume control. */
    wireVolume(set.music, function (v) {
      if (SM.sound && SM.sound.setMusicVolume) SM.sound.setMusicVolume(v);
    }, 'music');
    wireVolume(set.sfx, function (v) {
      if (SM.sound && SM.sound.setSfxVolume) SM.sound.setSfxVolume(v);
    }, 'sfx');
    volumeSets.push(set);
    paintVolumes();
    return set;
  }

  /**
   * One row: a label that carries the gutter, a real range, and the number.
   *
   * The label's flex-basis is what makes both rows start their track at the
   * same x (hub CLAUDE.md §2). A real <input type="range"> rather than a
   * hand-rolled track, because it arrives with keyboard support, the right ARIA
   * role and a live value announcement — looking like the mine is a job for
   * CSS, not for reinventing a control badly.
   */
  function volumeRow(parent, id, label) {
    var row = el('div', 'sm-sound-row', parent);

    var lab = elT('label', 'sm-sound-label', row, label);
    lab.setAttribute('for', id);

    var input = el('input', 'sm-sound-range', row);
    input.id = id;
    input.setAttribute('type', 'range');
    input.setAttribute('min', '0');
    input.setAttribute('max', '100');
    input.setAttribute('step', '1');

    /* A REAL INTEGRATION HAZARD, and worse here than it looks. js/input.js
       listens for keydown on WINDOW in the bubble phase and calls
       preventDefault() on all four arrows — so a focused slider nudged with
       ArrowLeft would not only saw the wheel, it would not move at all. 'm'
       would toggle the mute, and onTitleKey's Enter/Space would start a
       descent out from under an open menu. Stopping propagation at the input
       is what keeps the key: nothing here calls preventDefault, so the range
       still does its own default thing. */
    /* ...all but Escape, which is the menu's BACK and must reach the handler
       that owns it from a focused slider too. */
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' && e.key !== 'Esc') e.stopPropagation();
    });
    input.addEventListener('keyup', function (e) { e.stopPropagation(); });

    var out = el('output', 'sm-sound-out', row, '100');
    out.setAttribute('for', id);

    return { input: input, out: out };
  }

  /** The only writer for one row: the drag and paintVolumes() both come through
   *  here, so the thumb, the number and the gauge fill cannot drift apart. */
  function paintVolume(pair, pct) {
    if (!pair) return;
    pct = Math.round(pct);
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    var s = '' + pct;
    if (pair.input.value !== s) pair.input.value = s;
    if (pair.out.textContent !== s) pair.out.textContent = s;
    /* The filled part of the track is a gradient stop, so the slider reads as
       one more gauge on this machine rather than as an OS control. Written on
       drag and on open only — this is not in any draw loop. */
    pair.input.style.setProperty('--sm-fill', pct + '%');
  }

  /** Pull every copy from the sound module. Feature-detected like every other
   *  cross-module call in this file: on a partial merge the menu still opens
   *  and still reads 100/100 rather than throwing on the way up. */
  function paintVolumes() {
    var m = (SM.sound && SM.sound.getMusicVolume) ? SM.sound.getMusicVolume() * 100 : null;
    var f = (SM.sound && SM.sound.getSfxVolume) ? SM.sound.getSfxVolume() * 100 : null;
    for (var i = 0; i < volumeSets.length; i++) {
      if (m !== null) paintVolume(volumeSets[i].music, m);
      if (f !== null) paintVolume(volumeSets[i].sfx, f);
    }
  }

  /** Each tick writes the level (sound.js persists it) and auditions the side
   *  it just moved. preview() also LIFTS THE MUTE (see sound.js): a slider
   *  silently cancelled by a mute elsewhere is not a volume control. The
   *  corner speaker repaints off the `sound:muted` event that follows. */
  function wireVolume(pair, apply, side) {
    if (!pair) return;
    pair.input.addEventListener('input', function () {
      var pct = Number(pair.input.value);
      if (!isFinite(pct)) pct = 0;
      paintVolume(pair, pct);
      if (apply) apply(pct / 100);
      if (SM.sound && SM.sound.preview) SM.sound.preview(side);
      /* The other copy of this slider is hidden right now, but it must not be
       * found at a stale level the next time its menu opens. */
      paintVolumes();
    });
  }

  /**
   * Open the settings face.
   *
   * NEVER OVER A LIVE DESCENT: onMenuPlate() sends the plate to advhud's pause
   * card whenever the HUD is up, so this only ever opens over a screen where
   * nothing is moving. WHERE "BACK" GOES NEEDS NO BOOKKEEPING: the panel is an
   * overlay with its own scrim, not a screen in a state machine, so closing it
   * reveals whatever it was opened over. Escape, BACK, the backdrop and a
   * second press of the plate all route through closeMenu().
   */
  function openMenu() {
    if (!els.menuPanel || menuOpen) return;
    closeTester();               // one menu at a time over the title
    menuOpen = true;
    /* Built once and reopened many times, so it repaints from the module on
     * the way up rather than trusting whatever the DOM was last left showing. */
    paintVolumes();
    els.menuPanel.classList.add('sm-sound-on');
    paintMenuPlate();
    // Put focus inside the thing that just appeared rather than leaving it on
    // a plate behind a scrim.
    try { els.menuBack.focus(); } catch (e) { /* focus is optional */ }
  }

  function closeMenu() {
    if (!els.menuPanel || !menuOpen) return;
    menuOpen = false;
    disarmMenuQuit();
    els.menuPanel.classList.remove('sm-sound-on');
    paintMenuPlate();
    if (els.menuBtn) {
      // Hand focus back to the plate that opened it, or a keyboard player is
      // dropped on the body with nothing selected.
      try { els.menuBtn.focus(); } catch (e) { /* focus is optional */ }
    }
  }

  /* ---------------------------------------------------------------------
   * FILLING THE SCREEN
   * ---------------------------------------------------------------------
   * The third plate in the corner, the one in the actual corner. It lives in THIS file rather than
   * in a js/screen.js of its own because index.html is frozen — every script
   * tag in it is accounted for and documented in dependency order — and ui.js
   * already builds every control on this screen. What it must NOT be called is
   * the obvious name: uBlock Origin's DEFAULT lists ban that basename across
   * the whole of github.io, and every game in this hub shares one origin, so a
   * file named for the API would be blocked for every player running a blocker
   * whether or not the rule was ever aimed at us.
   *
   * SUPPORT IS NOT UNIVERSAL. Safari on iPhone has no element fullscreen at
   * all; the plate therefore starts hidden and is only revealed once a working
   * request/exit PAIR has answered here.
   *
   * Escape and the browser's own chrome leave fullscreen without ever touching
   * this plate, so aria-pressed — which CSS reads to draw expand or contract —
   * and the words repaint from the CHANGE EVENT and not only from the click
   * handler.
   *
   * It works inside the arcade's iframe: the launcher's allow list already
   * grants fullscreen to every game it frames.
   * ------------------------------------------------------------------ */
  var screenRequest = null;
  var screenExit = null;
  var screenWired = false;

  function screenFilled() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function refreshScreenToggle() {
    if (!els.screen) return;
    var on = screenFilled();
    /* Plain words, and deliberately not the mine's own vocabulary. This is
     * something the browser does, not something the game does; it has one name
     * everywhere and the player already knows it. */
    var label = T(on ? 'menu.exitFullscreen' : 'menu.fullscreen');
    els.screen.setAttribute('aria-pressed', on ? 'true' : 'false');
    els.screen.setAttribute('aria-label', label);
    els.screen.setAttribute('title', label);
  }

  function toggleScreen() {
    if (!screenRequest || !screenExit) return;
    var r;
    try {
      r = screenFilled() ? screenExit.call(document)
                         : screenRequest.call(document.documentElement);
    } catch (e) {
      return;                      // an older synchronous implementation threw
    }
    /* Either call returns a promise that can reject — a permissions policy
       refusing it, or the player backing out of the browser's own prompt. The
       change event already covers what actually happened, so this exists only
       to stop a refusal surfacing as an unhandled rejection. */
    if (r && typeof r['catch'] === 'function') r['catch'](function () {});
  }

  function initScreenToggle() {
    if (screenWired) return;       // build() could in principle run again
    var docEl = document.documentElement;
    screenRequest = docEl.requestFullscreen || docEl.webkitRequestFullscreen || null;
    screenExit = document.exitFullscreen || document.webkitExitFullscreen || null;
    if (!els.screen || !screenRequest || !screenExit) return;   // stays hidden
    screenWired = true;

    els.screen.hidden = false;
    refreshScreenToggle();
    els.screen.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();         // the overlay underneath starts the campaign
      els.screen.blur();
      toggleScreen();
    });
    document.addEventListener('fullscreenchange', refreshScreenToggle, false);
    document.addEventListener('webkitfullscreenchange', refreshScreenToggle, false);
  }

  /* ---------------------------------------------------------------------
   * TESTER MODE — the cheat-code door and the panel behind it
   * ---------------------------------------------------------------------
   * Everything here lives ON the title overlay, because that is the only
   * screen where no company is live: the +$1M button writes straight into
   * the STORED tester record (SM.save.grantCash), and js/adv.js re-reads
   * record.cash in startCompany(), so the grant can never desync a ledger.
   *
   * EVERY CLICK IN HERE MUST NOT REACH THE OVERLAY — els.start's own click
   * handler starts the game. The panel stops propagation once, at its root,
   * which covers every button inside it.
   * ------------------------------------------------------------------ */
  function buildTester() {
    els.testerBtn = elT('button', 'sm-btn sm-start-tester', els.start, 'tester.title');
    els.testerBtn.setAttribute('type', 'button');
    if (!testerUnlocked) els.testerBtn.style.display = 'none';
    els.testerBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openTester();
    });

    els.tester = el('div', 'sm-tester', els.start);
    els.tester.addEventListener('click', function (e) {
      e.stopPropagation();      // nothing in here may start the campaign...
      if (e.target === els.tester) closeTester();   // ...and the backdrop closes
    });

    var card = el('div', 'sm-tester-card', els.tester);
    elT('div', 'sm-tester-title', card, 'tester.title');
    elT('div', 'sm-tester-note', card, 'tester.note');

    var slot = el('div', 'sm-tester-slot', card);
    var info = el('div', 'sm-tester-info', slot);
    els.testerName = el('div', 'sm-tester-name', info, T('tester.empty'));
    els.testerStats = el('div', 'sm-tester-stats', info, '');
    els.testerCash = el('button', 'sm-btn sm-tester-cash', slot, '+ $1 000 000');
    els.testerCash.setAttribute('type', 'button');
    els.testerCash.addEventListener('click', function (e) {
      e.preventDefault();
      if (!(SM.save && SM.save.grantCash)) return;
      SM.save.grantCash(SM.save.TESTER_SLOT, TESTER_GRANT);
      if (SM.sound && SM.sound.play) SM.sound.play('ui');
      paintTester();
    });

    var acts = el('div', 'sm-tester-acts', card);
    els.testerGo = el('button', 'sm-btn sm-btn-primary sm-tester-go', acts, T('tester.new'));
    els.testerGo.setAttribute('type', 'button');
    els.testerGo.addEventListener('click', function (e) {
      e.preventDefault();
      if (!(SM.save && SM.save.testerSummary)) return;
      if (SM.save.testerSummary().empty) {
        SM.save.newGame(SM.save.TESTER_SLOT, TESTER_NAME);
        if (SM.save.flush) SM.save.flush();
        if (SM.sound && SM.sound.play) SM.sound.play('ui');
        paintTester();          // stays in the menu: grant cash, then continue
      } else {
        enterTester();
      }
    });
    els.testerWipe = el('button', 'sm-btn sm-tester-quiet', acts, T('tester.wipe'));
    els.testerWipe.setAttribute('type', 'button');
    els.testerWipe.addEventListener('click', function (e) {
      e.preventDefault();
      if (!wipeTimer) {
        /* Two taps, like every destructive verb in the campaign. */
        els.testerWipe.textContent = T('tester.wipeSure');
        wipeTimer = setTimeout(function () {
          wipeTimer = 0;
          els.testerWipe.textContent = T('tester.wipe');
        }, 2600);
        return;
      }
      clearTimeout(wipeTimer);
      wipeTimer = 0;
      els.testerWipe.textContent = T('tester.wipe');
      if (SM.save && SM.save.erase) SM.save.erase(SM.save.TESTER_SLOT);
      if (SM.save && SM.save.flush) SM.save.flush();
      paintTester();
    });
    els.testerBack = elT('button', 'sm-btn sm-tester-quiet', acts, 'menu.back');
    els.testerBack.setAttribute('type', 'button');
    els.testerBack.addEventListener('click', function (e) {
      e.preventDefault();
      closeTester();
    });
  }

  function moneyStr(n) {
    n = Math.floor(n > 0 ? n : 0);
    return '$' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  function paintTester() {
    var s = (SM.save && SM.save.testerSummary) ? SM.save.testerSummary() : null;
    var empty = !s || s.empty;
    setText('tstName', els.testerName, empty ? T('tester.empty') : String(s.company || TESTER_NAME));
    setText('tstStats', els.testerStats, empty
      ? T('tester.none')
      : T('tester.stats', s.day, moneyStr(s.cash), s.tier, s.mines));
    setText('tstGo', els.testerGo, empty ? T('tester.new') : T('tester.continue'));
    els.testerCash.disabled = empty;
    els.testerWipe.style.display = empty ? 'none' : '';
  }

  function openTester() {
    if (!els.tester) return;
    closeMenu();                 // one menu at a time over the title
    testerOpen = true;
    paintTester();
    els.tester.classList.add('sm-tester-on');
    if (SM.sound && SM.sound.play) SM.sound.play('ui');
  }

  function closeTester() {
    testerOpen = false;
    if (els.tester) els.tester.classList.remove('sm-tester-on');
  }

  /** Feed one key to the sequence tracker. -> true if the key was consumed
   *  (matched mid-sequence and must not reach the title's own handlers). */
  function trackTesterCode(k) {
    if (testerOpen) return false;              // the panel owns the keyboard
    if (k === TESTER_CODE[codeAt]) {
      codeAt++;
      if (codeAt >= TESTER_CODE.length) {
        codeAt = 0;
        unlockTester();
        return true;
      }
      /* Only Enter needs swallowing: it is the one mid-sequence key the
       * title itself acts on, and by position 9 the player has typed eight
       * correct arrows — this is the code, not a launch. */
      return k === 'Enter';
    }
    codeAt = (k === TESTER_CODE[0]) ? 1 : 0;   // a miss can restart the run
    return false;
  }

  function unlockTester() {
    testerUnlocked = true;
    try { localStorage.setItem(TESTER_FLAG, '1'); } catch (e) { /* session-only then */ }
    if (els.testerBtn) {
      els.testerBtn.style.display = '';
      els.testerBtn.classList.remove('sm-tester-pop');
      els.testerBtn.classList.add('sm-tester-pop');
    }
    if (SM.sound && SM.sound.play) SM.sound.play('ui');
  }

  /**
   * Enter the campaign with the TESTER company. Mirrors beginAdventure() —
   * same latch order, same gesture note — then skips the slot picker by
   * loading the tester slot and handing straight over to the state machine,
   * exactly the way js/advui.js's own CONTINUE does it.
   */
  function enterTester() {
    if (!titleUp) return;
    if (!(SM.save && SM.save.load && SM.adv && SM.adv.open && SM.adv.startCompany)) return;
    if (!SM.save.load(SM.save.TESTER_SLOT)) return;

    titleUp = false;
    closeTester();
    if (SM.sound && SM.sound.play) SM.sound.play('ui');
    if (SM.input && SM.input.noteGesture) SM.input.noteGesture();
    hideTitle();
    SM.adv.open();           // arms the campaign ('slots')...
    SM.adv.startCompany();   // ...and adopts the loaded record ('map'/'prep')
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
    if (!e) return;
    var k = e.key;
    /* THE SETTINGS FACE OWNS THE KEYBOARD WHILE IT IS UP, AND IT TAKES IT
     * BEFORE THE `titleUp` GATE. That gate is the first line of this handler
     * because everything below it is the title's business — but the menu is
     * not the title's, it opens from every screen, and behind the gate its
     * Escape key would never be delivered on six of them. advui.js's handler
     * asks isMenuOpen() and checks defaultPrevented before it acts, so one
     * Escape closes the menu and does not also walk a meta screen back.
     *
     * The rest of the reason this block comes early has not changed: Enter and
     * Space must not start a descent out from under an open menu when focus is
     * on BACK, and the arrows a player nudges a slider with must not be
     * quietly feeding the cheat tracker while they do it. The sliders stop
     * propagation one level lower for input.js's sake — see volumeRow(). */
    if (menuOpen) {
      if (k === 'Escape' || k === 'Esc') {
        e.preventDefault();
        if (!e.repeat) closeMenu();
      }
      return;
    }
    if (!titleUp) return;
    /* ESCAPE ON THE TITLE, the hub's rule in this screen's two states
     * (CLAUDE.md §2, "Escape goes one step back"): the tester panel is a
     * sub-panel and Escape is its BACK; with nothing open, Escape IS the
     * "Back to arcade" button — the same startQuit(), and only when that
     * button is shown. Taken here, before the Enter/Space and cheat-tracker
     * logic below, and preventDefault()ed, so the one press can never also
     * start a descent: that exact double — quit AND descend on one keystroke
     * — is the bug the hub names this game for. Auto-repeat is ignored so a
     * held key cannot close the tester and then leave the game behind it. */
    if (k === 'Escape' || k === 'Esc') {
      /* ...unless another handler already answered this very press. A meta
       * screen's BACK (advui.js) can land on this title synchronously, and if
       * that listener ran first, `titleUp` is already true by the time this
       * one runs — one Escape would walk to the title AND out of the game. */
      if (e.defaultPrevented) return;
      e.preventDefault();
      if (e.repeat) return;
      if (testerOpen) closeTester();
      else if (els.startQuit) startQuit();
      return;
    }
    if (els.update && e.target === els.update) return;
    /* ENTER AND SPACE BELONG TO WHATEVER BUTTON HAS FOCUS, not to the overlay
       underneath it. The UPDATE plate got this by name on the line above, back
       when it was the only other focusable thing on the screen. It is not any
       more: the door, the tester plate, the corner cluster's two plates and
       the sound panel's own BACK are five more, and on every one of them a
       keyboard press fired the button AND started a descent behind it — which
       on BACK TO ARCADE meant quitting and launching a run in the same
       keystroke. START is the exception and needs no help here: its own click
       handler IS beginAdventure, and a key on a focused button synthesises a
       click. Only Enter and Space are taken, so the cheat sequence's arrows
       still reach the tracker below whatever happens to have focus. */
    if ((k === 'Enter' || k === ' ' || k === 'Spacebar') &&
        e.target && e.target !== els.startBtn &&
        e.target.tagName && e.target.tagName.toLowerCase() === 'button') return;
    /* The cheat tracker sees every key first; a consumed key (the sequence's
     * own Enter) must not fall through and start the game. */
    if (trackTesterCode(k)) { e.preventDefault(); return; }
    if (testerOpen) {
      /* The tester panel owns the keyboard: Enter and Space must not start a
       * campaign underneath an open menu. (Escape closed it above.) */
      return;
    }
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
    /* A click outside an open tester panel closes the panel — it must never
     * fall through the backdrop and launch the campaign. */
    if (testerOpen) { closeTester(); return; }
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
    closeTester();               // never resurface the title with a stale panel
    closeMenu();                 // ...and the menu is a panel like any other
    if (els.start) els.start.classList.remove('sm-start-off');
  }

  function hideTitle() {
    /* THE MENU IS NOT A CHILD OF THE OVERLAY, so the fade does not take it
     * away — this call is what does. Without it the settings face would still
     * be over the screen when the first descent began underneath it. */
    closeMenu();
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
  /* A LANGUAGE SWITCH, from the menu's copy of the row or the pause card's. paintStatic has already
   * repainted every data-i18n node by the time this runs; what is left is the
   * text this file writes itself. Nothing here closes a panel, leaves the
   * title or touches the pause — the menu stays open, in the new words. */
  function onLang() {
    lastStrings = {};
    paintUpdate();
    refreshScreenToggle();
    refreshMute();
    paintQuitLabels();
    if (menuQuitArmed && els.menuQuitLabel) els.menuQuitLabel.textContent = T('pause.confirmLose');
    if (els.testerWipe && !wipeTimer) els.testerWipe.textContent = T('tester.wipe');
    if (els.testerName) paintTester();
  }

  function init() {
    build();
    /* AFTER build(), because it un-hides a plate build() has just created —
     * and only if a working request/exit pair answers. See the section header:
     * a plate that does nothing when pressed is worse than no plate. */
    initScreenToggle();
    if (!subscribed) {
      subscribed = true;
      window.addEventListener('resize', onResize, false);
      window.addEventListener('orientationchange', onResize, false);
      /* Registered ONCE here rather than in buildTitle(), which build() could
       * in principle run again — a second listener would be harmless (the call
       * is idempotent) but this is the file's existing discipline. */
      window.addEventListener('keydown', onTitleKey, false);
      document.addEventListener('arcade:lang', onLang, false);
      /* The M key and a slider drag change the mute without touching the
       * corner speaker; it repaints off the event, so the two cannot disagree. */
      if (SM.events && SM.events.on) SM.events.on('sound:muted', refreshMute);
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

  /* What the update button is saying, so a language switch can say it again:
   * '' (hidden), 'offer' or 'installing'. */
  var updateState = '';
  var updateVersion = null;

  function paintUpdate() {
    if (!els.update || !updateState) return;
    els.update.textContent = updateState === 'installing'
      ? T('update.installing')
      : T('update.offer', updateVersion);
  }

  function offerUpdate(version) {
    if (!els.update) return;
    updateState = 'offer';
    updateVersion = version || null;
    paintUpdate();
    els.update.style.display = '';
    els.update.classList.add('sm-update-on');
  }

  function applyUpdate() {
    if (!swReg || !swReg.waiting) return;
    if (SM.sound && SM.sound.play) SM.sound.play('ui');
    updateState = 'installing';
    paintUpdate();
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
    /* Asked by advhud.js's and advui.js's Escape handlers, which share the
     * key with this file's: while the settings face is up, its Escape is this
     * file's to answer, and nobody else may act on the same press. */
    isMenuOpen: function () { return menuOpen; },
    /* advhud's pause card is the in-run face of the same menu: it builds its
     * sliders through here, and tells us when it opens and closes so the
     * three-bar plate's aria-expanded is right. */
    buildVolumes: buildVolumes,
    paintVolumes: paintVolumes,
    paintMenuPlate: paintMenuPlate,
    getRoot: function () { return root; }
  };
})();
