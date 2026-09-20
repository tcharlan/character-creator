/**
 * Character Creator — shared contracts (convention 6): the draft schema, query names and payloads,
 * error codes and limits. The single source of truth for the player's wizard and the GM side.
 *
 * Pure: no Foundry globals, so it runs under `npm test` as well as in the browser. Structural checks
 * only — whether a draft is *legal* (allowed content, counts, rules) is the validator's job (PLAN 2.6).
 */

export const MODULE_ID = "character-creator";

/** Bump when the draft shape changes, and add a migration below. */
export const SCHEMA_VERSION = 1;

/** Where the draft lives: `user.flags[MODULE_ID][DRAFT_FLAG]` (players may write their own flags). */
export const DRAFT_FLAG = "draft";

/** Query names (`CONFIG.queries`; module-prefixed as Foundry requires). */
export const QUERIES = Object.freeze({
  SUBMIT: `${MODULE_ID}.submit`,
  UPLOAD_PORTRAIT: `${MODULE_ID}.uploadPortrait`
});

/** dnd5e's `rulesVersion` setting values; a draft is fixed to one when it starts. */
export const RULES = Object.freeze(["legacy", "modern"]);

export const STATUS = Object.freeze({ DRAFT: "draft", SUBMITTED: "submitted", CREATED: "created", FAILED: "failed" });

/** Wizard steps (CREATION-FLOW.md); error codes point at the step to revisit. */
export const STEPS = Object.freeze(["start", "species", "class", "background", "abilities", "choices", "equipment",
  "spells", "details", "portrait", "review"]);

export const ROLES = Object.freeze(["species", "background", "class"]);
export const ABILITIES = Object.freeze(["str", "dex", "con", "int", "wis", "cha"]);
export const ABILITY_METHODS = Object.freeze(["pointBuy", "standardArray", "rolled"]);
export const EQUIPMENT_MODES = Object.freeze(["items", "wealth"]);
export const PORTRAIT_STATUS = Object.freeze(["none", "skipped", "ready"]);
export const DETAIL_FIELDS = Object.freeze(["name", "pronouns", "alignment", "age", "height", "weight", "eyes", "hair",
  "skin", "appearance", "biography", "traits", "ideals", "bonds", "flaws"]);

export const LIMITS = Object.freeze({
  portraitMaxSide: 1024,
  portraitMaxBytes: 512 * 1024,
  portraitSourceMaxBytes: 10 * 1024 * 1024,   // default of the GM setting (DESIGN.md → Settings)
  draftMaxBytes: 64 * 1024,                   // the draft flag without its pending image
  stepDataMaxBytes: 16 * 1024,                // one advancement's apply() data
  maxSteps: 200,
  maxPathSegments: 8,
  maxListLength: 64,
  nameMaxLength: 100,
  shortTextMaxLength: 200,
  longTextMaxLength: 10000
});

/* -------------------------------------------- */
/*  Error codes                                 */
/* -------------------------------------------- */

/** Every error code, the step the player revisits for it, and its message key in lang/en.json. */
const CODES_BY_STEP = {
  start: ["BAD_REQUEST", "SCHEMA_TOO_NEW", "WORLD_MISMATCH", "RULES_MISMATCH", "GM_OFFLINE", "NOT_ACTIVE_GM",
    "CHARACTER_LIMIT", "ALREADY_SUBMITTED"],
  species: ["SPECIES_MISSING", "SPECIES_NOT_ALLOWED"],
  class: ["CLASS_MISSING", "CLASS_NOT_ALLOWED"],
  background: ["BACKGROUND_MISSING", "BACKGROUND_NOT_ALLOWED"],
  abilities: ["ABILITY_METHOD_NOT_ALLOWED", "POINT_BUY_INVALID", "STANDARD_ARRAY_INVALID", "ROLL_INVALID"],
  choices: ["UNKNOWN_ITEM", "UNKNOWN_ADVANCEMENT", "UNKNOWN_ADVANCEMENT_TYPE", "NOT_ALLOWED", "TOO_MANY_PICKS",
    "UNFULFILLED", "ASI_OVER_LIMIT", "ASI_LOCKED", "NOT_OFFERED", "MISSING_STEP", "APPLY_FAILED"],
  equipment: ["UNKNOWN_ENTRY_TYPE", "MISSING_CHOICE", "INVALID_CHOICE", "WRONG_PICK_COUNT", "NOT_IN_CATEGORY",
    "NOT_PROFICIENT", "UNEXPECTED_SELECTION", "BAD_MODE", "NO_WEALTH_OPTION", "WEALTH_OUT_OF_RANGE",
    "WEALTH_ROLL_INVALID"],
  spells: ["NOT_A_CASTER", "CANTRIP_COUNT", "SPELL_COUNT", "SPELLBOOK_COUNT", "NOT_IN_SPELLBOOK", "NOT_ON_LIST",
    "WRONG_LEVEL", "DUPLICATE", "ALREADY_KNOWN"],
  details: ["NAME_REQUIRED"],
  portrait: ["BAD_IMAGE", "IMAGE_TOO_LARGE", "WRONG_IMAGE_TYPE", "UNREADABLE_IMAGE", "UPLOADS_DISABLED", "NO_ACTOR",
    "NOT_OWNER", "UPLOAD_FAILED"]
};

/** `ERRORS[code] = { code, step, key }`. */
export const ERRORS = Object.freeze(Object.fromEntries(Object.entries(CODES_BY_STEP).flatMap(([step, codes]) =>
  codes.map(code => [code, Object.freeze({ code, step, key: `CHARCREATOR.Error.${code}` })]))));

/**
 * An error as returned to the wizard: `{ code, step, key, detail? }` (DESIGN.md → Queries).
 * @param {string} code
 * @param {*} [detail]  JSON-serialisable context (paths, counts, UUIDs).
 */
export function makeError(code, detail) {
  const def = ERRORS[code];
  if ( !def ) throw new Error(`Unknown error code "${code}"`);
  return detail === undefined ? { ...def } : { ...def, detail };
}

/* -------------------------------------------- */
/*  Formats                                     */
/* -------------------------------------------- */

const ID = /^[A-Za-z0-9]{16}$/;
/** Compendium item UUID; the `Item.` segment is optional (2014 SRD advancement data omits it). */
const COMPENDIUM_UUID = /^Compendium\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.(?:Item\.)?[A-Za-z0-9]{16}$/;
const ACTOR_UUID = /^Actor\.[A-Za-z0-9]{16}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export const isId = v => typeof v === "string" && ID.test(v);
export const isCompendiumUuid = v => typeof v === "string" && COMPENDIUM_UUID.test(v);
export const isActorUuid = v => typeof v === "string" && ACTOR_UUID.test(v);

/* -------------------------------------------- */
/*  Draft                                       */
/* -------------------------------------------- */

/**
 * A new, empty draft.
 * @param {{ id: string, worldId: string, rules: string, now?: number }} init
 */
export function createDraft({ id, worldId, rules, now = Date.now() }) {
  return {
    schema: SCHEMA_VERSION,
    id, worldId, rules,
    status: STATUS.DRAFT,
    step: "start",
    updatedAt: now,
    picks: { species: null, background: null, class: null },
    abilities: { method: null, base: null, roll: null },
    recipe: { steps: [] },
    equipment: { class: null, background: null },
    spells: { cantrips: [], spells: [], spellbook: [] },
    details: Object.fromEntries(DETAIL_FIELDS.map(f => [f, ""])),
    portrait: { status: "none", ring: { ring: null, background: null, effects: 1 }, pendingImage: null },
    result: { actorUuid: null, errors: [] }
  };
}

/**
 * Collects `{ path, problem }` entries while walking a value. `undefined` values are skipped by the
 * value checks: a missing key is already reported once by `object()`.
 */
class Checker {
  problems = [];
  add(path, problem) {
    this.problems.push({ path, problem });
    return false;
  }
  object(path, v, keys, { optional = [] } = {}) {
    if ( !v || typeof v !== "object" || Array.isArray(v) ) return this.add(path, "not an object");
    for ( const k of Object.keys(v) ) if ( !keys.includes(k) && !optional.includes(k) ) this.add(`${path}.${k}`, "unknown key");
    for ( const k of keys ) if ( !(k in v) ) this.add(`${path}.${k}`, "missing");
    return true;
  }
  oneOf(path, v, values, { nullable = false } = {}) {
    if ( v === undefined ) return false;
    if ( nullable && v === null ) return true;
    return values.includes(v) || this.add(path, `not one of ${values.join("|")}`);
  }
  int(path, v, min, max, { nullable = false } = {}) {
    if ( v === undefined ) return false;
    if ( nullable && v === null ) return true;
    return (Number.isInteger(v) && v >= min && v <= max) || this.add(path, `not an integer ${min}–${max}`);
  }
  string(path, v, maxLength, { nullable = false } = {}) {
    if ( v === undefined ) return false;
    if ( nullable && v === null ) return true;
    if ( typeof v !== "string" ) return this.add(path, "not a string");
    return v.length <= maxLength || this.add(path, `longer than ${maxLength}`);
  }
  test(path, v, ok, what, { nullable = false } = {}) {
    if ( v === undefined ) return false;
    if ( nullable && v === null ) return true;
    return ok(v) || this.add(path, `not ${what}`);
  }
  list(path, v, each, { max = LIMITS.maxListLength } = {}) {
    if ( !Array.isArray(v) ) return this.add(path, "not an array");
    if ( v.length > max ) this.add(path, `more than ${max} entries`);
    v.forEach((x, i) => each(`${path}[${i}]`, x));
    return true;
  }
}

const jsonBytes = v => {
  try {
    return new TextEncoder().encode(JSON.stringify(v)).length;
  } catch {
    return Infinity;
  }
};

function checkSelection(c, path, sel) {
  if ( sel === null ) return;
  if ( !c.object(path, sel, ["mode", "choices", "picks"], { optional: ["wealth"] }) ) return;
  c.oneOf(`${path}.mode`, sel.mode, EQUIPMENT_MODES);
  if ( c.object(`${path}.choices`, sel.choices, Object.keys(sel.choices ?? {})) ) {
    for ( const [k, v] of Object.entries(sel.choices) ) {
      c.test(`${path}.choices`, k, isId, "an entry id");
      c.test(`${path}.choices.${k}`, v, isId, "an entry id");
    }
  }
  if ( c.object(`${path}.picks`, sel.picks, Object.keys(sel.picks ?? {})) ) {
    for ( const [k, v] of Object.entries(sel.picks) ) {
      c.test(`${path}.picks`, k, isId, "an entry id");
      c.list(`${path}.picks.${k}`, v, (p, u) => c.test(p, u, isCompendiumUuid, "a compendium item UUID"), { max: 20 });
    }
  }
  if ( "wealth" in sel && sel.wealth !== null && c.object(`${path}.wealth`, sel.wealth, ["total"], { optional: ["messageId"] }) ) {
    c.int(`${path}.wealth.total`, sel.wealth.total, 0, 100000);
    if ( "messageId" in sel.wealth ) c.test(`${path}.wealth.messageId`, sel.wealth.messageId, isId, "a message id", { nullable: true });
  }
}

/** Check an image payload (portrait): WebP, base64, within the size limits. */
export function checkImage(image, path = "image") {
  const c = new Checker();
  if ( c.object(path, image, ["mime", "data", "width", "height"]) ) {
    c.oneOf(`${path}.mime`, image.mime, ["image/webp"]);
    if ( c.string(`${path}.data`, image.data, Math.ceil(LIMITS.portraitMaxBytes / 3) * 4) ) {
      c.test(`${path}.data`, image.data, v => BASE64.test(v), "base64");
    }
    c.int(`${path}.width`, image.width, 1, LIMITS.portraitMaxSide);
    c.int(`${path}.height`, image.height, 1, LIMITS.portraitMaxSide);
  }
  return c.problems;
}

/**
 * Structural check of a draft of the current schema: every key known and typed, formats (ids,
 * UUIDs, colours), sizes. Returns `{ path, problem }[]` (empty = well-formed).
 */
export function checkDraftShape(draft) {
  const c = new Checker();
  const top = ["schema", "id", "worldId", "rules", "status", "step", "updatedAt", "picks", "abilities", "recipe",
    "equipment", "spells", "details", "portrait", "result"];
  if ( !c.object("draft", draft, top) ) return c.problems;
  const d = draft;
  c.oneOf("draft.schema", d.schema, [SCHEMA_VERSION]);
  c.test("draft.id", d.id, isId, "an id");
  c.string("draft.worldId", d.worldId, 64);
  c.oneOf("draft.rules", d.rules, RULES);
  c.oneOf("draft.status", d.status, Object.values(STATUS));
  c.oneOf("draft.step", d.step, STEPS);
  c.int("draft.updatedAt", d.updatedAt, 0, Number.MAX_SAFE_INTEGER);

  if ( c.object("draft.picks", d.picks, ROLES) ) {
    for ( const r of ROLES ) c.test(`draft.picks.${r}`, d.picks[r], isCompendiumUuid, "a compendium item UUID", { nullable: true });
  }

  if ( c.object("draft.abilities", d.abilities, ["method", "base", "roll"]) ) {
    const a = d.abilities;
    c.oneOf("draft.abilities.method", a.method, ABILITY_METHODS, { nullable: true });
    if ( a.base !== null && c.object("draft.abilities.base", a.base, ABILITIES) ) {
      // null while the player is still assigning values (the validator asks for all six before submitting).
      for ( const k of ABILITIES ) c.int(`draft.abilities.base.${k}`, a.base[k], 3, 18, { nullable: true });
    }
    if ( a.roll !== null && c.object("draft.abilities.roll", a.roll, ["messageId", "results"]) ) {
      c.test("draft.abilities.roll.messageId", a.roll.messageId, isId, "a message id");
      c.list("draft.abilities.roll.results", a.roll.results, (p, v) => c.int(p, v, 3, 18), { max: 6 });
    }
  }

  if ( c.object("draft.recipe", d.recipe, ["steps"]) ) {
    c.list("draft.recipe.steps", d.recipe.steps, (p, s) => {
      if ( !c.object(p, s, ["path", "advancementId", "level", "data"]) ) return;
      c.list(`${p}.path`, s.path, (pp, seg) => {
        const first = pp.endsWith("[0]");
        if ( first ) c.oneOf(pp, seg, ROLES);
        else c.test(pp, seg, v => typeof v === "string" && isId(v.slice(0, 16)) && v[16] === ":"
          && isCompendiumUuid(v.slice(17)), "\"<advancementId>:<compendium UUID>\"");
      }, { max: LIMITS.maxPathSegments });
      if ( Array.isArray(s.path) && !s.path.length ) c.add(`${p}.path`, "empty");
      c.test(`${p}.advancementId`, s.advancementId, isId, "an advancement id");
      c.int(`${p}.level`, s.level, 0, 1);
      if ( !s.data || typeof s.data !== "object" || Array.isArray(s.data) ) c.add(`${p}.data`, "not an object");
      else if ( jsonBytes(s.data) > LIMITS.stepDataMaxBytes ) c.add(`${p}.data`, `larger than ${LIMITS.stepDataMaxBytes} bytes`);
    }, { max: LIMITS.maxSteps });
  }

  if ( c.object("draft.equipment", d.equipment, ["class", "background"]) ) {
    checkSelection(c, "draft.equipment.class", d.equipment.class);
    checkSelection(c, "draft.equipment.background", d.equipment.background);
  }

  if ( c.object("draft.spells", d.spells, ["cantrips", "spells", "spellbook"]) ) {
    for ( const k of ["cantrips", "spells", "spellbook"] ) {
      c.list(`draft.spells.${k}`, d.spells[k], (p, u) => c.test(p, u, isCompendiumUuid, "a compendium item UUID"), { max: 30 });
    }
  }

  if ( c.object("draft.details", d.details, DETAIL_FIELDS) ) {
    const long = ["appearance", "biography", "traits", "ideals", "bonds", "flaws"];
    for ( const f of DETAIL_FIELDS ) {
      const max = f === "name" ? LIMITS.nameMaxLength : long.includes(f) ? LIMITS.longTextMaxLength : LIMITS.shortTextMaxLength;
      c.string(`draft.details.${f}`, d.details[f], max);
    }
  }

  if ( c.object("draft.portrait", d.portrait, ["status", "ring", "pendingImage"]) ) {
    const p = d.portrait;
    c.oneOf("draft.portrait.status", p.status, PORTRAIT_STATUS);
    if ( c.object("draft.portrait.ring", p.ring, ["ring", "background", "effects"]) ) {
      c.test("draft.portrait.ring.ring", p.ring.ring, v => HEX_COLOR.test(v), "a #rrggbb colour", { nullable: true });
      c.test("draft.portrait.ring.background", p.ring.background, v => HEX_COLOR.test(v), "a #rrggbb colour", { nullable: true });
      c.int("draft.portrait.ring.effects", p.ring.effects, 0, 8388607);
    }
    if ( p.pendingImage !== null ) c.problems.push(...checkImage(p.pendingImage, "draft.portrait.pendingImage"));
  }

  if ( c.object("draft.result", d.result, ["actorUuid", "errors"]) ) {
    c.test("draft.result.actorUuid", d.result.actorUuid, isActorUuid, "an actor UUID", { nullable: true });
    c.list("draft.result.errors", d.result.errors, (p, e) => c.test(p, e, x => x && typeof x === "object" && x.code in ERRORS,
      "a known error"), { max: 100 });
  }

  // Size budget: the flag without its pending image (the image is capped separately).
  const withoutImage = { ...d, portrait: { ...d.portrait, pendingImage: null } };
  if ( jsonBytes(withoutImage) > LIMITS.draftMaxBytes ) c.add("draft", `larger than ${LIMITS.draftMaxBytes} bytes`);
  return c.problems;
}

/* -------------------------------------------- */
/*  Migration                                   */
/* -------------------------------------------- */

/**
 * Draft migrations: `MIGRATIONS[n]` turns a schema-n draft into schema n+1. Empty at v1.
 * @type {Record<number, (draft: object) => object>}
 */
export const MIGRATIONS = Object.freeze({});

/**
 * Bring a stored draft up to the current schema.
 * @param {object} draft
 * @param {object} [options]
 * @param {Record<number, Function>} [options.migrations]  For tests.
 * @param {number} [options.target]                        For tests.
 * @returns {{ draft: object, migrated: boolean }}
 * @throws {Error} with `code` "SCHEMA_TOO_NEW" (a newer module wrote it) or "BAD_REQUEST" (no path).
 */
export function migrateDraft(draft, { migrations = MIGRATIONS, target = SCHEMA_VERSION } = {}) {
  let current = structuredClone(draft);
  const from = current?.schema;
  if ( !Number.isInteger(from) ) throw Object.assign(new Error("Draft has no schema version"), { code: "BAD_REQUEST" });
  if ( from > target ) throw Object.assign(new Error(`Draft schema ${from} is newer than ${target}`), { code: "SCHEMA_TOO_NEW" });
  for ( let v = from; v < target; v++ ) {
    const step = migrations[v];
    if ( !step ) throw Object.assign(new Error(`No migration from draft schema ${v}`), { code: "BAD_REQUEST" });
    current = step(current);
    current.schema = v + 1;
  }
  return { draft: current, migrated: from !== target };
}

/* -------------------------------------------- */
/*  Query payloads                              */
/* -------------------------------------------- */

/**
 * `QUERIES.SUBMIT` payload: `{ draft, image? }` — the draft as stored, plus the portrait if the player
 * uploaded one (it lives in the browser until submit; D17 keeps it on the pending build when offline).
 * @returns {{ path, problem }[]}
 */
export function checkSubmitPayload(payload) {
  const c = new Checker();
  if ( !c.object("payload", payload, ["draft"], { optional: ["image"] }) ) return c.problems;
  const problems = [...c.problems, ...checkDraftShape(payload.draft)];
  if ( payload.image !== undefined && payload.image !== null ) problems.push(...checkImage(payload.image, "payload.image"));
  return problems;
}

/**
 * `QUERIES.UPLOAD_PORTRAIT` payload (after creation, A5): `{ actorUuid, image, ring? }`.
 * @returns {{ path, problem }[]}
 */
export function checkUploadPayload(payload) {
  const c = new Checker();
  if ( !c.object("payload", payload, ["actorUuid", "image"], { optional: ["ring"] }) ) return c.problems;
  c.test("payload.actorUuid", payload.actorUuid, isActorUuid, "an actor UUID");
  const problems = [...c.problems, ...checkImage(payload.image, "payload.image")];
  if ( payload.ring !== undefined ) {
    const r = new Checker();
    if ( r.object("payload.ring", payload.ring, ["ring", "background", "effects"]) ) {
      r.test("payload.ring.ring", payload.ring.ring, v => HEX_COLOR.test(v), "a #rrggbb colour", { nullable: true });
      r.test("payload.ring.background", payload.ring.background, v => HEX_COLOR.test(v), "a #rrggbb colour", { nullable: true });
      r.int("payload.ring.effects", payload.ring.effects, 0, 8388607);
    }
    problems.push(...r.problems);
  }
  return problems;
}
