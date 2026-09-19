/**
 * Pending builds (PLAN 2.8, D17), the parts that need no Foundry: which drafts the processor takes, and
 * what it writes back on the player's draft afterwards.
 */

import { STATUS } from "../contracts.mjs";

/**
 * Drafts waiting for a GM, oldest first.
 * @param {{ id: string, isGM: boolean, draft: object|null }[]} users   Plain user data.
 * @returns {{ userId: string, draft: object }[]}
 */
export function pendingDrafts(users) {
  return users
    .filter(u => !u.isGM && u.draft?.status === STATUS.SUBMITTED)
    .map(u => ({ userId: u.id, draft: u.draft }))
    .sort((a, b) => (a.draft.updatedAt ?? 0) - (b.draft.updatedAt ?? 0));
}

/** The draft as submitted: status `submitted`, the portrait kept with it until a GM saves it (D17). */
export function submittedDraft(draft, image, now = Date.now()) {
  return { ...draft, status: STATUS.SUBMITTED, updatedAt: now,
    portrait: { ...draft.portrait, pendingImage: image ?? null }, result: { actorUuid: null, errors: [] } };
}

/**
 * The player's draft after processing.
 * - Created: status `created`, the actor, and the pending portrait dropped (saved on the actor, or reported).
 * - Rejected: status `failed` with the errors (at most 100); the portrait stays for a resubmission.
 * @param {object} draft
 * @param {{ ok: boolean, actorUuid?: string, errors?: object[], warnings?: object[] }} outcome   From the submit path.
 */
export function processedDraft(draft, outcome, now = Date.now()) {
  if ( outcome.ok ) {
    return { ...draft, status: STATUS.CREATED, updatedAt: now, portrait: { ...draft.portrait, pendingImage: null },
      result: { actorUuid: outcome.actorUuid, errors: (outcome.warnings ?? []).slice(0, 100) } };
  }
  return { ...draft, status: STATUS.FAILED, updatedAt: now, result: { actorUuid: null, errors: (outcome.errors ?? []).slice(0, 100) } };
}
