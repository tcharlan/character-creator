/**
 * The draft store (PLAN 2.9): the one place the player's draft is read and written, on their own user
 * (`user.flags["character-creator"].draft`; players may write their own flags). It stores the recipe, not the
 * result (convention 8). Logic without Foundry is in state.mjs.
 */

import { MODULE_ID, DRAFT_FLAG, STATUS, makeError, createDraft, checkDraftShape } from "../contracts.mjs";
import { draftState, isEditable, Debouncer } from "./state.mjs";

const draftPath = `flags.${MODULE_ID}.${DRAFT_FLAG}`;

/** Store a whole draft on a user (ForcedReplacement: no stale keys survive a merge). */
export function writeDraft(user, draft) {
  return user.update({ [draftPath]: foundry.data.operators.ForcedReplacement.create(draft) });
}

/** Thrown when a save is refused; `err.error` is the contract error. */
export class DraftError extends Error {
  constructor(code, detail) {
    super(`${code}${detail ? `: ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
    this.error = makeError(code, detail);
  }
}

export class DraftStore {
  #user;
  #debouncer;
  #draft = null;

  /**
   * @param {User} [user]           Default: the current user.
   * @param {{ delay?: number }} [options]   Autosave delay in ms (default 1000).
   */
  constructor(user = game.user, { delay = 1000 } = {}) {
    this.#user = user;
    this.#debouncer = new Debouncer(draft => this.#write(draft), delay);
  }

  /** The draft being edited (after load, create or update), or null. */
  get draft() {
    return this.#draft;
  }

  /** Is an autosave waiting? */
  get pending() {
    return this.#debouncer.pending;
  }

  /**
   * Read the stored draft for this world and rules (migrated if needed). Only an `editable` draft becomes the
   * one being edited; `submitted` and `created` ones are returned read-only.
   * @returns {{ state: string, draft: object|null, migrated: boolean, problems: object[] }}  See state.mjs.
   */
  load() {
    const res = draftState(this.#user.getFlag(MODULE_ID, DRAFT_FLAG), this.#world());
    this.#draft = res.state === "editable" ? res.draft : null;
    return res;
  }

  /** Start a new draft (replacing any stored one) and save it now. */
  async create() {
    this.#debouncer.cancel();
    const { worldId, rules } = this.#world();
    this.#draft = createDraft({ id: foundry.utils.randomID(), worldId, rules });
    await this.#write(this.#draft);
    return this.#draft;
  }

  /**
   * Change the draft and autosave it (debounced). Refuses a draft that isn't editable (ALREADY_SUBMITTED) or
   * would be malformed or too large (BAD_REQUEST) — the stored draft stays as it was.
   * @param {(draft: object) => object|void} change   Mutates a copy, or returns a new draft object.
   * @returns {Promise<void>}  Settles when the autosave that includes this change is written.
   */
  update(change) {
    if ( !isEditable(this.#draft) ) {
      return Promise.reject(new DraftError("ALREADY_SUBMITTED", { status: this.#draft?.status ?? null }));
    }
    const copy = foundry.utils.deepClone(this.#draft);
    // A returned draft replaces the copy; any other return value (e.g. `d => d.x = 1`) is ignored.
    const returned = change(copy);
    const next = returned && typeof returned === "object" && "schema" in returned ? returned : copy;
    next.updatedAt = Date.now();
    const problems = checkDraftShape(next);
    if ( problems.length ) return Promise.reject(new DraftError("BAD_REQUEST", { problems: problems.slice(0, 20) }));
    this.#draft = next;
    return this.#debouncer.schedule(next);
  }

  /** Write a waiting autosave now (e.g. when the wizard closes). */
  flush() {
    return this.#debouncer.flush();
  }

  /** Remove the stored draft, and its pending portrait with it. Earlier rolls stay in chat (A10). */
  async discard() {
    this.#debouncer.cancel();
    this.#draft = null;
    if ( this.#user.getFlag(MODULE_ID, DRAFT_FLAG) !== undefined ) await this.#user.unsetFlag(MODULE_ID, DRAFT_FLAG);
  }

  /**
   * After the player has seen the result: a created draft is cleared (the actor is the record); a failed one
   * goes back to editing with its errors cleared.
   * @returns {Promise<object|null>}  The draft to keep editing, or null.
   */
  async acknowledge() {
    const { state, draft } = draftState(this.#user.getFlag(MODULE_ID, DRAFT_FLAG), this.#world());
    if ( state === "created" ) {
      await this.discard();
      return null;
    }
    if ( draft?.status === STATUS.FAILED ) {
      this.#draft = { ...draft, status: STATUS.DRAFT, updatedAt: Date.now(), result: { actorUuid: null, errors: [] } };
      await this.#write(this.#draft);
      return this.#draft;
    }
    return this.#draft;
  }

  #world() {
    return { worldId: game.world.id, rules: game.settings.get("dnd5e", "rulesVersion") };
  }

  async #write(draft) {
    // Refuse to overwrite a draft a GM is processing or has processed since this one was loaded.
    const stored = this.#user.getFlag(MODULE_ID, DRAFT_FLAG);
    if ( stored?.id === draft.id && !isEditable(stored) && isEditable(draft) ) {
      throw new DraftError("ALREADY_SUBMITTED", { status: stored.status });
    }
    await writeDraft(this.#user, draft);
    return draft;
  }
}
