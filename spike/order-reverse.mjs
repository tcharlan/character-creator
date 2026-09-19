/*
 * SPIKE 1.2 — throwaway. Not part of the module.
 *
 * Questions: applied species → background → class → subclass on one scratch actor, do later choices
 * see earlier ones (no duplicates, increases stack and cap)? Does changing an answer undo cleanly
 * (reverse + apply ≡ a fresh build with the new answer)? Plus: why is the Hill Dwarf's HP 10?
 *
 * Run in the browser console as Player A in legacy-test, then modern-test:
 *   const spike = await import("/modules/character-creator/spike/order-reverse.mjs");
 *   const report = await spike.run();
 *   foundry.utils.saveDataToFile(JSON.stringify(report, null, 2), "application/json", `spike-1.2-${report.rules}.json`);
 */

import {
  PICKS, BASE_SCORES, watchDb, buildCharacter, processItem, processGranted, getAdv, reverseOne,
  reverseCascade, orphans, snapshot, compare, schemaInitials
} from "./lib.mjs";

export async function run({ rules = game.settings.get("dnd5e", "rulesVersion") } = {}) {
  const report = {
    spike: "1.2", rules, user: game.user.name, role: game.user.role, isGM: game.user.isGM,
    dnd5e: game.system.version, started: new Date().toISOString(), checks: [], probes: {}, errors: []
  };
  const stopWatch = watchDb();
  const initialsBefore = schemaInitials();
  const check = (id, name, pass, detail = {}, { expect = true } = {}) => {
    report.checks.push({ id, name, pass, expect, ok: pass === expect, ...detail });
  };
  // One failing check must not stop the others.
  const attempt = async (id, fn) => {
    try {
      await fn();
    } catch ( err ) {
      report.checks.push({ id, ok: false, error: err.message, stack: err.stack?.split("\n").slice(0, 6).join("\n") });
    }
  };

  try {
    // Determinism (a preview of 1.3): two fresh builds are identical once ids are abstracted.
    const a = await buildCharacter(rules);
    await attempt("D1", async () => {
      const b = await buildCharacter(rules);
      const same = compare(snapshot(a.actor), snapshot(b.actor));
      check("D1", "Two fresh builds are identical", same.equal, same);
    });
    report.baseSteps = a.steps.map(({ source, key, type, level, data, offered, error, note }) => ({
      source, key, type, level, data, offeredCount: offered?.length, error, note }));
    report.stepErrors = a.steps.filter(s => s.error);

    if ( rules === "legacy" ) await legacyChecks(a, check, report, attempt);
    else await modernChecks(a, check, report, attempt);
  } catch ( err ) {
    report.errors.push({ message: err.message, stack: err.stack?.split("\n").slice(0, 8).join("\n") });
  }

  // Guard: no build may have mutated a shared schema default (see makeActor).
  const initialsAfter = schemaInitials();
  const mutated = Object.keys(initialsBefore).filter(k => initialsBefore[k] !== initialsAfter[k])
    .map(k => [k, initialsBefore[k], initialsAfter[k]]);
  check("G1", "No schema default (field `initial`) was mutated by any build", !mutated.length,
    { mutated, fieldsWatched: Object.keys(initialsBefore).length });

  report.dbWrites = stopWatch();
  report.verdict = {
    noDbWrites: report.dbWrites.length === 0,
    allChecksAsExpected: report.checks.length > 0 && report.checks.every(c => c.ok),
    noErrors: !report.errors.length && !report.stepErrors?.length
  };
  console.log("SPIKE 1.2 verdict", report.verdict);
  console.table(report.checks.map(({ id, name, pass, expect, ok, error }) => ({ id, name, pass, expect, ok, error })));
  return report;
}

/* -------------------------------------------- */

/** v14 keeps effect changes in `system.changes`. */
const effectChanges = e => foundry.utils.deepClone(e.system?.changes ?? []);

const step = (steps, key) => {
  const s = steps.find(x => x.key === key);
  if ( !s ) throw new Error(`No step "${key}" — got: ${steps.map(x => x.key).join(", ")}`);
  return s;
};

/**
 * Build, change one answer by reverse + apply, then compare with a fresh build that used the new
 * answer from the start. With `cascade`, dependants are reversed first and re-processed after.
 */
async function swapCheck(rules, key, newData, { cascade = false } = {}) {
  const built = await buildCharacter(rules);
  const { actor, steps } = built;
  const s = step(steps, key);
  const before = new Set(actor.items.map(i => i.id));

  if ( cascade ) await reverseCascade(actor, steps, s.itemId, s.advancementId, s.level);
  else await reverseOne(actor, s.itemId, s.advancementId, s.level);
  const afterReverse = { orphans: orphans(actor), items: actor.items.map(i => i.name) };

  const data = newData ?? s.data;
  await getAdv(actor, s.itemId, s.advancementId).apply(s.level, foundry.utils.deepClone(data));
  actor.reset();

  // Items the re-apply added (e.g. a subclass) need their own advancements processed again.
  const ctx = { actor, rules, picks: PICKS[rules], overrides: {}, steps: [],
    done: new Set(actor.items.filter(i => before.has(i.id)).map(i => i.id)) };
  if ( cascade ) {
    for ( const item of actor.items.filter(i => !ctx.done.has(i.id)) ) {
      await processItem(ctx, item.id, item.type === "subclass" ? [1] : [0, 1], `re:${item.name}`);
    }
    await processGranted(ctx);
    actor.reset();
  }

  const fresh = await buildCharacter(rules, { overrides: newData ? { [key]: newData } : {} });
  const result = compare(snapshot(actor), snapshot(fresh.actor));
  return { ...result, afterReverse, reprocessErrors: ctx.steps.filter(x => x.error) };
}

/* -------------------------------------------- */

async function legacyChecks(base, check, report, attempt) {
  const { actor, steps, ids } = base;

  // Later choices see earlier ones.
  await attempt("L1", () => {
    const skills = step(steps, "Cleric/Skills");
    check("L1", "Cleric skill choices exclude Acolyte's Insight and Religion",
      !skills.offered.includes("skills:ins") && !skills.offered.includes("skills:rel"), { offered: skills.offered });
  });
  await attempt("L2", () => {
    const langs = step(steps, "Acolyte/Languages");
    check("L2", "Acolyte language choices exclude Hill Dwarf's Common and Dwarvish",
      !langs.offered.includes("languages:standard:common") && !langs.offered.includes("languages:standard:dwarvish"),
      { offeredCount: langs.offered.length });
  });

  // Reverse + re-apply.
  const swaps = [
    ["L3", "Trait: swap Cleric skills (med → per) ≡ fresh build", "Cleric/Skills",
      { chosen: ["skills:his", "skills:per"] }],
    ["L4", "ASI: reverse + re-apply ≡ original", "Hill Dwarf/Ability Score Improvement", null],
    ["L5", "Size: reverse + re-apply ≡ original", "Hill Dwarf/Size", null],
    ["L6", "ItemGrant: reverse + re-apply ≡ original", "Acolyte/Feature", null],
    ["L7", "HitPoints: reverse + re-apply ≡ original", "Cleric/Hit Points", null]
  ];
  for ( const [id, name, key, data] of swaps ) {
    await attempt(id, async () => {
      const r = await swapCheck("legacy", key, data);
      check(id, name, r.equal, r);
    });
  }

  // Subclass: naive reverse leaves the subclass's grants behind; cascade doesn't.
  await attempt("L8", async () => {
    const r = await swapCheck("legacy", "Cleric/Divine Domain", null);
    check("L8", "Subclass: NAIVE reverse leaves orphans (expected)", r.afterReverse.orphans.length > 0,
      { orphans: r.afterReverse.orphans, equalAfterReapply: r.equal, differences: r.differences });
  });
  await attempt("L9", async () => {
    const r = await swapCheck("legacy", "Cleric/Divine Domain", null, { cascade: true });
    check("L9", "Subclass: CASCADE reverse leaves no orphans and re-apply ≡ original",
      !r.afterReverse.orphans.length && r.equal, r);
  });

  // Increases stack and respect the cap: base CON 19 + Hill Dwarf's +2.
  await attempt("L10", async () => {
    const capped = await buildCharacter("legacy", { base: { ...BASE_SCORES, con: 19 } });
    const asi = step(capped.steps, "Hill Dwarf/Ability Score Improvement");
    const asiAdv = getAdv(capped.actor, asi.itemId, asi.advancementId);
    const conAfter = capped.actor.system.abilities.con.value;
    const stored = asiAdv.value.assignments?.con;
    await reverseOne(capped.actor, asi.itemId, asi.advancementId, asi.level);
    const conReversed = capped.actor.system.abilities.con.value;
    check("L10", "ASI caps at 20 (19 + 2 → 20), stores the applied +1, and reverses to 19",
      conAfter === 20 && stored === 1 && conReversed === 19, { requested: asi.data, conAfter, stored, conReversed });
  });

  // Probe: Hill Dwarf HP (Dwarven Toughness). Informational — it answers the question either way.
  await attempt("L11", async () => {
    const race = actor.items.get(ids.species);
    const hpEffects = actor.items.contents.flatMap(i => i.effects.contents
      .filter(e => effectChanges(e).some(c => c.key.includes("hp")))
      .map(e => ({ item: i.name, effect: e.name, transfer: e.transfer, disabled: e.disabled, changes: effectChanges(e) })));
    const index = await game.packs.get("dnd5e.races").getIndex({ fields: ["type"] });
    report.probes.hillDwarfHp = {
      hp: { value: actor.system.attributes.hp.value, max: actor.system.attributes.hp.max },
      hpBonuses: foundry.utils.deepClone(actor.system.attributes.hp.bonuses),
      raceEffects: race.effects.map(e => ({ name: e.name, transfer: e.transfer, disabled: e.disabled,
        changes: effectChanges(e) })),
      hpEffects,
      appliedEffects: actor.appliedEffects?.map(e => e.name) ?? null,
      applicableEffects: [...actor.allApplicableEffects()].map(e => `${e.parent?.name}: ${e.name}`),
      raceGrants: race.advancement.byType.ItemGrant?.flatMap(a => a.configuration.items.map(i => i.uuid)) ?? [],
      descriptionMentionsToughness: /toughness/i.test(race.system.description?.value ?? ""),
      racesPackEntries: index.map(e => `${e.type}: ${e.name}`)
    };
    const expectedMax = 8 + actor.system.abilities.con.mod + 1;
    check("L11", "Hill Dwarf HP includes Dwarven Toughness (+1) — info",
      actor.system.attributes.hp.max === expectedMax, { expectedMax, got: actor.system.attributes.hp.max });
    report.checks.at(-1).ok = true;
  });
}

/* -------------------------------------------- */

async function modernChecks(base, check, report, attempt) {
  const { steps } = base;

  await attempt("M1", () => {
    const skills = step(steps, "Fighter/Skill Proficiencies");
    check("M1", "Fighter skill choices exclude Human's Acrobatics and Sage's Arcana/History",
      !["skills:acr", "skills:arc", "skills:his"].some(k => skills.offered.includes(k)), { offered: skills.offered });
  });

  const swaps = [
    ["M2", "ItemChoice: Archery → Defense ≡ fresh build", "Fighter/Fighting Style",
      { selected: ["Compendium.dnd5e.feats24.Item.phbfstDefense000"] }],
    ["M3", "Size: small → medium ≡ fresh build", "Human/Size", { size: "med" }],
    ["M5", "Trait (mastery): swap three masteries ≡ fresh build", "Fighter/Weapon Mastery",
      { chosen: ["weapon:mar:longsword", "weapon:mar:greatsword", "weapon:sim:spear"] }]
  ];
  for ( const [id, name, key, data] of swaps ) {
    await attempt(id, async () => {
      const r = await swapCheck("modern", key, data);
      check(id, name, r.equal, r);
    });
  }

  // HP is stored when HitPoints applies, so an ability change made afterwards leaves it stale.
  const asiSwap = { type: "asi", assignments: { int: 2, wis: 1 } };
  await attempt("M4", async () => {
    const r = await swapCheck("modern", "Sage/Background Ability Score Improvement", asiSwap);
    const hpOnly = r.differences.length === 1 && r.differences[0][0] === "system.attributes.hp.value";
    check("M4", "ASI swap (CON+2 → INT+2/WIS+1) leaves stale HP (expected ≠ fresh, HP only)",
      !r.equal && hpOnly, r);
  });
  await attempt("M4b", async () => {
    const built = await buildCharacter("modern");
    const { actor, steps } = built;
    const asi = step(steps, "Sage/Background Ability Score Improvement");
    const hp = step(steps, "Fighter/Hit Points");
    await reverseOne(actor, hp.itemId, hp.advancementId, hp.level);
    await reverseOne(actor, asi.itemId, asi.advancementId, asi.level);
    await getAdv(actor, asi.itemId, asi.advancementId).apply(asi.level, foundry.utils.deepClone(asiSwap));
    actor.reset();
    await getAdv(actor, hp.itemId, hp.advancementId).apply(hp.level, foundry.utils.deepClone(hp.data));
    actor.reset();
    const fresh = await buildCharacter("modern", { overrides: { "Sage/Background Ability Score Improvement": asiSwap } });
    const r = compare(snapshot(actor), snapshot(fresh.actor));
    check("M4b", "ASI swap with HitPoints reversed first and re-applied after ≡ fresh build", r.equal, r);
  });

  // Granted item with its own advancements (Sage → Magic Initiate → spells).
  await attempt("M6", async () => {
    const r = await swapCheck("modern", "Sage/Background Feat", null);
    check("M6", "ItemGrant: NAIVE reverse orphans Magic Initiate's spells (expected)",
      r.afterReverse.orphans.length > 0, { orphans: r.afterReverse.orphans, equalAfterReapply: r.equal });
  });
  await attempt("M7", async () => {
    const r = await swapCheck("modern", "Sage/Background Feat", null, { cascade: true });
    check("M7", "ItemGrant: CASCADE reverse leaves no orphans and re-apply ≡ original",
      !r.afterReverse.orphans.length && r.equal, r);
  });

  // Changing an EARLIER answer doesn't revisit later ones: Human takes Athletics, which the Fighter
  // had already chosen. Expected: not equal to a fresh build (which gives the Fighter another skill).
  await attempt("M8", async () => {
    const r = await swapCheck("modern", "Human/Skillful", { chosen: ["skills:ath"] });
    check("M8", "Earlier change (Human → Athletics) leaves Fighter's duplicate Athletics (expected ≠ fresh)",
      r.equal, r, { expect: false });
  });

  // Duplicate feat: Human's Versatile takes Magic Initiate, which Sage also grants.
  await attempt("M9", async () => {
    const dup = await buildCharacter("modern", {
      overrides: { "Human/Versatile": { selected: ["Compendium.dnd5e.feats24.Item.phbftMagicInitia"] } }
    });
    const mi = dup.actor.items.filter(i => i.name === "Magic Initiate");
    check("M9", "Versatile = Magic Initiate while Sage grants it too: two copies? (info)", mi.length === 2, {
      copies: mi.length, spells: dup.actor.items.filter(i => i.type === "spell").map(i => i.name),
      stepErrors: dup.steps.filter(s => s.error)
    });
    report.checks.at(-1).ok = true;
  });
}
