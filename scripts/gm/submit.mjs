/**
 * GM query handlers (PLAN 2.7; DESIGN.md → Queries). Registered on every client; only the active GM answers
 * (D13: the GM is the only writer).
 *
 * `QUERIES.SUBMIT` `{ draft, image? }`:
 *   payload check → in-flight lock per draft → idempotency (the actor already created from this draft)
 *   → validateDraft against the player's catalog → create → assign as the player's character → portrait
 *   (a failed portrait is a warning, never a failure).
 * `QUERIES.UPLOAD_PORTRAIT` `{ actorUuid, image, ring? }`: after creation (A5), for an actor the sender owns.
 */

import { QUERIES, makeError, checkSubmitPayload, checkUploadPayload } from "../contracts.mjs";
import { getCatalog } from "../catalog/catalog.mjs";
import { NO_RESTRICTIONS } from "../catalog/filters.mjs";
import { validateDraft } from "../rules/validate.mjs";
import { createCharacter, createdFor, createdFrom } from "./create.mjs";
import { savePortrait } from "./portrait.mjs";
import { InFlight } from "./inflight.mjs";
import { readSettings } from "../settings/settings.mjs";
import { checkRandomCharacter } from "./random-review.mjs";

const inFlight = new InFlight();
const isActiveGM = () => game.user.isGM && !!game.users.activeGM?.isSelf;
const fail = (errors, extra = {}) => ({ ok: false, errors, ...extra });

export function registerGmQueries() {
  CONFIG.queries[QUERIES.SUBMIT] = handleSubmit;
  CONFIG.queries[QUERIES.UPLOAD_PORTRAIT] = handleUploadPortrait;
}

/**
 * @param {{ draft: object, image?: object }} payload
 * @param {{ user: User }} context   The sender (Foundry fills this in; it can't be forged by the payload).
 */
export async function handleSubmit(payload, { user }, options = {}) {
  if ( !isActiveGM() ) return fail([makeError("NOT_ACTIVE_GM")]);
  return submitFor(payload, user, options);
}

/**
 * The submit path for a user's payload, shared by the query handler and the pending-build processor
 * (pending.mjs). Callers make sure this is the active GM.
 * @param {{ draft: object, image?: object }} payload
 * @param {User} user   The player the draft belongs to.
 */
export async function submitFor(payload, user, options = {}) {
  const problems = checkSubmitPayload(payload);
  if ( problems.length ) return fail([makeError("BAD_REQUEST", { problems: problems.slice(0, 20) })]);
  return inFlight.run(`${user.id}:${payload.draft.id}`, () => submit(payload, user, options));
}

/** Settings (PLAN 2.10), overridable per call for tests. */
async function submit({ draft, image = null }, user, overrides = {}) {
  const settings = { ...readSettings(), ...overrides };
  const { characterLimit, abilityMethods: allowedMethods } = settings;
  const existing = createdFrom(draft.id, user.id);
  if ( existing ) return { ok: true, actorUuid: existing.uuid, duplicate: true, warnings: [] };

  const catalog = await getCatalog({ user });
  // The standard items, for a kit the GM's allowed list can't fill: the same fallback the player was offered.
  const standard = await getCatalog({ user, restrictions: NO_RESTRICTIONS });
  // A character the dice made is checked against the rolls that made it (D31).
  if ( draft.mode === "hardcore" ) {
    const problems = await checkRandomCharacter(draft, { catalog, userId: user.id });
    if ( problems.length ) return fail(problems);
  }
  // The character limit is for players; a GM's characters are theirs to give away (D29).
  const validated = await validateDraft(draft, { catalog, standard, userId: user.id, allowedMethods, image,
    characters: { limit: user.isGM ? null : characterLimit, existing: createdFor(user.id).length } });
  if ( !validated.ok ) return fail(validated.errors, { byStep: validated.byStep });

  const actor = await createCharacter(validated, { user, catalog, folderName: settings.folderName });
  const warnings = [];
  if ( !user.character && !user.isGM ) await user.update({ character: actor.id });
  if ( image && !settings.portraits.enabled ) warnings.push(makeError("UPLOADS_DISABLED"));
  else if ( image ) {
    const saved = await savePortrait(actor, image, draft.portrait?.ring, user, { ringDefaults: settings.ringColors });
    if ( !saved.ok ) warnings.push(saved.error);
  }
  return { ok: true, actorUuid: actor.uuid, duplicate: false, warnings };
}

/**
 * @param {{ actorUuid: string, image: object, ring?: object }} payload
 * @param {{ user: User }} context
 */
export async function handleUploadPortrait(payload, { user }) {
  if ( !isActiveGM() ) return fail([makeError("NOT_ACTIVE_GM")]);
  const problems = checkUploadPayload(payload);
  if ( problems.length ) return fail([makeError("BAD_REQUEST", { problems: problems.slice(0, 20) })]);
  const actor = await fromUuid(payload.actorUuid);
  if ( !(actor instanceof Actor) ) return fail([makeError("NO_ACTOR")]);
  if ( !actor.testUserPermission(user, "OWNER") ) return fail([makeError("NOT_OWNER")]);
  const settings = readSettings();
  if ( !settings.portraits.enabled ) return fail([makeError("UPLOADS_DISABLED")]);
  const saved = await savePortrait(actor, payload.image, payload.ring, user, { ringDefaults: settings.ringColors });
  return saved.ok ? { ok: true, path: saved.path } : fail([saved.error]);
}
