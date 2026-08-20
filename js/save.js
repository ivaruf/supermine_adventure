/* =============================================================================
 * SUPERMINE ADVENTURE — js/save.js
 * -----------------------------------------------------------------------------
 * THREE MINING COMPANIES IN localStorage. Each slot is one company: its cash,
 * its day counter, its machine, the mining rights it holds, and the state of
 * every mine it has dug — including the tunnels it left behind.
 *
 * ---------------------------------------------------------------------------
 * THE SAVE RECORD
 *   {
 *     v: 2,                        // SM.config.ADV.SAVE_VERSION
 *     company: 'Deep Rock Ltd',
 *     day: 47,
 *     cash: 128450,
 *     integrity: 0.62,             // HULL, as a 0..1 FRACTION. See the note below.
 *     rig: { drill:3, engine:2, ... },        // from SM.rig.getState()
 *     mines: {
 *       old_creek: {
 *         owned: true,
 *         levels: 2,                          // LIFT STATIONS bought, see below
 *         rails: [3, 1],                      // RAIL CHECKPOINTS bought per level
 *         visits: 12,
 *         deepestM: 173,                      // best depth reached, for the map card
 *         hauls: [3, 1],                      // QUALIFYING HAULS banked per level
 *         taught: 2,                          // unlock notice shown down to level 2
 *         carve: '<sparse>',                  // dug chunks, see below
 *         piles: [ [x, y, matIndex, units], ... ]   // cargo dumped underground
 *       }
 *     },
 *     seen: { foothills: 1, ... },  // world-map regions surveyed (js/advui.js)
 *     stats: { hauled: 0, bestHaul: 0, runs: 0 }
 *   }
 *
 * LIFT STATIONS — `levels` IS A COUNT, NOT A SET
 *   A company buys the levels of a mine strictly in order, cheapest (shallowest)
 *   first, so the only thing worth storing is HOW MANY: `levels: 3` means levels
 *   1, 2 and 3 are owned and 4 is the next one for sale. A set would let a save
 *   describe a lift with a hole in it, which no purchase path can produce and
 *   which every consumer would then have to defend against.
 *
 *   Level 0 is the SURFACE station. It is not stored: it is owned by definition
 *   the moment the company holds the mining rights, exactly as a price-0 mine is
 *   always `owned`. A missing or nonsense `levels` migrates to 0 — no levels
 *   bought — which is the only safe direction and is what every record written
 *   before the lift existed says.
 *
 * RAIL CHECKPOINTS — `rails` IS AN ARRAY OF COUNTS, ONE PER LEVEL
 *   Rails run EAST from the lift inside a single level, and checkpoints on a
 *   level are bought strictly outward, so the same argument as `levels` applies
 *   one dimension over: the only thing worth storing per level is HOW MANY.
 *   `rails: [3, 1]` means level 1 has checkpoints 1-3 and level 2 has checkpoint
 *   1; every deeper level has none. Index i is LEVEL i+1 — there is no entry for
 *   level 0, because the surface has no rails.
 *
 *   A missing, short or nonsense `rails` migrates to all-zero: no track bought.
 *   Same reasoning as `levels` — it is the only safe direction, it is what every
 *   record written before rails existed says, and it does not warrant a
 *   SAVE_VERSION bump (which would delete every existing company; see below).
 *
 * THE PROGRESSION GATE — `hauls` IS COUNTS PER LEVEL, `taught` IS A COUNT
 *   js/adv.js will not show the player the price of the next level down until
 *   they have banked N real hauls out of the level they are on AND can afford
 *   it. Both halves of that have to survive a reload or the gate would re-arm
 *   every session, so both are stored here:
 *
 *   `hauls` is one count per level, index i = LEVEL i+1 — the same shape and the
 *   same argument as `rails`. It counts QUALIFYING hauls only (js/adv.js decides
 *   what qualifies; a token one-unit sale does not), so it cannot be farmed.
 *
 *   `taught` is how deep the one-time "you may buy another level down" notice
 *   has been shown, as a level index. A COUNT for the third time in this file
 *   and for the third identical reason: reveals happen strictly in order, so
 *   there is no set to describe. `taught: 2` means the box for level 2 has been
 *   seen and will never be shown again; the box for level 3 has not.
 *
 *   Both migrate to zero, which is the only safe direction — see the note by
 *   each in validateMineState().
 *
 *   SECURED ORE IS NOT HERE, ON PURPOSE. Ore deposited at a checkpoint is RUN
 *   state: it is credited when the company next surfaces and it does not exist
 *   between runs. Reloading mid-run was never supported — there is nowhere to
 *   store "the machine is 400 m down with a part tank" — so persisting the
 *   secured ledger alone would let a reload bank it twice.
 *
 * HULL INTEGRITY — MIND THE UNITS
 *   Stored here as a 0..1 FRACTION, because that is what SM.adv.getIntegrity()
 *   is contracted to return and what js/adv.js reads and writes on this record.
 *   SM.mines.repairPrice() is quoted per POINT on a 0..100 scale, which is a
 *   different unit on purpose (money is quoted in whole points). The bridge in
 *   both directions is SM.mines.repairCost(fraction) -> whole dollars; never
 *   multiply repairPrice() by a fraction.
 *
 *   A record with no `integrity` migrates to 1.0 — a sound hull. That is the
 *   only safe direction: the alternative is inventing damage a player never
 *   took. It is also why this did NOT warrant a SAVE_VERSION bump, quite apart
 *   from js/config.js being frozen — validateRecord() drops any record whose `v`
 *   is not SAVE_VERSION, so bumping the version to add an optional field would
 *   delete every company that already exists to fix a missing number that
 *   defaults correctly anyway.
 *
 * >>> ADDING A FIELD: this validator DROPS keys it does not know, which makes
 * >>> every new field a silent data-loss bug until it is listed here. Two got in
 * >>> that way (`integrity` from js/adv.js and `seen` from js/advui.js: hull
 * >>> damage healed on reload and surveyed map regions re-fogged). If you write
 * >>> a new key on the record, ADD IT TO validateRecord() in the same commit —
 * >>> and if a value is mysteriously not persisting, call
 * >>> SM.save.getDroppedKeys() and it will be the first thing you see.
 *
 * THE CARVE STORE — why it is a string, and why it is sparse
 *   js/advterrain.js remembers what the player has dug. That is what makes
 *   tunnels PERSIST: geology is regenerated from the mine's seed every time rock
 *   streams in, and the store subtracts what is gone.
 *
 *   IT USED TO BE A FLAT BYTE PER CELL OF A FINITE MINE. A level map is endless
 *   east, west and south now (ARCHITECTURE.md §7), so there is nothing to size a
 *   flat array against; the store is a sparse map of 32x32-cell chunks, one BIT
 *   per cell, keyed on (level, chunkX, chunkY), and only chunks the player has
 *   actually touched exist at all.
 *
 *   The seam is exactly:
 *     SM.advterrain.exportCarve()   -> a descriptor (see below), or null
 *     SM.advterrain.importCarve(desc)
 *   Encode/decode must round-trip EXACTLY, and decode must survive garbage
 *   (a hand-edited localStorage, a half-written string) by returning null
 *   rather than throwing — a corrupt store should cost the player their tunnels,
 *   never their company.
 *
 * HARD RULES
 *   1. NEVER throw. localStorage is absent in private mode on some browsers and
 *      throws on quota. Every entry point is wrapped; failure degrades to
 *      "this session is not saved" and the game keeps running.
 *   2. Writes are DEBOUNCED, never per-frame. flush() on the real moments:
 *      extraction, purchase, day rollover.
 *   3. Validate on load. An unknown mine id or part key is dropped, not
 *      trusted — a save from a future build must not crash this one.
 *
 * =============================================================================
 * ================  DESIGN NOTES — THE CARVE CODEC  ===================
 * =============================================================================
 *
 * THE DESCRIPTOR CROSSING THE SEAM
 *
 *     { count, level: Int32Array, cx: Int32Array, cy: Int32Array,
 *       data: [Uint8Array(128), ...], chunkCells: 32, chunkBytes: 128 }
 *
 *   Parallel arrays, not an array of objects, because advterrain holds them as
 *   its live store and this file only ever reads them. Chunk i is `data[i]`,
 *   128 bytes = 1024 bits, ROW-MAJOR within the chunk (bit = cy*32 + cx).
 *
 * THE WIRE FORMAT
 *
 *     "2S," <chunkCount base36> "," <payload>
 *
 *   The leading "2" is the codec generation and it is checked: a v1 mask string
 *   starts "1A" or "1P" and is REJECTED here rather than mis-parsed, which is
 *   what makes an old tunnel set vanish cleanly instead of decoding into noise.
 *
 *   The payload is `chunkCount` records, each:
 *
 *     varint(level)  varint(zz(chunkX))  varint(zz(chunkY))  varint(head) body
 *
 *   `zz` is zigzag (n<0 ? -2n-1 : 2n), so a chunk west or north of the origin
 *   costs the same as one east or south of it. `head` is (n << 1) | fmt:
 *
 *     fmt 0  RUNS. `n` is the number of runs; the body is that many varint run
 *            lengths, alternating 0,1,0,1,... starting with the ZERO run, and
 *            they must sum to exactly 1024. A leading zero-length run is legal
 *            (and only legal) first, which is how a chunk whose very first cell
 *            is carved is expressed. A tunnel is contiguous along rows, so a
 *            real chunk is ~30 runs at ~2.2 characters each.
 *     fmt 1  RAW. `n` is 0; the body is exactly 205 symbols of 5 bits each,
 *            little-endian, carrying the 1024 bits. The fallback for a chunk so
 *            speckled that RLE would cost more than the bits do — which the
 *            drill's rectangular bite does not produce, but a save file is
 *            untrusted input and the decoder must not be able to be made to
 *            allocate unboundedly.
 *
 *   Run lengths and values are VARINTs over a 64-symbol alphabet, 5 data bits
 *   per symbol: symbol index < 32 is the LAST digit and carries that value,
 *   index >= 32 is a continuation carrying index-32. Little-endian groups.
 *
 *   The alphabet deliberately excludes ',' ':' '"' and '\\' so the payload is a
 *   single JSON string token and the header can be split on ',' with no
 *   escaping anywhere.
 *
 * WHY IT IS AS STRICT AS IT IS
 *   decodeCarve() rejects, rather than repairs: an unknown symbol, a truncated
 *   varint, a zero-length run anywhere except the very first of a chunk, a run
 *   sum that is not exactly 1024, a chunk count that disagrees with the payload,
 *   a coordinate outside CARVE_MAX_COORD, a level outside 1..MAX_LEVELS, or more
 *   than CARVE_MAX_CHUNKS chunks. All of those return null. Repairing a corrupt
 *   store would hand advterrain a plausible-looking set of tunnels that are not
 *   where it says they are, and the mine would generate solid rock inside the
 *   player's own workings. Losing the tunnels is recoverable; lying about them
 *   is not.
 *
 * MEASURED SIZE — the number that decides whether this fits in localStorage.
 *   A chunk covers 672 x 672 world units. A machine cuts a corridor about 300
 *   units wide at about 200 units/second, so an hour of driving over ground it
 *   has never seen touches roughly 480 chunks, each encoding to about 70
 *   characters: ~33 KB PER HOUR OF NOVEL DRIVING, per mine. Real play backtracks
 *   constantly and re-uses chunks for free. Against a 5 MB origin quota shared
 *   by three slots and seven mines that is comfortable, and writeRaw() still
 *   drops every store rather than fail if it ever is not.
 * ========================================================================== */

var SM = SM || {};

SM.save = (function () {
  'use strict';

  /* ----- Tunables live here ----------------------------------- */

  var DEBOUNCE_MS = 1200;      // markDirty() coalescing window
  var MAX_COMPANY = 22;        // characters; the slot card is a fixed width
  var MAX_PILES = 400;         // per mine, so a griefed save cannot balloon
  var MASK_MAX_CHARS = 600000; // sanity ceiling on an encoded carve string
  /* Ceilings on a DECODED carve store, so a hand-edited save cannot make this
   * allocate a gigabyte. CARVE_MAX_CHUNKS matches advterrain's own MAX_CHUNKS;
   * CARVE_MAX_COORD is +-2^20 chunks, which is +-704 million world units and far
   * beyond anything the biggest tank in the workshop can reach. */
  var CARVE_MAX_CHUNKS = 4096;
  var CARVE_MAX_COORD = 1 << 20;
  var CARVE_CELLS = 32;                    // cells per chunk side
  var CARVE_BITS = CARVE_CELLS * CARVE_CELLS;   // 1024
  var CARVE_BYTES = CARVE_BITS >> 3;            // 128
  var CARVE_RAW_SYMS = Math.ceil(CARVE_BITS / 5);  // 205
  var MAX_DAY = 100000;
  var MAX_CASH = 1e12;
  var MAX_SEEN = 64;           // world-map region keys; the catalogue has 7
  var MAX_KEY = 40;            // characters in any id used as an object key
  /* Lift stations bought in one mine. The deepest mine in the catalogue sells 4,
   * so this is a paranoia ceiling on a hand-edited save, not a game rule —
   * SM.adv clamps to what SM.mines.levelsOf() actually offers. */
  var MAX_LEVELS = 16;
  /* Rail checkpoints bought on ONE level. The catalogue sells 4, so this is the
   * same kind of paranoia ceiling as MAX_LEVELS — SM.adv clamps to what
   * SM.mines.checkpointsOf() actually offers. */
  var MAX_RAILS = 16;
  /* Qualifying hauls banked from ONE level (js/adv.js's progression gate). The
   * gate only ever asks "is this >= 2 or 3", so the counter is allowed to stop
   * climbing long before this — it is a ceiling on a hand-edited save, not a
   * game rule, and it keeps the stored number short. */
  var MAX_HAULS = 9999;

  /* Set true to have every key validateRecord() discards printed once. Left OFF
   * because the build's bar is zero console output, but the list is always
   * available through getDroppedKeys() whether this is on or not. */
  var DEBUG_SAVE = false;

  /* 64 JSON-safe symbols. Indices 0..31 terminate a varint, 32..63 continue it.
   * ',' ':' '"' and '\' are absent on purpose — see the design note. */
  var ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$_';
  var UNALPHA = null;          // char code -> index, built once below

  var A = SM.config.ADV;
  /* THE TESTER SLOT — one extra, hidden slot for TESTER MODE (see ui.js's
   * title-gate cheat code). It rides the same array, the same validator and
   * the same persistence as the three player slots, but listSlots() never
   * reports it, so no player-facing picker can see or touch it. An older
   * build reading the same key simply ignores the extra entry (its init
   * clamps to SAVE_SLOTS), so this is forward- and backward-compatible. */
  var TESTER_SLOT = A.SAVE_SLOTS;
  var SLOT_COUNT = A.SAVE_SLOTS + 1;   // player slots + the tester slot

  var slots = [];          // index -> record or null
  var active = -1;         // currently loaded slot, -1 = none
  var record = null;       // LIVE record for the active slot

  var available = false;   // localStorage actually works
  var lastError = '';      // human-readable reason the last write failed
  var dirty = false;
  var timer = 0;
  var listenersBound = false;

  /* =====================================================================
   * THE CARVE CODEC
   * ------------------------------------------------------------------
   * Kept at the top of the module and free of every other concern, because it
   * is the one piece of this file that has a provable contract.
   * ================================================================== */

  function buildUnalpha() {
    UNALPHA = new Int16Array(128);
    for (var i = 0; i < 128; i++) UNALPHA[i] = -1;
    for (i = 0; i < ALPHA.length; i++) UNALPHA[ALPHA.charCodeAt(i)] = i;
  }
  buildUnalpha();

  /** Little-endian base-32 varint. Appends to `parts`, which is joined once. */
  function putVarint(parts, n) {
    while (n >= 32) {
      parts.push(ALPHA.charAt(32 + (n % 32)));
      n = Math.floor(n / 32);
    }
    parts.push(ALPHA.charAt(n));
  }

  /** Zigzag, so a negative chunk coordinate costs what a positive one does. */
  function zz(n) { return n < 0 ? (-n * 2 - 1) : (n * 2); }
  function unzz(n) { return (n & 1) ? -((n + 1) / 2) : (n / 2); }

  /* THE VARINT READER, as a pair of module vars rather than a returned object.
   * decodeCarve() reads several hundred thousand of these on a big store and a
   * per-varint allocation would be the whole cost of the decode. `vPos` is the
   * cursor into the body and `vVal` the value; vRead() returns false on a
   * truncated or illegal varint and the caller bails the whole decode. */
  var vBody = '', vPos = 0, vVal = 0;
  function vRead() {
    var n = 0, mul = 1, code, d;
    while (vPos < vBody.length) {
      code = vBody.charCodeAt(vPos++);
      if (code > 127) return false;
      d = UNALPHA[code];
      if (d < 0) return false;
      if (d < 32) { vVal = n + d * mul; return true; }
      n += (d - 32) * mul; mul *= 32;
      if (mul > 1e12) return false;              // absurd varint: refuse it
    }
    return false;                                 // ran off the end mid-value
  }

  /**
   * Encode a carve descriptor (see the design note) to a string.
   * Returns '' for a null/empty store — '' is the canonical "no tunnels" value
   * and decodeCarve('') returns null, so the pair is closed.
   */
  function encodeCarve(desc) {
    try {
      if (!desc || !(desc.count > 0) || !desc.data) return '';
      var n = desc.count;
      if (n > CARVE_MAX_CHUNKS) n = CARVE_MAX_CHUNKS;
      if (desc.chunkBytes && desc.chunkBytes !== CARVE_BYTES) return '';

      var parts = ['2S,', n.toString(36), ','];
      var i, b, bits, runs, cur, run, k, sym, acc, accN;

      for (i = 0; i < n; i++) {
        b = desc.data[i];
        if (!b || b.length !== CARVE_BYTES) return '';
        putVarint(parts, desc.level[i] | 0);
        putVarint(parts, zz(desc.cx[i] | 0));
        putVarint(parts, zz(desc.cy[i] | 0));

        /* Count the runs first, so the head can carry the count and the decoder
         * never has to guess where a chunk ends. Cheap: one pass over 1024 bits
         * that the encoding pass would have made anyway. */
        runs = 0; cur = 0; run = 0;
        for (k = 0; k < CARVE_BITS; k++) {
          bits = (b[k >> 3] >> (k & 7)) & 1;
          if (bits === cur) { run++; continue; }
          runs++; cur = bits; run = 1;
        }
        runs++;                                   // the final run

        /* RAW when the runs would cost more than the bits do. `runs` varints of
         * at most two symbols each against a flat 205, so the crossover is about
         * 102 runs — a threshold a rectangular drill bite never reaches and a
         * pathological save file does. */
        if (runs > CARVE_RAW_SYMS) {
          putVarint(parts, 1);                    // head: n = 0, fmt = 1 (raw)
          acc = 0; accN = 0;
          for (k = 0; k < CARVE_BITS; k++) {
            acc |= (((b[k >> 3] >> (k & 7)) & 1) << accN);
            if (++accN === 5) { parts.push(ALPHA.charAt(acc)); acc = 0; accN = 0; }
          }
          if (accN > 0) parts.push(ALPHA.charAt(acc));
          continue;
        }

        putVarint(parts, runs << 1);              // head: n = runs, fmt = 0
        cur = 0; run = 0;
        for (k = 0; k < CARVE_BITS; k++) {
          bits = (b[k >> 3] >> (k & 7)) & 1;
          if (bits === cur) { run++; continue; }
          putVarint(parts, run);                  // may be 0, and only for k = 0
          cur = bits; run = 1;
        }
        putVarint(parts, run);
      }
      var s = parts.join('');
      return s.length > MASK_MAX_CHARS ? '' : s;
    } catch (e) {
      return '';
    }
  }

  /**
   * Decode a carve string back into a descriptor advterrain can adopt.
   * -> {count, level, cx, cy, data, chunkCells, chunkBytes} or null. Never throws.
   *
   * A v1 mask string ("1A..." / "1P...") is REJECTED here rather than parsed: it
   * described a flat array of a finite mine and there is nothing honest to turn
   * it into. See the migration note in validateRecord().
   */
  function decodeCarve(str) {
    try {
      if (typeof str !== 'string') return null;
      if (str.length < 5 || str.length > MASK_MAX_CHARS) return null;
      if (str.charAt(0) !== '2' || str.charAt(1) !== 'S') return null;

      /* The payload alphabet excludes ',', so a well-formed string has exactly
       * two of them and the count is pure base-36. Checking the SHAPE before
       * parseInt matters: parseInt('1.5', 36) is 1, so a sloppy header would
       * otherwise decode to a plausible-looking count. */
      var f = str.split(',');
      if (f.length !== 3) return null;
      if (f[0].length !== 2) return null;
      if (!/^[0-9a-z]{1,4}$/.test(f[1])) return null;

      var n = parseInt(f[1], 36);
      if (!(n >= 0) || n !== Math.floor(n) || n > CARVE_MAX_CHUNKS) return null;
      if (n === 0) return null;

      vBody = f[2]; vPos = 0;

      var out = {
        count: 0,
        level: new Int32Array(n),
        cx: new Int32Array(n),
        cy: new Int32Array(n),
        data: new Array(n),
        chunkCells: CARVE_CELLS,
        chunkBytes: CARVE_BYTES
      };

      var i, k, lv, x, y, head, runs, b, want, written, r, acc, sym, bit;
      for (i = 0; i < n; i++) {
        if (!vRead()) return null;
        lv = vVal;
        if (lv < 0 || lv > MAX_LEVELS) return null;
        if (!vRead()) return null;
        x = unzz(vVal);
        if (x < -CARVE_MAX_COORD || x > CARVE_MAX_COORD) return null;
        if (!vRead()) return null;
        y = unzz(vVal);
        if (y < -CARVE_MAX_COORD || y > CARVE_MAX_COORD) return null;
        if (!vRead()) return null;
        head = vVal;

        b = new Uint8Array(CARVE_BYTES);

        if ((head & 1) === 1) {
          /* --- RAW: exactly CARVE_RAW_SYMS symbols of five bits each. */
          if ((head >> 1) !== 0) return null;
          if (vPos + CARVE_RAW_SYMS > vBody.length) return null;
          for (k = 0; k < CARVE_BITS; ) {
            sym = UNALPHA[vBody.charCodeAt(vPos++)];
            if (sym === undefined || sym < 0 || sym >= 32) return null;
            for (r = 0; r < 5 && k < CARVE_BITS; r++, k++) {
              if ((sym >> r) & 1) b[k >> 3] |= (1 << (k & 7));
            }
          }
        } else {
          /* --- RUNS: alternating 0,1,0,1..., summing to exactly CARVE_BITS. */
          runs = head >> 1;
          if (runs < 1 || runs > CARVE_BITS) return null;
          want = 0; written = 0;
          for (r = 0; r < runs; r++) {
            if (!vRead()) return null;
            if (vVal === 0 && r !== 0) return null;   // only run 0 may be empty
            if (written + vVal > CARVE_BITS) return null;
            if (want === 1) {
              for (k = written; k < written + vVal; k++) b[k >> 3] |= (1 << (k & 7));
            }
            written += vVal;
            want ^= 1;
          }
          if (written !== CARVE_BITS) return null;
        }

        out.level[i] = lv; out.cx[i] = x; out.cy[i] = y;
        out.data[i] = b;
      }
      if (vPos !== vBody.length) return null;        // trailing junk
      out.count = n;
      return out;
    } catch (e) {
      return null;
    } finally {
      vBody = '';                                    // do not pin a big string
    }
  }

  /* =====================================================================
   * localStorage PLUMBING — nothing below this line may throw
   * ================================================================== */

  function store() {
    try {
      return (typeof localStorage !== 'undefined') ? localStorage : null;
    } catch (e) {
      return null;                 // Safari private mode throws on the getter
    }
  }

  function probeStorage() {
    var s = store();
    if (!s) { lastError = 'localStorage unavailable'; return false; }
    try {
      s.setItem(A.SAVE_KEY + '.probe', '1');
      s.removeItem(A.SAVE_KEY + '.probe');
      return true;
    } catch (e) {
      lastError = 'localStorage is read-only or full';
      return false;
    }
  }

  function readRaw() {
    var s = store();
    if (!s) return null;
    try {
      return s.getItem(A.SAVE_KEY);
    } catch (e) {
      return null;
    }
  }

  /**
   * The only place anything is written. Two-stage degradation: a quota failure
   * retries WITHOUT the carve masks, because tunnels are the one part of a
   * company that is cheap to lose and expensive to store.
   */
  function writeRaw() {
    var s = store();
    if (!s) { available = false; return false; }

    /* NOTHING TO SAVE -> LEAVE NO TRACE. Every slot null means either the player
     * has never started a company or has just erased their last one. Writing
     * `{v:1,slots:[null,null,null]}` in that state would put a key in
     * localStorage for somebody who only ever played TIME ATTACK — and the
     * pagehide flush below means that would happen on the FIRST page unload, to
     * everyone. Removing it also does the right thing for the erase case. */
    var anySlot = false, si;
    for (si = 0; si < slots.length; si++) { if (slots[si]) { anySlot = true; break; } }
    if (!anySlot) {
      try { s.removeItem(A.SAVE_KEY); lastError = ''; return true; }
      catch (e) { return false; }
    }

    var payload = { v: A.SAVE_VERSION, slots: slots };
    var text;
    try {
      text = JSON.stringify(payload);
    } catch (e) {
      lastError = 'save could not be serialised';
      return false;
    }
    try {
      s.setItem(A.SAVE_KEY, text);
      lastError = '';
      return true;
    } catch (e) {
      lastError = 'storage full — tunnels dropped';
    }
    /* Retry with every carve store stripped. */
    try {
      var lean = JSON.parse(text);
      var i, id;
      for (i = 0; i < lean.slots.length; i++) {
        if (!lean.slots[i] || !lean.slots[i].mines) continue;
        for (id in lean.slots[i].mines) {
          if (!lean.slots[i].mines.hasOwnProperty(id)) continue;
          lean.slots[i].mines[id].carve = '';
        }
      }
      s.setItem(A.SAVE_KEY, JSON.stringify(lean));
      return true;
    } catch (e2) {
      available = false;
      lastError = 'storage full — this session will not be saved';
      return false;
    }
  }

  /* =====================================================================
   * VALIDATION
   * ------------------------------------------------------------------
   * A record that came off disk is UNTRUSTED input: another build wrote it, or
   * the player edited it, or a quota failure truncated it. Everything is coerced
   * into range; anything unrecognisable is dropped rather than repaired.
   * ================================================================== */

  function num(v, dflt, lo, hi) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    if (!(n === n) || n === Infinity || n === -Infinity) return dflt;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  function str(v, dflt, maxLen) {
    if (typeof v !== 'string') return dflt;
    var s = v.replace(/[\x00-\x1f]/g, '').substring(0, maxLen);
    return s.length ? s : dflt;
  }

  /* --- dropped-key diagnostics ----------------------------------------
   * Dropping unknown keys is the right behaviour for untrusted input, but it
   * turns "I added a field and it does not persist" into a bug you can only find
   * by measuring the game. So every discarded key is remembered, once, under the
   * path it appeared at ('record.integrity', 'mines[old_creek].foo'), and
   * getDroppedKeys() hands the list to whoever is confused. */
  var dropped = [];
  var droppedSeen = Object.create(null);

  function noteDropped(path) {
    if (droppedSeen[path]) return;
    droppedSeen[path] = 1;
    if (dropped.length < 64) dropped.push(path);
    if (DEBUG_SAVE && typeof console !== 'undefined' && console.warn) {
      console.warn('SM.save: dropped unknown save key "' + path +
                   '" — add it to validateRecord() in js/save.js');
    }
  }

  /** Keys validateRecord() has discarded this session. Read-only. */
  function getDroppedKeys() { return dropped; }

  /* Walk an incoming object and note every key that is not in `known`. */
  function auditKeys(obj, known, prefix) {
    if (!obj || typeof obj !== 'object') return;
    for (var k in obj) {
      if (!obj.hasOwnProperty(k)) continue;
      if (known.indexOf(k) < 0) noteDropped(prefix + '.' + k);
    }
  }

  var RECORD_KEYS = ['v', 'company', 'day', 'cash', 'integrity', 'rig',
                     'mines', 'seen', 'stats', 'worldSeed'];
  /* `mask` is listed and never read: it is v1's flat carve mask, and leaving it
   * in the known set is what stops a migrated record filling getDroppedKeys()
   * with a key that was dropped on purpose. `carve` is v2's sparse store. */
  var MINE_KEYS = ['owned', 'levels', 'rails', 'visits', 'deepestM', 'mask',
                   'carve', 'piles', 'hauls', 'taught'];

  function knownMine(id) {
    if (!SM.mines || !SM.mines.count || SM.mines.count() === 0) return true;
    return !!SM.mines.get(id);
  }

  function blankMineState() {
    return { owned: false, levels: 0, rails: [], visits: 0, deepestM: 0,
             carve: '', piles: [], hauls: [], taught: 0 };
  }

  function validateMineState(o) {
    var out = blankMineState();
    if (!o || typeof o !== 'object') return out;
    auditKeys(o, MINE_KEYS, 'mines[]');
    out.owned = !!o.owned;
    /* LIFT STATIONS BOUGHT, as a count. Missing -> 0: a company from before the
     * lift existed owns the surface station and nothing else, which is exactly
     * how it played. See the header note. */
    out.levels = Math.floor(num(o.levels, 0, 0, MAX_LEVELS));
    /* RAIL CHECKPOINTS BOUGHT, one count per level, index i = level i+1. Missing
     * or short -> zeros: a company from before rails owns no track. See the
     * header note. Written back as a dense array so JSON.stringify cannot turn a
     * hole into `null` and hand the next load a NaN. */
    out.rails = [];
    /* `typeof === 'object'` as well as a numeric length, because a STRING is
     * array-like: without it a hand-edited `"rails": "3"` decodes to [3] — one
     * checkpoint the player never bought. Measured; it is the only shape in this
     * validator that could be read as something it is not. */
    if (o.rails && typeof o.rails === 'object' &&
        typeof o.rails.length === 'number') {
      var nl = o.rails.length < MAX_LEVELS ? o.rails.length : MAX_LEVELS;
      for (var r = 0; r < nl; r++) {
        out.rails.push(Math.floor(num(o.rails[r], 0, 0, MAX_RAILS)));
      }
    }
    out.visits = Math.floor(num(o.visits, 0, 0, 1e7));
    out.deepestM = Math.floor(num(o.deepestM, 0, 0, 1e6));
    /* QUALIFYING HAULS BANKED PER LEVEL, index i = level i+1. Exactly the shape
     * and exactly the argument as `rails` one dimension over: the progression
     * gate (js/adv.js) asks "how many real hauls has this company brought up
     * from level k", and a count per level is the only thing worth storing.
     * Missing or short -> zeros, which is what every record written before the
     * gate existed says and is the only safe direction: a company that reloads
     * into "you have not proved this level yet" has lost nothing it can see,
     * whereas inventing hauls would hand out a purchase nobody earned. */
    out.hauls = [];
    /* `typeof === 'object'` as well as a numeric length, for the same reason
     * `rails` needs it: a hand-edited `"hauls": "3"` is array-like and would
     * decode to [3]. */
    if (o.hauls && typeof o.hauls === 'object' &&
        typeof o.hauls.length === 'number') {
      var nh = o.hauls.length < MAX_LEVELS ? o.hauls.length : MAX_LEVELS;
      for (var h = 0; h < nh; h++) {
        out.hauls.push(Math.floor(num(o.hauls[h], 0, 0, MAX_HAULS)));
      }
    }
    /* HOW FAR THE UNLOCK NOTICE HAS BEEN SHOWN, as a level index — a COUNT, not
     * a set, for the third time in this validator and for the third identical
     * reason: reveals happen strictly in order, so `taught: 2` means "the box
     * that says level 2 may now be bought has been seen" and nothing else is
     * expressible. Missing -> 0: an existing company gets the notice once at
     * whatever rung it is on, which is the correct behaviour for a feature that
     * did not exist when the record was written. */
    out.taught = Math.floor(num(o.taught, 0, 0, MAX_LEVELS));
    /* THE SPARSE CARVE STORE. `o.mask` — v1's flat one — is deliberately not
     * consulted: it described a byte per cell of a finite mine, and there is
     * nothing honest to turn that into now that a level map is endless. A
     * migrated company keeps its money, its machine and its levels and loses its
     * tunnels; see the migration note in validateRecord(). */
    out.carve = (typeof o.carve === 'string' && o.carve.length <= MASK_MAX_CHARS)
      ? o.carve : '';
    out.piles = [];
    if (o.piles && o.piles.length) {
      var n = o.piles.length < MAX_PILES ? o.piles.length : MAX_PILES;
      for (var i = 0; i < n; i++) {
        var p = o.piles[i];
        if (!p || p.length < 4) continue;
        var x = num(p[0], NaN, -1e7, 1e7);
        var y = num(p[1], NaN, -1e7, 1e7);
        var mi = Math.floor(num(p[2], -1, 0, 255));
        var un = num(p[3], 0, 0, 1e6);
        if (!(x === x) || !(y === y) || mi < 0 || !(un > 0)) continue;
        out.piles.push([x, y, mi, un]);
      }
    }
    return out;
  }

  function validateRig(o) {
    var out = {}, keys = (SM.rig && SM.rig.PART_KEYS) ? SM.rig.PART_KEYS : [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var max = (SM.rig && SM.rig.maxTier) ? SM.rig.maxTier(k) : 0;
      out[k] = Math.floor(num(o ? o[k] : 0, 0, 0, max));
    }
    return out;
  }

  /* HOW FAR BACK A RECORD MAY COME FROM. Anything at or above this and below
   * SAVE_VERSION is migrated in place rather than dropped. */
  var MIN_MIGRATABLE_VERSION = 1;

  function validateRecord(o) {
    if (!o || typeof o !== 'object') return null;
    /* VERSION GATE, AND THE ONE MIGRATION.
     *
     * A record from the FUTURE is still dropped — the slot reads as empty rather
     * than as a corrupt company, because this build cannot know what a later one
     * meant. A record from v1 is MIGRATED, and the migration is deliberately
     * cheap and lossy in exactly one place:
     *
     *   KEPT   company, day, cash, integrity, rig, mines owned, levels bought,
     *          rails bought, visits, deepestM, dumped piles, surveyed regions,
     *          lifetime stats. Everything a player worked for.
     *   LOST   TUNNELS. v1's carve mask was one byte per cell of a mine that was
     *          a finite box; a level map is endless in three directions now and
     *          keyed per level, and there is no honest mapping from one to the
     *          other. Inventing one would put solid rock inside workings the
     *          player remembers digging, which is worse than a clean slate.
     *
     * Everything else falls out for free, because every field below already
     * defaults correctly for a record that does not carry it. Nothing else in
     * this validator needs to know a migration happened.
     */
    var v = Math.floor(num(o.v, -1, -1, 1e6));
    if (v > A.SAVE_VERSION) return null;
    if (v < MIN_MIGRATABLE_VERSION) return null;

    auditKeys(o, RECORD_KEYS, 'record');

    var rec = {
      v: A.SAVE_VERSION,
      company: str(o.company, 'UNNAMED', MAX_COMPANY),
      day: Math.floor(num(o.day, 1, 1, MAX_DAY)),
      /* Floor, not round: js/adv.js already rounds a sale's gross to whole
       * dollars at the moment it becomes money, precisely so this floor is a
       * no-op and the ledger cannot drift by a dollar across a save. Every other
       * money source is integral by construction (fuelCost and repairCost ceil,
       * part and rights prices are literals), so cash arrives here integral. */
      cash: Math.floor(num(o.cash, 0, 0, MAX_CASH)),
      /* HULL, 0..1. Missing -> 1.0, a sound hull: see the units note in the
       * header. NOT clamped through Math.floor — this one is a fraction. */
      integrity: num(o.integrity, 1, 0, 1),
      rig: validateRig(o.rig),
      mines: {},
      seen: {},
      stats: {
        hauled: Math.floor(num(o.stats ? o.stats.hauled : 0, 0, 0, MAX_CASH)),
        bestHaul: Math.floor(num(o.stats ? o.stats.bestHaul : 0, 0, 0, MAX_CASH)),
        runs: Math.floor(num(o.stats ? o.stats.runs : 0, 0, 0, 1e7))
      },
      /* Missing on every record written before it existed -> 0, the legacy
       * world: those companies keep the exact geology their tunnels were dug
       * against. See freshRecord() for why 0 is reserved. */
      worldSeed: Math.floor(num(o.worldSeed, 0, 0, 0x7fffffff))
    };
    if (o.stats && typeof o.stats === 'object') {
      auditKeys(o.stats, ['hauled', 'bestHaul', 'runs'], 'record.stats');
    }
    if (o.mines && typeof o.mines === 'object') {
      for (var id in o.mines) {
        if (!o.mines.hasOwnProperty(id)) continue;
        if (typeof id !== 'string' || id.length > MAX_KEY) continue;
        if (!knownMine(id)) continue;              // a mine this build removed
        rec.mines[id] = validateMineState(o.mines[id]);
      }
    }
    /* SURVEYED WORLD-MAP REGIONS (js/advui.js). Validated STRUCTURALLY rather
     * than against SM.mines.regions(), because the region key is advui's to
     * choose (it slugifies) and coupling this validator to another module's
     * naming would drop legitimate data the day they rename one. A bounded
     * number of bounded string keys, every value normalised to 1. */
    if (o.seen && typeof o.seen === 'object') {
      var kept = 0;
      for (var rk in o.seen) {
        if (!o.seen.hasOwnProperty(rk)) continue;
        if (typeof rk !== 'string' || !rk.length || rk.length > MAX_KEY) continue;
        if (!o.seen[rk]) continue;
        if (++kept > MAX_SEEN) break;
        rec.seen[rk] = 1;
      }
    }
    return rec;
  }

  function freshRecord(companyName) {
    var rec = {
      v: A.SAVE_VERSION,
      company: str(companyName, 'NEW VENTURE', MAX_COMPANY),
      day: 1,
      cash: (SM.mines && SM.mines.startingCash) ? SM.mines.startingCash() : 900,
      integrity: 1,              // a new company's machine is battered, not broken
      rig: (SM.rig && SM.rig.getState) ? SM.rig.getState() : {},
      mines: {},
      seen: {},
      stats: { hauled: 0, bestHaul: 0, runs: 0 },
      /* THE COMPANY'S OWN WORLD. Rolled once, here, and never again: advterrain
       * folds it into every mine's catalogue seed, so two companies dig two
       * different Old Creeks while each company's own geology stays eternal
       * (tunnels are diffs against regenerable rock — the seed IS the rock).
       * Zero is reserved to mean "legacy record, pure catalogue seed", which is
       * why a fresh roll may never produce it. */
      worldSeed: ((Math.random() * 0x7fffffff) | 0) || 1
    };
    /* The starter mine's rights come with the company. */
    var starter = (SM.mines && SM.mines.getStarterId) ? SM.mines.getStarterId() : null;
    if (starter) {
      rec.mines[starter] = blankMineState();
      rec.mines[starter].owned = true;
    }
    return rec;
  }

  /* =====================================================================
   * LIFECYCLE
   * ================================================================== */

  function init() {
    var i;
    slots = [];
    for (i = 0; i < SLOT_COUNT; i++) slots.push(null);
    active = -1;
    record = null;
    dirty = false;

    available = probeStorage();
    if (available) {
      var raw = readRaw();
      if (raw) {
        var parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
        if (parsed && parsed.slots && parsed.slots.length) {
          var n = parsed.slots.length < SLOT_COUNT ? parsed.slots.length : SLOT_COUNT;
          for (i = 0; i < n; i++) slots[i] = validateRecord(parsed.slots[i]);
        }
      }
    }
    bindListeners();
  }

  /* A tab close or an app switch is the one moment a debounced write would be
   * lost, so both are flush points. No layout is read and nothing is built —
   * this is a listener, not DOM work in the fixed step. */
  function bindListeners() {
    if (listenersBound) return;
    listenersBound = true;
    try {
      if (typeof window === 'undefined' || !window.addEventListener) return;
      window.addEventListener('pagehide', flush, false);
      window.addEventListener('beforeunload', flush, false);
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'hidden') flush();
        }, false);
      }
    } catch (e) { /* no window: nothing to bind, nothing to lose */ }
  }

  /* =====================================================================
   * SLOT MANAGEMENT
   * ================================================================== */

  function tierOfRig(rigState) {
    if (!rigState) return 1;
    var keys = (SM.rig && SM.rig.PART_KEYS) ? SM.rig.PART_KEYS : [];
    if (!keys.length) return 1;
    var sum = 0;
    for (var i = 0; i < keys.length; i++) sum += num(rigState[keys[i]], 0, 0, 99);
    return 1 + Math.floor(sum / keys.length);
  }

  function ownedIn(rec) {
    var n = 0, id;
    if (!rec || !rec.mines) return 0;
    for (id in rec.mines) {
      if (rec.mines.hasOwnProperty(id) && rec.mines[id].owned) n++;
    }
    return n;
  }

  /** Summaries for the slot picker. Always A.SAVE_SLOTS entries, never null. */
  function listSlots() {
    var out = [], i, r;
    for (i = 0; i < A.SAVE_SLOTS; i++) {
      r = slots[i];
      if (!r) {
        out.push({ index: i, empty: true, company: '', day: 0, cash: 0, tier: 0, mines: 0 });
      } else {
        out.push({
          index: i,
          empty: false,
          company: r.company,
          day: r.day,
          cash: r.cash,
          /* The ACTIVE slot's machine is the live one; a stored slot is read
           * off its own rig object. Both go through the same arithmetic. */
          tier: (i === active && SM.rig && SM.rig.getMachineTier)
            ? SM.rig.getMachineTier() : tierOfRig(r.rig),
          mines: ownedIn(r)
        });
      }
    }
    return out;
  }

  /** The tester slot's card, in listSlots()'s shape. Never part of listSlots:
   *  the player-facing picker must stay three slots wide. */
  function testerSummary() {
    var r = slots[TESTER_SLOT];
    if (!r) return { index: TESTER_SLOT, empty: true, company: '', day: 0, cash: 0, tier: 0, mines: 0 };
    return {
      index: TESTER_SLOT,
      empty: false,
      company: r.company,
      day: r.day,
      cash: r.cash,
      tier: (TESTER_SLOT === active && SM.rig && SM.rig.getMachineTier)
        ? SM.rig.getMachineTier() : tierOfRig(r.rig),
      mines: ownedIn(r)
    };
  }

  /** TESTER MODE's money tap: add `delta` dollars to a STORED slot's ledger.
   *  Title-screen tool only — js/adv.js caches cash while a campaign is live
   *  and re-reads record.cash in startCompany(), so granting from the title
   *  (campaign off) can never desync the live ledger. -> the new balance. */
  function grantCash(slot, delta) {
    var i = Math.floor(num(slot, -1, -1, TESTER_SLOT));
    if (i < 0 || !slots[i]) return 0;
    var c = Math.floor(num(slots[i].cash, 0, 0, MAX_CASH) + num(delta, 0));
    if (c < 0) c = 0;
    if (c > MAX_CASH) c = MAX_CASH;
    slots[i].cash = c;
    flush();
    return c;
  }

  /** Create a company in `slot`, make it active, and persist. -> the record. */
  function newGame(slot, companyName) {
    try {
      var i = Math.floor(num(slot, -1, -1, TESTER_SLOT));
      if (i < 0) return null;
      if (SM.rig && SM.rig.reset) SM.rig.reset();
      var rec = freshRecord(companyName);
      slots[i] = rec;
      active = i;
      record = rec;
      flush();
      return rec;
    } catch (e) {
      return null;
    }
  }

  /** Make an existing slot active. -> true if it loaded. */
  function load(slot) {
    try {
      var i = Math.floor(num(slot, -1, -1, TESTER_SLOT));
      if (i < 0 || !slots[i]) return false;
      active = i;
      record = slots[i];
      /* The machine is state, and this is the only module that owns its
       * persistence, so installing it belongs here rather than in adv.js. */
      if (SM.rig && SM.rig.applyState) SM.rig.applyState(record.rig);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Wipe a slot. Refuses nothing; the confirm lives in the UI. */
  function erase(slot) {
    try {
      var i = Math.floor(num(slot, -1, -1, TESTER_SLOT));
      if (i < 0) return;
      slots[i] = null;
      if (active === i) { active = -1; record = null; }
      flush();
    } catch (e) { /* never throw */ }
  }

  function getActiveSlot() { return active; }
  function isLoaded() { return !!record; }
  /** The LIVE record. Mutate it, then markDirty(). */
  function get() { return record; }
  /** False when this session is running without persistence. */
  function isAvailable() { return available; }
  /** Why the last write failed, or ''. The prep screen can surface this. */
  function getError() { return lastError; }

  /* =====================================================================
   * WRITING
   * ================================================================== */

  function markDirty() {
    dirty = true;
    if (timer) return;
    try {
      if (typeof setTimeout !== 'function') return;
      timer = setTimeout(function () { timer = 0; flush(); }, DEBOUNCE_MS);
    } catch (e) { timer = 0; }
  }

  /** Write now, synchronously. Call on extraction, purchase, day rollover. */
  function flush() {
    try {
      if (timer) {
        try { clearTimeout(timer); } catch (e) { /* ignore */ }
        timer = 0;
      }
      /* No early-out on `dirty`: erase() and newGame() both flush with the
       * record in whatever state they just left it, and a write is cheap enough
       * that "someone asked" is reason enough.
       *
       * The machine's tiers live in js/rig.js; snapshot them here so no caller
       * has to remember to. */
      if (record && SM.rig && SM.rig.getState) record.rig = SM.rig.getState();

      /* HULL. Repaired into range if it is missing or nonsense, but deliberately
       * NOT pulled from SM.adv.getIntegrity(): newGame() flushes a brand new
       * record BEFORE js/adv.js has adopted it, so a snapshot here would stamp
       * the outgoing company's hull damage onto the incoming one. js/adv.js owns
       * the value and writes it on damage, on repair and on sale — exactly as it
       * owns `cash` and `day`, which are not snapshotted either. */
      if (record && !(typeof record.integrity === 'number' &&
                      record.integrity >= 0 && record.integrity <= 1)) {
        record.integrity = 1;
      }
      dirty = false;
      if (!available) return;
      writeRaw();
    } catch (e) {
      dirty = false;
    }
  }

  /* =====================================================================
   * PER-MINE STATE
   * ================================================================== */

  /** Mine state for `id`, created empty (and unowned) if it has never existed. */
  function mineState(id) {
    if (!record || typeof id !== 'string') return null;
    if (!record.mines) record.mines = {};
    var m = record.mines[id];
    if (!m) {
      /* Created but NOT marked dirty: an all-default entry carries no
       * information, so losing it costs the player nothing and reading the map
       * should not schedule a write. */
      m = blankMineState();
      record.mines[id] = m;
    }
    return m;
  }

  function isOwned(id) {
    /* A price-0 mine is always owned. This is deliberate belt-and-braces: it
     * means a truncated or hand-edited save can never leave a company with no
     * mine it is allowed to enter. */
    if (SM.mines && SM.mines.get) {
      var def = SM.mines.get(id);
      if (def && def.price === 0) return true;
    }
    var m = record && record.mines ? record.mines[id] : null;
    return !!(m && m.owned);
  }

  function setOwned(id, on) {
    var m = mineState(id);
    if (!m) return;
    m.owned = !!on;
    markDirty();
  }

  function ownedCount() { return ownedIn(record); }

  /* --- lift stations ---------------------------------------------------
   * Named levelsOwned/setLevelsOwned rather than get/setLevels on purpose:
   * SM.adv.getLevels() returns the STATION TABLE and these return a COUNT, and
   * two functions one namespace apart with the same name and different units is
   * how a bug gets written twice. */

  /** How many lift levels are bought in this mine. 0 when nothing is loaded. */
  function levelsOwned(id) {
    var m = record && record.mines ? record.mines[id] : null;
    if (!m) return 0;
    var n = Math.floor(num(m.levels, 0, 0, MAX_LEVELS));
    return n;
  }
  /** Persist the count. SM.adv is the only caller; it clamps to the catalogue. */
  function setLevelsOwned(id, n) {
    var m = mineState(id);
    if (!m) return false;
    m.levels = Math.floor(num(n, 0, 0, MAX_LEVELS));
    markDirty();
    return true;
  }

  /* --- rail checkpoints ------------------------------------------------
   * Per LEVEL, so both of these take one. Named railsOwned/setRailsOwned to
   * rhyme with levelsOwned/setLevelsOwned for exactly the same reason: a COUNT
   * and a TABLE must not share a name. */

  /** How many checkpoints are bought on level `L` (1-based) of this mine. */
  function railsOwned(id, L) {
    var m = record && record.mines ? record.mines[id] : null;
    if (!m || !m.rails) return 0;
    var i = Math.floor(num(L, 0, 0, MAX_LEVELS)) - 1;
    if (i < 0 || i >= m.rails.length) return 0;
    return Math.floor(num(m.rails[i], 0, 0, MAX_RAILS));
  }

  /** Persist it. SM.adv is the only caller; it clamps to the catalogue. */
  function setRailsOwned(id, L, n) {
    var m = mineState(id);
    if (!m) return false;
    var i = Math.floor(num(L, 0, 0, MAX_LEVELS)) - 1;
    if (i < 0) return false;
    if (!m.rails || typeof m.rails.length !== 'number') m.rails = [];
    // Dense: pad with zeros rather than leaving holes JSON would write as null.
    while (m.rails.length <= i) m.rails.push(0);
    m.rails[i] = Math.floor(num(n, 0, 0, MAX_RAILS));
    markDirty();
    return true;
  }

  /* --- the progression gate -------------------------------------------
   * Two counts, both per mine, both written only by js/adv.js — which owns what
   * a "qualifying haul" is and when the notice has been seen. This file only
   * stores them, exactly as it only stores `levels` and `rails`.
   *
   * Named haulsFrom/setHaulsFrom and noticeShown/setNoticeShown rather than
   * get/setHauls and get/setTaught for the reason the block above gives twice:
   * a name that could be read as a TABLE must not return a COUNT. */

  /** Qualifying hauls banked from level `L` (1-based) of this mine. */
  function haulsFrom(id, L) {
    var m = record && record.mines ? record.mines[id] : null;
    if (!m || !m.hauls) return 0;
    var i = Math.floor(num(L, 0, 0, MAX_LEVELS)) - 1;
    if (i < 0 || i >= m.hauls.length) return 0;
    return Math.floor(num(m.hauls[i], 0, 0, MAX_HAULS));
  }

  /** Persist it. Dense, for the reason setRailsOwned() gives. */
  function setHaulsFrom(id, L, n) {
    var m = mineState(id);
    if (!m) return false;
    var i = Math.floor(num(L, 0, 0, MAX_LEVELS)) - 1;
    if (i < 0) return false;
    if (!m.hauls || typeof m.hauls.length !== 'number') m.hauls = [];
    while (m.hauls.length <= i) m.hauls.push(0);
    m.hauls[i] = Math.floor(num(n, 0, 0, MAX_HAULS));
    markDirty();
    return true;
  }

  /** The deepest level whose "you may buy down" notice has been shown. */
  function noticeShown(id) {
    var m = record && record.mines ? record.mines[id] : null;
    if (!m) return 0;
    return Math.floor(num(m.taught, 0, 0, MAX_LEVELS));
  }

  /** Persist it. Monotonic in js/adv.js; clamped here regardless. */
  function setNoticeShown(id, n) {
    var m = mineState(id);
    if (!m) return false;
    m.taught = Math.floor(num(n, 0, 0, MAX_LEVELS));
    markDirty();
    return true;
  }

  /* --- hull integrity -------------------------------------------------
   * js/adv.js may keep writing record.integrity directly; these exist so that
   * nothing ELSE has to know whether the stored unit is a fraction or a point.
   * Both speak the 0..1 FRACTION that SM.adv.getIntegrity() speaks. To turn one
   * into money, use SM.mines.repairCost(fraction). */

  /** Hull integrity as a 0..1 fraction. 1 when no company is loaded. */
  function getIntegrity() {
    if (!record) return 1;
    return (typeof record.integrity === 'number' &&
            record.integrity >= 0 && record.integrity <= 1) ? record.integrity : 1;
  }
  /** Persist hull integrity. Accepts 0..1; anything else is clamped. */
  function setIntegrity(frac) {
    if (!record) return false;
    record.integrity = num(frac, 1, 0, 1);
    markDirty();
    return true;
  }

  /* --- surveyed world-map regions (js/advui.js) ------------------------ */
  function isSeen(regionKey) {
    return !!(record && record.seen && record.seen[regionKey]);
  }
  function setSeen(regionKey) {
    if (!record || typeof regionKey !== 'string' || !regionKey.length ||
        regionKey.length > MAX_KEY) return false;
    if (!record.seen) record.seen = {};
    if (record.seen[regionKey]) return true;          // already surveyed
    var n = 0;
    for (var k in record.seen) { if (record.seen.hasOwnProperty(k)) n++; }
    if (n >= MAX_SEEN) return false;
    record.seen[regionKey] = 1;
    markDirty();
    return true;
  }

  /* --- convenience writes: the seams other modules actually use -------- */

  /** Store a mine's carve store. Accepts an encoded string or a descriptor. */
  function storeCarve(mineId, descOrString) {
    var m = mineState(mineId);
    if (!m) return false;
    m.carve = (typeof descOrString === 'string')
      ? descOrString : encodeCarve(descOrString);
    if (m.carve.length > MASK_MAX_CHARS) m.carve = '';
    markDirty();
    return true;
  }
  /** -> a descriptor for SM.advterrain.importCarve(), or null. */
  function loadCarve(mineId) {
    var m = record && record.mines ? record.mines[mineId] : null;
    if (!m || !m.carve) return null;
    return decodeCarve(m.carve);
  }
  /** Replace a mine's dumped-cargo piles. Validated and capped. */
  function setPiles(mineId, piles) {
    var m = mineState(mineId);
    if (!m) return false;
    m.piles = validateMineState({ piles: piles }).piles;
    markDirty();
    return true;
  }
  function getPiles(mineId) {
    var m = record && record.mines ? record.mines[mineId] : null;
    return m ? m.piles : [];
  }
  /** Bump visit count and best depth after a descent. */
  function recordVisit(mineId, depthM) {
    var m = mineState(mineId);
    if (!m) return;
    m.visits++;
    var d = Math.floor(num(depthM, 0, 0, 1e6));
    if (d > m.deepestM) m.deepestM = d;
    if (record) record.stats.runs++;
    markDirty();
  }
  /** Bank a haul into the lifetime stats. */
  function recordHaul(gross) {
    if (!record) return;
    var g = Math.floor(num(gross, 0, 0, MAX_CASH));
    record.stats.hauled += g;
    if (g > record.stats.bestHaul) record.stats.bestHaul = g;
    markDirty();
  }
  function getStats() {
    return record ? record.stats : { hauled: 0, bestHaul: 0, runs: 0 };
  }

  return {
    init: init,
    listSlots: listSlots,
    newGame: newGame,
    load: load,
    erase: erase,

    /* --- TESTER MODE (ui.js's title-gate cheat; see TESTER_SLOT above) --- */
    TESTER_SLOT: TESTER_SLOT,
    testerSummary: testerSummary,
    grantCash: grantCash,
    getActiveSlot: getActiveSlot,
    isLoaded: isLoaded,
    get: get,
    markDirty: markDirty,
    flush: flush,
    mineState: mineState,
    isOwned: isOwned,
    setOwned: setOwned,
    /** The loaded company's world seed; 0 = legacy record (pure catalogue seed). */
    getWorldSeed: function () { return record ? (record.worldSeed | 0) : 0; },
    /* THE CARVE CODEC. See the design note at the top of this file for the wire
     * format; the seam is SM.advterrain.exportCarve() / importCarve(). */
    encodeCarve: encodeCarve,
    decodeCarve: decodeCarve,

    /* --- Agent-2 additions (documented in the report) ------------------- */
    isAvailable: isAvailable,
    getError: getError,
    getDroppedKeys: getDroppedKeys,
    getIntegrity: getIntegrity,
    setIntegrity: setIntegrity,
    isSeen: isSeen,
    setSeen: setSeen,
    ownedCount: ownedCount,
    levelsOwned: levelsOwned,
    setLevelsOwned: setLevelsOwned,
    railsOwned: railsOwned,
    setRailsOwned: setRailsOwned,
    /* THE PROGRESSION GATE (js/adv.js owns the rule; this only stores it).
     * haulsFrom(id, L)     qualifying hauls banked from level L of that mine
     * noticeShown(id)      deepest level whose unlock notice has been shown
     * NOTE the neighbours: recordHaul(gross) below is the LIFETIME money stat
     * and has nothing to do with these — one is dollars for the whole company,
     * these are counts per level per mine. */
    haulsFrom: haulsFrom,
    setHaulsFrom: setHaulsFrom,
    noticeShown: noticeShown,
    setNoticeShown: setNoticeShown,
    storeCarve: storeCarve,
    loadCarve: loadCarve,
    setPiles: setPiles,
    getPiles: getPiles,
    recordVisit: recordVisit,
    recordHaul: recordHaul,
    getStats: getStats
  };
})();
