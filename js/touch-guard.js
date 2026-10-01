/*
 * touch-guard.js — stop the browser treating the game as a page of text.
 *
 * On a tablet, a thumb resting on the stick or the gauges is a long press,
 * and a drag that starts on a mine card, a workshop price or a save slot
 * is a text selection, so Safari highlights words and offers Copy / Look
 * Up while the rig is driving. style.css turns selection and the callout
 * off; this is the half CSS cannot promise, for the engines and the edges
 * where it is not honoured:
 *
 *   selectstart   cancelled unless it begins in a real text field
 *   contextmenu   cancelled likewise — on touch it IS the long-press menu
 *   selectionchange  anything that slipped through anyway is cleared, unless
 *                 a field has focus (a player naming their company
 *                 on a save slot must still be able to select what
 *                 they typed)
 *
 * The cost, written down: no right-click menu over the game on desktop
 * either. Nothing in a game wants one, and devtools stay a keystroke away.
 *
 * The game's own contextmenu handlers (the canvas in js/input.js, the
 * stick layer in js/joystick.js) still run first: this listens on document,
 * in the bubble phase, and stops nothing propagating.
 *
 * A classic, deferred script outside the SM global and outside the load
 * order in index.html, self-contained and importing nothing, so a failure
 * anywhere in the game cannot take this down and this cannot take the game
 * down.
 */
(function () {
  'use strict';

  function editable(node) {
    return !!(node && node.closest && node.closest('input, textarea, select, [contenteditable="true"]'));
  }

  document.addEventListener('selectstart', function (e) {
    if (!editable(e.target)) e.preventDefault();
  });

  document.addEventListener('contextmenu', function (e) {
    if (!editable(e.target)) e.preventDefault();
  });

  document.addEventListener('selectionchange', function () {
    if (editable(document.activeElement)) return;
    var sel = window.getSelection && window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) sel.removeAllRanges();
  });
})();
