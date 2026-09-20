import { test } from "node:test";
import assert from "node:assert/strict";
import { createDraft, makeError, STATUS } from "../scripts/contracts.mjs";
import { reviewModel, summaryOf, outcomeOf } from "../scripts/wizard/review-step.mjs";

const ID = n => String(n).padEnd(16, "0");
const U = n => `Compendium.test.items.Item.${ID(n)}`;

/** A stand-in for the rebuilt character. */
const built = {
  actor: {
    system: {
      details: { level: 1 },
      attributes: { hp: { max: 11 }, ac: { value: 16 }, movement: { walk: 25 }, prof: 2 },
      abilities: { str: { value: 15, mod: 2, proficient: 1 }, dex: { value: 12, mod: 1, proficient: 0 },
        con: { value: 16, mod: 3, proficient: 1 }, int: { value: 8, mod: -1, proficient: 0 },
        wis: { value: 13, mod: 1, proficient: 0 }, cha: { value: 10, mod: 0, proficient: 0 } },
      skills: { ath: { value: 1 }, per: { value: 0 }, rel: { value: 1 } }
    },
    items: [
      { type: "race", name: "Hill Dwarf" }, { type: "background", name: "Acolyte" },
      { type: "class", name: "Cleric" }, { type: "subclass", name: "Life Domain" },
      { type: "feat", name: "Dwarven Resilience" }, { type: "feat", name: "Channel Divinity" },
      { type: "spell", name: "Bless" }, { type: "spell", name: "Guidance" }
    ]
  }
};
built.actor.items.filter = Array.prototype.filter.bind(built.actor.items);
const equipment = { items: [{ uuid: U("mace"), name: "Mace", count: 1 }, { uuid: U("arrow"), name: "Arrow", count: 20 }],
  currency: { gp: 15, sp: 0 } };
const draft = over => ({ ...createDraft({ id: ID("d"), worldId: "w", rules: "legacy", now: 1 }), ...over });

test("the summary is read from the rebuilt character", () => {
  const d = draft({ details: { ...draft().details, name: "Brenna" } });
  const s = summaryOf(built, equipment, d);
  assert.equal(s.name, "Brenna");
  assert.deepEqual([s.species, s.background, s.class, s.subclass], ["Hill Dwarf", "Acolyte", "Cleric", "Life Domain"]);
  assert.deepEqual([s.hitPoints, s.armorClass, s.speed, s.proficiency], [11, 16, 25, 2]);
  assert.equal(s.abilities.length, 6);
  assert.deepEqual(s.abilities[0], { key: "str", label: "STR", value: 15, modifier: "+2", saveProficient: true });
  assert.equal(s.abilities.find(a => a.key === "int").modifier, "-1");
  assert.deepEqual(s.skills, ["ath", "rel"], "only the proficient ones (labels come from dnd5e in Foundry)");
  assert.deepEqual(s.features, ["Channel Divinity", "Dwarven Resilience"]);
  assert.deepEqual(s.equipment, [{ name: "Mace", count: null }, { name: "Arrow", count: 20 }]);
  assert.equal(s.currency, "15 GP");
  assert.deepEqual(s.spells, ["Bless", "Guidance"]);
  assert.equal(summaryOf({}, equipment, d), null, "nothing to show without a character");
});

test("with problems, Create is held back and each one points at its step", () => {
  const model = reviewModel({ built, draft: draft(), equipment,
    validation: { errors: [makeError("NAME_REQUIRED"), makeError("CANTRIP_COUNT"), makeError("SPELL_COUNT")] } });
  assert.equal(model.ready, false);
  assert.equal(model.problems, 3);
  assert.deepEqual(model.groups.map(g => [g.step, g.errors.length]), [["spells", 2], ["details", 1]]);
  assert.equal(model.outcome, null);
});

test("with nothing to fix, the character can be created", () => {
  const model = reviewModel({ built, draft: draft(), equipment, validation: { errors: [] } });
  assert.deepEqual([model.ready, model.problems, model.busy], [true, 0, false]);
  assert.equal(reviewModel({ built, draft: draft(), equipment, validation: { errors: [] }, busy: true }).busy, true);
});

test("once sent, the outcome says what happened", () => {
  assert.equal(outcomeOf(draft()), null);
  assert.deepEqual(outcomeOf(draft({ status: STATUS.SUBMITTED })), { kind: "pending" });
  const created = outcomeOf(draft({ status: STATUS.CREATED,
    result: { actorUuid: `Actor.${ID("a")}`, errors: [makeError("BAD_IMAGE")] } }));
  assert.deepEqual([created.kind, created.actorUuid, created.warnings], ["created", `Actor.${ID("a")}`,
    ["CHARCREATOR.Error.BAD_IMAGE"]]);
  const failed = outcomeOf(draft({ status: STATUS.FAILED, result: { actorUuid: null, errors: [makeError("MISSING_STEP")] } }));
  assert.equal(failed.kind, "failed");
  assert.deepEqual(failed.errors[0].step, "choices", "a refused build points at the step to revisit");
});

test("once the character is made, another can be started while the GM's limit allows", () => {
  const created = draft({ status: STATUS.CREATED, result: { actorUuid: `Actor.${ID("a")}`, errors: [] } });
  const model = over => reviewModel({ built, draft: created, equipment, validation: { errors: [] }, ...over });
  assert.equal(model({ another: true }).another, true);
  assert.equal(model({ another: false }).another, false);
  assert.equal(model({}).another, false, "nothing is assumed");
});
