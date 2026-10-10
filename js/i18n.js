/* =============================================================================
 * SUPERMINE ADVENTURE — js/i18n.js
 * -----------------------------------------------------------------------------
 * WHICH LANGUAGE THE MINE SPEAKS, and every word it says.
 *
 * Bokmål first, English one tap away — the hub's rule (games/CLAUDE.md §2,
 * "Two languages, Norwegian first"). With nothing stored the game speaks
 * Norwegian whatever the browser prefers; there is deliberately no
 * navigator.language sniffing. The choice lives in `arcade.lang.v1`, the ONE
 * key every arcade game shares, because a language is a fact about the player
 * and not about the cabinet: choose English in fishtank and this game opens in
 * English too. It holds "nb" or "en" and nothing else, ever (§6).
 *
 * A CLASSIC SCRIPT ON `window.I18N`, NOT A MODULE and not on SM. This game is
 * nineteen classic scripts on one global (see index.html), and this file is
 * loaded in <head>, ahead of every one of them, for two reasons: <html lang>
 * has to be right before the first paint, so the page never flashes English;
 * and everything that speaks — ui.js's title gate first of all — needs t() the
 * moment it builds. It sits outside SM because it is the one file whose shape
 * is the same in every game of the hub: t, getLang, setLang, paintStatic.
 *
 * HOW A SWITCH REACHES THE SCREEN
 *   setLang() stores the choice, sets <html lang>, repaints every node that
 *   carries data-i18n / data-i18n-label / data-i18n-ph (paintStatic), and only
 *   THEN dispatches `arcade:lang` on document. Everything the game writes at
 *   runtime — the HUD, the meta screens, the toasts — listens for that event
 *   and re-renders whatever it is currently showing. Canvas text calls t() at
 *   draw time and simply comes out in the new language on the next frame.
 *   Nothing on this path reloads, restarts, closes a panel or unpauses: a
 *   language must not destroy a run any more than a deploy may (§1).
 *
 * THE TABLE. STRINGS = { nb: {…}, en: {…} }, grouped by the file that speaks.
 * A value may be a FUNCTION, because a language is not a template with blanks
 * in it — "1 TUR" / "2 TURER", "1 RUN" / "2 RUNS", and the money goes before
 * the noun in one language and after it in the other. A key missing from the
 * current language falls back to English, then to the key itself, with one
 * console warning per key so a gap is findable rather than silent.
 *
 * WHAT IS NOT IN HERE: the SUPERMINE / ADVENTURE wordmark (a name, not a
 * word), the company names players type, the manifest (one language, and the
 * arcade card reads it), console output and storage keys. Numbers keep the
 * game's own '$1 000 000' formatting, which is not locale-driven and never was.
 *
 * The language row (langRow) is built here rather than in the two places that
 * show it — the sound panel (reachable from the title, before any run) and the
 * pause card — so the two copies cannot drift. Its flags are the hub's art,
 * copied path for path from kitchens/index.html, never emoji.
 * ========================================================================== */

var I18N = (function () {
  'use strict';

  var KEY = 'arcade.lang.v1';
  var LANGS = ['nb', 'en'];
  var LOCALES = { nb: 'nb-NO', en: 'en-GB' };

  function initial() {
    try {
      var saved = localStorage.getItem(KEY);
      if (saved === 'nb' || saved === 'en') return saved;
    } catch (e) {
      // No storage (private mode, blocked site data): the default applies.
    }
    return 'nb';
  }

  var lang = initial();
  document.documentElement.lang = lang;

  var STRINGS = {
    nb: {
      // --- shared menu glossary (games/CLAUDE.md §2) -----------------------
      'menu.play': 'SPILL',
      'menu.resume': 'FORTSETT',
      'menu.paused': 'PAUSE',
      'menu.pause': 'Pause',
      'menu.back': 'TILBAKE',
      'menu.sound': 'LYD',
      'menu.soundAria': 'Lyd',
      'menu.engine': 'MOTOR',
      'menu.effects': 'EFFEKTER',
      'menu.language': 'SPRÅK',
      'menu.fullscreen': 'Fullskjerm',
      'menu.exitFullscreen': 'Avslutt fullskjerm',
      'menu.exitArcade': 'TILBAKE TIL ARKADEN',
      'menu.close': 'LUKK',
      'menu.closeTab': 'LUKK FANEN SELV',
      'menu.titleScreen': 'STARTSKJERMEN',
      'menu.map': 'KART',
      'menu.workshop': 'VERKSTED',
      'menu.level': 'NIVÅ',
      'menu.confirm': 'BEKREFT',
      'menu.soundOnOff': 'Lyd av / på',

      // --- js/ui.js: the title gate, the sound panel, tester mode, updates --
      'title.pick': 'DRIV DITT EGET GRUVEFIRMA',
      'title.tag': 'GRAV DYPT\u00a0· FYLL LASTEROMMET\u00a0· KOM DEG TILBAKE TIL HEISEN',
      'title.keysDesk': 'W A S D / PILTASTER — KJØR   ·   M — LYD AV   ·   ENTER — SPILL',
      'title.keysTouch': 'DRA HVOR SOM HELST FOR Å KJØRE',
      'sound.kicker': 'HØYTTALERNE I FØRERHUSET',
      'sound.hint': 'MOTOR ER DUREN OG BORET — LYDEN SOM ALDRI STOPPER MENS DU ' +
        'KJØRER. EFFEKTER ER ALT DU KNUSER, OG HVER BIT MALM SOM HAVNER I ' +
        'LASTEROMMET. DRA I EN AV DEM, SÅ HØRER DU DET.',
      'update.offer': function (v) {
        return (v ? 'NY VERSJON KLAR (' + v + ')' : 'NY VERSJON KLAR') +
          ' — TRYKK FOR Å INSTALLERE';
      },
      'update.installing': 'INSTALLERER…',
      'tester.title': 'TESTMODUS',
      'tester.note': 'EN EGEN PLASS FOR TESTING — DE TRE FIRMAPLASSENE BLIR ALDRI RØRT',
      'tester.empty': 'TOM',
      'tester.none': 'INGEN TESTFIRMA ENNÅ',
      'tester.new': 'NYTT TESTFIRMA',
      'tester.continue': 'FORTSETT',
      'tester.wipe': 'SLETT',
      'tester.wipeSure': 'SLETTE FOR GODT?',
      'tester.stats': function (day, cash, tier, mines) {
        return 'DAG ' + day + '   ·   ' + cash + '   ·   MK ' + tier + '   ·   ' +
          mines + (mines === 1 ? ' GRUVE' : ' GRUVER');
      },
      // --- js/advhud.js: the instruments -----------------------------------
      'hud.exit': 'UTGANG',
      'hud.funds': 'PENGER',
      'hud.heat': 'VARME',
      'hud.hull': 'SKROG',
      'hud.fuel': 'DIESEL',
      'hud.home': 'HJEM ',
      'hud.hold': 'LAST',
      'hud.unknown': 'UKJENT',
      'hud.manifest': 'Last',
      'hud.manifestTip': 'Lasten — trykk to ganger på en rad for å kaste den',
      'hud.dumpQ': 'KASTE?',
      'hud.moreOther': function (u) { return '+ ' + u + 'u ANNET'; },
      'hud.jettisoned': 'KASTET',
      'hud.jettisonedSub': function (name) { return name + ' ble tippet ut på bakken'; },
      'hud.levelN': function (n) { return 'NIVÅ ' + n; },
      'hud.lvlShort': function (n) { return 'N' + n; },
      'hud.reserveSpent': 'RESERVE BRUKT',
      'hud.turnBack': 'SNU NÅ',
      'hud.burn': function (r) { return 'BRUKER ' + r + '/s'; },
      'hud.secsLeft': function (s) { return s + 's IGJEN'; },
      'hud.thisRock': 'DENNE STEINEN',
      'hud.sealHere': 'HER SLUTTER NIVÅET',
      'hud.sealNotice': 'INGEN BOR KOMMER GJENNOM · TA HEISEN NED',
      'hud.needDrill': 'DU TRENGER ET BEDRE BOR',
      'hud.hardNotice': function (h, c) { return 'HARDHET ' + h + ' · DETTE BORET KLARER ' + c; },
      'hud.sealBanner': function (name) { return name + ' — HER SLUTTER NIVÅET'; },
      'hud.sealBannerSub': 'Bare heisen går mellom nivåene',
      'hud.hardBanner': function (name) { return name + ' — FOR HARD FOR DETTE BORET'; },
      'hud.rammedSub': 'Å kjøre inn i den bulker skroget · oppgrader i verkstedet',
      'hud.hardSub': function (h, c) { return 'Hardhet ' + h + ' · boret klarer ' + c + ' · oppgrader i verkstedet'; },
      'hud.holdFull': 'LASTEROMMET ER FULLT',
      'hud.holdFullSub': 'Kast noe, eller kjør opp til overflaten',
      'hud.fuelLow': 'LITE DIESEL',
      'hud.fuelLowSub': function (pct) { return pct + '% igjen  ·  følg med på reservestreken'; },
      'hud.hullDamage': 'SKADE PÅ SKROGET',
      'hud.dmgImpact': 'SMELL',
      'hud.dmgRam': 'KJØRTE INN I FJELLET',
      'hud.dmgHeat': 'FOR VARMT',
      'hud.overheat': 'OVEROPPHETET',
      'hud.overheatSub': 'Rygg unna fjellet og la maskinen kjøle seg ned',
      'hud.newLayer': function (m) { return m + ' m  ·  nytt lag'; },
      // --- js/advhud.js: the lift and its doors ---------------------------
      'door.lift': 'HEIS',
      'door.closeAria': 'Kjør ut av heisen',
      'door.sell': 'SELG',
      'door.refuel': 'FYLL PÅ',
      'door.leave': 'KJØR UT',
      'door.buy': 'KJØP',
      'door.here': 'HER',
      'door.ride': 'KJØR',
      'door.sealed': 'STENGT',
      'door.holdEmpty': 'INGEN LAST',
      'door.tankFull': 'FULL TANK',
      'door.toRock': 'INN I GRUVA',
      'door.toMap': 'TIL KARTET',
      'door.toSurface': 'TIL OVERFLATEN',
      'door.fitParts': 'MONTER DELER',
      'door.allFitted': 'ALT ER MONTERT',
      'door.fromPrice': function (p) { return 'FRA $' + p; },
      'door.noMove': 'HEISEN VIL IKKE GÅ',
      'door.noMoveSub': 'Kjør inn i døråpningen først',
      'door.opened': 'NIVÅET ER ÅPNET',
      'door.openedSub': function (name) { return name + ' — heisen tar deg ned'; },
      'door.refused': 'KJØPET GIKK IKKE',
      'door.refusedSub': 'Du har ikke nok penger på kontoen',
      'door.nothing': 'INGENTING Å SELGE',
      'door.nothingSub': 'Lasterommet er tomt',
      'door.banked': 'SATT INN',
      'door.bankedSub': function (v) { return '$' + v + ' inn på firmakontoen'; },
      'door.noFuel': 'KAN IKKE FYLLE PÅ',
      'door.noFuelSub': 'Tanken er full, eller kontoen er tom',
      'door.refuelled': 'TANKEN ER FYLT',
      'door.refuelledSub': function (v) { return 'Diesel for $' + v; },
      'door.notYet': 'IKKE ENNÅ',
      'door.notYetSub': 'Vent til heisen har stoppet helt',
      'door.deeper': 'HEISEN KAN GÅ DYPERE',
      'door.deeperBody': function (n, name, price) {
        return 'Du har jobbet ferdig her, og du har råd til mer. NIVÅ ' + n + ' — ' + name +
               ' er til salgs for $' + price + '. Kjøp det nedenfor og kjør ned: rikere fjell, samme heis.';
      },
      'door.mapOpen': 'KARTET ER ÅPENT',
      'door.mapOpenBody': function (name) {
        return 'Du eier alle nivåene ' + (name || 'denne gruva') + ' har å selge, og det har ' +
               'folk fått med seg. Nå er hele kartet ditt: andre felt, hardere fjell, rikere ' +
               'grunn — og rettigheter du kan kjøpe når kontoen tåler det. KJØR UT tar deg dit.';
      },
      'door.noteSell': function (v) { return 'SELG GIR $' + v + ' OG STARTER EN NY DAG.'; },
      'door.noteAllOpen': 'ALLE NIVÅENE I DENNE GRUVA ER ÅPNE.',
      'door.noteNeed': function (v, name) { return 'DU TRENGER $' + v + ' TIL FOR Å KJØPE ' + name + '.'; },
      'door.noteCosts': function (name, p) { return name + ' KOSTER $' + p + ' — KJØP DET HERFRA.'; },
      'door.noteDoors': 'DØRENE ER OVERFLATEN — SELG, FYLL PÅ, OG TILBAKE TIL JOBBEN.',
      'door.rideKicker': function (n) { return 'HEIS  ·  NIVÅ ' + n; },
      // --- js/advhud.js: the pause card -----------------------------------
      'pause.kicker': 'MOTOREN GÅR PÅ TOMGANG',
      'pause.depth': 'DYBDE',
      'pause.fuel': 'DIESEL',
      'pause.hold': 'LAST',
      'pause.abort': 'AVBRYT TUREN',
      'pause.confirmLose': 'BEKREFT — MIST LASTEN',
      'pause.confirmTitle': 'BEKREFT — MIST LASTEN',
      'pause.abortNote': 'Avbryter du, blir lasten liggende der den er — akkurat som når tanken går tom.',
      'scan.signature': function (name) { return 'SPOR AV ' + name; },
      // --- js/advui.js: shared bits ---------------------------------------
      'aui.day': function (n) { return 'DAG ' + n; },
      'aui.diveAgain': 'KJØR NED IGJEN',
      'aui.noCompany': 'INTET FIRMA',
      'aui.noMoney': 'Du har ikke nok penger',
      'aui.refused': 'KJØPET GIKK IKKE',
      'aui.unknown': 'UKJENT',
      'aui.wide': function (n) { return n + ' m BREDT'; },
      // --- js/advui.js: company slots ------------------------------------
      'slots.kicker': 'TRE FIRMAER · ETT REGNSKAP HVER',
      'slots.title': 'GRUVEFIRMAER',
      'slots.slot': function (n) { return 'PLASS ' + n; },
      'slots.empty': 'TOM',
      'slots.cash': 'PENGER',
      'slots.day': 'DAG',
      'slots.machine': 'MASKIN',
      'slots.mines': 'GRUVER',
      'slots.namePh': 'FIRMANAVN',
      'slots.sign': 'START FIRMAET',
      'slots.new': 'NYTT FIRMA',
      'slots.continue': 'FORTSETT',
      'slots.erase': 'SLETT',
      'slots.eraseConfirm': 'SLETT FOR GODT',
      'slots.erased': 'PLASSEN ER SLETTET',
      'slots.erasedSub': function (n) { return 'Plass ' + n + ' er tom igjen'; },
      'slots.unnamed': 'FIRMA UTEN NAVN',
      'slots.name1': 'DYPFJELL AS',
      'slots.name2': 'JERNMUNN GRUVER',
      'slots.name3': 'SVARTÅRA & CO',
      'slots.name4': 'HULÅSEN AS',
      'slots.name5': 'GRANITTLAGET',
      'slots.name6': 'MØRKEDAL GRAVING',
      // --- js/advui.js: map ----------------------------------------------
      'map.kicker': 'VELG HVOR DU VIL GRAVE',
      'map.noData': 'INGEN KARTDATA',
      'map.rights': 'RETTIGHETER',
      'map.recDrill': 'ANBEFALT BOR',
      'map.estDepth': 'DYBDE CA.',
      'map.deepest': 'DYPESTE TUR',
      'map.unsurveyed': 'IKKE UTFORSKET',
      'map.pinHeld': 'DIN',
      'map.free': 'GRATIS',
      'map.uncharted': 'UKJENT STED',
      'map.surveyed': 'NYTT OMRÅDE',
      'map.surveyedSub': function (name) { return name + ' er på kartet nå'; },
      'map.rightsHeld': 'DINE',
      'map.yours': function (n) { return 'DITT ' + n; },
      'map.runs': function (count, n) { return n + (count === 1 ? ' TUR' : ' TURER'); },
      'map.liftLine': function (owned, total) { return 'HEIS   ' + owned + ' AV ' + total + ' NIVÅER'; },
      'map.liftDeepest': function (where) { return 'DYPESTE ' + where; },
      'map.warnStall': 'Boret ditt kommer til å stå fast i denne steinen. Hver meter koster mye drivstoff.',
      'map.warnWeak': 'Boret er litt for svakt her. Det går, men det går sakte og bruker mye drivstoff.',
      'map.warnTank': 'En full tank holder så vidt ned og opp igjen så dypt. Kjøp en større tank først.',
      'map.common': 'VANLIG',
      'map.rare': 'SJELDEN',
      'map.hazards': 'FARER',
      'map.buy': function (m) { return 'KJØP GRUVA  ' + m; },
      'map.need': function (m) { return 'MANGLER ' + m; },
      'map.heat': 'VARME',
      'map.heat0': 'INGEN',
      'map.heat1': 'LITT',
      'map.heat2': 'VARMT',
      'map.heat3': 'GLOHETT',
      'map.ground': 'FJELL',
      'map.ground0': 'MYKT',
      'map.ground1': 'FAST',
      'map.ground2': 'HARDT',
      'map.pays': 'BESTE MALM',
      'map.bought': 'GRUVA ER DIN',
      'map.boughtSub': function (name) { return name + ' er din – bare begynn å grave'; },
      'map.region.foothills': 'Fjellfoten',
      'map.region.red_ridge': 'Rødryggen',
      'map.region.blackstone_range': 'Svartsteinfjella',
      'map.region.frostpeak': 'Frosttind',
      'map.region.the_hollows': 'Søkkene',
      'map.region.cinder_coast': 'Askekysten',
      'map.region.the_rift': 'Kløfta',
      'map.region.uncharted': 'Ukjent',
      // --- js/advui.js: workshop -----------------------------------------
      'shop.kicker': 'MASKINEN DIN · ÅTTE DELER',
      'shop.fitted': 'MONTERT',
      'shop.next': 'NESTE TRINN',
      'shop.install': 'MONTER',
      'shop.installCost': function (m) { return 'MONTER  ' + m; },
      'shop.maxed': 'FULLT OPPGRADERT',
      'shop.fittedName': function (name) { return 'MONTERT: ' + name; },
      'shop.requires': function (part, name) {
        return 'KREVER ' + part + (name ? (': ' + name) : '') + ' – beltene klarer ikke denne motoren ennå.';
      },
      'shop.runningGear': 'UNDERSTELL',
      'shop.need': function (m) { return 'DU MANGLER ' + m + ' PÅ KONTOEN.'; },
      'shop.upgraded': function (part) { return part + ' OPPGRADERT'; },
      'shop.upgradedSub': function (mk) { return mk + ' er montert og skrudd fast'; },
      'shop.refused': 'KAN IKKE MONTERE',
      'shop.noPreview': 'KAN IKKE VISE MASKINEN',
      'shop.part.drill': 'BOR',
      'shop.part.lights': 'LYS',
      'shop.part.scanner': 'SKANNER',
      'shop.part.engine': 'MOTOR',
      'shop.part.tracks': 'BELTER',
      'shop.part.cooling': 'KJØLING',
      'shop.part.fuel': 'DRIVSTOFF',
      'shop.part.cargo': 'LASTEROM',
      'shop.partStat.drill': 'KRAFT',
      'shop.partStat.lights': 'REKKEVIDDE',
      'shop.partStat.scanner': 'REKKEVIDDE',
      'shop.partStat.engine': 'FART',
      'shop.partStat.tracks': 'SVING',
      'shop.partStat.cooling': 'AVKJØLING',
      'shop.partStat.fuel': 'TANK',
      'shop.partStat.cargo': 'LASTEROM',
      'shop.partBlurb.drill': 'Hardere stein, fortere. Hvert trinn klarer en ny hardhet.',
      'shop.partBlurb.lights': 'Hulen du ikke ser, er hulen du kjører rett inn i.',
      'shop.partBlurb.scanner': 'Finner malm gjennom stein du ikke har rørt ennå.',
      'shop.partBlurb.engine': 'Fart, og kraft til å dytte løs stein ut av veien.',
      'shop.partBlurb.tracks': 'Grep og svinging. En graver som ikke kan snu, kommer ikke tilbake.',
      'shop.partBlurb.cooling': 'Det er varmt langt nede. Kjøling gjør at du klarer deg på bunnen.',
      'shop.partBlurb.fuel': 'Hver ekstra enhet er ett minutt til der nede.',
      'shop.partBlurb.cargo': 'Færre turer opp. Lasten er hele grunnen til å kjøre ned.',
      'shop.stat.power': 'KRAFT',
      'shop.stat.cap': 'MAKS',
      'shop.stat.speed': 'FART',
      'shop.stat.thrust': 'SKYVEKRAFT',
      'shop.stat.turn': 'SVING',
      'shop.stat.grip': 'GREP',
      'shop.stat.armor': 'PANSER',
      'shop.stat.collect': 'OPPSAMLING',
      'shop.stat.radius': 'RADIUS',
      'shop.stat.range': 'REKKEVIDDE',
      'shop.stat.heatCap': 'VARMETÅLING',
      'shop.stat.shed': 'AVKJØLING',
      // --- js/advui.js: before a descent ---------------------------------
      'prep.kicker': 'SISTE SJEKK FØR MØRKET',
      'prep.title': 'GJØR KLAR',
      'prep.hull': 'SKROG',
      'prep.repair': 'REPARER',
      'prep.repairCost': function (m) { return 'REPARER  ' + m; },
      'prep.repaired': 'SKROGET ER REPARERT',
      'prep.repairedSub': 'Platene er sveiset og skjøtene sjekket',
      'prep.repairRefused': 'KAN IKKE REPARERE',
      'prep.descend': 'KJØR NED',
      'prep.descendCost': function (m) { return 'KJØR NED  ·  ' + m; },
      'prep.theMine': 'GRUVA',
      'prep.meta': function (region, depth, rec, yours) {
        return region + '   ·   CA. ' + depth + ' m   ·   ANBEFALT BOR ' + rec + '   ·   DITT ' + yours;
      },
      'prep.noSurvey': 'INGEN KARTLEGGING',
      'lift.title': 'HEISEN',
      'lift.count': function (owned, total) { return owned + ' AV ' + total + ' NIVÅER'; },
      'lift.descendTo': function (level) { return 'KJØR NED TIL ' + level; },
      'lift.allOpen': 'ALLE NIVÅENE ER ÅPNE',
      'lift.short': function (i) { return 'N' + i; },
      'lift.start': 'START',
      'lift.held': 'DITT',
      'lift.sealed': 'STENGT',
      'lift.buy': 'KJØP',
      'lift.need': function (m, level) { return 'DU MANGLER ' + m + ' FOR Å KJØPE ' + level + '.'; },
      'lift.opened': 'NYTT NIVÅ ÅPNET',
      'lift.mapOpen': 'KARTET ER ÅPENT',
      'lift.mapOpenSub': 'Alle nivåene her er dine – verdenskartet er åpent. TILBAKE tar deg ut dit.',
      // --- js/advui.js: after a run --------------------------------------
      'haul.kicker': 'UTVINNING',
      'haul.title': 'FANGSTEN',
      'haul.kickerStrand': 'GRUVA BEHOLDT DEN',
      'haul.kickerDone': 'UTVINNING FERDIG',
      'haul.stranded': 'STRANDET',
      'haul.secured': 'BERGET',
      'haul.leftBehind': 'LAGT IGJEN',
      'haul.holdValue': 'VERDI I LASTEROMMET',
      'haul.depth': 'NÅDD DYBDE',
      'haul.time': 'TID UNDER JORDA',
      'haul.fuelLeft': 'DIESEL IGJEN',
      'haul.sell': 'SELG FANGSTEN',
      'haul.refuel': 'FYLL TANKEN',
      'haul.refuelCost': function (m) { return 'FYLL TANKEN  ·  ' + m; },
      'haul.lineSold': 'Solgt. Lasterommet er tomt, og pengene er på kontoen.',
      'haul.lineFull': 'Tilbake på overflaten med lasten i behold.',
      'haul.lineEmpty': 'Tilbake på overflaten. Lasterommet er tomt.',
      'haul.noteLoad': function (level, depth, lost) {
        return 'Lasten ligger på ' + level + ', ' + depth + ' m nede' + (lost ? (' – verdt ' + lost) : '') +
               '. Kjør ned til det nivået for å hente den.';
      },
      'haul.noteBanked': function (m) { return 'SATT INN ' + m + ' på firmakontoen.'; },
      'haul.thatLevel': 'det nivået',
      'haul.reason.fuel': function (depth, level) { return 'Tanken gikk tom ' + depth + ' m nede' + (level ? (', på ' + level) : '') + '.'; },
      'haul.reason.hull': function (depth, level) { return 'Skroget ga etter ' + depth + ' m nede' + (level ? (', på ' + level) : '') + '.'; },
      'haul.reason.abort': function (depth, level) { return 'Du ga opp gravingen ' + depth + ' m nede' + (level ? (', på ' + level) : '') + '.'; },
      'haul.reason.other': function (depth, level) { return 'Maskinen stoppet ' + depth + ' m nede' + (level ? (', på ' + level) : '') + '.'; },
      'haul.noneSecured': 'INGENTING BLE BERGET',
      'haul.noneHold': 'LASTEROMMET ER TOMT',
      'haul.banked': 'SATT INN',
      'haul.bankedSub': function (m) { return m + ' er satt inn på firmakontoen'; },
      'haul.tankFull': 'TANKEN ER FULL',
      'haul.tankFullSub': 'Det er ingenting å fylle på',
      'haul.cantRefuel': 'KAN IKKE FYLLE TANKEN',
      'haul.cantRefuelSub': function (m) { return 'Du har ikke nok penger til ' + m; },
      'haul.refuelled': 'TANKEN ER FYLT',
      'haul.refuelledSub': function (m) { return m + ' i diesel'; },
      'haul.tankEmpty': 'TANKEN ER TOM',
      'haul.tankEmptySub': 'Fyll tanken før du kjører ned igjen',
      'haul.cantDescend': 'KAN IKKE KJØRE NED',
      'haul.cantDescendSub': 'Sjekk gruverettighetene her',
      // --- js/mines.js — the mines (names are place names in the fiction) ---
      'mine.old_creek.name': 'Gamlebekken gruve',
      'mine.old_creek.blurb': 'Et gammelt familiekrav nede i bekkefaret. Grunt, mykt og gjennomgravd to ganger allerede — men kullet ligger der fortsatt, og ingen tar betalt for at du henter det.',
      'mine.old_creek.L1': 'Matjord',
      'mine.old_creek.L2': 'Bekkegrus',
      'mine.old_creek.L3': 'Gamle ganger',
      'mine.red_ridge.name': 'Rødåsen steinbrudd',
      'mine.red_ridge.blurb': 'Et åpent steinbrudd sprengt inn i åsen, og den første grunnen som slår tilbake. De røde hematittbenkene har mer jern enn noen klarer å bære — men sølvet følger med, og et sted under kalksteinen ligger verdens første krystall.',
      'mine.red_ridge.L1': 'Hematittbenken',
      'mine.red_ridge.L2': 'Sølvbenken',
      'mine.red_ridge.L3': 'Dype benker',
      'mine.blackstone.name': 'Svartstein gruve',
      'mine.blackstone.blurb': 'Kvartsårer i granitt, og firmaet som sprengte denne sjakten gikk konkurs av å kjøpe borkroner. Årene de var ute etter ligger der fortsatt — og det gjør platinaen også, som ingen den gangen visste hvordan de skulle selge.',
      'mine.blackstone.L1': 'Granittårer',
      'mine.blackstone.L2': 'Sølvårer',
      'mine.blackstone.L3': 'Gull-lomma',
      'mine.frostpeak.name': 'Frosttind-sjakten',
      'mine.frostpeak.blurb': 'Ingenting her nede er varmt, og det er hele poenget: krystallhvelvene betaler som en dyp gruve og krever ingenting av kjølingen din. Det er selve grunnen som er problemet — og tomromssteinen i den har ingen noen gang klart å skjære.',
      'mine.frostpeak.L1': 'Frossent fjell',
      'mine.frostpeak.L2': 'Krystallhvelv',
      'mine.deep_hollow.name': 'Dypholet',
      'mine.deep_hollow.blurb': 'Et sammenrast hulrom med noe varmt under seg. Malmen er myk og grunnen er raus — og revet i bunnen lyser gulgrønt på hvert eneste instrument noen har senket ned dit.',
      'mine.deep_hollow.L1': 'Hulrommet',
      'mine.deep_hollow.L2': 'Varmerevet',
      'mine.cinder_fell.name': 'Askefjell',
      'mine.cinder_fell.blurb': 'En død vulkan med en levende kjeller. Hver meter av den måler over 0,8 på varmemålingen, magmaskorpa er full av obsidian som ingenting svakere enn en lanse biter på — og askekjernen under er det eneste stedet noen har funnet stjernekjerne.',
      'mine.cinder_fell.L1': 'Magmaskorpa',
      'mine.cinder_fell.L2': 'Askekjernen',
      'mine.the_rift.name': 'Kløfta',
      'mine.the_rift.blurb': 'Det aller siste her nede er ikke stein, uansett hva en geolog sier. Låser av obsidian, sprekker som måler tusen grader, og en bunn av stjernekjerne med oldtidsfunn i — ikke spredt, ikke et rykte. I hele årer.',
      'mine.the_rift.L1': 'Obsidianlåsene',
      'mine.the_rift.L2': 'Dampsprekker',
      'mine.the_rift.L3': 'Kløftbunnen',
      'mine.shakedown.name': 'PRØVESJAKTEN',
      'mine.shakedown.blurb': 'En sjakt ingen gadd å gi navn. God nok til å prøvekjøre maskinen.',
      // regions (m.regionLabel / SM.mines.regionLabel; the region id stays English)
      'mine.region.foothills': 'Fjellfoten',
      'mine.region.red_ridge': 'Rødryggen',
      'mine.region.blackstone_range': 'Svartsteinfjella',
      'mine.region.frostpeak': 'Frosttind',
      'mine.region.the_hollows': 'Søkkene',
      'mine.region.cinder_coast': 'Askekysten',
      'mine.region.the_rift': 'Kløfta',
      'mine.region.test_ground': 'Prøvefeltet',
      // hazards
      'mine.haz.rotten_timbers': 'Råtne støtter',
      'mine.haz.limestone_benches': 'Kalksteinsbenker',
      'mine.haz.hard_rock': 'Hardt fjell',
      'mine.haz.long_tunnels': 'Lange tunneler',
      'mine.haz.heat': 'Varme',
      'mine.haz.frozen_ground': 'Frossen grunn',
      'mine.haz.hardest_rock_in_the_world': 'Verdens hardeste fjell',
      'mine.haz.radiation': 'Stråling',
      'mine.haz.no_return_without_fuel': 'Ingen vei hjem uten drivstoff',
      'mine.haz.extreme_heat': 'Voldsom varme',
      'mine.haz.obsidian': 'Obsidian',
      'mine.haz.gas_pockets': 'Gasslommer',
      'mine.haz.geothermal': 'Jordvarme',
      'mine.haz.obsidian_locks': 'Obsidianlåser',
      'mine.haz.depth': 'Dybde',
      'mine.haz.unsurveyed': 'Ikke kartlagt',
      // --- js/rig.js — the workshop's parts ---
      'part.drill.title': 'BOR',
      'part.drill.blurb': 'Hvor hard stein du kan skjære, og hvor fort.',
      'part.drill.t0.name': 'SLITT SPIRALBOR',
      'part.drill.t0.blurb': 'Bare myk grunn. Granitt har du ikke råd til å prøve deg på.',
      'part.drill.t1.name': 'WOLFRAMBOR',
      'part.drill.t1.blurb': 'Kalksteinsbenkene gir seg. Skjærer gjennom OLDTIDSFUNNET.',
      'part.drill.t2.name': 'KOMPOSITT-BORHODE',
      'part.drill.t2.blurb': 'Kobber, sølv, gull og smaragd i full fart. Granitt i 42 %.',
      'part.drill.t3.name': 'DIAMANTKUTTER',
      'part.drill.t3.blurb': 'Granitt i seksti prosent. Skjærer OBSIDIAN — låsene i Kløfta går opp.',
      'part.drill.t4.name': 'VARMELANSER',
      'part.drill.t4.blurb': 'Nå er det bare obsidian og grunnfjell som står i veien.',
      'part.drill.t5.name': 'PLASMABRYTER',
      'part.drill.t5.blurb': 'Skjærer GRUNNFJELL — selve bunnen av gruva. Sakte, men den skjærer.',
      'part.engine.title': 'MOTOR',
      'part.engine.blurb': 'Fart, og kraft til å skyve løs stein ut av veien.',
      'part.engine.t0.name': 'SLITEN DIESEL',
      'part.engine.t0.blurb': 'Den starter de fleste morgener.',
      'part.engine.t1.name': 'OVERHALT DIESEL',
      'part.engine.t1.blurb': 'En firedel raskere overalt, og den skyver steinras i stedet for å stoppe.',
      'part.engine.t2.name': 'TURBODIESEL',
      'part.engine.t2.blurb': 'Den lange veien opp sjakten koster deg ikke lenger hele turen.',
      'part.engine.t3.name': 'TVILLINGTURBIN',
      'part.engine.t3.blurb': 'Full fart, under jorda, i mørket.',
      'part.engine.t4.name': 'HYDROGENTURBIN',
      'part.engine.t4.blurb': 'Seks hundre meter opp tar halvannet minutt.',
      'part.engine.t5.name': 'FUSJONSMOTOR',
      'part.engine.t5.blurb': 'Fra bunnen av Kløfta til dagslys på én tank.',
      'part.tracks.title': 'BELTER',
      'part.tracks.blurb': 'Hvor krapt maskinen svinger, og hvor mye av et steinras den tåler.',
      'part.tracks.t0.name': 'LAPPET GUMMI',
      'part.tracks.t0.blurb': 'Svinger som en lekter. Hver stein som faller, treffer skroget.',
      'part.tracks.t1.name': 'STÅLLENKER',
      'part.tracks.t1.blurb': 'Krappere svinger i trange årer, og den første ordentlige panseringen.',
      'part.tracks.t2.name': 'BREDT STÅL',
      'part.tracks.t2.blurb': 'Holder kursen over et hulegulv i stedet for å skli.',
      'part.tracks.t3.name': 'HERDEDE PIGGER',
      'part.tracks.t3.blurb': 'Du kan kjøre gjennom et obsidianfelt uten å stoppe.',
      'part.tracks.t4.name': 'GYROSTABILISERT',
      'part.tracks.t4.blurb': 'Snu på stedet. Et steinras gir en skramme i stedet for å ødelegge turen.',
      'part.tracks.t5.name': 'MAGNETBELTER',
      'part.tracks.t5.blurb': 'Skroget bryr seg ikke lenger om hva gulvet er laget av.',
      'part.fuel.title': 'DRIVSTOFF',
      'part.fuel.blurb': 'Hvor lenge du kan bli der nede.',
      'part.fuel.t0.name': 'BULKETE TANK',
      'part.fuel.t0.blurb': 'Toppen av Gamlebekken og tilbake. Ikke én meter å gå på.',
      'part.fuel.t1.name': 'SVEISET TANK',
      'part.fuel.t1.blurb': 'Tre ganger så langt. Gamlebekken åpner seg, og Rødåsen er innen rekkevidde.',
      'part.fuel.t2.name': 'DOBBELTANK',
      'part.fuel.t2.blurb': 'Hele Rødåsen fra topp til bunn, og en ordentlig titt på Svartstein.',
      'part.fuel.t3.name': 'TRYKKBLÆRE',
      'part.fuel.t3.blurb': 'Svartstein og Frosttind, frem og tilbake, med drivstoff til overs.',
      'part.fuel.t4.name': 'LANGTURCELLER',
      'part.fuel.t4.blurb': 'Nok til å nå bunnen av Dypholet og fortsatt komme deg opp.',
      'part.fuel.t5.name': 'EKSPEDISJONSTANK',
      'part.fuel.t5.blurb': 'Tre og en halv tusen meter. Kløfta er ikke lenger livsfarlig.',
      'part.cargo.title': 'LASTEROM',
      'part.cargo.blurb': 'Hvor mye du får plass til — og hvor langt unna maskinen suger inn malm.',
      'part.cargo.t0.name': 'ÅPEN KASSE',
      'part.cargo.t0.blurb': 'Tolv klumper kull. Du kommer til å hate kull.',
      'part.cargo.t1.name': 'STÅLBINGE',
      'part.cargo.t1.blurb': 'Dobbelt så mye. To fulle kasser før du må opp igjen.',
      'part.cargo.t2.name': 'HØY BINGE',
      'part.cargo.t2.blurb': 'En sølvåre fyller deg ikke lenger opp halvveis langs den.',
      'part.cargo.t3.name': 'PRESSBINGE',
      'part.cargo.t3.blurb': 'Malmen blir knust på vei inn. En dyp tur trenger ikke lenger to turer.',
      'part.cargo.t4.name': 'DOBBELBINGE',
      'part.cargo.t4.blurb': 'Nå har du råd til å ta med den billige malmen i tillegg til den gode.',
      'part.cargo.t5.name': 'MALMTOG',
      'part.cargo.t5.blurb': 'Femten hundre enheter. Nå er det tanken som sender deg hjem.',
      'part.lights.title': 'LYS',
      'part.lights.blurb': 'Hvor mye av hulen du får se.',
      'part.lights.t0.name': 'KNUST LYKT',
      'part.lights.t0.blurb': 'Du ser steinen du allerede kjører borti.',
      'part.lights.t1.name': 'DOBBEL HALOGEN',
      'part.lights.t1.blurb': 'Langt nok frem til å styre i stedet for å bråbremse.',
      'part.lights.t2.name': 'FLOMLYS',
      'part.lights.t2.blurb': 'Du ser huleveggene før du er inne i dem.',
      'part.lights.t3.name': 'LYSMAST',
      'part.lights.t3.blurb': 'Du ser et helt kammer og kan velge den rikeste veggen.',
      'part.lights.t4.name': 'XENONREKKE',
      'part.lights.t4.blurb': 'Nesten hele skjermen er opplyst. Malmen glitrer mot deg på lang avstand.',
      'part.lights.t5.name': 'DAGSLYS',
      'part.lights.t5.blurb': 'Mørket er ikke noe problem lenger.',
      'part.scanner.title': 'SKANNER',
      'part.scanner.blurb': 'Finner malm gjennom stein du ikke har rørt.',
      'part.scanner.t0.name': 'INGEN SKANNER',
      'part.scanner.t0.blurb': 'Du graver der steinen ser lovende ut, og håper.',
      'part.scanner.t1.name': 'LETESPOLE',
      'part.scanner.t1.blurb': 'Førti meters varsel. Nok til å slutte å grave feil vei.',
      'part.scanner.t2.name': 'PULSLODD',
      'part.scanner.t2.blurb': 'Sytti meter. Nå velger du årer i stedet for å lete etter dem.',
      'part.scanner.t3.name': 'SEISMISK MÅLER',
      'part.scanner.t3.blurb': 'Hundre og ti meter, med en retning du kan stole på.',
      'part.scanner.t4.name': 'DYPEKKO',
      'part.scanner.t4.blurb': 'Ser den andre veggen i en hule du ikke har vært inne i.',
      'part.scanner.t5.name': 'MALMORAKELET',
      'part.scanner.t5.blurb': 'To hundre og seksti meter. Du planlegger hele turen ned.',
      'part.cooling.title': 'KJØLING',
      'part.cooling.blurb': 'Dybde. Varmen er grensen under hver dype gruve.',
      'part.cooling.t0.name': 'LUFTET RADIATOR',
      'part.cooling.t0.blurb': 'Holder følge ned til rundt 0,13 varme. Dypere enn det, og klokka tikker.',
      'part.cooling.t1.name': 'SPYLT RADIATOR',
      'part.cooling.t1.blurb': 'Sølvårene i Svartstein er ikke lenger et kappløp mot klokka.',
      'part.cooling.t2.name': 'DOBBELVIFTE',
      'part.cooling.t2.blurb': 'Holder ut på bunnen av Dypholet. Askefjell koker deg fortsatt.',
      'part.cooling.t3.name': 'GLYKOLKRETS',
      'part.cooling.t3.blurb': 'I magmaskorpa kan du jobbe i korte runder.',
      'part.cooling.t4.name': 'FRYSEVEKSLER',
      'part.cooling.t4.blurb': 'Holder følge i en dampsprekk. Askefjell åpner seg skikkelig.',
      'part.cooling.t5.name': 'FASEKJERNE',
      'part.cooling.t5.blurb': 'Bunnen av Kløfta på tusen grader, så lenge du vil.',
      // --- js/materials.js — what is in the rock and in the hold ---
      'mat.dirt': 'Jord',
      'mat.stone': 'Stein',
      'mat.iron': 'Jernmalm',
      'mat.gold': 'Gull',
      'mat.gem': 'Smaragd',
      'mat.crystal': 'Krystall',
      'mat.rare': 'Tomromsstein',
      'mat.rubble': 'Steinskrot',
      'mat.granite': 'Granitt',
      'mat.starcore': 'Stjernekjerne',
      'mat.obsidian': 'Obsidian',
      'mat.timecell': 'Tidscelle',
      'mat.boostcell': 'Turbo',
      'mat.clay': 'Leire',
      'mat.coal': 'Kull',
      'mat.copper': 'Kobbermalm',
      'mat.sandstone': 'Sandstein',
      'mat.limestone': 'Kalkstein',
      'mat.silver': 'Sølv',
      'mat.platinum': 'Platina',
      'mat.uranium': 'Uranmalm',
      'mat.ancient': 'Oldtidsfunn',
      'mat.bedrock': 'Grunnfjell',
      // --- js/advterrain.js — words painted into the world ---
      'terr.level': function (n) { return 'NIVÅ ' + n; },
      'terr.layer': function (n) { return 'LAG ' + n; },
      'terr.locked': 'STENGT',
      'terr.bedrock': 'GRUNNFJELL',
      'terr.default.topsoil': 'MATJORD',
      'terr.default.clay': 'LEIRLAG',
      'terr.default.sandstone': 'SANDSTEIN',
      'terr.default.limestone': 'KALKSTEIN',
      'terr.default.granite': 'GRANITT',
      'terr.default.deep': 'DYPET',
    },
    en: {
      // --- shared menu glossary (games/CLAUDE.md §2) -----------------------
      'menu.play': 'PLAY',
      'menu.resume': 'RESUME',
      'menu.paused': 'PAUSED',
      'menu.pause': 'Pause',
      'menu.back': 'BACK',
      'menu.sound': 'SOUND',
      'menu.soundAria': 'Sound',
      'menu.engine': 'ENGINE',
      'menu.effects': 'EFFECTS',
      'menu.language': 'LANGUAGE',
      'menu.fullscreen': 'Fullscreen',
      'menu.exitFullscreen': 'Exit fullscreen',
      'menu.exitArcade': 'BACK TO ARCADE',
      'menu.close': 'CLOSE',
      'menu.closeTab': 'CLOSE THIS TAB YOURSELF',
      'menu.titleScreen': 'TITLE SCREEN',
      'menu.map': 'MAP',
      'menu.workshop': 'WORKSHOP',
      'menu.level': 'LEVEL',
      'menu.confirm': 'CONFIRM',
      'menu.soundOnOff': 'Sound on / off',

      // --- js/ui.js: the title gate, the sound panel, tester mode, updates --
      'title.pick': 'RUN A MINING COMPANY',
      'title.tag': 'DIG DEEP\u00a0· FILL THE HOLD\u00a0· GET BACK TO THE LIFT',
      'title.keysDesk': 'W A S D / ARROWS — DRIVE   ·   M — MUTE   ·   ENTER — PLAY',
      'title.keysTouch': 'DRAG ANYWHERE TO DRIVE',
      'sound.kicker': 'CAB SPEAKERS',
      'sound.hint': 'ENGINE IS THE DRONE AND THE CUTTER — THE NOISE THAT NEVER STOPS WHILE ' +
        'YOU DRIVE. EFFECTS IS EVERYTHING IT BREAKS, AND EVERY ORE THAT GOES IN ' +
        'THE HOLD. DRAG EITHER ONE AND YOU WILL HEAR IT.',
      'update.offer': function (v) {
        return (v ? v + ' READY' : 'UPDATE READY') + ' — TAP TO INSTALL';
      },
      'update.installing': 'INSTALLING…',
      'tester.title': 'TESTER MODE',
      'tester.note': 'A SEPARATE SLOT FOR TESTING — THE THREE COMPANY SLOTS ARE NEVER TOUCHED',
      'tester.empty': 'EMPTY',
      'tester.none': 'NO TEST COMPANY YET',
      'tester.new': 'NEW TEST COMPANY',
      'tester.continue': 'CONTINUE',
      'tester.wipe': 'WIPE',
      'tester.wipeSure': 'WIPE FOR GOOD?',
      'tester.stats': function (day, cash, tier, mines) {
        return 'DAY ' + day + '   ·   ' + cash + '   ·   MK ' + tier + '   ·   ' +
          mines + (mines === 1 ? ' MINE' : ' MINES');
      },
      // --- js/advhud.js: the instruments -----------------------------------
      'hud.exit': 'EXIT',
      'hud.funds': 'FUNDS',
      'hud.heat': 'HEAT',
      'hud.hull': 'HULL',
      'hud.fuel': 'FUEL',
      'hud.home': 'HOME ',
      'hud.hold': 'HOLD',
      'hud.unknown': 'UNKNOWN',
      'hud.manifest': 'Manifest',
      'hud.manifestTip': 'Manifest — tap a row twice to dump it',
      'hud.dumpQ': 'DUMP?',
      'hud.moreOther': function (u) { return '+ ' + u + 'u OF OTHER MATERIAL'; },
      'hud.jettisoned': 'JETTISONED',
      'hud.jettisonedSub': function (name) { return name + ' tipped onto the floor'; },
      'hud.levelN': function (n) { return 'LEVEL ' + n; },
      'hud.lvlShort': function (n) { return 'L' + n; },
      'hud.reserveSpent': 'RESERVE SPENT',
      'hud.turnBack': 'TURN BACK',
      'hud.burn': function (r) { return 'BURN ' + r + '/s'; },
      'hud.secsLeft': function (s) { return s + 's LEFT'; },
      'hud.thisRock': 'THIS ROCK',
      'hud.sealHere': 'THE LEVEL ENDS HERE',
      'hud.sealNotice': 'NO DRILL CUTS IT · TAKE THE LIFT DOWN',
      'hud.needDrill': 'UPGRADE THE DRILL TO MINE',
      'hud.hardNotice': function (h, c) { return 'HARDNESS ' + h + ' · THIS BIT CUTS ' + c; },
      'hud.sealBanner': function (name) { return name + ' — THE LEVEL ENDS HERE'; },
      'hud.sealBannerSub': 'The lift is the only way between levels',
      'hud.hardBanner': function (name) { return name + ' — TOO HARD FOR THIS DRILL'; },
      'hud.rammedSub': 'Ramming it dents the hull · upgrade in the workshop',
      'hud.hardSub': function (h, c) { return 'Hardness ' + h + ' · bit cuts ' + c + ' · upgrade in the workshop'; },
      'hud.holdFull': 'HOLD FULL',
      'hud.holdFullSub': 'Dump the spoil or head for the surface',
      'hud.fuelLow': 'FUEL LOW',
      'hud.fuelLowSub': function (pct) { return pct + '% left  ·  check the reserve mark'; },
      'hud.hullDamage': 'HULL DAMAGE',
      'hud.dmgImpact': 'IMPACT',
      'hud.dmgRam': 'RAM',
      'hud.dmgHeat': 'HEAT',
      'hud.overheat': 'OVERHEATING',
      'hud.overheatSub': 'Back off the rock and let it cool',
      'hud.newLayer': function (m) { return m + ' m  ·  new stratum'; },
      // --- js/advhud.js: the lift and its doors ---------------------------
      'door.lift': 'LIFT',
      'door.closeAria': 'Leave the lift',
      'door.sell': 'SELL',
      'door.refuel': 'REFUEL',
      'door.leave': 'LEAVE',
      'door.buy': 'BUY',
      'door.here': 'HERE',
      'door.ride': 'RIDE',
      'door.sealed': 'SEALED',
      'door.holdEmpty': 'HOLD EMPTY',
      'door.tankFull': 'TANK FULL',
      'door.toRock': 'INTO THE MINE',
      'door.toMap': 'TO THE MAP',
      'door.toSurface': 'TO THE SURFACE',
      'door.fitParts': 'FIT PARTS',
      'door.allFitted': 'ALL FITTED',
      'door.fromPrice': function (p) { return 'FROM $' + p; },
      'door.noMove': 'THE LIFT WILL NOT MOVE',
      'door.noMoveSub': 'Drive into the doorway first',
      'door.opened': 'LEVEL OPENED',
      'door.openedSub': function (name) { return name + ' — the lift will take you down'; },
      'door.refused': 'THE SALE WAS REFUSED',
      'door.refusedSub': 'The ledger will not cover it',
      'door.nothing': 'NOTHING TO SELL',
      'door.nothingSub': 'The hold is empty',
      'door.banked': 'BANKED',
      'door.bankedSub': function (v) { return '$' + v + ' into the company account'; },
      'door.noFuel': 'CANNOT REFUEL',
      'door.noFuelSub': 'The tank is full, or the ledger is empty',
      'door.refuelled': 'REFUELLED',
      'door.refuelledSub': function (v) { return '$' + v + ' of diesel'; },
      'door.notYet': 'NOT YET',
      'door.notYetSub': 'Wait for the lift to finish docking',
      'door.deeper': 'THE LIFT WILL GO DEEPER',
      'door.deeperBody': function (n, name, price) {
        return 'You have worked this level and the ledger covers it. LEVEL ' + n + ' — ' + name +
               ' is now for sale at $' + price + '. Buy it below, then ride down: richer rock, same lift.';
      },
      'door.mapOpen': 'THE FIELD IS OPEN',
      'door.mapOpenBody': function (name) {
        return 'You own every level ' + (name || 'this mine') + ' has to sell, and word travels. ' +
               'The world map is yours from here: other claims, harder rock, richer ground — and ' +
               'rights to buy when the ledger can stand it. LEAVE takes you out to it.';
      },
      'door.noteSell': function (v) { return 'SELL BANKS $' + v + ' AND ROLLS THE DAY.'; },
      'door.noteAllOpen': 'EVERY LEVEL OF THIS MINE IS OPEN.',
      'door.noteNeed': function (v, name) { return 'NEED $' + v + ' MORE FOR ' + name + '.'; },
      'door.noteCosts': function (name, p) { return name + ' COSTS $' + p + ' — BUY IT FROM HERE.'; },
      'door.noteDoors': 'THE DOORS ARE THE SURFACE — SELL, REFUEL, AND BACK TO WORK.',
      'door.rideKicker': function (n) { return 'LIFT  ·  LEVEL ' + n; },
      // --- js/advhud.js: the pause card -----------------------------------
      'pause.kicker': 'ENGINE IDLING',
      'pause.depth': 'DEPTH',
      'pause.fuel': 'FUEL',
      'pause.hold': 'HOLD',
      'pause.abort': 'END RUN',
      'pause.confirmLose': 'CONFIRM — LOSE THE HOLD',
      'pause.confirmTitle': 'CONFIRM — LOSE THE HOLD',
      'pause.abortNote': 'Ending the run drops the hold where it stands, exactly like running dry.',
      'scan.signature': function (name) { return name + ' SIGNATURE'; },
      // --- js/advui.js: shared bits ---------------------------------------
      'aui.day': function (n) { return 'DAY ' + n; },
      'aui.diveAgain': 'DESCEND AGAIN',
      'aui.noCompany': 'NO COMPANY',
      'aui.noMoney': 'The ledger will not cover it',
      'aui.refused': 'PURCHASE REFUSED',
      'aui.unknown': 'UNKNOWN',
      'aui.wide': function (n) { return n + ' m WIDE'; },
      // --- js/advui.js: company slots ------------------------------------
      'slots.kicker': 'THREE COMPANIES · ONE LEDGER EACH',
      'slots.title': 'MINING COMPANIES',
      'slots.slot': function (n) { return 'SLOT ' + n; },
      'slots.empty': 'EMPTY',
      'slots.cash': 'CASH',
      'slots.day': 'DAY',
      'slots.machine': 'MACHINE',
      'slots.mines': 'MINES',
      'slots.namePh': 'COMPANY NAME',
      'slots.sign': 'START COMPANY',
      'slots.new': 'NEW COMPANY',
      'slots.continue': 'CONTINUE',
      'slots.erase': 'ERASE',
      'slots.eraseConfirm': 'ERASE FOR GOOD',
      'slots.erased': 'SLOT ERASED',
      'slots.erasedSub': function (n) { return 'Slot ' + n + ' is empty again'; },
      'slots.unnamed': 'UNNAMED CO',
      'slots.name1': 'DEEP ROCK LTD',
      'slots.name2': 'IRONMOUTH MINING',
      'slots.name3': 'BLACKSEAM & CO',
      'slots.name4': 'HOLLOW HILL CO',
      'slots.name5': 'GRANITE UNION',
      'slots.name6': 'LOWLIGHT DIGGING',
      // --- js/advui.js: map ----------------------------------------------
      'map.kicker': 'MINING RIGHTS · CHOOSE YOUR GROUND',
      'map.noData': 'NO SURVEY DATA',
      'map.rights': 'MINING RIGHTS',
      'map.recDrill': 'REC. DRILL',
      'map.estDepth': 'EST. DEPTH',
      'map.deepest': 'DEEPEST RUN',
      'map.unsurveyed': 'UNSURVEYED',
      'map.pinHeld': 'HELD',
      'map.free': 'FREE',
      'map.uncharted': 'UNCHARTED SITE',
      'map.surveyed': 'REGION SURVEYED',
      'map.surveyedSub': function (name) { return name + ' is on the chart'; },
      'map.rightsHeld': 'HELD',
      'map.yours': function (n) { return 'YOURS ' + n; },
      'map.runs': function (count, n) { return n + (count === 1 ? ' RUN' : ' RUNS'); },
      'map.liftLine': function (owned, total) { return 'LIFT   ' + owned + ' OF ' + total + ' LEVELS'; },
      'map.liftDeepest': function (where) { return 'DEEPEST ' + where; },
      'map.warnStall': 'Your drill will stall in this rock. Expect to burn fuel for every metre.',
      'map.warnWeak': 'Under-gunned for this ground. Workable, but slow and thirsty.',
      'map.warnTank': 'A full tank barely covers the round trip at this depth. Fit a bigger tank first.',
      'map.common': 'COMMON',
      'map.rare': 'RARE',
      'map.hazards': 'HAZARDS',
      'map.buy': function (m) { return 'BUY RIGHTS  ' + m; },
      'map.need': function (m) { return 'NEED ' + m + ' MORE'; },
      'map.heat': 'HEAT',
      'map.heat0': 'NONE',
      'map.heat1': 'MILD',
      'map.heat2': 'HOT',
      'map.heat3': 'SEVERE',
      'map.ground': 'GROUND',
      'map.ground0': 'SOFT',
      'map.ground1': 'FIRM',
      'map.ground2': 'HARD',
      'map.pays': 'PAYS FOR',
      'map.bought': 'RIGHTS ACQUIRED',
      'map.boughtSub': function (name) { return name + ' is yours to dig'; },
      'map.region.foothills': 'Foothills',
      'map.region.red_ridge': 'Red Ridge',
      'map.region.blackstone_range': 'Blackstone Range',
      'map.region.frostpeak': 'Frostpeak',
      'map.region.the_hollows': 'The Hollows',
      'map.region.cinder_coast': 'Cinder Coast',
      'map.region.the_rift': 'The Rift',
      'map.region.uncharted': 'Uncharted',
      // --- js/advui.js: workshop -----------------------------------------
      'shop.kicker': 'YOUR MACHINE · EIGHT SUBASSEMBLIES',
      'shop.fitted': 'FITTED',
      'shop.next': 'NEXT TIER',
      'shop.install': 'INSTALL',
      'shop.installCost': function (m) { return 'INSTALL  ' + m; },
      'shop.maxed': 'FULLY UPGRADED',
      'shop.fittedName': function (name) { return 'FITTED: ' + name; },
      'shop.requires': function (part, name) {
        return 'REQUIRES ' + part + (name ? (': ' + name) : '') + ' — the tracks cannot carry this engine yet.';
      },
      'shop.runningGear': 'RUNNING GEAR',
      'shop.need': function (m) { return 'NEED ' + m + ' MORE IN THE ACCOUNT.'; },
      'shop.upgraded': function (part) { return part + ' UPGRADED'; },
      'shop.upgradedSub': function (mk) { return mk + ' fitted and bolted down'; },
      'shop.refused': 'INSTALL REFUSED',
      'shop.noPreview': 'MACHINE PREVIEW UNAVAILABLE',
      'shop.part.drill': 'DRILL',
      'shop.part.lights': 'LIGHTS',
      'shop.part.scanner': 'SCANNER',
      'shop.part.engine': 'ENGINE',
      'shop.part.tracks': 'TRACKS',
      'shop.part.cooling': 'COOLING',
      'shop.part.fuel': 'FUEL',
      'shop.part.cargo': 'CARGO',
      'shop.partStat.drill': 'POWER',
      'shop.partStat.lights': 'REACH',
      'shop.partStat.scanner': 'RANGE',
      'shop.partStat.engine': 'SPEED',
      'shop.partStat.tracks': 'TURN',
      'shop.partStat.cooling': 'SHED',
      'shop.partStat.fuel': 'TANK',
      'shop.partStat.cargo': 'HOLD',
      'shop.partBlurb.drill': 'Harder rock, faster. Every tier crosses a real hardness threshold.',
      'shop.partBlurb.lights': 'The cavern you cannot see is the cavern you drive into.',
      'shop.partBlurb.scanner': 'Reads ore signatures through rock you have not touched yet.',
      'shop.partBlurb.engine': 'Speed, and the shove to push loose debris out of the way.',
      'shop.partBlurb.tracks': 'Grip and turn rate. A digger that cannot turn cannot come back.',
      'shop.partBlurb.cooling': 'The deep is hot. Cooling is what makes the bottom survivable.',
      'shop.partBlurb.fuel': 'Every extra unit is another minute you can spend down there.',
      'shop.partBlurb.cargo': 'Fewer return trips. The hold is the whole reason to go down.',
      'shop.stat.power': 'POWER',
      'shop.stat.cap': 'CAP',
      'shop.stat.speed': 'SPEED',
      'shop.stat.thrust': 'THRUST',
      'shop.stat.turn': 'TURN',
      'shop.stat.grip': 'GRIP',
      'shop.stat.armor': 'ARMOR',
      'shop.stat.collect': 'COLLECT',
      'shop.stat.radius': 'RADIUS',
      'shop.stat.range': 'RANGE',
      'shop.stat.heatCap': 'HEAT CAP',
      'shop.stat.shed': 'SHED',
      // --- js/advui.js: before a descent ---------------------------------
      'prep.kicker': 'LAST CHECKS BEFORE THE DARK',
      'prep.title': 'PREPARE DESCENT',
      'prep.hull': 'HULL',
      'prep.repair': 'REPAIR',
      'prep.repairCost': function (m) { return 'REPAIR  ' + m; },
      'prep.repaired': 'HULL REPAIRED',
      'prep.repairedSub': 'Plates welded, seams checked',
      'prep.repairRefused': 'REPAIR REFUSED',
      'prep.descend': 'DESCEND',
      'prep.descendCost': function (m) { return 'DESCEND  ·  ' + m; },
      'prep.theMine': 'THE MINE',
      'prep.meta': function (region, depth, rec, yours) {
        return region + '   ·   EST. ' + depth + ' m   ·   REC. DRILL ' + rec + '   ·   YOURS ' + yours;
      },
      'prep.noSurvey': 'NO SURVEY ON FILE',
      'lift.title': 'THE LIFT',
      'lift.count': function (owned, total) { return owned + ' OF ' + total + ' LEVELS'; },
      'lift.descendTo': function (level) { return 'DESCEND TO ' + level; },
      'lift.allOpen': 'EVERY LEVEL IS OPEN',
      'lift.short': function (i) { return 'L' + i; },
      'lift.start': 'START',
      'lift.held': 'HELD',
      'lift.sealed': 'SEALED',
      'lift.buy': 'BUY',
      'lift.need': function (m, level) { return 'NEED ' + m + ' MORE FOR ' + level + '.'; },
      'lift.opened': 'LEVEL OPENED',
      'lift.mapOpen': 'THE MAP IS OPEN',
      'lift.mapOpenSub': 'Every level here is yours — the world map is open. BACK takes you out to it.',
      // --- js/advui.js: after a run --------------------------------------
      'haul.kicker': 'EXTRACTION',
      'haul.title': 'THE HAUL',
      'haul.kickerStrand': 'THE MINE KEPT IT',
      'haul.kickerDone': 'EXTRACTION COMPLETE',
      'haul.stranded': 'STRANDED',
      'haul.secured': 'SECURED',
      'haul.leftBehind': 'LEFT BEHIND',
      'haul.holdValue': 'HOLD VALUE',
      'haul.depth': 'DEPTH REACHED',
      'haul.time': 'TIME UNDER',
      'haul.fuelLeft': 'FUEL LEFT',
      'haul.sell': 'SELL THE HAUL',
      'haul.refuel': 'REFUEL',
      'haul.refuelCost': function (m) { return 'REFUEL  ·  ' + m; },
      'haul.lineSold': 'Sold. The hold is empty and the money is in the account.',
      'haul.lineFull': 'Back at the surface with the hold intact.',
      'haul.lineEmpty': 'Back at the surface. The hold is empty.',
      'haul.noteLoad': function (level, depth, lost) {
        return 'The load is on ' + level + ' at ' + depth + ' m' + (lost ? (' — ' + lost + ' of it') : '') +
               '. Descend to that level to pick it up.';
      },
      'haul.noteBanked': function (m) { return 'BANKED ' + m + ' into the company account.'; },
      'haul.thatLevel': 'that level',
      'haul.reason.fuel': function (depth, level) { return 'The tank ran dry at ' + depth + ' m' + (level ? (' on ' + level) : '') + '.'; },
      'haul.reason.hull': function (depth, level) { return 'The hull gave out at ' + depth + ' m' + (level ? (' on ' + level) : '') + '.'; },
      'haul.reason.abort': function (depth, level) { return 'You walked away from the dig at ' + depth + ' m' + (level ? (' on ' + level) : '') + '.'; },
      'haul.reason.other': function (depth, level) { return 'The machine stopped at ' + depth + ' m' + (level ? (' on ' + level) : '') + '.'; },
      'haul.noneSecured': 'NOTHING WAS SECURED',
      'haul.noneHold': 'NOTHING IN THE HOLD',
      'haul.banked': 'BANKED',
      'haul.bankedSub': function (m) { return m + ' into the company account'; },
      'haul.tankFull': 'TANK FULL',
      'haul.tankFullSub': 'Nothing to top up',
      'haul.cantRefuel': 'CANNOT REFUEL',
      'haul.cantRefuelSub': function (m) { return 'Not enough in the account for ' + m; },
      'haul.refuelled': 'REFUELLED',
      'haul.refuelledSub': function (m) { return m + ' of diesel'; },
      'haul.tankEmpty': 'TANK IS EMPTY',
      'haul.tankEmptySub': 'Refuel before you go back down',
      'haul.cantDescend': 'CANNOT DESCEND',
      'haul.cantDescendSub': 'Check the mining rights for this site',
      // --- js/mines.js — the mines (names are place names in the fiction) ---
      'mine.old_creek.name': 'Old Creek Mine',
      'mine.old_creek.blurb': 'A worked-out family claim in the creek bed. Shallow, soft, and picked over twice already — but the coal is still there and nobody charges you to take it.',
      'mine.old_creek.L1': 'Topsoil',
      'mine.old_creek.L2': 'Creek Gravel',
      'mine.old_creek.L3': 'Old Workings',
      'mine.red_ridge.name': 'Red Ridge Quarry',
      'mine.red_ridge.blurb': 'An open quarry cut back into the ridge, and the first ground that fights you. The red hematite benches carry more iron than anyone can lift — but the silver runs with it, and somewhere under the bench limestone the first crystal in the world.',
      'mine.red_ridge.L1': 'Hematite Bench',
      'mine.red_ridge.L2': 'Silver Bench',
      'mine.red_ridge.L3': 'Deep Benches',
      'mine.blackstone.name': 'Blackstone Mine',
      'mine.blackstone.blurb': 'Sheeted quartz veins in granite, and the company that sank this shaft went under paying for the drill bits. The veins they were chasing are still down there, and so is the platinum nobody in their day knew how to sell.',
      'mine.blackstone.L1': 'Vein Granite',
      'mine.blackstone.L2': 'Silver Veins',
      'mine.blackstone.L3': 'Gold Pocket',
      'mine.frostpeak.name': 'Frostpeak Shaft',
      'mine.frostpeak.blurb': 'Nothing down here is warm, which is the whole attraction: the crystal vaults pay like a deep mine and ask nothing at all of your cooling. The ground itself is the problem — and the voidstone in it has never been cut by anybody.',
      'mine.frostpeak.L1': 'Ice-Bound Rock',
      'mine.frostpeak.L2': 'Crystal Vaults',
      'mine.deep_hollow.name': 'Deep Hollow',
      'mine.deep_hollow.blurb': 'A collapsed karst hollow with something hot underneath it. The ore is soft and the ground is generous — and the reef at the bottom reads yellow-green on every instrument anyone has ever lowered down there.',
      'mine.deep_hollow.L1': 'The Hollow',
      'mine.deep_hollow.L2': 'Hot Reef',
      'mine.cinder_fell.name': 'Cinder Fell',
      'mine.cinder_fell.blurb': 'A dead volcano with a live basement. Every metre of it reads above 0.8 on the thermal survey, the magma skin is shot through with obsidian nothing under a lance will touch — and the cinder core underneath is the only starcore anyone has ever brought up.',
      'mine.cinder_fell.L1': 'Magma Skin',
      'mine.cinder_fell.L2': 'Cinder Core',
      'mine.the_rift.name': 'The Rift',
      'mine.the_rift.blurb': 'The last of it is not rock in any sense a geologist will sign off on. Pressure locks of obsidian, vents that read a thousand degrees, and a floor of starcore with the ancient rock still in it — not scattered, not a rumour. In seams.',
      'mine.the_rift.L1': 'Obsidian Locks',
      'mine.the_rift.L2': 'Geothermal Vents',
      'mine.the_rift.L3': 'The Rift Floor',
      'mine.shakedown.name': 'SHAKEDOWN SHAFT',
      'mine.shakedown.blurb': 'A shaft nobody bothered to name. Good enough to shake the rig down.',
      // regions (m.regionLabel / SM.mines.regionLabel; the region id stays English)
      'mine.region.foothills': 'Foothills',
      'mine.region.red_ridge': 'Red Ridge',
      'mine.region.blackstone_range': 'Blackstone Range',
      'mine.region.frostpeak': 'Frostpeak',
      'mine.region.the_hollows': 'The Hollows',
      'mine.region.cinder_coast': 'Cinder Coast',
      'mine.region.the_rift': 'The Rift',
      'mine.region.test_ground': 'Test Ground',
      // hazards
      'mine.haz.rotten_timbers': 'Rotten timbers',
      'mine.haz.limestone_benches': 'Limestone benches',
      'mine.haz.hard_rock': 'Hard rock',
      'mine.haz.long_tunnels': 'Long tunnels',
      'mine.haz.heat': 'Heat',
      'mine.haz.frozen_ground': 'Frozen ground',
      'mine.haz.hardest_rock_in_the_world': 'Hardest rock in the world',
      'mine.haz.radiation': 'Radiation',
      'mine.haz.no_return_without_fuel': 'No return without fuel',
      'mine.haz.extreme_heat': 'Extreme heat',
      'mine.haz.obsidian': 'Obsidian',
      'mine.haz.gas_pockets': 'Gas pockets',
      'mine.haz.geothermal': 'Geothermal',
      'mine.haz.obsidian_locks': 'Obsidian locks',
      'mine.haz.depth': 'Depth',
      'mine.haz.unsurveyed': 'Unsurveyed',
      // --- js/rig.js — the workshop's parts ---
      'part.drill.title': 'DRILL',
      'part.drill.blurb': 'Hardness you can cut, and how fast you cut it.',
      'part.drill.t0.name': 'WORN AUGER BIT',
      'part.drill.t0.blurb': 'Soft ground only. Granite is a suggestion you cannot afford.',
      'part.drill.t1.name': 'TUNGSTEN BIT',
      'part.drill.t1.blurb': 'Limestone benches stop fighting back. Cuts the ANCIENT FORMATION.',
      'part.drill.t2.name': 'COMPOSITE ROTARY HEAD',
      'part.drill.t2.blurb': 'Copper, silver, gold and emerald at full speed. Granite at 42%.',
      'part.drill.t3.name': 'POLYCRYSTALLINE CUTTER',
      'part.drill.t3.blurb': 'Granite at sixty per cent. Cuts OBSIDIAN — the Rift locks open.',
      'part.drill.t4.name': 'THERMAL LANCE ARRAY',
      'part.drill.t4.blurb': 'Nothing but obsidian and bedrock is in the way any more.',
      'part.drill.t5.name': 'PLASMA CORE BREAKER',
      'part.drill.t5.blurb': 'Cuts BEDROCK — the floor of the mine itself. Slowly, but it cuts.',
      'part.engine.title': 'ENGINE',
      'part.engine.blurb': 'Ground speed, and the shove that clears loose debris.',
      'part.engine.t0.name': 'TIRED DIESEL',
      'part.engine.t0.blurb': 'It starts most mornings.',
      'part.engine.t1.name': 'REBUILT DIESEL',
      'part.engine.t1.blurb': 'A quarter faster everywhere, and it pushes rubble instead of stopping.',
      'part.engine.t2.name': 'TURBO DIESEL',
      'part.engine.t2.blurb': 'Long hauls back up the shaft stop costing you the run.',
      'part.engine.t3.name': 'TWIN TURBINE',
      'part.engine.t3.blurb': 'Classic-rig pace, underground, in the dark.',
      'part.engine.t4.name': 'HYDROGEN TURBINE',
      'part.engine.t4.blurb': 'Six hundred metres of climb becomes a minute and a half.',
      'part.engine.t5.name': 'FUSION DRIVE',
      'part.engine.t5.blurb': 'The Rift floor to daylight on one tank.',
      'part.tracks.title': 'TRACKS',
      'part.tracks.blurb': 'How sharply the hull turns, and how much of a cave-in it shrugs off.',
      'part.tracks.t0.name': 'PATCHED RUBBER',
      'part.tracks.t0.blurb': 'Turns like a barge. Every falling rock lands on the hull.',
      'part.tracks.t1.name': 'STEEL LINKED',
      'part.tracks.t1.blurb': 'Tighter cornering in narrow seams, and the first real plating.',
      'part.tracks.t2.name': 'WIDE STEEL',
      'part.tracks.t2.blurb': 'Holds a line across a cavern floor instead of skating.',
      'part.tracks.t3.name': 'HARDENED CLEAT',
      'part.tracks.t3.blurb': 'You can pick your way through an obsidian field without stopping.',
      'part.tracks.t4.name': 'GYRO-STABILISED',
      'part.tracks.t4.blurb': 'Turn on the spot. Cave-ins cost a scratch instead of a run.',
      'part.tracks.t5.name': 'MAGLEV CRAWLER',
      'part.tracks.t5.blurb': 'The hull stops caring what the floor is made of.',
      'part.fuel.title': 'FUEL',
      'part.fuel.blurb': 'How long you can stay down there.',
      'part.fuel.t0.name': 'DENTED TANK',
      'part.fuel.t0.blurb': 'The top of Old Creek and back. Not a metre of it is spare.',
      'part.fuel.t1.name': 'WELDED TANK',
      'part.fuel.t1.blurb': 'Three times the range. Old Creek opens up, Red Ridge is reachable.',
      'part.fuel.t2.name': 'TWIN TANKS',
      'part.fuel.t2.blurb': 'Red Ridge floor to ceiling, and a real look at Blackstone.',
      'part.fuel.t3.name': 'PRESSURE BLADDER',
      'part.fuel.t3.blurb': 'Blackstone and Frostpeak, there and back, with fuel to spare.',
      'part.fuel.t4.name': 'LONG-RANGE CELLS',
      'part.fuel.t4.blurb': 'Enough to reach the Deep Hollow floor and still climb out.',
      'part.fuel.t5.name': 'DEEP EXPEDITION RESERVE',
      'part.fuel.t5.blurb': 'Three and a half thousand metres. The Rift stops being suicide.',
      'part.cargo.title': 'CARGO',
      'part.cargo.blurb': 'Hold volume — and the intake radius that fills it.',
      'part.cargo.t0.name': 'OPEN SKIP',
      'part.cargo.t0.blurb': 'Twelve deposits of coal. You will learn to hate coal.',
      'part.cargo.t1.name': 'STEEL HOPPER',
      'part.cargo.t1.blurb': 'Double. Two full skips before you have to climb out.',
      'part.cargo.t2.name': 'HIGH-SIDED HOPPER',
      'part.cargo.t2.blurb': 'A silver vein no longer fills you up halfway along it.',
      'part.cargo.t3.name': 'COMPACTING HOPPER',
      'part.cargo.t3.blurb': 'Ore goes in crushed. A deep run stops being two trips.',
      'part.cargo.t4.name': 'DUAL HOPPER RIG',
      'part.cargo.t4.blurb': 'You can afford to carry the cheap ore as well as the good.',
      'part.cargo.t5.name': 'ORE TRAIN',
      'part.cargo.t5.blurb': 'Fifteen hundred units. Now the tank is what sends you home.',
      'part.lights.title': 'LIGHTS',
      'part.lights.blurb': 'How much of the cavern exists.',
      'part.lights.t0.name': 'CRACKED HEADLAMP',
      'part.lights.t0.blurb': 'You see the rock you are already touching.',
      'part.lights.t1.name': 'TWIN HALOGEN',
      'part.lights.t1.blurb': 'Far enough ahead to steer instead of react.',
      'part.lights.t2.name': 'ARC FLOODS',
      'part.lights.t2.blurb': 'Cavern walls resolve before you are inside them.',
      'part.lights.t3.name': 'MAST ARRAY',
      'part.lights.t3.blurb': 'You can read a whole chamber and pick the richest wall.',
      'part.lights.t4.name': 'XENON BATTERY',
      'part.lights.t4.blurb': 'Most of the screen is lit. Ore glints at you from range.',
      'part.lights.t5.name': 'DAYLIGHT RIG',
      'part.lights.t5.blurb': 'The dark stops being a mechanic.',
      'part.scanner.title': 'SCANNER',
      'part.scanner.blurb': 'Ore signatures through rock you have not touched.',
      'part.scanner.t0.name': 'NO SCANNER',
      'part.scanner.t0.blurb': 'You dig where the rock looks promising and hope.',
      'part.scanner.t1.name': 'PROSPECTOR COIL',
      'part.scanner.t1.blurb': 'Forty metres of warning. Enough to stop digging the wrong way.',
      'part.scanner.t2.name': 'PULSE SOUNDER',
      'part.scanner.t2.blurb': 'Seventy metres. You start choosing seams instead of finding them.',
      'part.scanner.t3.name': 'SEISMIC ARRAY',
      'part.scanner.t3.blurb': 'A hundred and ten metres, with a bearing you can trust.',
      'part.scanner.t4.name': 'DEEP RESONANCE',
      'part.scanner.t4.blurb': 'Reads the far wall of a cavern you have not entered.',
      'part.scanner.t5.name': 'ORE ORACLE',
      'part.scanner.t5.blurb': 'Two hundred and sixty metres. You plan the whole descent.',
      'part.cooling.title': 'COOLING',
      'part.cooling.blurb': 'Depth. Heat is the soft floor under every deep mine.',
      'part.cooling.t0.name': 'BLED RADIATOR',
      'part.cooling.t0.blurb': 'Breaks even to about 0.13 heat. Anything deeper is a stopwatch.',
      'part.cooling.t1.name': 'FLUSHED RADIATOR',
      'part.cooling.t1.blurb': 'The Blackstone silver veins stop being a countdown.',
      'part.cooling.t2.name': 'TWIN FANS',
      'part.cooling.t2.blurb': 'Holds station on the Deep Hollow floor. Cinder Fell still cooks you.',
      'part.cooling.t3.name': 'GLYCOL LOOP',
      'part.cooling.t3.blurb': 'The magma skin becomes a place you can work in bursts.',
      'part.cooling.t4.name': 'CRYO EXCHANGER',
      'part.cooling.t4.blurb': 'Breaks even in a geothermal vent. Cinder Fell opens properly.',
      'part.cooling.t5.name': 'PHASE-CHANGE CORE',
      'part.cooling.t5.blurb': 'The Rift floor at a thousand degrees, indefinitely.',
      // --- js/materials.js — what is in the rock and in the hold ---
      'mat.dirt': 'Dirt',
      'mat.stone': 'Stone',
      'mat.iron': 'Iron Ore',
      'mat.gold': 'Gold',
      'mat.gem': 'Emerald',
      'mat.crystal': 'Crystal',
      'mat.rare': 'Voidstone',
      'mat.rubble': 'Rubble',
      'mat.granite': 'Granite',
      'mat.starcore': 'Starcore',
      'mat.obsidian': 'Obsidian',
      'mat.timecell': 'Time Cell',
      'mat.boostcell': 'Boost',
      'mat.clay': 'Clay',
      'mat.coal': 'Coal',
      'mat.copper': 'Copper Ore',
      'mat.sandstone': 'Sandstone',
      'mat.limestone': 'Limestone',
      'mat.silver': 'Silver',
      'mat.platinum': 'Platinum',
      'mat.uranium': 'Uranium Ore',
      'mat.ancient': 'Ancient Debris',
      'mat.bedrock': 'Bedrock',
      // --- js/advterrain.js — words painted into the world ---
      'terr.level': function (n) { return 'LEVEL ' + n; },
      'terr.layer': function (n) { return 'LAYER ' + n; },
      'terr.locked': 'LOCKED',
      'terr.bedrock': 'BEDROCK',
      'terr.default.topsoil': 'TOPSOIL',
      'terr.default.clay': 'CLAY BEDS',
      'terr.default.sandstone': 'SANDSTONE',
      'terr.default.limestone': 'LIMESTONE',
      'terr.default.granite': 'GRANITE',
      'terr.default.deep': 'THE DEEP',
    }
  };

  var warned = {};
  function warn(key, why) {
    if (warned[key]) return;
    warned[key] = true;
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('SUPERMINE ADVENTURE: ' + why + ' "' + key + '"');
    }
  }

  var has = Object.prototype.hasOwnProperty;

  function t(key) {
    var v;
    if (has.call(STRINGS[lang], key)) v = STRINGS[lang][key];
    else if (has.call(STRINGS.en, key)) {
      warn(key, 'no ' + lang + ' text, showing English for');
      v = STRINGS.en[key];
    } else {
      warn(key, 'no text at all for');
      return key;
    }
    if (typeof v === 'function') {
      return v.apply(null, Array.prototype.slice.call(arguments, 1));
    }
    return v;
  }

  function getLang() { return lang; }
  function locale() { return LOCALES[lang]; }

  function paintStatic(root) {
    root = root || document;
    if (!root.querySelectorAll) return;
    var i, n, words;
    var a = root.querySelectorAll('[data-i18n]');
    for (i = 0; i < a.length; i++) {
      n = a[i];
      words = t(n.getAttribute('data-i18n'));
      if (n.textContent !== words) n.textContent = words;
    }
    a = root.querySelectorAll('[data-i18n-label]');
    for (i = 0; i < a.length; i++) {
      n = a[i];
      words = t(n.getAttribute('data-i18n-label'));
      n.setAttribute('aria-label', words);
      n.setAttribute('title', words);
    }
    a = root.querySelectorAll('[data-i18n-ph]');
    for (i = 0; i < a.length; i++) {
      a[i].setAttribute('placeholder', t(a[i].getAttribute('data-i18n-ph')));
    }
    markRows();
  }

  function setLang(next) {
    if (LANGS.indexOf(next) < 0) return;
    lang = next;
    document.documentElement.lang = lang;
    try { localStorage.setItem(KEY, lang); }
    catch (e) { /* not remembered; this visit still switches */ }
    paintStatic(document);
    var ev;
    try { ev = new CustomEvent('arcade:lang', { detail: lang }); }
    catch (e) {
      ev = document.createEvent('CustomEvent');
      ev.initCustomEvent('arcade:lang', false, false, lang);
    }
    document.dispatchEvent(ev);
  }

  /* -------------------------------------------------------------------------
   * THE LANGUAGE ROW
   * -------------------------------------------------------------------------
   * Two equal buttons in one segmented row, Norsk first, each with its flag and
   * its endonym — always in its own language, with a lang attribute so a screen
   * reader says it right. aria-pressed marks the chosen one and is what the
   * stylesheet reads (.sm-lang-btn[aria-pressed="true"]), so the picture and
   * what is announced cannot drift.
   *
   * `uid` keeps the Union Jack's clipPath ids unique per copy. Ids are
   * page-global, and with the row in the sound panel AND on the pause card a
   * shared id would clip the second flag against the first.
   *
   * Clicks stop here. The sound panel sits over the title overlay, whose own
   * click handler starts the game, and a language is not a way in.
   * ---------------------------------------------------------------------- */
  var NO_FLAG = '<svg class="sm-flag" viewBox="0 0 22 16" aria-hidden="true">' +
    '<rect width="22" height="16" fill="#ba0c2f"/>' +
    '<path d="M6 0h4v16H6zM0 6h22v4H0z" fill="#fff"/>' +
    '<path d="M7 0h2v16H7zM0 7h22v2H0z" fill="#00205b"/>' +
    '</svg>';

  function ukFlag(uid) {
    var c = 'uk-clip-' + uid, d = 'uk-diag-' + uid;
    return '<svg class="sm-flag" viewBox="0 0 60 30" aria-hidden="true">' +
      '<clipPath id="' + c + '"><path d="M0 0v30h60V0z"/></clipPath>' +
      '<clipPath id="' + d + '"><path d="M30 15h30v15zv15H0zH0V0zV0h30z"/></clipPath>' +
      '<g clip-path="url(#' + c + ')">' +
      '<path d="M0 0v30h60V0z" fill="#012169"/>' +
      '<path d="M0 0l60 30m0-30L0 30" stroke="#fff" stroke-width="6"/>' +
      '<path d="M0 0l60 30m0-30L0 30" clip-path="url(#' + d + ')" stroke="#c8102e" stroke-width="4"/>' +
      '<path d="M30 0v30M0 15h60" stroke="#fff" stroke-width="10"/>' +
      '<path d="M30 0v30M0 15h60" stroke="#c8102e" stroke-width="6"/>' +
      '</g></svg>';
  }

  function markRows() {
    var a = document.querySelectorAll('.sm-lang-btn');
    for (var i = 0; i < a.length; i++) {
      a[i].setAttribute('aria-pressed',
        a[i].getAttribute('data-lang') === lang ? 'true' : 'false');
    }
  }

  function langRow(parent, uid) {
    var row = document.createElement('div');
    row.className = 'sm-lang';
    var cap = document.createElement('div');
    cap.className = 'sm-lang-label';
    cap.setAttribute('data-i18n', 'menu.language');
    cap.textContent = t('menu.language');
    row.appendChild(cap);

    var seg = document.createElement('div');
    seg.className = 'sm-lang-seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('data-i18n-label', 'menu.language');
    seg.setAttribute('aria-label', t('menu.language'));
    row.appendChild(seg);

    var defs = [
      { id: 'nb', name: 'NORSK', flag: NO_FLAG },
      { id: 'en', name: 'ENGLISH', flag: ukFlag(uid || 'x') }
    ];
    defs.forEach(function (d) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'sm-btn sm-lang-btn';
      b.setAttribute('data-lang', d.id);
      b.setAttribute('lang', d.id);
      b.setAttribute('aria-pressed', d.id === lang ? 'true' : 'false');
      b.innerHTML = d.flag + '<span class="sm-lang-name">' + d.name + '</span>';
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        b.blur();
        setLang(d.id);
      });
      seg.appendChild(b);
    });

    if (parent) parent.appendChild(row);
    return row;
  }

  return {
    t: t,
    getLang: getLang,
    setLang: setLang,
    paintStatic: paintStatic,
    locale: locale,
    langRow: langRow
  };
})();

window.I18N = I18N;
