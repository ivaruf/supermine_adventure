/* =============================================================================
 * SUPERMINE ADVENTURE — js/input.js
 * -----------------------------------------------------------------------------
 * Keyboard (WASD + all four arrows) and the virtual thumbstick, unified into
 * ONE two-dimensional movement vector.
 *
 * There used to be a second, separate path here: a single steering AXIS, fed
 * by A/D and by a self-recentring pointer drag, for a machine that advanced by
 * itself and only needed to be told left or right. That machine is gone. What
 * is left is the vector, and the pointer no longer steers at all — js/joystick.js
 * owns touch driving and pushes through setStick().
 *
 * WHAT SURVIVES OF THE POINTER: one listener on the canvas whose only job is
 * to notice that the player has touched the page. That first gesture is what
 * unlocks WebAudio and releases main.js's simulation gate, and it has to be
 * catchable however it arrives — the title screen's button, the thumbstick, a
 * key, or a bare tap on the canvas.
 *
 * Public API
 *   SM.input.init(canvas)      -- attach listeners (called by main.js)
 *   SM.input.update(dt)        -- smooth the keyboard axes (called by main.js)
 *   SM.input.reset()           -- clear all held state
 *   SM.input.noteGesture()     -- the canonical "the player touched something"
 *                                 path. Fires 'input:firstgesture' exactly once.
 *   SM.input.consumeFirstGesture() -- returns true exactly once, after that
 *                                 first gesture. sound.js uses it to unlock
 *                                 WebAudio; anyone may listen to the event.
 *
 *   SM.input.setStick(x, y) / clearStick() / isStickActive()
 *   SM.input.getMove()         -- REUSED {x, y, mag} — never stash it
 *   SM.input.getMoveX() / getMoveY() / getMoveMag()
 *
 * Behaviour notes
 *  - The KEYBOARD WINS over the stick while any key is held, so a stuck stick
 *    can never lock you out.
 *  - Diagonals are NORMALISED. Without this, holding W+D would drive 41%
 *    faster than holding W, which is both wrong and immediately noticeable.
 * ========================================================================== */

var SM = SM || {};

SM.input = (function () {
  'use strict';

  var C = SM.config;

  var keyLeft = false;
  var keyRight = false;
  var keyUp = false;
  var keyDown = false;
  var keyAxis = 0;          // smoothed -1..1, negative = left
  var keyAxisY = 0;         // smoothed -1..1, negative = towards the surface

  var stickX = 0, stickY = 0, stickOn = false;
  var moveVec = { x: 0, y: 0, mag: 0 };   // REUSED — never stash this object

  var firstGestureFired = false;
  var firstGesturePending = false;

  var boundCanvas = null;

  /* ------------------------------------------------------------------ */

  function noteGesture() {
    if (firstGestureFired) return;
    firstGestureFired = true;
    firstGesturePending = true;
    SM.events.emit('input:firstgesture', null);
  }

  /** Returns true exactly once — the first time it is polled after a gesture. */
  function consumeFirstGesture() {
    if (firstGesturePending) { firstGesturePending = false; return true; }
    return false;
  }

  /* --- keyboard ------------------------------------------------------ */

  function onKeyDown(e) {
    var k = e.key;
    if (k === 'a' || k === 'A' || k === 'ArrowLeft') { keyLeft = true; noteGesture(); e.preventDefault(); }
    else if (k === 'd' || k === 'D' || k === 'ArrowRight') { keyRight = true; noteGesture(); e.preventDefault(); }
    else if (k === 'w' || k === 'W' || k === 'ArrowUp') { keyUp = true; noteGesture(); e.preventDefault(); }
    else if (k === 's' || k === 'S' || k === 'ArrowDown') { keyDown = true; noteGesture(); e.preventDefault(); }
    else if (k === 'r' || k === 'R') { noteGesture(); SM.events.emit('input:restart', null); }
    else if (k === 'm' || k === 'M') { noteGesture(); SM.events.emit('input:mutetoggle', null); }
  }

  function onKeyUp(e) {
    var k = e.key;
    if (k === 'a' || k === 'A' || k === 'ArrowLeft') keyLeft = false;
    else if (k === 'd' || k === 'D' || k === 'ArrowRight') keyRight = false;
    else if (k === 'w' || k === 'W' || k === 'ArrowUp') keyUp = false;
    else if (k === 's' || k === 'S' || k === 'ArrowDown') keyDown = false;
  }

  function onBlur() { reset(); }

  /* --- pointer -------------------------------------------------------
   * Gesture capture only. Anything landing on the DOM UI above the canvas is
   * somebody else's event — the buttons and the thumbstick call noteGesture()
   * themselves — so this bails unless the canvas itself was hit.
   * ------------------------------------------------------------------ */
  function onPointerDown(e) {
    if (e.target && e.target !== boundCanvas) return;
    noteGesture();
    e.preventDefault();
  }

  /* ------------------------------------------------------------------ */

  function init(canvas) {
    boundCanvas = canvas;

    window.addEventListener('keydown', onKeyDown, { passive: false });
    window.addEventListener('keyup', onKeyUp, false);
    window.addEventListener('blur', onBlur, false);

    canvas.addEventListener('pointerdown', onPointerDown, { passive: false });

    // Stop iOS/Android from scrolling or pinch-zooming the page while playing.
    canvas.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });
    canvas.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); }, false);
  }

  /** Smooth the digital keyboard axes so driving has weight. */
  function update(dt) {
    var k = 1 - Math.exp(-C.INPUT_KEY_RAMP * dt);

    var target = (keyRight ? 1 : 0) - (keyLeft ? 1 : 0);
    keyAxis += (target - keyAxis) * k;
    if (Math.abs(keyAxis) < 0.001) keyAxis = 0;

    var targetY = (keyDown ? 1 : 0) - (keyUp ? 1 : 0);
    keyAxisY += (targetY - keyAxisY) * k;
    if (Math.abs(keyAxisY) < 0.001) keyAxisY = 0;
  }

  /* =====================================================================
   * THE MOVEMENT VECTOR
   * ================================================================== */

  /** Push the translucent thumbstick. x,y in -1..1; magnitude is clamped. */
  function setStick(x, y) {
    if (!(x === x)) x = 0;                 // NaN guard: a pointer event can
    if (!(y === y)) y = 0;                 // produce one on a torn-off touch
    var m = Math.sqrt(x * x + y * y);
    if (m > 1) { x /= m; y /= m; }
    stickX = x; stickY = y;
    stickOn = true;
  }

  function clearStick() { stickX = 0; stickY = 0; stickOn = false; }
  function isStickActive() { return stickOn; }

  /** REUSED {x, y, mag}. Read what you need inside the frame; never stash it. */
  function getMove() {
    var x, y;
    if (keyLeft || keyRight || keyUp || keyDown) { x = keyAxis; y = keyAxisY; }
    else if (stickOn) { x = stickX; y = stickY; }
    else { x = keyAxis; y = keyAxisY; }   // decaying residual

    var m = Math.sqrt(x * x + y * y);
    if (m > 1) { x /= m; y /= m; m = 1; }
    moveVec.x = x; moveVec.y = y; moveVec.mag = m;
    return moveVec;
  }

  function getMoveX() { return getMove().x; }
  function getMoveY() { return getMove().y; }
  function getMoveMag() { return getMove().mag; }

  function reset() {
    keyLeft = keyRight = false;
    keyUp = keyDown = false;
    keyAxis = 0;
    keyAxisY = 0;
    clearStick();
  }

  return {
    init: init,
    update: update,
    consumeFirstGesture: consumeFirstGesture,
    noteGesture: noteGesture,
    reset: reset,

    setStick: setStick,
    clearStick: clearStick,
    isStickActive: isStickActive,
    getMove: getMove,
    getMoveX: getMoveX,
    getMoveY: getMoveY,
    getMoveMag: getMoveMag
  };
})();
