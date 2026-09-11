// ---------------------------------------------------------------------------
// The activity checker.
//
// A contender who alt-tabs (or switches apps on a phone) is, as far as the
// table is concerned, on their phone — and the pub gets to see it. This
// module folds every signal the browser gives us into one of three states
// and reports TRANSITIONS to the caller, which forwards them to the module
// (set_attention). The tally lives server-side, so nobody can quietly edit
// their own phone time; this file only decides what to report and when.
//
// Signals, in order of confidence:
//   document.visibilityState — hidden = tab in the background, app
//     switched, screen locked. Unambiguous: PHONE.
//   window focus/blur — the tab is visible but another window has the
//     keyboard (a second monitor, a chat app on top). Also PHONE, after a
//     short grace so a stray click on the desktop doesn't fire it.
//   input silence — visible AND focused, but nothing pressed or moved for
//     IDLE_AFTER_MS. Softer: IDLE ("wake up!" rather than "phone down").
// ---------------------------------------------------------------------------
import { ATT_HERE, ATT_IDLE, ATT_PHONE, IDLE_AFTER_MS } from './config';

const BLUR_GRACE_MS = 1500;

let state = ATT_HERE;
let lastInput = performance.now();
let blurTimer: number | null = null;
let idleTimer: number | null = null;
let listener: ((state: number) => void) | null = null;

function report(next: number) {
  if (next === state) return;
  state = next;
  listener?.(state);
}

function armIdle() {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    if (state === ATT_HERE) report(ATT_IDLE);
  }, IDLE_AFTER_MS);
}

function onInput() {
  lastInput = performance.now();
  if (state === ATT_IDLE) report(ATT_HERE);
  armIdle();
}

function evaluate() {
  if (document.visibilityState === 'hidden') {
    if (blurTimer !== null) { clearTimeout(blurTimer); blurTimer = null; }
    report(ATT_PHONE);
    return;
  }
  if (!document.hasFocus()) {
    // visible but unfocused: give a stray click a moment to come back
    if (blurTimer === null && state !== ATT_PHONE) {
      blurTimer = window.setTimeout(() => {
        blurTimer = null;
        if (document.visibilityState !== 'hidden' && !document.hasFocus()) report(ATT_PHONE);
      }, BLUR_GRACE_MS);
    }
    return;
  }
  if (blurTimer !== null) { clearTimeout(blurTimer); blurTimer = null; }
  // Back and looking: idle only if nothing has been touched for a while
  report(performance.now() - lastInput > IDLE_AFTER_MS ? ATT_IDLE : ATT_HERE);
  armIdle();
}

/** Start watching. `cb` gets every state change (ATT_*). */
export function startAttentionChecker(cb: (state: number) => void) {
  listener = cb;
  document.addEventListener('visibilitychange', evaluate);
  window.addEventListener('focus', evaluate);
  window.addEventListener('blur', evaluate);
  window.addEventListener('pagehide', () => report(ATT_PHONE));
  window.addEventListener('pageshow', evaluate);
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const) {
    window.addEventListener(ev, onInput, { passive: true });
  }
  armIdle();
  evaluate();
}

export const attentionState = () => state;

/** Re-send the current state — after a reconnect the module's copy is stale
 *  (clientConnected resets it to HERE). */
export function resyncAttention() {
  listener?.(state);
}
