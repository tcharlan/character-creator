/**
 * Character Creator — shared contracts (convention 6): the draft schema, query names and payloads,
 * error codes and limits. The single source of truth for the player's wizard and the GM side.
 *
 * Pure: no Foundry globals, so it runs under `npm test` as well as in the browser. Structural checks
 * only — whether a draft is *legal* (allowed content, counts, rules) is the validator's job (PLAN 2.6).
 */

export const MODULE_ID = "character-creator";

/** Bump when the draft shape changes, and add a migration below. */
export const SCHEMA_VERSION = 6;

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

/** Character levels (D32). A draft is built for the GM's starting level and records which. */
export const MAX_LEVEL = 20;

/**
 * Another class taken by multiclassing (D35, D37) roots its recipe paths at `multiclass:<identifier>`, the
 * class's dnd5e identifier: a character can't hold two classes of one identifier, and unlike a position in the
 * list it survives the player reordering or dropping a class. The first class keeps the `class` role.
 */
export const MULTICLASS_ROOT = "multiclass:";
const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;
export const isIdentifier = v => typeof v === "string" && IDENTIFIER.test(v);

/** A recipe path's first segment: a role, or a multiclass root. */
export const isPathRoot = v => ROLES.includes(v)
  || (typeof v === "string" && v.startsWith(MULTICLASS_ROOT) && isIdentifier(v.slice(MULTICLASS_ROOT.length)));

/**
 * A rolled hit die is kept by the class level it is for (`<identifier>@<class level>`, D33), so changing the
 * level split and changing it back finds the same rolls rather than rolling again (as D26 does for scores).
 */
const HP_SLOT = /^([A-Za-z0-9_-]{1,64})@([1-9]|1[0-9]|20)$/;
export const isHitPointSlot = v => typeof v === "string" && HP_SLOT.test(v);
export const hitPointSlot = (identifier, level) => `${identifier}@${level}`;

/** How a character was made: the player choosing, or the dice (D31). */
export const DRAFT_MODES = Object.freeze(["normal", "hardcore"]);

/**
 * What hardcore mode can roll for the player, in the order it is rolled. The GM may hand any of them back to
 * the player (the `hardcore.free` setting); spells, the portrait and the name are always the player's.
 */
export const RANDOM_PARTS = Object.freeze(["species", "class", "subclass", "background", "abilities", "choices", "equipment",
  "details"]);

/** The most rolls of a character a GM can hand out (D31); 0 in the setting means as many as the player likes. */
export const MAX_ATTEMPTS = 10;
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
  maxSteps: 200,                              // a level-20 character is ~95 (Spike 8.0)
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
    "CHARACTER_LIMIT", "ALREADY_SUBMITTED", "RANDOM_INVALID", "RANDOM_ATTEMPTS"],
  species: ["SPECIES_MISSING", "SPECIES_NOT_ALLOWED"],
  class: ["CLASS_MISSING", "CLASS_NOT_ALLOWED", "LEVEL_MISMATCH", "MULTICLASS_NOT_ALLOWED",
    "MULTICLASS_PREREQUISITES", "MULTICLASS_FIRST_LEVELS"],
  background: ["BACKGROUND_MISSING", "BACKGROUND_NOT_ALLOWED"],
  abilities: ["ABILITY_METHOD_MISSING", "ABILITY_METHOD_NOT_ALLOWED", "ABILITY_SCORES_MISSING", "POINT_BUY_INVALID",
    "STANDARD_ARRAY_INVALID", "ROLL_INVALID"],
  choices: ["UNKNOWN_ITEM", "UNKNOWN_ADVANCEMENT", "UNKNOWN_ADVANCEMENT_TYPE", "NOT_ALLOWED", "TOO_MANY_PICKS",
    "UNFULFILLED", "ASI_OVER_LIMIT", "ASI_LOCKED", "NOT_OFFERED", "MISSING_STEP", "APPLY_FAILED", "HIT_POINTS_ROLL_INVALID"],
  equipment: ["UNKNOWN_ENTRY_TYPE", "MISSING_CHOICE", "INVALID_CHOICE", "WRONG_PICK_COUNT", "NOT_IN_CATEGORY",
    "NOT_PROFICIENT", "UNEXPECTED_SELECTION", "BAD_MODE", "NO_WEALTH_OPTION", "WEALTH_OUT_OF_RANGE",
    "WEALTH_ROLL_INVALID"],
  spells: ["NOT_A_CASTER", "CANTRIP_COUNT", "SPELL_COUNT", "SPELLBOOK_COUNT", "NOT_IN_SPELLBOOK", "NOT_ON_LIST",
    "WRONG_LEVEL", "DUPLICATE", "ALREADY_KNOWN"],
  details: ["NAME_REQUIRED", "DETAIL_INVALID"],
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
export function createDraft({ id, worldId, rules, level = 1, now = Date.now() }) {
  return {
    schema: SCHEMA_VERSION,
    id, worldId, rules,
    status: STATUS.DRAFT,
    step: "start",
    updatedAt: now,
    mode: "normal",
    // The character level the draft is built for: the GM's starting level when it began (D32). The validator
    // holds it to the setting, so a draft started before the GM changed it is sent back to be brought up to date.
    level,
    // Classes besides the first (D35, D37): `{ uuid, levels }` each. The first class (`picks.class`) has what is
    // left of `level`, at least one.
    multiclass: [],
    // Rolled hit dice by class level (D33): `{ "<identifier>@<level>": { faces, total, messageId } }`. Empty when
    // the GM's method is the average.
    hitPoints: { rolls: {} },
    // Set when the dice made this character (D31): which attempt made it (1-based, so the GM can hold a
    // player to the rolls they are allowed), the chat messages the rolls were posted in, and every roll in the
    // order it was made. A choice the player was left (their class, say) can open decisions the first handful
    // of dice never saw, so more are rolled and posted as they appear.
    random: null,
    picks: { species: null, background: null, class: null },
    abilities: { method: null, base: null, roll: null },
    recipe: { steps: [] },
    equipment: { class: null, background: null },
    spells: { cantrips: [], spells: [], spellbook: [] },
    // Another class's spells (D35, PLAN 8.2b), by its path root: each class chooses on its own, "as if you were a
    // single-classed member of that class" (PHB multiclassing). The first class's are `spells`.
    multiclassSpells: {},
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
  const top = ["schema", "id", "worldId", "rules", "status", "step", "updatedAt", "mode", "level", "multiclass",
    "hitPoints", "random", "picks", "abilities", "recipe", "equipment", "spells", "multiclassSpells", "details", "portrait",
    "result"];
  if ( !c.object("draft", draft, top) ) return c.problems;
  const d = draft;
  c.oneOf("draft.schema", d.schema, [SCHEMA_VERSION]);
  c.test("draft.id", d.id, isId, "an id");
  c.string("draft.worldId", d.worldId, 64);
  c.oneOf("draft.rules", d.rules, RULES);
  c.oneOf("draft.status", d.status, Object.values(STATUS));
  c.oneOf("draft.step", d.step, STEPS);
  c.int("draft.updatedAt", d.updatedAt, 0, Number.MAX_SAFE_INTEGER);
  c.oneOf("draft.mode", d.mode, DRAFT_MODES);
  if ( d.random !== null && c.object("draft.random", d.random, ["attempt", "messageIds", "rolls"], { optional: ["stages"] }) ) {
    c.int("draft.random.attempt", d.random.attempt, 1, MAX_ATTEMPTS);
    c.list("draft.random.messageIds", d.random.messageIds,
      (path, v) => c.test(path, v, isId, "a message id"), { max: LIMITS.maxListLength });
    c.list("draft.random.rolls", d.random.rolls, (path, v) => {
      if ( !c.object(path, v, ["key", "faces", "total"]) ) return;
      c.string(`${path}.key`, v.key, LIMITS.shortTextMaxLength);
      c.int(`${path}.faces`, v.faces, 1, 1000);
      c.int(`${path}.total`, v.total, 1, 1000);
    }, { max: LIMITS.maxSteps });
    // The shortlists the player picks from above level 1 (D35, D36, D39), by the decision they are for.
    if ( "stages" in d.random && c.object("draft.random.stages", d.random.stages, Object.keys(d.random.stages ?? {})) ) {
      const entries = Object.entries(d.random.stages);
      if ( entries.length > LIMITS.maxListLength ) c.add("draft.random.stages", `more than ${LIMITS.maxListLength} entries`);
      for ( const [key, s] of entries ) {
        const p = `draft.random.stages.${key}`;
        if ( !c.object(p, s, ["kind"], { optional: ["options", "answered", "path", "advancementId", "at"] }) ) continue;
        c.oneOf(`${p}.kind`, s.kind, ["multiclass", "subclass", "feat"]);
        if ( "options" in s ) c.list(`${p}.options`, s.options, (pp, u) => c.test(pp, u, isCompendiumUuid, "a compendium item UUID"));
        if ( "answered" in s ) c.test(`${p}.answered`, s.answered, v => typeof v === "boolean", "true or false");
        if ( "at" in s ) c.int(`${p}.at`, s.at, 0, MAX_LEVEL);
        if ( "advancementId" in s ) c.test(`${p}.advancementId`, s.advancementId, isId, "an advancement id");
        if ( "path" in s ) c.list(`${p}.path`, s.path, (pp, seg) => c.string(pp, seg, LIMITS.shortTextMaxLength), { max: LIMITS.maxPathSegments });
      }
    }
  }

  c.int("draft.level", d.level, 1, MAX_LEVEL);
  if ( c.list("draft.multiclass", d.multiclass, (p, m) => {
    if ( !c.object(p, m, ["uuid", "levels"]) ) return;
    c.test(`${p}.uuid`, m.uuid, isCompendiumUuid, "a compendium item UUID");
    c.int(`${p}.levels`, m.levels, 1, MAX_LEVEL - 1);
  }, { max: MAX_LEVEL - 1 }) && Number.isInteger(d.level) && (d.level >= 1) && (d.level <= MAX_LEVEL) ) {
    // The first class keeps at least its first level.
    const taken = d.multiclass.reduce((n, m) => n + (Number.isInteger(m?.levels) ? m.levels : 0), 0);
    if ( taken > d.level - 1 ) c.add("draft.multiclass", `${taken} levels in other classes of a level-${d.level} character`);
    const uuids = d.multiclass.map(m => m?.uuid);
    if ( new Set(uuids).size !== uuids.length ) c.add("draft.multiclass", "a class taken twice");
  }
  if ( c.object("draft.hitPoints", d.hitPoints, ["rolls"])
    && c.object("draft.hitPoints.rolls", d.hitPoints.rolls, Object.keys(d.hitPoints.rolls ?? {})) ) {
    const slots = Object.entries(d.hitPoints.rolls);
    if ( slots.length > LIMITS.maxListLength ) c.add("draft.hitPoints.rolls", `more than ${LIMITS.maxListLength} entries`);
    for ( const [slot, r] of slots ) {
      const p = `draft.hitPoints.rolls.${slot}`;
      c.test(p, slot, isHitPointSlot, "\"<class identifier>@<level>\"");
      if ( !c.object(p, r, ["faces", "total", "messageId"]) ) continue;
      c.int(`${p}.faces`, r.faces, 2, 20);
      c.int(`${p}.total`, r.total, 1, Number.isInteger(r.faces) ? r.faces : 20);
      c.test(`${p}.messageId`, r.messageId, isId, "a message id");
    }
  }

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
        if ( first ) c.test(pp, seg, isPathRoot, `one of ${ROLES.join("|")} or ${MULTICLASS_ROOT}<identifier>`);
        else c.test(pp, seg, v => typeof v === "string" && isId(v.slice(0, 16)) && v[16] === ":"
          && isCompendiumUuid(v.slice(17)), "\"<advancementId>:<compendium UUID>\"");
      }, { max: LIMITS.maxPathSegments });
      if ( Array.isArray(s.path) && !s.path.length ) c.add(`${p}.path`, "empty");
      c.test(`${p}.advancementId`, s.advancementId, isId, "an advancement id");
      c.int(`${p}.level`, s.level, 0, MAX_LEVEL);
      if ( !s.data || typeof s.data !== "object" || Array.isArray(s.data) ) c.add(`${p}.data`, "not an object");
      else if ( jsonBytes(s.data) > LIMITS.stepDataMaxBytes ) c.add(`${p}.data`, `larger than ${LIMITS.stepDataMaxBytes} bytes`);
    }, { max: LIMITS.maxSteps });
  }

  if ( c.object("draft.equipment", d.equipment, ["class", "background"]) ) {
    checkSelection(c, "draft.equipment.class", d.equipment.class);
    checkSelection(c, "draft.equipment.background", d.equipment.background);
  }

  const checkSpells = (path, sel) => {
    if ( !c.object(path, sel, ["cantrips", "spells", "spellbook"]) ) return;
    for ( const k of ["cantrips", "spells", "spellbook"] ) {
      c.list(`${path}.${k}`, sel[k], (p, u) => c.test(p, u, isCompendiumUuid, "a compendium item UUID"), { max: LIMITS.maxListLength });
    }
  };
  checkSpells("draft.spells", d.spells);
  if ( c.object("draft.multiclassSpells", d.multiclassSpells, Object.keys(d.multiclassSpells ?? {})) ) {
    for ( const [root, sel] of Object.entries(d.multiclassSpells) ) {
      const p = `draft.multiclassSpells.${root}`;
      if ( c.test(p, root, v => isPathRoot(v) && v.startsWith(MULTICLASS_ROOT), `${MULTICLASS_ROOT}<identifier>`) ) checkSpells(p, sel);
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
 * Draft migrations: `MIGRATIONS[n]` turns a schema-n draft into schema n+1.
 * @type {Record<number, (draft: object) => object>}
 */
export const MIGRATIONS = Object.freeze({
  // 1 → 2: the draft says how it was made, and keeps the rolls when the dice made it (D31).
  1: draft => ({ ...draft, mode: draft.mode ?? "normal", random: draft.random ?? null }),
  // 2 → 3: the rolls can come in more than one message, as later choices open more of them.
  2: draft => ({ ...draft, random: draft.random
    ? { messageIds: draft.random.messageIds ?? [draft.random.messageId].filter(Boolean), rolls: draft.random.rolls }
    : null }),
  // 3 → 4: a rolled character says which attempt it came from (D31 rerolls); what is already rolled is the first.
  3: draft => ({ ...draft, random: draft.random
    ? { attempt: draft.random.attempt ?? 1, messageIds: draft.random.messageIds, rolls: draft.random.rolls }
    : null }),
  // 4 → 5: characters above level 1 (D32–D37). Everything before was a level-1, single-class character.
  4: draft => ({ ...draft, level: draft.level ?? 1, multiclass: draft.multiclass ?? [],
    hitPoints: draft.hitPoints ?? { rolls: {} } }),
  // 5 → 6: another class's spells (PLAN 8.2b). Nothing before had another class.
  5: draft => ({ ...draft, multiclassSpells: draft.multiclassSpells ?? {} })
});

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
