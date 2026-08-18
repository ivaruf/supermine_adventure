/* =============================================================================
 * SUPERMINE ADVENTURE — js/sound.js
 * -----------------------------------------------------------------------------
 * A small procedural WebAudio engine. No assets, no network, no libraries.
 *
 * SIGNAL PATH
 *   engineBus ─┐
 *   grindBus  ─┼─> master (gain, muted here) ─> limiter (compressor) ─> out
 *   sfxBus    ─┘
 *
 * A FOURTH BUS USED TO HANG OFF MASTER: `rhythmBus`, feeding a 16th-note grid
 * that thickened as a time-attack run escalated through its zones. It is gone
 * with the zones, and so is the sustained overdrive layer that rode the engine
 * bus. What is left is the excavation itself — the drone, the grinder, and the
 * one-shots the rock makes — which is what a mine should sound like.
 *
 * WHY THE HOT EVENTS ONLY INCREMENT COUNTERS
 *   material:destroyed fires ~150x per step and resource:collected ~30x.
 *   Building a voice per event is impossible. Instead the handlers do nothing
 *   but bump integers; update() reads those counters once per step and decides
 *   what the excavation should SOUND like this instant (a light crack, a heavy
 *   collapse, a two-note arpeggio, ...). That is both cheaper and more musical.
 *
 * DEGRADATION
 *   Everything is behind `if (!actx) return;`. If AudioContext is missing,
 *   blocked, or throws at any point the whole module goes quiet and the game
 *   is unaffected.
 *
 * Public API (contract)
 *   SM.sound.init() / update(dt) / reset()
 *   SM.sound.play(name, opts?)   'break' 'crunch' 'hit' 'impact' 'clank'
 *                                'collect' 'sparkle' 'ui'
 *   SM.sound.setMuted(b) / toggleMute() / isMuted()
 *
 * PAUSE
 *   Subscribes to `game:paused` and ducks the engine and grinder BUSES to
 *   zero, then back on resume. Those two are the only nodes in here that keep
 *   sounding without update() feeding them, so that single hook is the whole
 *   of it — see setPaused() for why it is not master that gets ducked.
 * ========================================================================== */

var SM = SM || {};

SM.sound = (function () {
  'use strict';

  /* =====================================================================
   * Tunables
   * ================================================================== */
  var ENGINE_BASE_HZ   = 46;
  var ENGINE_GAIN      = 0.075;
  var GRIND_GAIN       = 0.13;
  var SFX_GAIN         = 0.9;

  var VOICE_LIMIT      = 18;     // hard cap on concurrent one-shot voices
  var VOICE_LIMIT_SOFT = 12;     // above this, only "important" sounds get in

  // Collection arpeggio: a pentatonic ladder that climbs while you keep
  // collecting and resets after a short silence. This is the single most
  // satisfying sound in the game — keep it.
  var ARP_STEPS        = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24];
  var ARP_ROOT_HZ      = 392.0;  // G4
  var ARP_RESET_TIME   = 0.45;
  var ARP_MIN_GAP      = 0.045;  // throttle for a bare SM.sound.play('collect')
  var ARP_NOTE_GAP     = 0.055;  // spacing of the staggered ladder in update()

  var BREAK_MIN_GAP    = 0.05;
  var CRUNCH_MIN_GAP   = 0.16;
  var CRUNCH_THRESHOLD = 26;     // destroys per step that counts as a collapse

  var GRIND_ATTACK     = 6.0;
  var GRIND_RELEASE    = 2.6;

  var C = SM.config;

  /* =====================================================================
   * Graph state
   * ================================================================== */
  var actx = null;
  var master = null, limiter = null;
  var sfxBus = null, engineBus = null, grindBus = null;
  var dead = false;              // audio permanently unavailable

  var muted = false;
  var paused = false;
  var unlocked = false;
  var voices = 0;

  var lastPlayed = Object.create(null);
  var clock = 0;

  // engine drone graph
  var engOsc = null, engOsc2 = null, engSub = null, engGain = null, engFilter = null;
  // grinding loop graph
  var grindSrc = null, grindGain = null, grindFilt = null, grindHi = null, grindHiGain = null;

  var noiseBuffer = null;        // short white noise, reused by percussion
  var loopBuffer = null;         // seamless looping noise for the grinder

  /* =====================================================================
   * Per-step activity counters (written by hot handlers, read by update)
   * ================================================================== */
  var nDestroy = 0, topDestroyValue = 0;
  var nCollect = 0, collectValue = 0, nSparkle = 0;
  var nHit = 0, hitIntensity = 0;

  var grindTarget = 0, grindLevel = 0;
  var arpIndex = 0, arpLast = -999, arpGate = 0;

  var subscribed = false;

  /* =====================================================================
   * CONTEXT
   * ================================================================== */
  function ensureContext() {
    if (actx) return true;
    if (dead) return false;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { dead = true; return false; }
    try {
      actx = new AC();

      limiter = actx.createDynamicsCompressor();
      // Glue the whole mix so a torrent of debris cannot clip the output.
      limiter.threshold.value = -12;
      limiter.knee.value = 6;
      limiter.ratio.value = 8;
      limiter.attack.value = 0.004;
      limiter.release.value = 0.16;
      limiter.connect(actx.destination);

      master = actx.createGain();
      master.gain.value = muted ? 0 : C.SOUND_MASTER_GAIN;
      master.connect(limiter);

      sfxBus = actx.createGain();    sfxBus.gain.value = SFX_GAIN;    sfxBus.connect(master);
      engineBus = actx.createGain(); engineBus.gain.value = 1;        engineBus.connect(master);
      grindBus = actx.createGain();  grindBus.gain.value = 1;         grindBus.connect(master);

      buildNoise();
      buildEngine();
      buildGrinder();
      unlocked = true;
      return true;
    } catch (e) {
      dead = true;
      actx = null;
      return false;
    }
  }

  function buildNoise() {
    // 2 s so even the longest burst ('complete') never runs off the end, and
    // so every burst can start at a random offset without repeating audibly.
    var n = (actx.sampleRate * 2.0) | 0;
    noiseBuffer = actx.createBuffer(1, n, actx.sampleRate);
    var d = noiseBuffer.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;

    // Two seconds of noise for the looping grinder. Cross-fade the tail into
    // the head so the loop point is inaudible.
    var m = (actx.sampleRate * 2) | 0;
    loopBuffer = actx.createBuffer(1, m, actx.sampleRate);
    var e = loopBuffer.getChannelData(0);
    for (var j = 0; j < m; j++) e[j] = Math.random() * 2 - 1;
    var fade = (actx.sampleRate * 0.05) | 0;
    for (var f = 0; f < fade; f++) {
      var t = f / fade;
      e[f] = e[f] * t + e[m - fade + f] * (1 - t);
    }
  }

  /** Low industrial drone: two detuned oscillators + a sub, through a lowpass. */
  function buildEngine() {
    engGain = actx.createGain();
    engGain.gain.value = 0;

    engFilter = actx.createBiquadFilter();
    engFilter.type = 'lowpass';
    engFilter.frequency.value = 300;
    engFilter.Q.value = 3.0;

    engOsc = actx.createOscillator();
    engOsc.type = 'sawtooth';
    engOsc.frequency.value = ENGINE_BASE_HZ;

    engOsc2 = actx.createOscillator();
    engOsc2.type = 'square';
    engOsc2.frequency.value = ENGINE_BASE_HZ * 1.505;   // beating -> "chugging"

    engSub = actx.createOscillator();
    engSub.type = 'sine';
    engSub.frequency.value = ENGINE_BASE_HZ * 0.5;
    var subG = actx.createGain();
    subG.gain.value = 0.75;

    engOsc.connect(engFilter);
    engOsc2.connect(engFilter);
    engSub.connect(subG); subG.connect(engFilter);
    engFilter.connect(engGain);
    engGain.connect(engineBus);
    try { engOsc.start(); engOsc2.start(); engSub.start(); } catch (e) { /* ignore */ }
  }

  /** Grinding loop: filtered noise band + a thin screech layer on top. */
  function buildGrinder() {
    grindGain = actx.createGain();
    grindGain.gain.value = 0;

    grindFilt = actx.createBiquadFilter();
    grindFilt.type = 'bandpass';
    grindFilt.frequency.value = 900;
    grindFilt.Q.value = 1.1;

    grindHi = actx.createBiquadFilter();
    grindHi.type = 'bandpass';
    grindHi.frequency.value = 3400;
    grindHi.Q.value = 7;
    grindHiGain = actx.createGain();
    grindHiGain.gain.value = 0.22;

    grindSrc = actx.createBufferSource();
    grindSrc.buffer = loopBuffer;
    grindSrc.loop = true;

    grindSrc.connect(grindFilt);
    grindSrc.connect(grindHi);
    grindHi.connect(grindHiGain);
    grindFilt.connect(grindGain);
    grindHiGain.connect(grindGain);
    grindGain.connect(grindBus);
    try { grindSrc.start(); } catch (e) { /* ignore */ }
  }

  /* =====================================================================
   * VOICE PRIMITIVES
   * ================================================================== */
  function canVoice(important) {
    if (!actx || muted) return false;
    return voices < (important ? VOICE_LIMIT : VOICE_LIMIT_SOFT);
  }

  function countVoice(node) {
    voices++;
    node.onended = function () { if (voices > 0) voices--; };
  }

  function noiseBurst(dur, freq, q, gain, type, delay) {
    if (!actx) return;
    var src = actx.createBufferSource();
    src.buffer = noiseBuffer;
    var f = actx.createBiquadFilter();
    f.type = type || 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    var g = actx.createGain();
    var t = actx.currentTime + (delay || 0);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f); f.connect(g); g.connect(sfxBus);
    // Random playback offset so repeated hits never sound identical. Clamped
    // so the burst can never run off the end of the buffer and go silent.
    var maxOff = noiseBuffer.duration - dur - 0.05;
    if (maxOff < 0) maxOff = 0;
    try { src.start(t, Math.random() * maxOff); } catch (e) { try { src.start(t); } catch (e2) { return; } }
    src.stop(t + dur + 0.02);
    countVoice(src);
  }

  function tone(freq, freq2, dur, gain, type, delay, dest) {
    if (!actx) return;
    var o = actx.createOscillator();
    o.type = type || 'triangle';
    var g = actx.createGain();
    var t = actx.currentTime + (delay || 0);
    o.frequency.setValueAtTime(freq, t);
    if (freq2 && freq2 !== freq) o.frequency.exponentialRampToValueAtTime(Math.max(1, freq2), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(dest || sfxBus);
    o.start(t);
    o.stop(t + dur + 0.02);
    countVoice(o);
  }

  /**
   * One rung of the collection ladder. Rapid pickups climb an ascending
   * pentatonic scale and the ladder resets after a short silence — this is
   * what makes a loot torrent feel like a payout instead of a rattle.
   */
  function collectNote(delay) {
    if (!actx) return;
    if (clock - arpLast > ARP_RESET_TIME) arpIndex = 0;
    arpLast = clock;
    var st = ARP_STEPS[arpIndex % ARP_STEPS.length];
    var oct = (arpIndex / ARP_STEPS.length) | 0;
    var hz = ARP_ROOT_HZ * Math.pow(2, (st + oct * 3) / 12);
    if (hz > 3800) hz = 3800;
    arpIndex++;
    if (arpIndex > 40) arpIndex = 24;      // plateau instead of squeaking
    tone(hz, hz * 1.01, 0.09, 0.13, 'triangle', delay);
    tone(hz * 2, hz * 2, 0.05, 0.045, 'sine', delay);
  }

  /** Inharmonic partial stack — the metal in "metallic clank". */
  function clank(baseHz, dur, gain) {
    if (!actx) return;
    noiseBurst(0.03, baseHz * 3.2, 3, gain * 0.5, 'bandpass');
    tone(baseHz, baseHz * 0.96, dur, gain * 0.55, 'square');
    tone(baseHz * 2.76, baseHz * 2.7, dur * 0.7, gain * 0.30, 'sine');
    tone(baseHz * 5.41, baseHz * 5.3, dur * 0.42, gain * 0.16, 'sine');
  }

  /* =====================================================================
   * ONE-SHOTS
   * ================================================================== */
  function play(name, opts) {
    if (muted || !unlocked || !actx) return;

    // THE INTERFACE OUTRANKS THE EXCAVATION. A menu blip that never sounded
    // because the drill was chewing granite reads as a dead button, so 'ui'
    // gets the full voice allowance and no rate limit. It is the only name
    // left on this list — the others were the clock's ('+10s', the run-over
    // stinger) and the gate ceremony's.
    var important = (name === 'ui');
    if (!canVoice(important)) return;

    var minGap = C.SOUND_MIN_INTERVAL;
    if (name === 'break') minGap = BREAK_MIN_GAP;
    else if (name === 'collect') minGap = ARP_MIN_GAP;
    else if (name === 'hit') minGap = 0.09;
    else if (name === 'crunch') minGap = CRUNCH_MIN_GAP;
    else if (name === 'sparkle') minGap = 0.10;
    else if (name === 'clank') minGap = 0.11;
    else if (important) minGap = 0;

    var last = lastPlayed[name];
    if (last !== undefined && clock - last < minGap) return;
    lastPlayed[name] = clock;

    var v = (opts && opts.variation !== undefined) ? opts.variation : Math.random();

    switch (name) {

      /* --- destruction --------------------------------------------- */
      case 'break':                    // light crack of a single deposit
        noiseBurst(0.075 + v * 0.05, 420 + v * 780, 1.5, 0.42);
        break;

      case 'crunch':                   // many deposits collapsing at once
        noiseBurst(0.22 + v * 0.10, 200 + v * 180, 0.8, 0.62, 'lowpass');
        noiseBurst(0.11, 1400 + v * 900, 1.2, 0.26);
        tone(120 - v * 25, 58, 0.20, 0.24, 'sine');
        break;

      case 'hit':                      // cutter skittering across hard rock
        noiseBurst(0.045, 2300 + v * 2700, 6, 0.20, 'bandpass');
        break;

      case 'impact':                   // stone thud
        noiseBurst(0.28, 105 + v * 95, 0.9, 0.70, 'lowpass');
        tone(92, 42, 0.26, 0.28, 'sine');
        break;

      case 'clank':                    // metal on metal
        clank(260 + v * 220, 0.24, 0.30);
        break;

      /* --- loot ------------------------------------------------------ */
      case 'collect':
        collectNote(0);
        break;

      case 'sparkle': {                // gem / crystal tinkle
        var base = 1500 + v * 900;
        tone(base, base * 1.02, 0.10, 0.10, 'sine');
        tone(base * 1.5, base * 1.52, 0.08, 0.07, 'sine', 0.035);
        tone(base * 2.02, base * 2.0, 0.07, 0.05, 'sine', 0.075);
        noiseBurst(0.05, 6200, 9, 0.07);
        break;
      }

      /* --- interface --------------------------------------------------
       * Ten cases used to sit here: 'gate', 'upgrade', 'boom', 'boost',
       * 'riser', 'complete', 'timeplus', 'timelow', 'tick' and 'timeout' —
       * the whole ceremony of a scored 60-second run, from the gate chime to
       * the per-second pip in the last ten seconds. Every one of them was
       * reachable from exactly one classic event, and nothing emits any of
       * them now. The excavation cases above are the ones the mine uses; the
       * campaign's own moments are advhud/advui calling play('ui').
       * ------------------------------------------------------------- */
      case 'ui':
        tone(660, 880, 0.06, 0.10, 'square');
        break;

      default:
        break;
    }
  }

  /* =====================================================================
   * HOT EVENT HANDLERS — integer bumps only, nothing else
   * ================================================================== */
  function onDestroyed(p) {
    nDestroy++;
    var m = SM.materials.get(p.matIndex);
    var v = m ? m.value : 0;
    if (v > topDestroyValue) topDestroyValue = v;
  }
  function onCollected(p) {
    nCollect++;
    collectValue += p.value;
    var m = SM.materials.get(p.matIndex);
    if (m && m.sparkle >= 0.7) nSparkle++;
  }
  function onHit(p) {
    nHit++;
    if (p.intensity > hitIntensity) hitIntensity = p.intensity;
  }

  /* =====================================================================
   * UPDATE — turns the counters into sound, drives the loops
   * ================================================================== */
  function update(dt) {
    clock += dt;

    if (!unlocked || !actx) {
      nDestroy = nCollect = nHit = 0;
      topDestroyValue = collectValue = hitIntensity = 0;
      return;
    }

    /* --- destruction --------------------------------------------------- */
    if (nDestroy > 0) {
      if (nDestroy >= CRUNCH_THRESHOLD) {
        play('crunch');
        if (nDestroy >= CRUNCH_THRESHOLD * 2.5) play('impact');
      } else {
        play('break');
      }
      if (topDestroyValue >= 80) play('sparkle');
      else if (topDestroyValue >= 25 && Math.random() < 0.5) play('clank');
    }

    /* --- collection ---------------------------------------------------- */
    if (nCollect > 0 && !muted && clock >= arpGate) {
      // Fire up to 3 rungs per step, STAGGERED in real time, so a torrent runs
      // UP the scale instead of retriggering one note on top of itself. The
      // gate advances by exactly the length of the burst, capping the ladder
      // at ~18 notes/sec however hard the loot is pouring in.
      var notes = nCollect > 6 ? 3 : nCollect > 2 ? 2 : 1;
      if (canVoice(false)) {
        for (var i = 0; i < notes; i++) collectNote(i * ARP_NOTE_GAP);
      }
      arpGate = clock + notes * ARP_NOTE_GAP;
      if (nSparkle > 0 && Math.random() < 0.5) play('sparkle');
    }

    /* --- grinding loop -------------------------------------------------- */
    var load = 0;
    if (SM.vehicle && SM.vehicle.getResistance) {
      load = Math.min(1, SM.vehicle.getResistance() * 0.0050);
    }
    // material:hit activity feeds the grinder even when resistance is low
    // (fast cutting through soft ground still rasps).
    var hitAct = Math.min(1, nHit * 0.34 + hitIntensity * 0.4);
    grindTarget = Math.max(load, hitAct * 0.8);
    var gk = grindTarget > grindLevel ? GRIND_ATTACK : GRIND_RELEASE;
    grindLevel += (grindTarget - grindLevel) * Math.min(1, gk * dt);
    if (grindLevel < 0.0015) grindLevel = 0;

    if (grindGain) {
      grindGain.gain.value = muted ? 0 : GRIND_GAIN * grindLevel;
      // Wobble the band so it sounds like a rotating cutter, not a noise gate.
      grindFilt.frequency.value = 620 + grindLevel * 900 + Math.sin(clock * 7.3) * 140;
      grindHi.frequency.value = 3000 + Math.sin(clock * 11.7) * 900 + grindLevel * 1400;
      grindHiGain.gain.value = 0.10 + grindLevel * 0.34;
    }

    /* --- engine drone --------------------------------------------------- */
    var speed = 0;
    if (SM.vehicle && SM.vehicle.getSpeed) {
      speed = SM.vehicle.getSpeed() / Math.max(1, C.VEHICLE_SPEED);
    }
    if (engGain) {
      var target = muted ? 0
        : ENGINE_GAIN * (0.5 + speed * 0.4 + load * 0.8);
      engGain.gain.value += (target - engGain.gain.value) * Math.min(1, dt * 4);
      var hz = ENGINE_BASE_HZ * (0.84 + speed * 0.34 + load * 0.22);
      engOsc.frequency.value = hz;
      engOsc2.frequency.value = hz * 1.505;
      engSub.frequency.value = hz * 0.5;
      engFilter.frequency.value = 210 + load * 900 + speed * 240;
    }

    /* --- clear per-step counters ------------------------------------------ */
    nDestroy = 0; topDestroyValue = 0;
    nCollect = 0; collectValue = 0; nSparkle = 0;
    nHit = 0; hitIntensity = 0;
  }

  /* =====================================================================
   * MUTE / LIFECYCLE
   * ================================================================== */
  function setMuted(b) {
    muted = !!b;
    if (master && actx) {
      // Ramp instead of a jump: a hard gain change on a running graph clicks.
      try {
        master.gain.setTargetAtTime(muted ? 0 : C.SOUND_MASTER_GAIN, actx.currentTime, 0.02);
      } catch (e) {
        master.gain.value = muted ? 0 : C.SOUND_MASTER_GAIN;
      }
    }
    SM.events.emit('sound:muted', muted);
  }
  function toggleMute() { setMuted(!muted); }
  function isMuted() { return muted; }

  function rampBus(bus, value) {
    if (!bus || !actx) return;
    try { bus.gain.setTargetAtTime(value, actx.currentTime, 0.025); }
    catch (e) { bus.gain.value = value; }
  }

  /**
   * PAUSE — duck the SUSTAINED layers, leave the one-shots alone.
   *
   * The engine drone and the grinder are permanently running nodes whose gain
   * is only ever moved by update() — and update() stops being called the
   * instant main.js holds the step. That happens on every pause, on every meta
   * screen and at the title. Left alone they would hang on one frozen note
   * under the menu, which is the loudest possible way to tell a player that
   * nothing is really paused.
   *
   * Ducking the two BUSES instead of master is what keeps the menu audible:
   * its own 'ui' blips still go out through sfxBus. Ramped rather than jumped
   * for the same reason setMuted() ramps: a step change on a running graph
   * clicks.
   *
   * The gains are not restored from update() on resume, so the ramp back has
   * to happen here — which also means a resume works while muted (the beds
   * come back to full on a master that is still at zero).
   */
  function setPaused(p) {
    p = !!p;
    if (p === paused) return;      // main.js emits on change, but say it here too
    paused = p;
    rampBus(engineBus, paused ? 0 : 1);
    rampBus(grindBus, paused ? 0 : 1);
  }

  function reset() {
    clock = 0;
    for (var k in lastPlayed) delete lastPlayed[k];
    nDestroy = nCollect = nHit = 0;
    topDestroyValue = collectValue = hitIntensity = nSparkle = 0;
    grindTarget = grindLevel = 0;
    arpIndex = 0; arpLast = -999; arpGate = 0;
    if (grindGain) grindGain.gain.value = 0;
  }

  function unlock() {
    if (!ensureContext()) return;
    if (actx.state === 'suspended') {
      try { actx.resume(); } catch (e) { /* ignore */ }
    }
  }

  function init() {
    if (subscribed) return;
    subscribed = true;

    // Browsers block audio until a user gesture.
    SM.events.on('input:firstgesture', unlock);
    var kick = function () {
      unlock();
      window.removeEventListener('pointerdown', kick, true);
      window.removeEventListener('keydown', kick, true);
      window.removeEventListener('touchstart', kick, true);
    };
    window.addEventListener('pointerdown', kick, true);
    window.addEventListener('keydown', kick, true);
    window.addEventListener('touchstart', kick, true);

    // Hot events: counters only.
    SM.events.on('material:destroyed', onDestroyed);
    SM.events.on('material:hit', onHit);
    SM.events.on('resource:collected', onCollected);

    // Rare events: play directly.
    SM.events.on('impact:heavy', function (p) {
      if (p && p.strength > 0.55) play('impact');
      else play('clank');
    });
    /* THIRTEEN SUBSCRIPTIONS USED TO FOLLOW: the gates, the upgrade fanfare,
     * the pulse, overdrive, the boost, the zone escalation, the completion
     * chord and the whole countdown (+10s, the low-time alarm, the run-over
     * stinger). Every one of them answered an event that only the time-attack
     * director emitted. What remains above is the engine's own — the rock
     * breaking, the cutter skittering, the loot ladder, the heavy impact.
     * The campaign speaks through play('ui') from advhud.js and advui.js. */

    SM.events.on('input:mutetoggle', function () { toggleMute(); });
    SM.events.on('game:paused', function (p) { setPaused(p && p.paused); });
  }

  return {
    init: init,
    update: update,
    play: play,
    setMuted: setMuted,
    toggleMute: toggleMute,
    isMuted: isMuted,
    reset: reset,
    isReady: function () { return unlocked && !!actx; },
    /** Introspection: the ducked bus levels, so "the beds actually stop" is a
     *  measurement rather than a claim. -1 when there is no audio graph. */
    getBedLevel: function () {
      if (!engineBus || !grindBus) return -1;
      return Math.max(engineBus.gain.value, grindBus.gain.value);
    }
  };
})();
