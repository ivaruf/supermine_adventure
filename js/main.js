/* =============================================================================
 * SUPERMINE ADVENTURE — js/main.js
 * -----------------------------------------------------------------------------
 * Bootstrap, canvas management and the fixed-timestep game loop.
 *
 * This file used to run TWO games. Every step and every render carried an
 * `if (adventure)` fork, because a time-attack director and an expedition
 * director cannot both own the frame. There is one game now, so the forks are
 * gone and the order below is simply the order.
 *
 * UPDATE ORDER (one fixed step)
 *   input -> adv -> advterrain -> vehicle -> particles
 *         -> camera -> effects -> sound -> ui -> advhud
 *
 * RENDER ORDER
 *   [world transform]  advterrain background -> particles -> vehicle
 *                      -> effects -> adv.renderWorld
 *   [screen space]     vignette          (DOM UI floats above the canvas)
 *
 * Why this order matters
 *   - advterrain streams new rock in before the vehicle cuts, so the drill
 *     never runs off the end of the generated world;
 *   - the vehicle cuts BEFORE particles integrate, so debris spawned this step
 *     moves on the same step it was created (no one-frame stall on impact);
 *   - camera updates after the vehicle so it follows the final position;
 *   - effects and sound run last: they only ever react to what already happened;
 *   - adv.renderWorld is LAST inside the world transform because that is where
 *     the darkness/headlight composite lives. It has to fall on the terrain,
 *     the machine AND the effects, so it cannot draw before any of them.
 *
 * THE SIMULATION IS GATED IN THREE PLACES, all of them the same one line: the
 * accumulator is ZEROED rather than the step loop skipped. A paused minute
 * banks nothing, so the first frame after a resume steps exactly once like any
 * other frame instead of paying out sixty seconds of backlog and teleporting
 * the rig across the map. The three holders are the title gate (`started`),
 * the pause menu (`paused`), and every adventure meta screen
 * (`SM.adv.holdsSim()` — the slot picker, the world map, the workshop, the
 * prep screen, the results card, and the title screen the campaign is closed
 * back to). The world keeps RENDERING behind all three.
 * ========================================================================== */

var SM = SM || {};

SM.main = (function () {
  'use strict';

  var C = SM.config;

  var canvas = null;
  var ctx = null;
  var dpr = 1;
  var cssW = 1, cssH = 1;

  var running = false;
  var started = false;   // simulation is held until the player's first gesture
  var paused = false;    // ...and again whenever the pause menu is up
  var lastTime = 0;
  var accumulator = 0;

  var evPaused = { paused: false };   // reused payload, like every hot emitter

  var fps = 0;
  var fpsFrames = 0;
  var fpsTimer = 0;
  var stepMs = 0;

  var vignette = null;

  /* =====================================================================
   * CANVAS
   * ================================================================== */
  function resize() {
    // Cap DPR at 2: beyond that the fill-rate cost is not worth the pixels.
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssW = Math.max(1, window.innerWidth);
    cssH = Math.max(1, window.innerHeight);

    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';

    SM.camera.setViewport(cssW, cssH);
    buildVignette();
  }

  function buildVignette() {
    var g = ctx.createRadialGradient(
      cssW * 0.5, cssH * 0.5, Math.min(cssW, cssH) * 0.35,
      cssW * 0.5, cssH * 0.5, Math.max(cssW, cssH) * 0.78
    );
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.40)');
    vignette = g;
  }

  /* =====================================================================
   * SIMULATION STEP
   * ================================================================== */
  function step(dt) {
    SM.input.update(dt);
    SM.adv.update(dt);          // the run director: fuel, cargo, heat, state
    SM.advterrain.update(dt);   // stream rock in ahead / recycle behind
    SM.vehicle.update(dt);      // drive, drill, push state into particles
    SM.particles.update(dt);    // integrate, rebuild hash, relax, sleep
    SM.camera.update(dt);
    SM.effects.update(dt);
    SM.sound.update(dt);
    SM.ui.update(dt);
    SM.advhud.update(dt);
  }

  /* =====================================================================
   * RENDER
   * ================================================================== */
  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0a0d';
    ctx.fillRect(0, 0, cssW, cssH);

    ctx.save();
    SM.camera.applyTransform(ctx);

    SM.advterrain.render(ctx);
    SM.particles.render(ctx);
    SM.vehicle.render(ctx);
    SM.effects.render(ctx);
    SM.adv.renderWorld(ctx);

    ctx.restore();

    // screen-space overlay
    if (vignette) {
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, cssW, cssH);
    }
  }

  /* =====================================================================
   * LOOP
   * ================================================================== */
  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);

    var dt = (now - lastTime) / 1000;
    lastTime = now;
    if (!(dt > 0)) dt = 0;
    if (dt > C.MAX_FRAME_DT) dt = C.MAX_FRAME_DT;

    accumulator += dt;
    // The three sim gates. See the header: ZEROING, never skipping.
    if (!started || paused || SM.adv.holdsSim()) accumulator = 0;

    var t0 = performance.now();
    var steps = 0;
    var fixed = C.FIXED_DT;
    while (accumulator >= fixed && steps < C.MAX_STEPS_PER_FRAME) {
      step(fixed);
      accumulator -= fixed;
      steps++;
    }
    // If we hit the cap we are behind: throw the backlog away rather than
    // trying to catch up (which would only make the next frame slower).
    if (steps >= C.MAX_STEPS_PER_FRAME) accumulator = 0;
    stepMs = stepMs * 0.9 + (performance.now() - t0) * 0.1;

    render();

    fpsFrames++;
    fpsTimer += dt;
    if (fpsTimer >= 0.5) {
      fps = Math.round(fpsFrames / fpsTimer);
      fpsFrames = 0;
      fpsTimer = 0;
    }
  }

  /* =====================================================================
   * RUN CONTROL
   * ================================================================== */
  /**
   * Gate the simulation. RENDERING CARRIES ON regardless, so the mine is still
   * there under the menu — held on the exact frame you paused it, rather than
   * blanked out or left to a stale backbuffer.
   *
   * Pausing is REFUSED behind the title gate, which has nothing to pause
   * because no time is passing there anyway. Un-pausing is never refused, so
   * nothing can strand the game.
   *
   * Fires `game:paused` ON CHANGE ONLY — a button that re-asserts the state it
   * is already in must not make the menu flicker. Returns the RESULTING state,
   * so a caller can tell an accepted pause from a refused one on the spot
   * instead of asking again. js/advhud.js is the caller that relies on this.
   */
  function setPaused(p) {
    p = !!p;
    if (p && !started) return paused;
    if (p === paused) return paused;
    paused = p;
    evPaused.paused = paused;
    SM.events.emit('game:paused', evPaused);
    return paused;
  }

  function restart() {
    // ADVENTURE OWNS ITS OWN RESTART while a company is live: re-descending
    // means rebuilding the mine from its saved seed and carve mask with the
    // loadout the player paid for, none of which this function knows about.
    if (SM.adv.isActive() && SM.adv.restart) { SM.adv.restart(); return; }

    // Otherwise this is the campaign being closed back to the title screen.
    // Clear the pause FIRST, so nothing can come back up already frozen, then
    // empty the world: what sits behind the title is black, not the mine the
    // player just walked out of.
    setPaused(false);

    SM.vehicle.reset();
    SM.camera.reset();
    SM.particles.reset();
    SM.advterrain.reset();
    SM.effects.reset();
    SM.sound.reset();
    SM.input.reset();
    accumulator = 0;
    SM.events.emit('run:reset', null);
  }

  function init() {
    canvas = document.getElementById('game');
    if (!canvas) throw new Error('SUPERMINE: #game canvas not found');
    ctx = canvas.getContext('2d', { alpha: false });

    SM.input.init(canvas);
    SM.particles.init();
    SM.camera.init();
    // THE DATA LAYER, before anything can ask it a question. Pure data and
    // localStorage: no canvas, no camera, no particles. Ordered
    // mines -> rig -> save because save.js validates a loaded slot against the
    // catalogues (an unknown mine id or part key must not boot a company into
    // an inconsistent state).
    SM.mines.init();
    SM.rig.init();
    SM.save.init();
    // Viewport BEFORE the world: advterrain sizes its streaming window from
    // the camera's visible bounds, which are meaningless until the canvas is
    // sized.
    resize();
    SM.vehicle.init();
    SM.effects.init();
    SM.sound.init();
    // ui.js WIPES #ui-root, so it must run before every module that appends to
    // it (joystick, advhud, advui).
    SM.ui.init();

    SM.advterrain.init();
    SM.scanner.init();
    SM.joystick.init();
    SM.advhud.init();
    SM.advui.init();
    // adv.js LAST: it is the state machine, and opening a state must be able to
    // reach a fully-built terrain streamer, scanner, HUD, joystick and screen
    // stack.
    SM.adv.init();

    window.addEventListener('resize', resize, false);
    window.addEventListener('orientationchange', resize, false);
    SM.events.on('input:restart', restart);
    SM.events.on('input:firstgesture', function () { started = true; });

    running = true;
    lastTime = performance.now();
    requestAnimationFrame(frame);
  }

  return {
    init: init,
    restart: restart,
    setPaused: setPaused,
    isPaused: function () { return paused; },
    getFps: function () { return fps; },
    getStepMs: function () { return stepMs; },
    getCanvas: function () { return canvas; },
    getContext: function () { return ctx; },
    getViewportWidth: function () { return cssW; },
    getViewportHeight: function () { return cssH; },
    isRunning: function () { return running; }
  };
})();

/* --- boot ------------------------------------------------------------- */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { SM.main.init(); });
} else {
  SM.main.init();
}
