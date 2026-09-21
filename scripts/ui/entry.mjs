/**
 * What the entry points offer (PLAN 3.10; CREATION-FLOW → Entry points): one decision shared by the Actors
 * sidebar button and the first-login prompt, so both always say the same thing. Pure — `entry-ui.mjs` is the
 * Foundry side.
 *
 * The wizard is a player tool: only the GM's browser writes characters (D13), and a GM would be asking their own
 * browser to do it, so the entry points stay hidden for GMs. `module.api.openWizard()` is still there for them.
 */

/** What the button offers, in the order a draft moves through. */
export const ENTRY_KINDS = Object.freeze(["create", "continue", "waiting", "ready"]);

/** Draft states (draft/state.mjs) that aren't a draft to continue: the wizard offers to discard and start again. */
const KIND_BY_STATE = Object.freeze({ editable: "continue", submitted: "waiting", created: "ready" });

const ICONS = Object.freeze({ create: "fa-solid fa-hat-wizard", continue: "fa-solid fa-pen-fancy",
  waiting: "fa-solid fa-hourglass-half", ready: "fa-solid fa-star", queue: "fa-solid fa-hourglass-half" });

/**
 * What the Actors sidebar should show this user.
 * @param {object} options
 * @param {string} [options.state]     The stored draft's state, from draftState().
 * @param {number} [options.created]   Characters this module has already made for them.
 * @param {number|null} [options.limit]   The character limit (null = no limit).
 * @param {boolean} [options.isGM]
 * @returns {{ visible: boolean, kind: string|null, hidden: string|null, label: string, tooltip: string,
 *   icon: string }}  `hidden` says why there's no button ("gm" or "limit"); the labels are i18n keys.
 */
export function entryState({ state = "none", created = 0, limit = null, isGM = false, waiting = 0 } = {}) {
  const none = reason => ({ visible: false, kind: null, hidden: reason, label: "", tooltip: "", icon: "" });
  // A GM doesn't make characters here, but they are the one who creates them: show what is waiting (PLAN 4.2).
  if ( isGM ) {
    return waiting > 0
      ? { visible: true, kind: "queue", hidden: null, count: waiting, label: "CHARCREATOR.Entry.queue.Button",
        tooltip: "CHARCREATOR.Entry.queue.Tooltip", icon: ICONS.queue }
      : none("gm");
  }
  const kind = KIND_BY_STATE[state] ?? "create";
  // At the limit there's nothing to start; a draft already under way is still shown, so it can be finished or
  // discarded rather than sitting there invisibly.
  if ( (kind === "create") && (limit !== null) && (created >= limit) ) return none("limit");
  return { visible: true, kind, hidden: null, label: `CHARCREATOR.Entry.${kind}.Button`,
    tooltip: `CHARCREATOR.Entry.${kind}.Tooltip`, icon: ICONS[kind] };
}

/**
 * How many characters this player may still make (A4). `limit` null means no limit at all.
 * @returns {{ limit: number|null, made: number, left: number|null, atLimit: boolean, unlimited: boolean }}
 */
export function allowance({ limit = null, made = 0 } = {}) {
  const unlimited = (limit === null) || (limit === undefined);
  const left = unlimited ? null : Math.max(0, limit - made);
  return { limit: unlimited ? null : limit, made, left, atLimit: !unlimited && (left === 0), unlimited };
}

/**
 * The prompt shown once a session (CREATION-FLOW → Entry points).
 *
 * A result the player is waiting for is always worth saying — it's the answer to something they sent, and for a
 * build made while they were away it's the only notice they get (TESTING B8). The nudge to start one is only for
 * a player without a character, and the GM can turn it off.
 * @param {ReturnType<entryState>} entry
 * @param {{ showOnLogin?: boolean, hasCharacter?: boolean }} [options]
 * @returns {{ message: string, kind: string, permanent: boolean }|null}
 */
export function loginPrompt(entry, { showOnLogin = true, hasCharacter = false } = {}) {
  if ( !entry?.visible ) return null;
  const result = (entry.kind === "waiting") || (entry.kind === "ready");
  if ( !result && (!showOnLogin || hasCharacter) ) return null;
  return { kind: entry.kind, message: `CHARCREATOR.Entry.${entry.kind}.Prompt`, permanent: entry.kind !== "waiting" };
}
