/**
 * Draft store logic that needs no Foundry (PLAN 2.9): what a stored draft can be used for, the size budget,
 * and a debouncer for autosave. `store.mjs` is the Foundry side.
 */

import { STATUS, LIMITS, migrateDraft, checkDraftShape } from "../contracts.mjs";

/**
 * States of a stored draft:
 * - `none`: nothing stored — start a new one.
 * - `editable`: a draft (or a failed submission, to fix and resubmit) for this world and rules.
 * - `submitted`: waiting for a GM (read-only).
 * - `created`: a GM created the character; show it, then clear the draft.
 * - `otherWorld` / `otherRules`: can't resume here — offer to discard.
 * - `tooNew`: written by a newer version of the module — can't resume; keep it (an update may read it).
 * - `broken`: unreadable — offer to discard.
 */
export const DRAFT_STATES = Object.freeze(["none", "editable", "submitted", "created", "otherWorld", "otherRules", "tooNew",
  "broken"]);

/**
 * Classify a stored draft.
 * @param {object|null|undefined} stored
 * @param {{ worldId: string, rules: string }} world
 * @returns {{ state: string, draft: object|null, migrated: boolean, problems: object[] }}
 *   `draft` is the migrated copy (null for none, tooNew, broken).
 */
export function draftState(stored, { worldId, rules }) {
  const out = (state, draft = null, extra = {}) => ({ state, draft, migrated: false, problems: [], ...extra });
  if ( stored === null || stored === undefined ) return out("none");
  let draft;
  let migrated;
  try {
    ({ draft, migrated } = migrateDraft(stored));
  } catch ( err ) {
    return out(err.code === "SCHEMA_TOO_NEW" ? "tooNew" : "broken", null, { problems: [{ path: "draft.schema", problem: err.message }] });
  }
  const problems = checkDraftShape(draft);
  if ( problems.length ) return out("broken", null, { problems });
  if ( draft.worldId !== worldId ) return out("otherWorld", draft, { migrated });
  if ( draft.rules !== rules ) return out("otherRules", draft, { migrated });
  const byStatus = { [STATUS.DRAFT]: "editable", [STATUS.FAILED]: "editable", [STATUS.SUBMITTED]: "submitted",
    [STATUS.CREATED]: "created" };
  return out(byStatus[draft.status] ?? "broken", draft, { migrated });
}

/** Is a draft in a state the player may change? */
export const isEditable = draft => draft?.status === STATUS.DRAFT || draft?.status === STATUS.FAILED;

/** Bytes of the draft flag, not counting the pending portrait (capped separately). */
export function draftBytes(draft) {
  const withoutImage = { ...draft, portrait: { ...draft?.portrait, pendingImage: null } };
  return new TextEncoder().encode(JSON.stringify(withoutImage)).length;
}

/** Within the flag budget (LIMITS.draftMaxBytes)? */
export const fitsBudget = draft => draftBytes(draft) <= LIMITS.draftMaxBytes;

/**
 * Debounce writes: `schedule(value)` restarts the timer and remembers the latest value; after `delay` ms of
 * quiet, `write(latest)` runs once. `flush()` writes now. Every caller's promise settles with that write.
 */
export class Debouncer {
  #write;
  #delay;
  #setTimer;
  #clearTimer;
  #timer = null;
  #value;
  #waiters = [];

  /**
   * @param {(value) => Promise<any>} write
   * @param {number} delay
   * @param {{ setTimer?: Function, clearTimer?: Function }} [timers]   For tests.
   */
  // Wrapped: the browser's setTimeout throws "Illegal invocation" when called as another object's method.
  constructor(write, delay, { setTimer = (fn, ms) => globalThis.setTimeout(fn, ms), clearTimer = id => globalThis.clearTimeout(id) } = {}) {
    this.#write = write;
    this.#delay = delay;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
  }

  /** Is a write waiting? */
  get pending() {
    return this.#timer !== null;
  }

  /** @returns {Promise<any>} settles when the write that includes this value finishes. */
  schedule(value) {
    this.#value = value;
    if ( this.#timer !== null ) this.#clearTimer(this.#timer);
    // A failed timed write is reported to the waiting callers, not as an unhandled rejection.
    this.#timer = this.#setTimer(() => this.flush().catch(() => null), this.#delay);
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  /** Write the waiting value now (no-op if nothing waits). */
  async flush() {
    if ( this.#timer === null ) return;
    this.#clearTimer(this.#timer);
    this.#timer = null;
    const waiters = this.#waiters;
    this.#waiters = [];
    try {
      const result = await this.#write(this.#value);
      waiters.forEach(w => w.resolve(result));
      return result;
    } catch ( err ) {
      waiters.forEach(w => w.reject(err));
      throw err;
    }
  }

  /** Drop the waiting value without writing (e.g. on discard). Waiters resolve with undefined. */
  cancel() {
    if ( this.#timer !== null ) this.#clearTimer(this.#timer);
    this.#timer = null;
    this.#waiters.forEach(w => w.resolve(undefined));
    this.#waiters = [];
  }
}
