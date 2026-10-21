/* =============================================================================
 * SUPERMINE ADVENTURE — js/intro.js                  the three-second sting
 * -----------------------------------------------------------------------------
 * The mark, brought to life. A small tracked rig hangs at the top of a dark
 * screen; its lamp stutters on, and the headlight cone sweeps across rock that
 * was not there until the light found it — warm strata, ore catching fire
 * where the beam passes and going dark again behind it. The sweep comes to
 * rest pointing straight down, the name rises into the light, the rock sinks
 * back into the black, and SUPERMINE and ADVENTURE slide onto the exact spots
 * of the real wordmark on the title gate while the dark thins away. The
 * hand-off is the name landing in its place, not one picture swapped for
 * another.
 *
 * It is drawn the way the icon is drawn and the game is lit (see the header of
 * tools/make-icons.py, "the light going down"): the rock exists twice, once
 * nearly black and once warm, and the warm copy is only ever seen through the
 * cone. Every colour is from there or from style.css — the icon's dark and lit
 * band palettes, its hull, amber band, cyan viewport and lamp, materials.js
 * gold and sapphire, and --sm-bg (#0b0a0d), which is also the canvas clear
 * colour, so the sting fades into the game with no seam. The only words are
 * the game's own name, which hub §2 leaves untranslated.
 *
 * WHAT IT MAY NOT DO
 *   - Cost anyone a run (hub §1). It only ever plays at page load, over the
 *     title gate, and any tap or key skips straight to the hand-off.
 *   - Let the skipping press through. Keys are swallowed by a CAPTURE-phase
 *     listener on window. The title's Enter/Space/Escape (ui.js onTitleKey),
 *     advui.js, advhud.js and input.js all listen on window in the BUBBLE
 *     phase, and a key event is dispatched to the focused element, so
 *     window's capture listeners run before every one of them whoever
 *     registered first: the press that skips can neither start the campaign
 *     nor quit to the arcade. The one other capture listener, sound.js's
 *     audio-unlock `kick`, is registered from main.js on DOMContentLoaded;
 *     this script is async at the very top of <body> and is in practice
 *     running long before the twenty classic scripts below it have been
 *     fetched — and should it ever lose that race, all `kick` does is
 *     resume a silent AudioContext.
 *     A tap lands on the curtain itself, which covers the whole title gate
 *     (itself one big start button) and the corner plates (z-index 30).
 *   - Delay the game. It is a curtain, not a gate: every SM script loads and
 *     main.js boots underneath while it plays. index.html is frozen apart
 *     from its one async <script> tag, and nothing in SM knows this exists.
 *   - Play for someone who has asked for less motion. prefers-reduced-motion
 *     means the script does nothing at all.
 *   - Make a sound. The game's audio waits for the first real gesture.
 *
 * Self-contained, classic, importing nothing and touching no SM global: if
 * anything else fails, the curtain must still lift. Every frame runs inside a
 * try, a hard timeout removes the curtain whatever happens, and a failure of
 * this file leaves the game exactly as it was without it.
 *
 * Canvas 2D, devicePixelRatio capped at 2, rock and ore laid out once, the
 * light's falloff built once per resize, and no allocation in the frame loop
 * (hub §10). The words are measured once at 100px and drawn by scaling the
 * transform, so no font string is built per frame.
 * ========================================================================== */
(function () {
  'use strict';

  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch (e) {
    /* No matchMedia: play it. */
  }

  /* --- palette, copied rather than read, because this file reads nothing --- */
  var BG = '#0b0a0d';
  // The rock twice over, from tools/make-icons.py: what it is in the dark,
  // and what it is when the lamp is on it.
  var DARK_BANDS = ['#15171d', '#121419', '#0f1115', '#0c0d11', '#0a0b0e'];
  var LIT_BANDS = ['#8a7048', '#6d5836', '#7d6640', '#54452c', '#3b3020'];
  var LIT_EDGE = '#f0d79c';
  var GOLD = '#ffcb31';
  var CYAN = '#48bcff';
  // The rig, same family as the mark: grey hull, amber band, cyan eye, lamp.
  var HULL = '#9aa4b1';
  var HULL_HI = '#cfd8e3';
  var TRACK = '#1b1e24';
  var BAND = '#e09a10';
  var EYE = '#79dcff';
  var LAMP = '#fff6d2';
  var SUB = '#ffc21f'; // --sm-gold, the ADVENTURE line

  /* --- the timeline, in milliseconds --------------------------------------
   * The lamp stutters on by LAMP_ON; the beam sweeps out to one side, across
   * to the other, and settles straight down at SETTLE. The name rises into the
   * light from LOGO_IN over LOGO_MS, and the rock has sunk back into the dark
   * by DARK. LAND starts the hand-off, which takes LAND_MS (or SKIP_MS when
   * the player skipped). */
  var LAMP_ON = 460;
  var SWEEP_A = 1150;
  var SETTLE = 1750;
  var LOGO_IN = 1600;
  var LOGO_MS = 650;
  var DARK = 2500;
  var LAND = 2650;
  var LAND_MS = 650;
  var SKIP_MS = 380;

  var BAND_N = 7;     // strata visible below the rig
  var ORE_N = 30;

  var WORD = 'SUPERMINE';
  var WORD_SP = 0.15; // letter-spacing / font-size, as in style.css
  var WORD_FONT = '900 100px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  var SUBW = 'ADVENTURE';
  var SUB_SP = 0.55;
  var SUB_FONT = '800 100px ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Roboto Mono", monospace';

  var canvas = document.createElement('canvas');
  canvas.id = 'intro';
  canvas.setAttribute('aria-hidden', 'true');
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  /* --- the rock, laid out once in screen-fraction units ------------------- */
  var bandY = new Float32Array(BAND_N + 1);
  for (var b = 0; b <= BAND_N; b++) bandY[b] = 0.2 + (0.8 * b) / BAND_N + (b > 0 && b < BAND_N ? (Math.random() - 0.5) * 0.05 : 0);
  var ore = new Float32Array(ORE_N * 4); // x, y (0..1), size, cold (1 = cyan)
  for (var o = 0; o < ORE_N; o++) {
    ore[o * 4] = 0.04 + Math.random() * 0.92;
    ore[o * 4 + 1] = 0.3 + Math.random() * 0.68;
    ore[o * 4 + 2] = 0.6 + Math.random() * 0.7;
    // One in six cold: gold is money down here and cyan is the rare stuff.
    ore[o * 4 + 3] = o % 6 === 5 ? 1 : 0;
  }

  /* --- the words, measured once at 100px ---------------------------------- */
  var wordGW = new Float32Array(WORD.length);
  var subGW = new Float32Array(SUBW.length);
  var wordW100 = 0;
  var subW100 = 0;

  var W = 0, H = 0, dpr = 1;
  var unit = 0;         // the rig's size
  var lampX = 0, lampY = 0;
  var falloff = null;   // the light dying with distance, rebuilt on resize

  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    unit = Math.max(30, Math.min(Math.min(W, H) * 0.085, 64));
    lampX = W / 2;
    lampY = Math.max(H * 0.16, unit * 1.4);
    var reach = Math.hypot(W / 2, H - lampY) * 1.02;
    falloff = ctx.createRadialGradient(lampX, lampY, unit * 0.5, lampX, lampY, reach);
    falloff.addColorStop(0, 'rgba(11, 10, 13, 0)');
    falloff.addColorStop(0.45, 'rgba(11, 10, 13, 0.25)');
    falloff.addColorStop(1, 'rgba(11, 10, 13, 1)');
  }

  function measure() {
    ctx.font = WORD_FONT;
    wordW100 = 0;
    for (var i = 0; i < WORD.length; i++) {
      wordGW[i] = ctx.measureText(WORD.charAt(i)).width;
      wordW100 += wordGW[i];
    }
    ctx.font = SUB_FONT;
    subW100 = 0;
    for (var j = 0; j < SUBW.length; j++) {
      subGW[j] = ctx.measureText(SUBW.charAt(j)).width;
      subW100 += subGW[j];
    }
  }

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function easeInOut(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
  function easeOut(x) { return 1 - Math.pow(1 - x, 3); }

  // The lamp coming on: a stutter, then a warm-up. A lamp that just appears
  // is a light switch; one that catches is a machine.
  function lampAt(t) {
    if (t < 140) return 0;
    if (t < 200) return 0.65;
    if (t < 270) return 0.08;
    return 0.4 + 0.6 * clamp01((t - 270) / (LAMP_ON - 270));
  }

  // The beam's angle off straight down, in radians: out to the left, across
  // to the right, back to the middle, each leg eased.
  function angleAt(t) {
    if (t < LAMP_ON) return -0.75;
    if (t < SWEEP_A) return -0.75 + 1.3 * easeInOut((t - LAMP_ON) / (SWEEP_A - LAMP_ON));
    if (t < SETTLE) return 0.55 * (1 - easeInOut((t - SWEEP_A) / (SETTLE - SWEEP_A)));
    return 0;
  }

  /* --- where the words live on the title gate -----------------------------
   * Asked at hand-off, never earlier: ui.js builds the title at runtime. If
   * it is missing or already dismissed (.sm-start-off), the words fade. */
  var target = null;
  var hidden1 = null;
  var hidden2 = null;
  function box(sel, fallbackSp) {
    var el = document.querySelector(sel);
    if (!el || el.closest('.sm-start-off')) return null;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    var cs = window.getComputedStyle(el);
    var fs = parseFloat(cs.fontSize);
    if (!(fs > 0)) return null;
    var ls = parseFloat(cs.letterSpacing);
    // text-indent pays back the trailing spacing, so the ink is centred on
    // the box.
    return { el: el, x: r.left + r.width / 2, y: r.top + r.height / 2, size: fs, sp: ls > 0 ? ls / fs : fallbackSp };
  }
  function findTarget() {
    var a = box('.sm-start-logo', WORD_SP);
    var s = box('.sm-start-sub', SUB_SP);
    if (!a || !s) return null;
    // The real words step aside so the flying ones land on empty spots; they
    // are given back the moment the curtain goes.
    hidden1 = a.el;
    hidden2 = s.el;
    hidden1.style.visibility = 'hidden';
    hidden2.style.visibility = 'hidden';
    return { word: a, sub: s };
  }

  var t0 = 0;
  var landAt = LAND;
  var landMs = LAND_MS;
  var done = false;
  var raf = 0;

  function finish() {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', size);
    if (hidden1) hidden1.style.visibility = '';
    if (hidden2) hidden2.style.visibility = '';
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  function skip() {
    var now = performance.now() - t0;
    if (now >= landAt) return;
    landAt = now;
    landMs = SKIP_MS;
  }

  function onKey(e) {
    // Skip, and let the press go no further: see the header.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.repeat) skip();
  }

  /* --- drawing ------------------------------------------------------------ */

  function drawRock(bands, lit) {
    for (var b = 0; b < BAND_N; b++) {
      var y0 = bandY[b] * H;
      ctx.fillStyle = bands[b % bands.length];
      ctx.fillRect(0, y0, W, bandY[b + 1] * H - y0 + 1);
      if (lit && b > 0) {
        // The lit copy catches the top of each seam, as the icon's does.
        ctx.fillStyle = LIT_EDGE;
        ctx.globalAlpha = 0.5;
        ctx.fillRect(0, y0, W, Math.max(1.5, unit * 0.04));
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawOre(lit) {
    var s0 = unit * 0.12;
    for (var o = 0; o < ORE_N; o++) {
      var x = ore[o * 4] * W;
      var y = ore[o * 4 + 1] * H;
      var r = s0 * ore[o * 4 + 2];
      var c = ore[o * 4 + 3] ? CYAN : GOLD;
      if (lit) {
        // Catching fire: a halo, then the stone.
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(x, y, r * 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
      } else {
        // Off the beam, almost invisible: there is always more out there
        // than the lamp is showing you.
        ctx.globalAlpha = 0.1;
      }
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // The cone as a clip: apex at the lamp, opening `half` radians either side
  // of `ang` off straight down, long enough to leave the screen.
  function wedge(ang, half) {
    var L = Math.hypot(W, H) * 1.5;
    ctx.beginPath();
    ctx.moveTo(lampX, lampY);
    ctx.lineTo(lampX + Math.sin(ang - half) * L, lampY + Math.cos(ang - half) * L);
    ctx.lineTo(lampX + Math.sin(ang + half) * L, lampY + Math.cos(ang + half) * L);
    ctx.closePath();
  }

  function drawLit(ang, half, alpha) {
    ctx.save();
    wedge(ang, half);
    ctx.clip();
    ctx.globalAlpha = alpha;
    drawRock(LIT_BANDS, true);
    drawOre(true);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = falloff;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawRig(ang, lamp) {
    var w = unit * 1.5;
    var h = unit * 0.78;
    var x = lampX - w / 2;
    var y = lampY - h - unit * 0.18;
    // Tracks, then the hull over them, then its band, eye and lamp.
    ctx.fillStyle = TRACK;
    ctx.fillRect(x - unit * 0.12, y + h * 0.62, w + unit * 0.24, h * 0.5);
    ctx.fillStyle = HULL;
    ctx.fillRect(x, y, w, h * 0.75);
    ctx.fillStyle = HULL_HI;
    ctx.fillRect(x, y, w, h * 0.14);
    ctx.fillStyle = BAND;
    ctx.fillRect(x, y + h * 0.42, w, h * 0.14);
    ctx.fillStyle = EYE;
    ctx.fillRect(x + w * 0.62, y + h * 0.16, w * 0.24, h * 0.2);
    // The lamp housing turns with the beam.
    ctx.fillStyle = lamp > 0.3 ? LAMP : '#5c5648';
    ctx.globalAlpha = 0.4 + 0.6 * lamp;
    ctx.beginPath();
    ctx.arc(lampX + Math.sin(ang) * unit * 0.1, lampY, unit * 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // One line of spaced capitals centred on (cx, cy) at font size `sz`, with
  // letter spacing `sp` as a fraction of it.
  function drawLine(font, text, gw, w100, cx, cy, sz, sp, fill, glow, blur, alpha) {
    var k = sz / 100;
    var total = w100 + sp * 100 * (text.length - 1);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, cx * dpr, cy * dpr);
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.globalAlpha = alpha;
    ctx.fillStyle = fill;
    // shadowBlur ignores the transform, so it is given in device pixels.
    ctx.shadowColor = glow;
    ctx.shadowBlur = blur * sz * dpr;
    var gx = -total / 2;
    for (var i = 0; i < text.length; i++) {
      ctx.fillText(text.charAt(i), gx, 0);
      gx += gw[i] + sp * 100;
    }
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'rgba(0, 0, 0, 0)';
    ctx.globalAlpha = 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function frame(now) {
    if (done) return;
    try {
      if (!t0) t0 = now;
      var t = now - t0;
      var land = clamp01((t - landAt) / landMs);
      if (land >= 1) { finish(); return; }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // How far the rock has sunk back into the dark: by DARK on its own,
      // or within the first third of a skip.
      var dark = clamp01((t - LOGO_IN - 200) / (DARK - LOGO_IN - 200));
      if (land > 0) dark = Math.max(dark, clamp01(land * 3));

      if (dark < 1) {
        var lamp = lampAt(t);
        var ang = angleAt(t);
        // The beam opens a little as it settles, to take the name in.
        var open = clamp01((t - SWEEP_A) / (SETTLE - SWEEP_A));
        ctx.fillStyle = BG;
        ctx.fillRect(0, 0, W, H);
        drawRock(DARK_BANDS, false);
        drawOre(false);
        if (lamp > 0) {
          // A soft outer cone and a bright inner one: two clips read as a
          // beam with an edge falling off, which one hard wedge does not.
          drawLit(ang, 0.42 + 0.1 * open, 0.38 * lamp);
          drawLit(ang, 0.24 + 0.06 * open, lamp);
        }
        drawRig(ang, lamp);
        if (dark > 0) {
          ctx.globalAlpha = dark;
          ctx.fillStyle = BG;
          ctx.fillRect(0, 0, W, H);
          ctx.globalAlpha = 1;
        }
      } else {
        // The curtain itself, which thins away during the hand-off and lets
        // the title gate show through.
        ctx.globalAlpha = 1 - easeInOut(land);
        ctx.fillStyle = BG;
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
      }

      // The name: rises into the light, rests, then flies home.
      var li = (t - LOGO_IN) / LOGO_MS;
      if (land > 0 && li < 1) li = 1; // a skip before the rise lands it whole
      if (li > 0) {
        var e = easeOut(clamp01(li));
        var sz = Math.min((W * 0.84) / ((wordW100 + WORD_SP * 100 * (WORD.length - 1)) / 100), H * 0.17, 120);
        var ssz = sz * 0.25;
        var cx = W / 2;
        var cy = H * 0.56 + (1 - e) * sz * 0.35;
        var sy = cy + sz * 0.5 + ssz * 1.6;
        var wsz = sz * (0.94 + 0.06 * e);
        var wsp = WORD_SP;
        var ssp = SUB_SP;
        var sx = cx;
        var a = e;
        // ADVENTURE follows a beat behind the name.
        var sa = clamp01((li - 0.35) / 0.65);
        if (land > 0) {
          if (target === null) target = findTarget() || false;
          var k = easeInOut(land);
          if (target) {
            var tw = target.word;
            var ts = target.sub;
            cx += (tw.x - cx) * k;
            cy += (tw.y - cy) * k;
            wsz += (tw.size - wsz) * k;
            wsp += (tw.sp - wsp) * k;
            sx += (ts.x - sx) * k;
            sy += (ts.y - sy) * k;
            ssz += (ts.size - ssz) * k;
            ssp += (ts.sp - ssp) * k;
            sa += (1 - sa) * k;
          } else {
            a *= 1 - k;   // nothing on screen to land on: just fade
            sa *= 1 - k;
          }
        }
        drawLine(WORD_FONT, WORD, wordGW, wordW100, cx, cy, wsz, wsp,
          '#ffffff', 'rgba(255, 194, 31, 0.55)', 0.45, a);
        if (sa > 0) {
          drawLine(SUB_FONT, SUBW, subGW, subW100, sx, sy, ssz, ssp,
            SUB, 'rgba(255, 194, 31, 0.6)', 0.7, sa);
        }
      }
    } catch (err) {
      finish();
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    size();
    measure();
    window.addEventListener('resize', size);
    window.addEventListener('keydown', onKey, true);
    canvas.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      skip();
    });
    document.body.appendChild(canvas);
    raf = requestAnimationFrame(frame);
    // Whatever happens to the frame loop, the curtain does not outstay this.
    setTimeout(finish, 6000);
  }

  // Loaded from the top of <body>, so the body exists even though the rest
  // of the page has not been parsed yet.
  try {
    start();
  } catch (e) {
    finish();
  }
})();
