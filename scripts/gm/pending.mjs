/**
 * Submitting with no GM online (PLAN 2.8, D17; CREATION-FLOW.md → Create character).
 *
 * Player side: `submitDraft` asks the active GM; with no GM online (or on a timeout or lost connection) it
 * stores the draft as `submitted` on the player's own user flag, portrait included.
 *
 * GM side: the pending-build processor runs in every GM browser on `ready`, `updateUser` and when a user
 * disconnects (the active GM may change), but only the active GM acts. Each pending draft goes through the
 * same path as a live submit (gm/submit.mjs `submitFor`: lock, idempotency, validation, creation, portrait),
 * then the result is written back on the player's draft: `created` (portrait dropped) or `failed` (errors).
 */

import { MODULE_ID, DRAFT_FLAG, QUERIES, STATUS } from "../contracts.mjs";
import { submitFor } from "./submit.mjs";
import { pendingDrafts, submittedDraft, processedDraft } from "./pending-core.mjs";
import { writeDraft } from "../draft/store.mjs";

export { writeDraft };

const draftPath = `flags.${MODULE_ID}.${DRAFT_FLAG}`;

/* -------------------------------------------- */
/*  Player side                                 */
/* -------------------------------------------- */

/**
 * Submit a draft: live when a GM is online, otherwise stored as a pending build.
 * @param {object} draft
 * @param {{ image?: object|null, timeout?: number }} [options]
 * @returns {Promise<{ ok: boolean, pending?: boolean, actorUuid?: string, errors?: object[], byStep?: object[],
 *   warnings?: object[] }>}  `pending: true` when stored for a GM to process later.
 */
export async function submitDraft(draft, { image = null, timeout = 30_000 } = {}) {
  const gm = game.users.activeGM;
  if ( gm ) {
    try {
      return await gm.query(QUERIES.SUBMIT, { draft: { ...draft, portrait: { ...draft.portrait, pendingImage: null } }, image },
        { timeout });
    } catch ( err ) {
      // Timed out or the GM left: treated as offline. Creation is idempotent per draft, so if the GM did
      // finish, the processor only records the result.
      console.warn(`${MODULE_ID} | submit didn't complete (${err.message}); keeping it as a pending build`);
    }
  }
  await writeDraft(game.user, submittedDraft(draft, image));
  return { ok: true, pending: true };
}

/* -------------------------------------------- */
/*  GM side                                     */
/* -------------------------------------------- */

const isActiveGM = () => game.user.isGM && !!game.users.activeGM?.isSelf;
let running = null;
let again = false;

/**
 * Process every pending build, one at a time. Calls while it runs schedule one more pass.
 * @returns {Promise<{ userId, status }[]>}  What this pass did (for tests and logs).
 */
export function processPending() {
  if ( !isActiveGM() ) return Promise.resolve([]);
  if ( running ) {
    again = true;
    return running;
  }
  running = (async () => {
    const done = [];
    do {
      again = false;
      const users = game.users.map(u => ({ id: u.id, isGM: u.isGM, draft: u.getFlag(MODULE_ID, DRAFT_FLAG) ?? null }));
      for ( const { userId, draft } of pendingDrafts(users) ) {
        if ( !isActiveGM() ) break;
        done.push({ userId, status: await processOne(game.users.get(userId), draft) });
      }
    } while ( again && isActiveGM() );
    return done;
  })().finally(() => running = null);
  return running;
}

/** One pending build: the live submit path, then the result on the player's draft. */
async function processOne(user, draft) {
  const image = draft.portrait?.pendingImage ?? null;
  let outcome;
  try {
    outcome = await submitFor({ draft: { ...draft, status: STATUS.DRAFT, portrait: { ...draft.portrait, pendingImage: null } }, image }, user);
  } catch ( err ) {
    console.error(`${MODULE_ID} | pending build for ${user.name} failed`, err);
    return "error";   // left as submitted; the next pass retries
  }
  // The player may have changed or discarded the draft meanwhile: only record a result for the same one.
  const current = user.getFlag(MODULE_ID, DRAFT_FLAG);
  if ( current?.id !== draft.id || current.status !== STATUS.SUBMITTED ) return "superseded";
  const next = processedDraft(current, outcome);
  await writeDraft(user, next);
  console.log(`${MODULE_ID} | pending build for ${user.name}: ${next.status}`);
  return next.status;
}

/** Run the processor on ready, when a draft changes, and when a user disconnects (a new active GM). */
export function registerPendingProcessor() {
  Hooks.once("ready", () => processPending());
  Hooks.on("updateUser", (user, changes) => {
    if ( foundry.utils.hasProperty(changes, draftPath) ) processPending();
  });
  Hooks.on("userConnected", (user, connected) => {
    if ( !connected ) processPending();
  });
}
