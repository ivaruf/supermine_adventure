/* =============================================================================
 * SUPERMINE ADVENTURE — js/effects.js
 * -----------------------------------------------------------------------------
 * The spectacle layer. A pooled, capped, allocation-free visual particle system
 * that is completely separate from SM.particles: nothing in here touches the
 * simulation, so it can be budgeted away without changing gameplay.
 *
 * WHAT IT DRAWS
 *   dust puffs          material-tinted soft blobs on destruction
 *   debris chips        little tumbling material-coloured chunks
 *   sparks              directional streaks from grinding contact
 *   rings / shockwaves  expanding circles (heavy impact, pulse, upgrade)
 *   flashes             additive blobs at collection / rare breaks
 *   glints              8-point metal star, sells "chrome" moments
 *   streaks             collection trails
 *   smoke               exhaust plume behind the machine
 *   text popups         floating "+value", ONE COMBO PER MATERIAL, in that
 *                       material's own colour (see the combo buckets below)
 *   overlays            screen flash (world-space rect)
 *   the headlight       the darkness composite; see the section at the bottom
 *
 * PERFORMANCE CONTRACT — do not weaken any of this
 *   * material:destroyed fires up to ~150x per simulation step. Every handler
 *     here is O(1), allocates nothing, and spends from FX_BUDGET_PER_STEP.
 *     Overflow is silently dropped — that is the whole point of the budget.
 *   * Event payload objects are REUSED by the engine. Fields are read
 *     immediately; nothing is ever stashed.
 *   * Rapid pickups are ACCUMULATED into combo popups instead of spawning one
 *     popup per pickup — per MATERIAL, so each seam reports itself in its own
 *     colour, with all spoil merged into one bucket.
 *   * All shake lives in camera.js. effects.js never calls camera.shake().
 *
 * Public API (contract — do not change these signatures)
 *   SM.effects.init() / reset() / update(dt) / render(ctx)
 *   SM.effects.dust(x,y,matIndex,count,speed)
 *   SM.effects.sparks(x,y,matIndex,count,speed)
 *   SM.effects.ring(x,y,radius,life,r,g,b)
 *   SM.effects.flash(x,y,size,matIndex)
 *   SM.effects.getCount()
 * Additions (safe to call from anywhere)
 *   SM.effects.chips / smoke / glint / streak / shock / popup / burst
 *   SM.effects.refuse(x,y,matIndex,normX,normY,big)   the bit BOUNCING OFF
 *   SM.effects.screenFlash(strength,r,g,b)
 *   SM.effects.renderDarkness(ctx)   -- called ONLY from SM.adv.renderWorld()
 * ========================================================================== */

var SM = SM || {};

SM.effects = (function () {
  'use strict';

  /* =====================================================================
   * Tunables
   * ================================================================== */
  var DUST_DRAG        = 3.4;
  var SPARK_DRAG       = 5.6;
  var CHIP_DRAG        = 2.3;
  var SMOKE_DRAG       = 1.15;
  var STREAK_DRAG      = 4.0;

  // How wide the refusal cone opens, in radians either side of the reflected
  // normal. Tight enough to read as "thrown straight back" and not as the
  // radial fountain that cutting makes — see refuse().
  var REFUSE_SPREAD    = 0.62;

  var RING_LIFE        = 0.42;

  var PUFF_TEX         = 48;    // px, soft blob texture
  var SMOKE_TEX        = 56;
  var STAR_TEX         = 72;
  var CHIP_TEX         = 18;
  var CHIP_FRAMES      = 8;     // baked rotations (never call ctx.rotate)

  // How many destroy events in one step still get the "rich" treatment. Past
  // this we fall back to a cheap stochastic trickle so a 150-break step does
  // not simply burn the whole budget on the first 90 chips.
  var RICH_DESTROYS_PER_STEP = 20;

  // Rings and glints are the two BIG additive draws (a full arc stroke and a
  // large star sprite). The generic per-step FX budget is not enough on its
  // own: a pocket of rare deposits breaking together stacked 20 shockwaves on
  // the machine and turned the lane into white soup. These are TIME gates, not
  // per-step budgets, so the on-screen density stays constant no matter how
  // hard the events are pouring in. Showpieces pass forced=true to bypass.
  var RING_MIN_GAP     = 0.085;   // ~12 rings/s -> ~4 alive at once
  var GLINT_MIN_GAP    = 0.11;    // ~9 glints/s -> ~2 alive at once

  var COMBO_WINDOW     = 0.24;  // s of pickups merged into one popup
  var COMBO_MAX_HOLD   = 0.85;  // ...but never hold longer than this
  var POPUP_LIFE       = 1.00;
  var POPUP_RISE       = 66;    // world units/s the popup floats forward
  var POPUP_CLEARANCE  = 46;    // world units clear of the rig's flank

  /* Popup size scales with the VALUE of the haul, on a log curve.
   * The dynamic range here is enormous — a mouthful of dirt is worth ~4 and a
   * ploughed emerald seam is worth ~30 000 — so a linear map would either
   * flatten everything at the top or make the small ones invisible. One decade
   * of value buys POPUP_FONT_PER_DECADE world units of type, which keeps the
   * whole range legible and still makes a big seam land like a big seam. */
  var POPUP_VALUE_REF      = 40;   // value that renders at exactly POPUP_FONT
  var POPUP_FONT           = 20;
  var POPUP_FONT_PER_DECADE = 8;
  var POPUP_FONT_MIN       = 14;
  var POPUP_FONT_MAX       = 52;

  var COLLECT_POP_CHANCE = 0.34;
  var COLLECT_STREAK_CHANCE = 0.20;

  var EXHAUST_RATE     = 15;    // puffs/s at full speed
  var GRIND_SPARK_RATE = 52;    // sparks/s at full cutter resistance

  var SCREEN_FLASH_MAX = 0.52;

  /* =====================================================================
   * Storage
   * ================================================================== */
  var C = SM.config;
  var TAU = Math.PI * 2;

  var DUST = 0, SPARK = 1, RING = 2, FLASH = 3,
      CHIP = 4, TEXT = 5, STREAK = 6, SMOKE = 7, GLINT = 8;

  var CAP = C.FX_CAPACITY;

  var fx    = new Float32Array(CAP);
  var fy    = new Float32Array(CAP);
  var fvx   = new Float32Array(CAP);
  var fvy   = new Float32Array(CAP);
  var fLife = new Float32Array(CAP);
  var fMax  = new Float32Array(CAP);
  var fSize = new Float32Array(CAP);
  var fRot  = new Float32Array(CAP);
  var fRotV = new Float32Array(CAP);
  var fA    = new Float32Array(CAP);   // per-type spare (thickness / grow / scale)
  var fR    = new Uint8Array(CAP);
  var fG    = new Uint8Array(CAP);
  var fB    = new Uint8Array(CAP);
  var fType = new Uint8Array(CAP);
  var fMat  = new Uint8Array(CAP);
  var fText = new Array(CAP);          // only ever touched for TEXT slots

  var freeStack = new Int32Array(CAP);
  var freeCount = 0;
  var actList   = new Int32Array(CAP);
  var actSlot   = new Int32Array(CAP);
  var actCount  = 0;

  var budget = 0;
  var ringCd = 0;
  var glintCd = 0;
  var destroysThisStep = 0;
  var comboSide = 1;

  /* --- baked textures ------------------------------------------------- */
  var puffs = [];        // [matIndex] -> tinted soft blob
  var chipTex = [];      // [matIndex] -> CHIP_FRAMES-wide rotation strip
  var whitePuff = null;
  var smokeTex = null;
  var starTex = null;

  /* --- flattened material lookups (no property access on the hot path) - */
  var matR = null, matG = null, matB = null;       // highlight colour
  var matBR = null, matBG = null, matBB = null;    // base colour
  var matValue = null, matSparkle = null, matGlow = null;
  var matBucket = null;                       // matIndex -> combo bucket, -1 = none
  var popR = null, popG = null, popB = null;  // legible popup ink per material
  var matCount = 0;

  /* --- ambient / state ------------------------------------------------ */
  var clock = 0;
  var exhaustAcc = 0;
  var grindAcc = 0;

  /* --- per-material collection combos ---------------------------------
   * ONE BUCKET PER MATERIAL, plus a shared bucket for spoil.
   *
   * Every ore accumulates independently and pops in its OWN colour the moment
   * that particular stream dries up — drive through an emerald seam and the
   * green number lands when the emeralds stop arriving, regardless of the dirt
   * still flowing in around it.
   *
   * Dirt, stone, rubble and granite share the LAST bucket. They are collected
   * continuously and would otherwise emit a permanent drip of small brown and
   * grey numbers, drowning the ore payoffs the player actually wants to read.
   * Merging them mirrors the SPOIL row on the extraction card.
   * ------------------------------------------------------------------ */
  var SPOIL_BUCKET = 0;         // set to matCount in buildTextures()
  var cbValue = null;           // Float64Array(matCount + 1)
  var cbCount = null;           // Uint32Array
  var cbTimer = null;           // Float32Array
  var cbHold = null;            // Float32Array
  var cbOpen = 0;               // buckets currently accumulating
  var comboX = 0, comboY = 0;

  var flashAmt = 0;           // screen flash 0..1
  var flashR = 255, flashG = 255, flashB = 255;

  var subscribed = false;

  var fontCache = [];         // [px] -> "900 NNpx ..." string

  /* =====================================================================
   * POOL — O(1) alloc / release via swap-remove
   * ================================================================== */
  function alloc() {
    if (freeCount === 0 || budget <= 0) return -1;
    budget--;
    var i = freeStack[--freeCount];
    actSlot[i] = actCount;
    actList[actCount++] = i;
    return i;
  }

  /** Allocate ignoring the per-step budget. Reserved for once-in-a-while
   *  showpieces (upgrade flourish, pulse, level complete). */
  function allocForced() {
    if (freeCount === 0) return -1;
    var i = freeStack[--freeCount];
    actSlot[i] = actCount;
    actList[actCount++] = i;
    return i;
  }

  function release(i) {
    var s = actSlot[i];
    var last = actList[--actCount];
    actList[s] = last;
    actSlot[last] = s;
    if (fType[i] === TEXT) fText[i] = null;
    freeStack[freeCount++] = i;
  }

  /* =====================================================================
   * TEXTURE BAKING (once, in init)
   * ================================================================== */
  function makePuff(r, g, b, size, softness) {
    var cv = document.createElement('canvas');
    cv.width = cv.height = size;
    var c = cv.getContext('2d');
    var h = size * 0.5;
    var grd = c.createRadialGradient(h, h, 0, h, h, h);
    grd.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',' + (0.9 * softness) + ')');
    grd.addColorStop(0.42, 'rgba(' + r + ',' + g + ',' + b + ',' + (0.36 * softness) + ')');
    grd.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0)');
    c.fillStyle = grd;
    c.fillRect(0, 0, size, size);
    return cv;
  }

  /** Eight-point additive star — the "metal glint" / rare-break sparkle. */
  function makeStar() {
    var cv = document.createElement('canvas');
    cv.width = cv.height = STAR_TEX;
    var c = cv.getContext('2d');
    var h = STAR_TEX * 0.5;

    // soft core
    var core = c.createRadialGradient(h, h, 0, h, h, h * 0.36);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = core;
    c.fillRect(0, 0, STAR_TEX, STAR_TEX);

    // four spikes: two axis-aligned long, two diagonal short
    c.translate(h, h);
    for (var k = 0; k < 4; k++) {
      var len = (k % 2 === 0) ? h * 0.98 : h * 0.52;
      var wide = (k % 2 === 0) ? h * 0.075 : h * 0.045;
      c.save();
      c.rotate(k * Math.PI / 4);
      var g = c.createLinearGradient(-len, 0, len, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.95)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(-len, 0);
      c.lineTo(0, -wide);
      c.lineTo(len, 0);
      c.lineTo(0, wide);
      c.closePath();
      c.fill();
      c.restore();
    }
    return cv;
  }

  /** Rotation strip of angular chunks in one material's colours. */
  function makeChipStrip(base, shadow, hi) {
    var cv = document.createElement('canvas');
    cv.width = CHIP_TEX * CHIP_FRAMES;
    cv.height = CHIP_TEX;
    var c = cv.getContext('2d');
    var h = CHIP_TEX * 0.5;
    // One fixed silhouette rotated through the strip so a tumbling chip reads
    // as a solid object rather than a shimmering blob.
    var pts = 5;
    var rad = [];
    for (var p = 0; p < pts; p++) rad.push(h * (0.58 + Math.random() * 0.36));

    for (var f = 0; f < CHIP_FRAMES; f++) {
      c.save();
      c.translate(f * CHIP_TEX + h, h);
      c.rotate(f * TAU / CHIP_FRAMES);
      c.beginPath();
      for (var q = 0; q < pts; q++) {
        var a = q * TAU / pts;
        var rr = rad[q];
        var px = Math.cos(a) * rr, py = Math.sin(a) * rr;
        if (q === 0) c.moveTo(px, py); else c.lineTo(px, py);
      }
      c.closePath();
      c.fillStyle = base;
      c.fill();
      // top-left lit edge
      c.strokeStyle = hi;
      c.lineWidth = 1.4;
      c.stroke();
      // bottom-right shadow wedge
      c.globalAlpha = 0.55;
      c.fillStyle = shadow;
      c.beginPath();
      c.moveTo(0, 0);
      for (var q2 = 1; q2 <= 2; q2++) {
        var a2 = (q2 % pts) * TAU / pts;
        c.lineTo(Math.cos(a2) * rad[q2 % pts], Math.sin(a2) * rad[q2 % pts]);
      }
      c.closePath();
      c.fill();
      c.restore();
    }
    return cv;
  }

  function hexToRgb(css, out) {
    var r = 200, g = 200, b = 200;
    if (typeof css === 'string' && css.charAt(0) === '#') {
      var h = css.slice(1);
      if (h.length === 3) {
        r = parseInt(h[0] + h[0], 16); g = parseInt(h[1] + h[1], 16); b = parseInt(h[2] + h[2], 16);
      } else if (h.length >= 6) {
        r = parseInt(h.substr(0, 2), 16); g = parseInt(h.substr(2, 2), 16); b = parseInt(h.substr(4, 2), 16);
      }
    }
    out[0] = r; out[1] = g; out[2] = b;
    return out;
  }

  var tmpRgb = [0, 0, 0];

  function buildTextures() {
    var list = SM.materials.list;
    matCount = list.length;
    puffs.length = 0;
    chipTex.length = 0;

    matR = new Uint8Array(matCount); matG = new Uint8Array(matCount); matB = new Uint8Array(matCount);
    matBR = new Uint8Array(matCount); matBG = new Uint8Array(matCount); matBB = new Uint8Array(matCount);
    matValue = new Float32Array(matCount);
    matSparkle = new Float32Array(matCount);
    matGlow = new Uint8Array(matCount);
    matBucket = new Int32Array(matCount);
    popR = new Uint8Array(matCount); popG = new Uint8Array(matCount); popB = new Uint8Array(matCount);

    // One bucket per material, plus the shared spoil bucket on the end.
    SPOIL_BUCKET = matCount;
    cbValue = new Float64Array(matCount + 1);
    cbCount = new Uint32Array(matCount + 1);
    cbTimer = new Float32Array(matCount + 1);
    cbHold = new Float32Array(matCount + 1);
    cbOpen = 0;

    for (var i = 0; i < matCount; i++) {
      var m = list[i];
      hexToRgb(m.colors[2] || m.colors[0], tmpRgb);
      matR[i] = tmpRgb[0]; matG[i] = tmpRgb[1]; matB[i] = tmpRgb[2];
      hexToRgb(m.colors[0], tmpRgb);
      matBR[i] = tmpRgb[0]; matBG[i] = tmpRgb[1]; matBB[i] = tmpRgb[2];
      matValue[i] = m.value || 0;
      matSparkle[i] = m.sparkle || 0;
      matGlow[i] = m.glow ? 1 : 0;

      // -1 = never popped (power-ups). Ores pop in their own colour; anything
      // else is spoil and shares one bucket.
      matBucket[i] = m.pickup ? -1 : (m.ore ? i : matCount);

      /* Popup ink. The base colour IDENTIFIES the material but is often too
       * dark to read as type over rubble (dirt is #7c5a3a), and the highlight
       * ramp is too washed out to identify anything. So: take the base hue and
       * push its brightest channel to full. Emerald stays unmistakably emerald,
       * dirt becomes a legible warm tan, and every popup clears the background
       * at the same perceived weight. */
      var mx = matBR[i] > matBG[i] ? matBR[i] : matBG[i];
      if (matBB[i] > mx) mx = matBB[i];
      var gain = mx > 0 ? 255 / mx : 1;
      popR[i] = Math.min(255, (matBR[i] * gain) | 0);
      popG[i] = Math.min(255, (matBG[i] * gain) | 0);
      popB[i] = Math.min(255, (matBB[i] * gain) | 0);

      // Dust is a desaturated, lifted version of the base rock colour.
      var dr = Math.min(255, (matBR[i] * 0.55 + 90) | 0);
      var dg = Math.min(255, (matBG[i] * 0.55 + 84) | 0);
      var db = Math.min(255, (matBB[i] * 0.55 + 78) | 0);
      puffs.push(makePuff(dr, dg, db, PUFF_TEX, 1));
      chipTex.push(makeChipStrip(m.colors[0], m.colors[1] || m.colors[0], m.colors[2] || m.colors[0]));
    }

    whitePuff = makePuff(255, 250, 235, PUFF_TEX, 1);
    smokeTex = makePuff(72, 74, 82, SMOKE_TEX, 0.8);
    starTex = makeStar();
  }

  /* =====================================================================
   * SPAWNERS
   * ================================================================== */
  function dust(x, y, mat, count, speed) {
    for (var k = 0; k < count; k++) {
      var i = alloc();
      if (i < 0) return;
      var a = Math.random() * TAU;
      var s = speed * (0.3 + Math.random() * 0.7);
      fx[i] = x; fy[i] = y;
      fvx[i] = Math.cos(a) * s;
      fvy[i] = Math.sin(a) * s;
      fMax[i] = C.FX_DUST_LIFE * (0.7 + Math.random() * 0.7);
      fLife[i] = fMax[i];
      fSize[i] = 9 + Math.random() * 15;
      fRot[i] = Math.random() * TAU;
      fRotV[i] = (Math.random() - 0.5) * 2;
      fA[i] = 24 + Math.random() * 16;     // bloom rate
      fType[i] = DUST;
      fMat[i] = mat;
    }
  }

  /** Directional sparks. dirX/dirY optional: omit for a full radial burst. */
  function sparksDir(x, y, mat, count, speed, dirX, dirY, spread) {
    var r = matR[mat] !== undefined ? matR[mat] : 255;
    var g = matG[mat] !== undefined ? matG[mat] : 220;
    var b = matB[mat] !== undefined ? matB[mat] : 160;
    var baseA = (dirX === undefined) ? 0 : Math.atan2(dirY, dirX);
    var sp = (dirX === undefined) ? Math.PI : (spread === undefined ? 0.9 : spread);
    for (var k = 0; k < count; k++) {
      var i = alloc();
      if (i < 0) return;
      var a = baseA + (Math.random() * 2 - 1) * sp;
      var s = speed * (0.45 + Math.random() * 0.9);
      fx[i] = x; fy[i] = y;
      fvx[i] = Math.cos(a) * s;
      fvy[i] = Math.sin(a) * s;
      fMax[i] = C.FX_SPARK_LIFE * (0.55 + Math.random() * 0.9);
      fLife[i] = fMax[i];
      fSize[i] = 3 + Math.random() * 5;
      fType[i] = SPARK;
      fMat[i] = mat;
      // Sparks run hot: lift toward white at the head of their life.
      fR[i] = r < 235 ? (r + 20) : 255;
      fG[i] = g < 235 ? (g + 20) : 255;
      fB[i] = b;
    }
  }

  function sparks(x, y, mat, count, speed) {
    sparksDir(x, y, mat, count, speed, undefined, undefined, undefined);
  }

  /**
   * A REFUSAL — the bit meeting rock it cannot cut. This is deliberately NOT
   * `sparks()`, because the difference between the two is the whole point of
   * the hardness cap:
   *
   *   CUTTING throws material outward in every direction. It is a fountain, and
   *   the debris is going somewhere because the deposit is coming apart.
   *   REFUSING throws everything BACK. Nothing is coming off the face, so the
   *   sparks are the bit's own — a tight cone along the reflected normal, fast,
   *   short-lived, with the chips tumbling back at the machine rather than away
   *   from it. Read side by side, one says "progress" and the other says "no".
   *
   * (normX, normY) is the direction the sparks are thrown in — vehicle.js
   * passes the REVERSE of its facing, i.e. straight back off the wall.
   * `big` is the contact moment (the first frame of a refusal episode) as
   * against the grind bed that follows it; everything scales off that one flag
   * so a ten-second lean stays an order quieter than the moment it started.
   *
   * Costs from the ordinary FX budget like every other spawner, so a refusal in
   * the middle of a full-blast excavation is simply dropped rather than
   * competing with it.
   */
  function refuse(x, y, mat, normX, normY, big) {
    var n = big ? 9 : 4;
    var sp = big ? 340 : 190;
    sparksDir(x, y, mat, n, sp, normX, normY, REFUSE_SPREAD);
    // A couple of chips flung back down the shaft you came up: the only debris a
    // refused cut ever makes, and it is off the BIT, not off the rock.
    chips(x, y, mat, big ? 3 : 1, big ? 210 : 120, normX, normY);
    flash(x, y, big ? 26 : 13, mat);
    // The white bite mark. Forced on the contact frame only — this is the one
    // thing that has to land even when the screen is already busy, because it
    // is the frame the player is being told "no".
    if (big) glint(x, y, 30, 0.16, 255, 244, 214, true);
  }

  function chips(x, y, mat, count, speed, dirX, dirY) {
    var baseA = (dirX === undefined) ? 0 : Math.atan2(dirY, dirX);
    var sp = (dirX === undefined) ? Math.PI : 1.25;
    for (var k = 0; k < count; k++) {
      var i = alloc();
      if (i < 0) return;
      var a = baseA + (Math.random() * 2 - 1) * sp;
      var s = speed * (0.4 + Math.random() * 0.95);
      fx[i] = x; fy[i] = y;
      fvx[i] = Math.cos(a) * s;
      fvy[i] = Math.sin(a) * s;
      fMax[i] = 0.42 + Math.random() * 0.42;
      fLife[i] = fMax[i];
      fSize[i] = 2.6 + Math.random() * 3.4;
      fRot[i] = Math.random() * TAU;
      fRotV[i] = (Math.random() - 0.5) * 26;
      fType[i] = CHIP;
      fMat[i] = mat;
    }
  }

  // `forced` is an additive 8th argument: the documented 7-argument signature
  // is unchanged, and showpieces pass true so their rings are never eaten by
  // the throttle that keeps ordinary destruction readable.
  function ring(x, y, radius, life, r, g, b, forced) {
    if (!forced && ringCd > 0) return;
    var i = forced ? allocForced() : alloc();
    if (i < 0) return;
    if (!forced) ringCd = RING_MIN_GAP;
    fx[i] = x; fy[i] = y;
    fvx[i] = 0; fvy[i] = 0;
    fMax[i] = life || RING_LIFE;
    fLife[i] = fMax[i];
    fSize[i] = radius;
    fA[i] = 2.4;                 // growth factor
    fType[i] = RING;
    fMat[i] = 0;                 // 0 = thin ring
    fR[i] = r === undefined ? 255 : r;
    fG[i] = g === undefined ? 240 : g;
    fB[i] = b === undefined ? 200 : b;
  }

  /** Fat shockwave: thicker stroke, faster growth, inner glow. */
  function shock(x, y, radius, life, r, g, b, forced) {
    if (!forced && ringCd > 0) return;
    var i = forced ? allocForced() : alloc();
    if (i < 0) return;
    if (!forced) ringCd = RING_MIN_GAP;
    fx[i] = x; fy[i] = y;
    fvx[i] = 0; fvy[i] = 0;
    fMax[i] = life || 0.55;
    fLife[i] = fMax[i];
    fSize[i] = radius;
    fA[i] = 3.4;
    fType[i] = RING;
    fMat[i] = 1;                 // 1 = shockwave
    fR[i] = r === undefined ? 255 : r;
    fG[i] = g === undefined ? 240 : g;
    fB[i] = b === undefined ? 200 : b;
  }

  function flash(x, y, size, mat) {
    var i = alloc();
    if (i < 0) return;
    fx[i] = x; fy[i] = y;
    fvx[i] = 0; fvy[i] = 0;
    fMax[i] = 0.18;
    fLife[i] = fMax[i];
    fSize[i] = size;
    fType[i] = FLASH;
    fMat[i] = mat === undefined ? 0 : mat;
  }

  function glint(x, y, size, life, r, g, b, forced) {
    if (!forced && glintCd > 0) return;
    var i = forced ? allocForced() : alloc();
    if (i < 0) return;
    if (!forced) glintCd = GLINT_MIN_GAP;
    fx[i] = x; fy[i] = y;
    fvx[i] = 0; fvy[i] = 0;
    fMax[i] = life || 0.30;
    fLife[i] = fMax[i];
    fSize[i] = size;
    fType[i] = GLINT;
    fR[i] = r === undefined ? 255 : r;
    fG[i] = g === undefined ? 250 : g;
    fB[i] = b === undefined ? 235 : b;
  }

  function smoke(x, y, vx, vy, size) {
    var i = alloc();
    if (i < 0) return;
    fx[i] = x; fy[i] = y;
    fvx[i] = vx; fvy[i] = vy;
    fMax[i] = 0.75 + Math.random() * 0.55;
    fLife[i] = fMax[i];
    fSize[i] = size;
    fRot[i] = Math.random() * TAU;
    fRotV[i] = (Math.random() - 0.5) * 1.2;
    fA[i] = 30 + Math.random() * 22;
    fType[i] = SMOKE;
  }

  /** Additive trail line. Length/direction come from the velocity. */
  function streak(x, y, vx, vy, len, life, r, g, b) {
    var i = alloc();
    if (i < 0) return;
    fx[i] = x; fy[i] = y;
    fvx[i] = vx; fvy[i] = vy;
    fMax[i] = life;
    fLife[i] = life;
    fSize[i] = len;
    fType[i] = STREAK;
    fR[i] = r; fG[i] = g; fB[i] = b;
  }

  function fontFor(px) {
    var k = px | 0;
    if (k < 6) k = 6;
    if (k > 90) k = 90;
    var s = fontCache[k];
    if (!s) {
      s = '900 ' + k + 'px ui-sans-serif, system-ui, "Segoe UI", Roboto, Arial, sans-serif';
      fontCache[k] = s;
    }
    return s;
  }

  function popup(x, y, text, size, r, g, b) {
    var i = allocForced();     // popups are already merged; never drop them
    if (i < 0) return;
    fx[i] = x; fy[i] = y;
    fvx[i] = (Math.random() - 0.5) * 26;
    fvy[i] = -POPUP_RISE;
    fMax[i] = POPUP_LIFE;
    fLife[i] = POPUP_LIFE;
    fSize[i] = size;
    fA[i] = 0;                 // pop-in animation phase
    fType[i] = TEXT;
    fText[i] = text;
    fR[i] = r; fG[i] = g; fB[i] = b;
  }

  /**
   * Glowing burst + shockwave — rare/crystal destruction, pulses, fireworks.
   * Sizes are deliberately restrained: several of these can land in one step
   * and additive blobs stack multiplicatively. Big is what `forced` is for.
   */
  function burst(x, y, mat, power, forced) {
    var saved = budget;
    if (forced) budget = 999;
    var r = matR[mat] !== undefined ? matR[mat] : 255;
    var g = matG[mat] !== undefined ? matG[mat] : 235;
    var b = matB[mat] !== undefined ? matB[mat] : 190;
    flash(x, y, 9 + power * 13, mat);
    glint(x, y, 16 + power * 20, 0.20 + power * 0.12, r, g, b, forced);
    if (forced) shock(x, y, 14 + power * 22, 0.36 + power * 0.2, r, g, b, true);
    else ring(x, y, 12 + power * 18, 0.30 + power * 0.14, r, g, b);
    sparks(x, y, mat, (3 + power * 9) | 0, 250 + power * 320);
    chips(x, y, mat, (2 + power * 4) | 0, 170 + power * 180);
    if (forced) budget = saved;
  }

  function screenFlash(strength, r, g, b) {
    if (strength > flashAmt) {
      flashAmt = strength > SCREEN_FLASH_MAX ? SCREEN_FLASH_MAX : strength;
      flashR = r === undefined ? 255 : r;
      flashG = g === undefined ? 250 : g;
      flashB = b === undefined ? 240 : b;
    }
  }

  /* =====================================================================
   * EVENT HOOKS — every one of these is O(1) and allocation-free
   * ================================================================== */

  /** Up to ~150x per step. The budget plus the rich/cheap split is what keeps
   *  a full-blast excavation from costing anything. */
  function onDestroyed(p) {
    var m = p.matIndex;
    if (m >= matCount) m = 0;
    var val = matValue[m];
    destroysThisStep++;

    // Precious material always gets the full treatment — it is rare enough
    // that it can never dominate the budget.
    if (val >= 150) {
      burst(p.x, p.y, m, 0.7, false);
      screenFlash(0.05, matR[m], matG[m], matB[m]);
      return;
    }
    if (val >= 25) {                       // gold / gem / crystal tier
      flash(p.x, p.y, 13, m);
      sparksDir(p.x, p.y, m, 3, 300, 0, 1, 2.2);
      chips(p.x, p.y, m, 2, 200);
      dust(p.x, p.y, m, 1, 70);
      return;
    }

    var rich = destroysThisStep <= RICH_DESTROYS_PER_STEP;
    if (rich || Math.random() < 0.22) dust(p.x, p.y, m, 1, 62);
    if (rich ? Math.random() < 0.75 : Math.random() < 0.14) chips(p.x, p.y, m, 1, 165);
    if (matSparkle[m] > 0) {
      if (Math.random() < matSparkle[m] * 0.55) sparks(p.x, p.y, m, 2, 240);
    } else if (Math.random() < (rich ? 0.22 : 0.05)) {
      sparks(p.x, p.y, m, 1, 175);
    }
  }

  /** Grinding contact. Rate limited by particles.js to <=3/step. */
  function onHit(p) {
    var m = p.matIndex;
    if (m >= matCount) m = 0;
    // Sparks fly BACK past the machine (+y) and outward from the lane centre.
    var side = p.x < 0 ? -0.55 : 0.55;
    var n = 1 + ((p.intensity * 4) | 0);
    sparksDir(p.x, p.y, m, n, 240 + p.intensity * 260, side, 1, 0.85);
    if (p.intensity > 0.6 && Math.random() < 0.4) flash(p.x, p.y, 8, m);
  }

  /** Up to ~30x per step. Merge into a combo popup; never one popup each. */
  function onCollected(p) {
    var m = p.matIndex;
    if (m >= matCount) m = 0;

    /* THE FLOATING SCORE, AND WHOSE MONEY IT IS.
     *
     * NOT `p.value`. That is the value baked into the particle at spawn, and it
     * is the wrong number underground twice over: dirt, clay, stone and granite
     * popped a score this economy will not pay for — spoil goes out the back of
     * the hopper and is worth nothing — and the ore that DOES sell popped a
     * figure that disagreed with the price quoted in the hold and on the
     * extraction screen.
     *
     * So the RUN'S OWN economy is asked, and a material nobody buys is dropped
     * out of the combo entirely: no bucket, no number, no popup. The visual
     * feedback for spoil is the debris and the dust, which is exactly what
     * breaking worthless rock should look like.
     */
    var b = matBucket[m];
    var gain = (SM.adv.fragValue ? SM.adv.fragValue(m) : 0);
    if (!(gain > 0)) b = -1;            // spoil: it never earns, so it never pops
    if (b >= 0) {
      if (cbCount[b] === 0) { cbHold[b] = 0; cbOpen++; }
      cbValue[b] += gain;
      cbCount[b]++;
      cbTimer[b] = COMBO_WINDOW;
      comboX = p.x; comboY = p.y;
    }

    var sp = matSparkle[m];
    // The satisfying "pop" at the exact moment of capture.
    if (sp > 0 ? (Math.random() < COLLECT_POP_CHANCE * sp) : (Math.random() < 0.05)) {
      flash(p.x, p.y, 9 + sp * 5, m);
    }
    // Sparkle trail: a short additive streak pointing back the way it flew.
    if (Math.random() < COLLECT_STREAK_CHANCE * (0.4 + sp)) {
      var vx = SM.vehicle.getX(), vy = SM.vehicle.getY();
      var dx = p.x - vx, dy = p.y - vy;
      var d = Math.sqrt(dx * dx + dy * dy) || 1;
      streak(p.x, p.y, (dx / d) * 210, (dy / d) * 210, 22 + sp * 18, 0.20,
             matR[m], matG[m], matB[m]);
    }
    if (matGlow[m] && Math.random() < 0.10) glint(p.x, p.y, 20, 0.2, matR[m], matG[m], matB[m]);
  }

  /** Fires several times a second while ploughing. Keep it cheap and small. */
  function onHeavy(p) {
    ring(p.x, p.y, 24 + p.strength * 38, 0.32, 255, 226, 170);
    dust(p.x, p.y, 1, 2, 130);
    if (p.strength > 0.7) {
      chips(p.x, p.y, 1, 3, 260);
      screenFlash(0.045 * p.strength, 255, 236, 200);
    }
  }

  /* --- showpieces -----------------------------------------------------
   * The old showpiece handlers lived here: onUpgrade, onTransform, onPulse,
   * onGate, onOverdriveStart/End, onZone, onComplete. Every one of them
   * answered an event the time attack emitted — a gate crossed, a zone
   * entered, a run completed — and nothing emits any of them now. The
   * machinery they used (shock, glint, screenFlash, the temporary `budget`
   * raise that buys a one-off flourish) is all still here and still exported;
   * js/advhud.js and js/advui.js drive screenFlash directly for the campaign's
   * own big moments.
   * ------------------------------------------------------------------ */

  /* =====================================================================
   * AMBIENT EMITTERS (driven from update, not from events)
   * ================================================================== */
  function emitExhaust(dt) {
    if (!SM.vehicle || !SM.vehicle.getY) return;
    var speed = SM.vehicle.getSpeed ? SM.vehicle.getSpeed() : 0;
    var load = SM.vehicle.getResistance ? SM.vehicle.getResistance() : 0;
    var rate = EXHAUST_RATE * (0.35 + Math.min(1, speed / C.VEHICLE_SPEED) * 0.65)
             * (1 + Math.min(1, load * 0.004) * 0.9);
    exhaustAcc += rate * dt;
    while (exhaustAcc >= 1) {
      exhaustAcc -= 1;
      var vx = SM.vehicle.getX();
      var vy = SM.vehicle.getY();
      var side = Math.random() < 0.5 ? -1 : 1;
      var px = vx + side * (22 + Math.random() * 12);
      var py = vy + C.VEHICLE_BODY_LENGTH * 0.42 + Math.random() * 12;
      smoke(px, py,
            side * (10 + Math.random() * 26) - (SM.vehicle.getLateralSpeed ? SM.vehicle.getLateralSpeed() * 0.25 : 0),
            60 + Math.random() * 70,
            9 + Math.random() * 8);
    }
  }

  function emitGrind(dt) {
    if (!SM.vehicle || !SM.vehicle.getResistance) return;
    var load = Math.min(1, SM.vehicle.getResistance() * 0.0055);
    if (load <= 0.02) { grindAcc = 0; return; }
    grindAcc += GRIND_SPARK_RATE * load * dt;
    while (grindAcc >= 1) {
      grindAcc -= 1;
      var half = (SM.vehicle.getBladeWidth ? SM.vehicle.getBladeWidth() : 140) * 0.5;
      var px = SM.vehicle.getX() + (Math.random() * 2 - 1) * half;
      var py = SM.vehicle.getBladeFrontY ? SM.vehicle.getBladeFrontY() : SM.vehicle.getY();
      sparksDir(px, py, 1, 1, 210 + load * 260, (px < SM.vehicle.getX() ? -0.5 : 0.5), 1, 1.0);
    }
  }

  /**
   * Walk the open combo buckets and pop each one whose stream has dried up.
   * O(matCount) only while something is actually being collected.
   */
  function flushCombo(dt) {
    if (cbOpen === 0) return;
    for (var b = 0; b <= SPOIL_BUCKET; b++) {
      if (cbCount[b] === 0) continue;
      cbTimer[b] -= dt;
      cbHold[b] += dt;
      // Pop when this material stops arriving, or when it has been streaming
      // for so long that holding the number back stops reading as one haul.
      if (cbTimer[b] > 0 && cbHold[b] < COMBO_MAX_HOLD) continue;
      emitComboPopup(b, Math.round(cbValue[b]));
      cbValue[b] = 0; cbCount[b] = 0; cbTimer[b] = 0; cbHold[b] = 0;
      cbOpen--;
    }
  }

  function emitComboPopup(bucket, v) {
    if (v <= 0) return;

    /* Size: log-scaled against POPUP_VALUE_REF, so "the higher the score, the
     * larger the number" holds smoothly across four orders of magnitude. */
    var size = POPUP_FONT +
               (Math.log(v / POPUP_VALUE_REF) / Math.LN10) * POPUP_FONT_PER_DECADE;
    if (size < POPUP_FONT_MIN) size = POPUP_FONT_MIN;
    if (size > POPUP_FONT_MAX) size = POPUP_FONT_MAX;

    // Ore pops in its own colour; the merged spoil bucket keeps the neutral
    // gold that used to be every popup's colour.
    var r, g, bl;
    var spoil = (bucket === SPOIL_BUCKET);
    if (spoil) { r = 235; g = 214; bl = 150; }
    else { r = popR[bucket]; g = popG[bucket]; bl = popB[bucket]; }

    var vx = SM.vehicle && SM.vehicle.getX ? SM.vehicle.getX() : comboX;
    var vy = SM.vehicle && SM.vehicle.getY ? SM.vehicle.getY() : comboY;
    var half = (SM.vehicle && SM.vehicle.getWidth ? SM.vehicle.getWidth() : 140) * 0.5;
    // Alternate flanks and stay clear of the rig, so a torrent of popups
    // never sits on top of the machine you are trying to watch.
    comboSide = -comboSide;
    var px = vx + comboSide * (half + POPUP_CLEARANCE + size * 1.6);
    /* KEEP IT ON SCREEN, and note what this clamp is measured against. It used
     * to be the classic LANE (a fixed +/-640 strip of world), which was fine
     * when the machine could never leave it and silently wrong the moment it
     * could: down here the rig drives to x = -2470 at the west edge of a level,
     * `px < -lim` was permanently true, and every popup in the game landed on
     * the right flank however the alternation came out. The VIEW is the honest
     * bound — it is what "off screen" actually means. */
    var b = SM.camera.getViewBounds();
    var lim = 70;
    if (px > b.maxX - lim) px = vx - (half + POPUP_CLEARANCE);
    else if (px < b.minX + lim) px = vx + (half + POPUP_CLEARANCE);

    // Stagger the height by bucket so two materials flushing on the same step
    // never render exactly on top of each other.
    var dy = -10 + ((bucket * 37) % 60) - 30;
    popup(px, vy + dy, '+' + v, size, r, g, bl);

    // A really big seam gets a matching flare in its own colour.
    if (!spoil && v >= 2000) glint(vx, vy, 46, 0.24, r, g, bl, true);
  }

  /* =====================================================================
   * LIFECYCLE
   * ================================================================== */
  function init() {
    buildTextures();
    if (!subscribed) {
      subscribed = true;
      SM.events.on('material:destroyed', onDestroyed);
      SM.events.on('material:hit', onHit);
      SM.events.on('resource:collected', onCollected);
      SM.events.on('impact:heavy', onHeavy);
      /* FOUR SUBSCRIPTIONS, all of them the particle engine's. The other nine
       * were the time attack's ceremony — upgrade applied, gate passed, zone
       * entered, overdrive, run complete — and nothing emits any of them now.
       * Everything the campaign wants a flourish for it asks for by calling
       * screenFlash()/shock()/burst() directly. */
    }
    reset();
  }

  function reset() {
    freeCount = 0;
    actCount = 0;
    for (var i = CAP - 1; i >= 0; i--) { freeStack[freeCount++] = i; fText[i] = null; }
    budget = C.FX_BUDGET_PER_STEP;
    ringCd = 0;
    glintCd = 0;
    destroysThisStep = 0;
    comboSide = 1;
    clock = 0;
    exhaustAcc = grindAcc = 0;
    if (cbValue) {
      for (var b = 0; b <= SPOIL_BUCKET; b++) {
        cbValue[b] = 0; cbCount[b] = 0; cbTimer[b] = 0; cbHold[b] = 0;
      }
    }
    cbOpen = 0;
    flashAmt = 0;
  }

  function update(dt) {
    clock += dt;

    /* --- sustained states ------------------------------------------- */
    if (flashAmt > 0) {
      flashAmt -= dt * 2.6;
      if (flashAmt < 0) flashAmt = 0;
    }
    if (ringCd > 0) ringCd -= dt;
    if (glintCd > 0) glintCd -= dt;

    /* --- integrate the pool ------------------------------------------ */
    var k = 0;
    while (k < actCount) {
      var i = actList[k];
      fLife[i] -= dt;
      if (fLife[i] <= 0) { release(i); continue; }   // swap-in lands on k: recheck

      var t = fType[i];
      if (t === RING || t === FLASH || t === GLINT) { k++; continue; }

      var drag = t === SPARK ? SPARK_DRAG
               : t === CHIP ? CHIP_DRAG
               : t === SMOKE ? SMOKE_DRAG
               : t === STREAK ? STREAK_DRAG
               : t === TEXT ? 1.8
               : DUST_DRAG;
      var d = Math.exp(-drag * dt);
      fvx[i] *= d; fvy[i] *= d;
      fx[i] += fvx[i] * dt;
      fy[i] += fvy[i] * dt;

      if (t === DUST || t === SMOKE) {
        fRot[i] += fRotV[i] * dt;
        fSize[i] += fA[i] * dt;                      // puffs bloom outward
      } else if (t === CHIP) {
        fRot[i] += fRotV[i] * dt;
      } else if (t === TEXT) {
        if (fA[i] < 1) { fA[i] += dt * 7; if (fA[i] > 1) fA[i] = 1; }
      }
      k++;
    }

    /* --- ambient emitters -------------------------------------------- */
    emitExhaust(dt);
    emitGrind(dt);
    flushCombo(dt);

    /* --- refill the spend allowance for the next step ------------------ */
    budget = C.FX_BUDGET_PER_STEP;
    destroysThisStep = 0;
  }

  /* =====================================================================
   * RENDER — grouped by blend mode so we flip composite state twice, total.
   * main.js calls this INSIDE the camera transform, so everything below is
   * world space (including the two full-view overlay rects).
   * ================================================================== */
  function render(ctx) {
    var i, k, a, s, img;

    /* NOTHING UNDER THE PARTICLE EFFECTS ANY MORE. A whole vector-item layer
     * used to draw here — a fuel canister over every time cell and a turbo
     * bottle over every speed boost, faded out as the blade closed in so the
     * item never painted over the machine. Power-up blocks were a time-attack
     * device placed by the classic streamer; the mine places none, so the
     * layer, its two item renderers and their fade have all gone. */
    if (actCount) {
      /* ---- pass 1: smoke + dust (normal blend, softest first) -------- */
      for (k = 0; k < actCount; k++) {
        i = actList[k];
        if (fType[i] !== SMOKE) continue;
        a = fLife[i] / fMax[i];
        ctx.globalAlpha = a * a * 0.5;
        s = fSize[i];
        ctx.drawImage(smokeTex, fx[i] - s, fy[i] - s, s * 2, s * 2);
      }
      for (k = 0; k < actCount; k++) {
        i = actList[k];
        if (fType[i] !== DUST) continue;
        a = fLife[i] / fMax[i];
        ctx.globalAlpha = a * 0.75;
        s = fSize[i];
        img = puffs[fMat[i]] || whitePuff;
        ctx.drawImage(img, fx[i] - s, fy[i] - s, s * 2, s * 2);
      }

      /* ---- pass 2: chips (normal blend, opaque, on top of the dust) --- */
      for (k = 0; k < actCount; k++) {
        i = actList[k];
        if (fType[i] !== CHIP) continue;
        a = fLife[i] / fMax[i];
        ctx.globalAlpha = a > 0.35 ? 1 : a / 0.35;
        s = fSize[i];
        img = chipTex[fMat[i]];
        if (!img) continue;
        var fr = ((fRot[i] * (CHIP_FRAMES / TAU)) | 0) % CHIP_FRAMES;
        if (fr < 0) fr += CHIP_FRAMES;
        ctx.drawImage(img, fr * CHIP_TEX, 0, CHIP_TEX, CHIP_TEX,
                      fx[i] - s, fy[i] - s, s * 2, s * 2);
      }

      /* ---- pass 3: everything additive ------------------------------- */
      ctx.globalCompositeOperation = 'lighter';

      // sparks + streaks: one path batch per colour
      var lastCol = -1, open = false;
      ctx.lineCap = 'round';
      ctx.lineWidth = 2.2;
      for (k = 0; k < actCount; k++) {
        i = actList[k];
        var tp = fType[i];
        if (tp !== SPARK && tp !== STREAK) continue;
        var col = (fR[i] << 16) | (fG[i] << 8) | fB[i];
        if (col !== lastCol) {
          if (open) ctx.stroke();
          ctx.strokeStyle = 'rgb(' + fR[i] + ',' + fG[i] + ',' + fB[i] + ')';
          ctx.beginPath();
          open = true;
          lastCol = col;
        }
        a = fLife[i] / fMax[i];
        ctx.globalAlpha = tp === STREAK ? a * a * 0.85 : a;
        var len = tp === STREAK ? fSize[i] * a : fSize[i] * (0.4 + a);
        var vxn = fvx[i], vyn = fvy[i];
        var vl = Math.sqrt(vxn * vxn + vyn * vyn) || 1;
        ctx.moveTo(fx[i], fy[i]);
        ctx.lineTo(fx[i] - (vxn / vl) * len, fy[i] - (vyn / vl) * len);
      }
      if (open) ctx.stroke();

      // rings / shockwaves
      for (k = 0; k < actCount; k++) {
        i = actList[k];
        if (fType[i] !== RING) continue;
        a = fLife[i] / fMax[i];
        var grow = 1 - a;
        var rad = fSize[i] * (0.35 + grow * fA[i]);
        var fat = fMat[i] === 1;
        ctx.globalAlpha = a * (fat ? 0.95 : 0.85);
        ctx.strokeStyle = 'rgb(' + fR[i] + ',' + fG[i] + ',' + fB[i] + ')';
        ctx.lineWidth = fat ? (3 + 16 * a * a) : (2 + 7 * a);
        ctx.beginPath();
        ctx.arc(fx[i], fy[i], rad, 0, TAU);
        ctx.stroke();
        if (fat && a > 0.55) {
          // leading edge highlight while the wave is young
          ctx.globalAlpha = (a - 0.55) * 1.6;
          ctx.lineWidth = 1.6;
          ctx.strokeStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(fx[i], fy[i], rad * 1.03, 0, TAU);
          ctx.stroke();
        }
      }

      // flashes + glints
      for (k = 0; k < actCount; k++) {
        i = actList[k];
        var t2 = fType[i];
        if (t2 === FLASH) {
          a = fLife[i] / fMax[i];
          ctx.globalAlpha = a;
          var fs = fSize[i] * (1.6 - a * 0.6);
          ctx.drawImage(whitePuff, fx[i] - fs, fy[i] - fs, fs * 2, fs * 2);
        } else if (t2 === GLINT) {
          a = fLife[i] / fMax[i];
          // snap open, fade out
          var ga = a > 0.75 ? (1 - a) * 4 : a / 0.75;
          ctx.globalAlpha = ga;
          var gs = fSize[i] * (0.5 + (1 - a) * 0.9);
          ctx.drawImage(starTex, fx[i] - gs, fy[i] - gs, gs * 2, gs * 2);
        }
      }

      ctx.globalCompositeOperation = 'source-over';

      /* ---- pass 4: floating text ------------------------------------- */
      var didText = false;
      for (k = 0; k < actCount; k++) {
        i = actList[k];
        if (fType[i] !== TEXT || !fText[i]) continue;
        if (!didText) {
          didText = true;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.lineJoin = 'round';
        }
        a = fLife[i] / fMax[i];
        // easeOutBack pop-in on scale, linear fade at the tail
        var ph = fA[i];
        var sc = ph < 1 ? (0.4 + ph * ph * (2.2 - 1.2 * ph)) : 1;
        ctx.globalAlpha = a > 0.42 ? 1 : a / 0.42;
        ctx.font = fontFor(fSize[i] * sc);
        ctx.lineWidth = Math.max(2, fSize[i] * 0.16);
        ctx.strokeStyle = 'rgba(0,0,0,0.72)';
        ctx.strokeText(fText[i], fx[i], fy[i]);
        ctx.fillStyle = 'rgb(' + fR[i] + ',' + fG[i] + ',' + fB[i] + ')';
        ctx.fillText(fText[i], fx[i], fy[i]);
      }
      if (didText) {
        // Leave the context the way we found it: advterrain.js also draws
        // text (strata labels, the lift's level boards) and must not inherit
        // our alignment.
        ctx.lineJoin = 'miter';
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
      }
      ctx.lineCap = 'butt';
    }

    /* ---- pass 5: the screen flash (still world space) ----------------- */
    if (flashAmt > 0.002) {
      var b = SM.camera.getViewBounds();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = flashAmt;
      ctx.fillStyle = 'rgb(' + flashR + ',' + flashG + ',' + flashB + ')';
      ctx.fillRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.globalAlpha = 1;
  }

  /* =====================================================================
   * THE HEADLIGHT — the darkness composite
   * ---------------------------------------------------------------------
   * Called ONLY from SM.adv.renderWorld(), which main.js runs last inside the
   * world transform, so the darkness falls on the terrain, the machine AND
   * every effect above it. Nothing above it in this file is touched.
   *
   * THE BUDGET IS ONE RADIAL GRADIENT AND ONE FILL. This is a full-screen
   * blend at DPR 2, which is already the most expensive thing on the frame;
   * a per-particle lighting pass at ~5000 deposits is not on the table.
   *
   * WHY THE GRADIENT IS BAKED AT THE ORIGIN AND THE CONTEXT IS TRANSLATED
   *   A CanvasGradient bakes its coordinates, so a gradient centred on the
   *   machine would have to be rebuilt every single frame (the machine is
   *   always moving). Building it at (0,0) and translating the context
   *   instead means it is rebuilt only when the LIGHT RADIUS changes — i.e.
   *   when the player buys better lamps, which is the point of the upgrade.
   *
   * Beyond the last stop a radial gradient keeps painting the terminal colour,
   * so one fillRect over the whole view is genuinely all it takes: lit disc in
   * the middle, DARK_ALPHA black everywhere else.
   * ================================================================== */
  var DARK_ALPHA    = 0.94;   // how black the rock is beyond the lamps
  var DARK_CORE     = 0.30;   // inner fraction of the radius that stays clear
  var DARK_MID      = 0.62;   // ...and where the falloff is half spent
  var DARK_MID_A    = 0.34;   // alpha at DARK_MID — shapes the pool of light
  var DARK_LEAD     = 0.16;   // fraction of the radius the pool leans forward
  var DARK_MIN_R    = 90;     // never a pinhole, even with the light "off"
  var DARK_MAX_R    = 4000;   // sanity clamp on a placeholder stat

  var darkGrad = null;
  var darkGradR = -1;
  var darkGradCtx = null;

  function darkGradient(ctx, r) {
    // One integer of radius is finer than the eye can see and keeps a stat
    // that drifts by fractions from rebuilding the gradient every frame.
    if (darkGrad && darkGradR === r && darkGradCtx === ctx) return darkGrad;
    var g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(DARK_CORE, 'rgba(0,0,0,0)');
    g.addColorStop(DARK_MID, 'rgba(0,0,0,' + DARK_MID_A + ')');
    g.addColorStop(1, 'rgba(0,0,0,' + DARK_ALPHA + ')');
    darkGrad = g;
    darkGradR = r;
    darkGradCtx = ctx;
    return g;
  }

  /**
   * Lay the dark over everything except a pool of light around the machine.
   * Radius comes from SM.rig.getLightRadius(); a missing or nonsense value
   * degrades to a usable radius rather than to a black screen.
   */
  function renderDarkness(ctx) {
    if (!ctx || !SM.camera || !SM.camera.getViewBounds) return;

    var r = 520;
    if (SM.rig && SM.rig.getLightRadius) {
      var rr = SM.rig.getLightRadius();
      if (typeof rr === 'number' && rr === rr) r = rr;
    }
    if (r < DARK_MIN_R) r = DARK_MIN_R;
    if (r > DARK_MAX_R) r = DARK_MAX_R;
    r = r | 0;

    var cx = 0, cy = 0;
    if (SM.vehicle && SM.vehicle.getX) { cx = SM.vehicle.getX(); cy = SM.vehicle.getY(); }
    if (!(cx === cx) || !(cy === cy)) { cx = 0; cy = 0; }

    /* The lamps are on the front of the hull, so the pool of light leans the
     * way the machine is pointing. Feature-detected: vehicle.js owns the
     * heading and may not have given it one yet — with no heading the light
     * simply sits centred on the machine, which is a perfectly good fallback. */
    var hx = 0, hy = -1;
    var v = SM.vehicle;
    if (v) {
      if (v.getHeadingX && v.getHeadingY) { hx = v.getHeadingX(); hy = v.getHeadingY(); }
      else if (v.getHeading) {
        var a = v.getHeading();
        if (typeof a === 'number' && a === a) { hx = Math.sin(a); hy = -Math.cos(a); }
      }
    }
    var hm = Math.sqrt(hx * hx + hy * hy);
    if (hm > 0.0001) { cx += (hx / hm) * r * DARK_LEAD; cy += (hy / hm) * r * DARK_LEAD; }

    var b = SM.camera.getViewBounds();
    // A little slack past the view: shake translates the whole transform after
    // these bounds were solved, and an unpainted seam at the edge would read
    // as a bright crack in the rock.
    var pad = 64;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.translate(cx, cy);
    ctx.fillStyle = darkGradient(ctx, r);
    ctx.fillRect(b.minX - cx - pad, b.minY - cy - pad,
                 (b.maxX - b.minX) + pad * 2, (b.maxY - b.minY) + pad * 2);
    ctx.restore();
  }

  function getCount() { return actCount; }

  return {
    init: init,
    reset: reset,
    update: update,
    render: render,
    // contract
    dust: dust,
    sparks: sparks,
    ring: ring,
    flash: flash,
    getCount: getCount,
    // additions
    sparksDir: sparksDir,
    refuse: refuse,
    chips: chips,
    shock: shock,
    glint: glint,
    smoke: smoke,
    streak: streak,
    popup: popup,
    burst: burst,
    screenFlash: screenFlash,

    /* --- THE HEADLIGHT -------------------------------------------------
     * Called by SM.adv.renderWorld() only, and it MUST be last inside the
     * world transform — see the section header above. */
    renderDarkness: renderDarkness
  };
})();
