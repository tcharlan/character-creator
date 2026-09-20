/**
 * The wizard shell (PLAN 3.1, D16/D25): a full-window ApplicationV2 with the step banner, the step pane and the
 * footer. It owns the draft (draft/store.mjs), rebuilds the character from the recipe on every change (D18) and
 * runs the validator to show what still needs attention. The step panes themselves arrive in PLAN 3.2–3.9; until
 * then each step shows what the engine already knows about it.
 */

import { MODULE_ID, STATUS } from "../contracts.mjs";
import { DraftStore } from "../draft/store.mjs";
import { getCatalog } from "../catalog/catalog.mjs";
import { checkBuilt } from "../rules/validate.mjs";
import { buildCharacter } from "../rules/build.mjs";
import { readSettings } from "../settings/settings.mjs";
import { bannerSteps, canOpen, moveStep, groupErrors, attention, BANNER_STEPS } from "./steps-model.mjs";
import { applyPick, answerStep, syncRecipe } from "./picks.mjs";
import { optionList, optionDetail, optionDescription, subclassOptions, subclassStep, STEP_CATEGORY } from "./options-step.mjs";
import { abilitiesModel, setMethod, spendPoint, assignValue } from "./abilities-step.mjs";
import { choicesModel, answerData } from "./choices-step.mjs";
import { sourceModel, setMode, chooseBranch, setPick, setWealth, EQUIPMENT_SOURCES } from "./equipment-step.mjs";
import { equipmentContext, rollStartingWealth } from "../rules/equipment-items.mjs";
import { spellsModel, toggleSpell } from "./spells-step.mjs";
import { spellContext } from "../rules/spell-facts.mjs";
import { detailsModel, setDetail, PERSONALITY } from "./details-step.mjs";
import { portraitModel, setImage, clearImage, skipPortrait, setRingColor } from "./portrait-step.mjs";
import { preparePortrait } from "../portrait/prepare.mjs";
import { rollAbilityScores } from "../rules/ability-roll.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Templates for the step panes (PLAN 3.2–3.9 fill these in; the rest fall back to the placeholder). */
const STEP_PARTIALS = {
  start: `modules/${MODULE_ID}/templates/steps/start.hbs`,
  species: `modules/${MODULE_ID}/templates/steps/options.hbs`,
  class: `modules/${MODULE_ID}/templates/steps/options.hbs`,
  background: `modules/${MODULE_ID}/templates/steps/options.hbs`,
  abilities: `modules/${MODULE_ID}/templates/steps/abilities.hbs`,
  choices: `modules/${MODULE_ID}/templates/steps/choices.hbs`,
  equipment: `modules/${MODULE_ID}/templates/steps/equipment.hbs`,
  spells: `modules/${MODULE_ID}/templates/steps/spells.hbs`,
  details: `modules/${MODULE_ID}/templates/steps/details.hbs`,
  portrait: `modules/${MODULE_ID}/templates/steps/portrait.hbs`
};

/** Shared pieces the step templates include. */
const PART_TEMPLATES = { ccAbility: `modules/${MODULE_ID}/templates/parts/ability-picker.hbs` };
const T = (key, data) => (data ? game.i18n.format(`CHARCREATOR.${key}`, data) : game.i18n.localize(`CHARCREATOR.${key}`));

/**
 * How long to wait after a change before rebuilding and revalidating. Replaying a character takes a noticeable
 * moment and blocks the browser while it runs, so while the player is still clicking we don't start one: only a
 * pause triggers the rebuild that updates the banner counts and the footer.
 */
const REBUILD_DELAY = 800;

export class CharacterWizard extends HandlebarsApplicationMixin(ApplicationV2) {
  /** The open wizard, if any (one per client). */
  static #instance = null;

  #store = new DraftStore();
  #catalog = null;
  #current = BANNER_STEPS[0];
  #visited = [];
  #validation = null;
  #build = null;
  #busy = false;
  #timer = null;
  #search = {};
  #auto = new Set();
  #openChoice = null;
  #equipment = null;
  #spellTab = null;
  #tables = null;

  static DEFAULT_OPTIONS = {
    id: "character-creator-wizard",
    classes: ["character-creator", "cc-wizard"],
    tag: "div",
    window: { title: "CHARCREATOR.Title", icon: "fa-solid fa-hat-wizard", resizable: true, minimizable: true },
    position: { width: 1280, height: 760 },
    actions: {
      step: onStep,
      back: onBack,
      next: onNext,
      discard: onDiscard,
      begin: onBegin,
      pick: onPick,
      subclass: onSubclass,
      method: onMethod,
      raise: onRaise,
      lower: onLower,
      roll: onRoll,
      choice: onChoice,
      item: onItemChoice,
      size: onSize,
      "subclass-choice": onSubclassChoice,
      "choice-ability": onChoiceAbility,
      "asi-raise": onAsiRaise,
      "asi-lower": onAsiLower,
      "equip-mode": onEquipMode,
      "equip-branch": onEquipBranch,
      "equip-roll": onEquipRoll,
      "spell-tab": onSpellTab,
      spell: onSpell,
      "detail-roll": onDetailRoll,
      "portrait-clear": onPortraitClear,
      "portrait-skip": onPortraitSkip,
      "ring-reset": onRingReset
    }
  };

  static PARTS = {
    banner: { template: `modules/${MODULE_ID}/templates/banner.hbs` },
    body: { template: `modules/${MODULE_ID}/templates/body.hbs`, scrollable: [""] },
    footer: { template: `modules/${MODULE_ID}/templates/footer.hbs` }
  };

  /** The draft being edited. */
  get draft() {
    return this.#store.draft;
  }

  /** The current step key. */
  get step() {
    return this.#current;
  }

  /** The last validation result (null until the first rebuild). */
  get validation() {
    return this.#validation;
  }

  /** The last rebuild with automatic steps filled in and each open step's options (what the panes show). */
  get build() {
    return this.#build;
  }

  /* -------------------------------------------- */

  /**
   * Open the wizard, resuming a draft or starting one. Returns the open application, or null when the draft can't
   * be used here (the player is told why).
   */
  static async open() {
    if ( CharacterWizard.#instance?.rendered ) {
      CharacterWizard.#instance.bringToFront();
      return CharacterWizard.#instance;
    }
    const app = new CharacterWizard();
    const opened = await app.#start();
    if ( !opened ) return null;
    CharacterWizard.#instance = app;
    await app.render({ force: true });
    return app;
  }

  /** Load or create the draft. Returns false when there's nothing to open. */
  async #start() {
    const { state, draft, problems } = this.#store.load();
    switch ( state ) {
      case "none":
        await this.#store.create();
        this.#current = "start";
        break;
      case "editable":
        this.#current = canOpen(draft.step, draft) ? draft.step : BANNER_STEPS[0];
        ui.notifications?.info(T("Notify.Resumed"));
        break;
      case "submitted":
        ui.notifications?.warn(T("Notify.WaitingForGM"));
        return false;
      case "created":
        ui.notifications?.info(T("Notify.AlreadyCreated"));
        return false;
      default: {
        // otherWorld, otherRules, tooNew, broken: can't be resumed here.
        const discard = await confirmDialog(T("Discard.Title"), T(`Discard.${state}`), T("Discard.Confirm"));
        console.debug(`${MODULE_ID} | draft ${state}`, problems);
        if ( !discard ) return false;
        await this.#store.discard();
        await this.#store.create();
      }
    }
    this.#catalog = await getCatalog();
    await this.#rebuild();
    warmTraitLists();
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Change the draft and rebuild. Step panes call this.
   *
   * The change takes effect at once; saving it is debounced by the store, so we don't wait for the write —
   * waiting would make every click feel a second slow. Closing the wizard flushes whatever is still waiting.
   * @param {(draft: object) => void} change
   * @param {{ wait?: boolean }} [options]   `wait: true` waits for the save.
   */
  async update(change, { wait = false } = {}) {
    const saved = this.#store.update(d => {
      change(d);
      d.step = this.#current;
    }).catch(err => {
      console.error(`${MODULE_ID} | the draft couldn't be saved`, err);
      ui.notifications?.error(game.i18n.localize(err?.error?.key ?? "CHARCREATOR.Error.BAD_REQUEST"));
    });
    if ( wait ) await saved;
    this.#schedule();
  }

  /** Go to a step (if its picks are in place). */
  async goTo(step) {
    if ( (step !== "start") && !canOpen(step, this.draft) ) return;
    if ( !this.#visited.includes(this.#current) ) this.#visited.push(this.#current);
    this.#current = step;
    if ( this.draft ) await this.update(() => null);
    else this.render({ parts: ["banner", "body", "footer"] });
  }

  /**
   * Choose the species, class or background for the current step (PLAN 3.2). Answers that belonged to the old
   * pick are dropped (picks.mjs).
   */
  async pick(uuid) {
    const role = STEP_CATEGORY[this.#current];
    if ( !role ) return;
    this.#auto.delete(role);
    // Show the choice at once (the details come from the compendium, not the rebuild), then rebuild in the
    // background: replaying a class's advancements takes a moment the first time dnd5e loads its lists.
    await this.update(d => applyPick(d, role, uuid));
    await this.render({ parts: ["banner", "body", "footer"] });
  }

  /** Choose a subclass the class grants at level 1. */
  async chooseSubclass(uuid) {
    const step = subclassStep(this.#build);
    if ( !step ) return;
    await this.update(d => answerStep(d, step, { uuid }));
    await this.settle();
  }

  /** Choose how ability scores are set (only the methods the GM allows are offered). */
  async chooseMethod(method) {
    await this.update(d => setMethod(d, method));
    await this.render({ parts: ["banner", "body", "footer"] });
  }

  /** Point buy: raise or lower one score. */
  async spend(ability, delta) {
    await this.update(d => spendPoint(d, ability, delta));
    await this.render({ parts: ["banner", "body", "footer"] });
  }

  /** Standard array and rolled: put a value on an ability (they swap if it was taken). */
  async assign(ability, value) {
    await this.update(d => assignValue(d, ability, value));
    await this.render({ parts: ["banner", "body", "footer"] });
  }

  /** Roll the six scores in this browser and post them to chat (D15). Only possible once (A10). */
  async rollScores() {
    if ( this.draft?.abilities?.roll ) return;
    try {
      const roll = await rollAbilityScores(this.draft);
      await this.update(d => d.abilities.roll = roll, { wait: true });
    } catch ( err ) {
      console.error(`${MODULE_ID} | the roll failed`, err);
      ui.notifications?.error(game.i18n.localize(err?.key ?? "CHARCREATOR.Error.ROLL_INVALID"));
    }
    await this.render({ parts: ["banner", "body", "footer"] });
  }

  /** Open one of the choices in the list. */
  async openChoice(key) {
    this.#openChoice = key;
    await this.render({ parts: ["body"] });
  }

  /**
   * Answer the open choice. The click is turned into the data the advancement wants (choices-step.mjs); a
   * click that would break a rule (one pick too many, a granted trait, no points left) changes nothing.
   * @param {{ action?: string, value?: string }} click
   */
  async answer(click) {
    const model = choicesModel(this.#build, this.#catalog, this.#openChoice);
    const open = model.open;
    if ( !open ) return;
    const result = this.#build.results.find(r => r.key === open.key);
    const data = answerData(result, click);
    if ( !data ) return;
    this.#openChoice = open.key;
    await this.update(d => answerStep(d, result, data));
    await this.settle();
  }

  /** Take a source's items or its starting wealth (D23: the two sources are separate). */
  async setEquipmentMode(role, mode) {
    await this.update(d => setMode(d, role, mode));
    await this.settle();
  }

  /** Choose one branch of an "a or b" group. */
  async chooseEquipmentBranch(role, entryId, optionId) {
    const tree = this.#equipment?.[role]?.tree;
    if ( !tree ) return;
    await this.update(d => chooseBranch(d, role, entryId, optionId, tree));
    await this.settle();
  }

  /** Put an item in one slot of a category pick. */
  async setEquipmentPick(role, entryId, index, uuid) {
    await this.update(d => setPick(d, role, entryId, index, uuid));
    await this.settle();
  }

  /** Roll 2014 starting wealth for a source; the dice go to chat (D15) and the total locks in (A10). */
  async rollWealth(role) {
    const wealth = this.#equipment?.[role]?.wealth;
    if ( !wealth ) return;
    try {
      const rolled = await rollStartingWealth(this.draft, role, wealth);
      await this.update(d => setWealth(d, role, rolled), { wait: true });
    } catch ( err ) {
      console.error(`${MODULE_ID} | the wealth roll failed`, err);
      ui.notifications?.error(game.i18n.localize(err?.key ?? "CHARCREATOR.Error.WEALTH_ROLL_INVALID"));
    }
    await this.settle();
  }

  /** Show one of the spell lists (cantrips, spellbook, prepared). */
  async openSpellList(tab) {
    this.#spellTab = tab;
    await this.render({ parts: ["body"] });
  }

  /** Choose or drop a spell in the open list. */
  async toggleSpell(kind, uuid) {
    const context = spellContext(this.#build, this.#catalog);
    let changed = false;
    await this.update(d => {
      changed = !!toggleSpell(d, kind, uuid, context.req, context.owned);
    });
    if ( changed ) await this.settle();
  }

  /** Type in one of the detail fields. */
  async setDetail(field, value) {
    await this.update(d => setDetail(d, field, value));
    if ( field === "name" ) await this.render({ parts: ["banner", "footer"] });
  }

  /**
   * Roll one of the 2014 personality fields on the background's table. It's flavour: the roll stays in this
   * browser, isn't posted to chat, and nothing checks it.
   */
  async rollDetail(field) {
    const uuid = (await this.#personalityTables())[field];
    if ( !uuid ) return;
    try {
      const table = await fromUuid(uuid);
      const { results } = await table.roll();
      const text = results.map(r => r.description ?? r.text ?? r.name).join(" ").trim();
      if ( text ) await this.setDetail(field, text);
      await this.render({ parts: ["body"] });
    } catch ( err ) {
      console.warn(`${MODULE_ID} | couldn't roll ${field}`, err);
    }
  }

  /**
   * The background's personality tables, by field. 2014 backgrounds have tables named like
   * "Personality Traits (Acolyte)" in the SRD; a background without them simply gets no roll buttons.
   */
  async #personalityTables() {
    const background = this.#build?.actor?.items?.get(this.#build.roots?.background);
    const key = background?.name ?? null;
    if ( this.#tables?.for === key ) return this.#tables.tables;
    const tables = {};
    if ( key ) {
      for ( const pack of game.packs.filter(p => (p.documentName === "RollTable") && p.visible) ) {
        const index = await pack.getIndex();
        for ( const [field, label] of Object.entries(PERSONALITY) ) {
          const entry = index.find(e => e.name === `${label} (${key})`);
          if ( entry ) tables[field] = entry.uuid;
        }
      }
    }
    this.#tables = { for: key, tables };
    return tables;
  }

  /**
   * Take the picture the player chose: it's checked and resized here, in their browser, and travels with the
   * submission. The GM's browser is what saves it (D13, D22).
   */
  async choosePortrait(file) {
    if ( !file ) return;
    try {
      const image = await preparePortrait(file);
      await this.update(d => setImage(d, image), { wait: true });
    } catch ( err ) {
      const key = err?.error?.key ?? "CHARCREATOR.Error.BAD_IMAGE";
      console.warn(`${MODULE_ID} | the portrait couldn't be used`, err);
      ui.notifications?.warn(game.i18n.localize(key));
    }
    await this.render({ parts: ["banner", "body", "footer"] });
  }

  /** Remove the chosen picture, skip the step, or reset the ring colours. */
  async setPortrait(change) {
    await this.update(change, { wait: true });
    await this.render({ parts: ["banner", "body", "footer"] });
  }

  /** Filter the option list of the current step. */
  async search(text) {
    this.#search[this.#current] = text;
    await this.render({ parts: ["body"] });
  }

  /**
   * Rebuild and re-render now, instead of waiting for the pause. Returns when the pane matches the draft.
   * (The tests use it; so does anything that must show the result at once.)
   */
  async settle() {
    await this.#store.flush();
    if ( this.#timer ) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#rebuild();
    if ( this.rendered ) await this.render({ parts: ["banner", "body", "footer"] });
  }

  /** Rebuild and revalidate after a short pause, so quick clicking stays smooth. */
  #schedule() {
    if ( this.#timer ) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#rebuild().then(() => this.rendered && this.render({ parts: ["banner", "body", "footer"] }));
    }, REBUILD_DELAY);
  }

  /** Replay the recipe and validate; the result drives the banner, the pane and the footer. */
  async #rebuild() {
    if ( !this.draft ) return;
    this.#busy = true;
    try {
      await this.#autoSelect();
      // Rebuild with automatic steps filled in (D18). Its recipe is what the draft keeps: it carries the
      // automatic answers, and leaves out answers that no longer fit (a changed pick, or content the GM
      // stopped allowing — A6).
      this.#build = await buildCharacter({ picks: this.draft.picks, base: this.draft.abilities.base,
        steps: this.draft.recipe.steps }, { catalog: this.#catalog, fill: true, withOptions: true });
      const next = syncRecipe(this.draft.recipe.steps, this.#build);
      if ( JSON.stringify(next) !== JSON.stringify(this.draft.recipe.steps) ) {
        await this.#store.update(d => d.recipe.steps = foundry.utils.deepClone(next));
      }
      const { errors, equipment } = await checkBuilt(this.draft, this.#build, { catalog: this.#catalog,
        userId: game.user.id, allowedMethods: readSettings().abilityMethods });
      this.#validation = { ok: !errors.length, errors, built: this.#build, equipment };
      await this.#equipmentContexts();
    } catch ( err ) {
      console.error(`${MODULE_ID} | rebuild failed`, err);
      this.#validation = null;
    } finally {
      this.#busy = false;
    }
  }

  /** Each source's starting-equipment tree, candidates and proficiency, for the equipment step. */
  async #equipmentContexts() {
    const contexts = {};
    for ( const role of EQUIPMENT_SOURCES ) {
      const item = this.#build?.actor?.items?.get(this.#build.roots?.[role]);
      if ( !item ) continue;
      contexts[role] = { name: item.name, ...await equipmentContext(this.#build.actor, item, this.#catalog) };
    }
    this.#equipment = contexts;
  }

  /** D4: a category the GM narrowed to a single option is chosen for the player. */
  async #autoSelect() {
    for ( const [step, category] of Object.entries(STEP_CATEGORY) ) {
      const only = this.#catalog?.byCategory?.[category];
      if ( only?.length !== 1 || this.draft.picks[step] ) continue;
      const uuid = only[0].uuid.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item.");
      await this.#store.update(d => applyPick(d, step, uuid));
      this.#auto.add(step);
    }
  }

  /* -------------------------------------------- */

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const draft = this.draft;
    const errorsByStep = groupErrors(this.#validation?.errors ?? []);
    const labels = await this.#labels();
    const state = attention(errorsByStep);
    const back = moveStep(this.#current, -1, draft);
    const next = moveStep(this.#current, 1, draft);
    return Object.assign(context, {
      moduleId: MODULE_ID,
      busy: this.#busy,
      draft,
      step: this.#current,
      stepTitle: T(`Step.${this.#current}.Title`),
      stepHint: T(`Step.${this.#current}.Hint`),
      steps: bannerSteps({ current: this.#current, draft, errorsByStep, labels, visited: this.#visited }),
      errors: errorsByStep[this.#current] ?? [],
      problems: Object.entries(errorsByStep).map(([step, errors]) => ({ step, title: T(`Step.${step}.Title`),
        errors: errors.map(e => ({ ...e, message: game.i18n.localize(e.key) })) })),
      summary: this.#summary(),
      stepPartial: STEP_PARTIALS[this.#current] ?? null,
      rulesLabel: T(`Rules.${this.draft?.rules ?? "legacy"}`),
      resuming: (this.draft?.recipe?.steps?.length ?? 0) > 0 || Object.values(this.draft?.picks ?? {}).some(Boolean),
      ...(await this.#stepContext()),
      attention: state,
      backLabel: back ? T(`Step.${back}.Title`) : T("Nav.Start"),
      nextLabel: next ? T("Nav.Next", { step: T(`Step.${next}.Title`) }) : T("Nav.Review"),
      canBack: !!back,
      canNext: !!next
    });
  }

  /** Whatever the current step's pane needs (PLAN 3.2: the option steps). */
  async #stepContext() {
    if ( this.#current === "equipment" ) return { equipment: this.#equipmentModel() };
    if ( this.#current === "portrait" ) {
      const settings = readSettings();
      return { portrait: portraitModel(this.draft, { enabled: settings.portraits.enabled,
        maxSourceBytes: settings.portraits.maxSourceBytes, defaults: settings.ringColors,
        userColor: game.user.color?.css ?? null }) };
    }
    if ( this.#current === "details" ) {
      const tables = this.draft.rules === "legacy" ? await this.#personalityTables() : {};
      return { details: detailsModel(this.draft, { rules: this.draft.rules, tables }) };
    }
    if ( this.#current === "spells" ) {
      const context = spellContext(this.#build, this.#catalog);
      const model = spellsModel(context, this.draft, this.#spellTab, this.#catalog);
      this.#spellTab = model.open?.key ?? null;
      return { spells: { ...model, knownText: model.known.join(", "),
        errors: (this.#validation?.errors ?? []).filter(e => e.step === "spells").map(e => e.key) } };
    }
    if ( this.#current === "choices" ) {
      const choices = choicesModel(this.#build, this.#catalog, this.#openChoice);
      this.#openChoice = choices.open?.key ?? null;
      return { choices };
    }
    if ( this.#current === "abilities" ) {
      const actor = this.#build?.actor;
      const finals = actor ? Object.fromEntries(Object.entries(actor.system.abilities ?? {})
        .map(([key, a]) => [key, { value: a.value, mod: a.mod }])) : {};
      return { abilities: abilitiesModel(this.draft, { allowedMethods: readSettings().abilityMethods, finals }) };
    }
    const role = STEP_CATEGORY[this.#current];
    if ( !role ) return {};
    const selected = this.draft?.picks?.[role] ?? null;
    const options = optionList(this.#catalog, this.#current, { search: this.#search[this.#current] ?? "", selected });
    const detail = selected ? await optionDetail(selected, this.#current) : null;
    if ( detail ) {
      detail.auto = this.#auto.has(role);
      // The description is enriched in the background; render again when it's ready.
      if ( detail.description === null ) {
        optionDescription(selected, this.#current)
          .then(() => (this.rendered && (this.draft?.picks?.[role] === selected)) ? this.render({ parts: ["body"] }) : null)
          .catch(err => console.warn(`${MODULE_ID} | couldn't read the description`, err));
      }
    }
    let subclass = null;
    if ( (this.#current === "class") && detail?.identifier ) {
      const step = subclassStep(this.#build);
      if ( step ) {
        const chosen = step.data?.uuid ?? null;
        subclass = { list: subclassOptions(this.#catalog, detail.identifier, chosen), chosen };
      }
    }
    return { options, detail, subclass };
  }

  /** @inheritDoc */
  _onRender(context, options) {
    super._onRender(context, options);
    // Checkboxes answer on "change": a click inside a <label> would otherwise fire the action twice.
    for ( const box of this.element.querySelectorAll(".cc-toggle") ) {
      box.addEventListener("change", event => this.answer({ action: event.target.dataset.toggle, value: event.target.dataset.key }));
    }
    const file = this.element.querySelector(".cc-file__input");
    if ( file ) file.addEventListener("change", event => this.choosePortrait(event.target.files?.[0]));
    for ( const color of this.element.querySelectorAll(".cc-color") ) {
      color.addEventListener("change", event =>
        this.setPortrait(d => setRingColor(d, event.target.dataset.ring, event.target.value)));
    }
    for ( const field of this.element.querySelectorAll("[data-detail]") ) {
      if ( field.tagName === "BUTTON" ) continue;
      field.addEventListener("input", foundry.utils.debounce(event =>
        this.setDetail(event.target.dataset.detail, event.target.value), 300));
    }
    for ( const select of this.element.querySelectorAll(".cc-equip-pick") ) {
      select.addEventListener("change", event => {
        const { role, entry, index } = event.target.dataset;
        this.setEquipmentPick(role, entry, Number(index), event.target.value || null);
      });
    }
    for ( const select of this.element.querySelectorAll(".cc-assign") ) {
      select.addEventListener("change", event => {
        const value = event.target.value === "" ? null : Number(event.target.value);
        this.assign(event.target.dataset.ability, value);
      });
    }
    const search = this.element.querySelector(".cc-search");
    if ( search ) {
      search.addEventListener("input", foundry.utils.debounce(event => this.search(event.target.value), 200));
    }
  }

  /** What the equipment step shows: one block per source, plus what the character ends up carrying. */
  #equipmentModel() {
    const sources = [];
    for ( const role of EQUIPMENT_SOURCES ) {
      const ctx = this.#equipment?.[role];
      if ( !ctx ) continue;
      const model = sourceModel({ role, name: ctx.name, tree: ctx.tree, wealthOption: ctx.wealthOption,
        candidates: ctx.candidates, isProficient: ctx.isProficient }, this.draft.equipment[role], this.#catalog);
      sources.push({ ...model, fixedText: model.fixed.join(", ") });
    }
    const resolved = this.#validation?.equipment;
    const items = (resolved?.items ?? []).map(i => ({ name: this.#catalog?.get(i.uuid)?.name ?? i.uuid, count: i.count > 1 ? i.count : null }));
    const currency = Object.entries(resolved?.currency ?? {}).map(([k, v]) => `${v} ${k.toUpperCase()}`).join(", ");
    return { sources, items, currencyText: currency,
      errors: (this.#validation?.errors ?? []).filter(e => e.step === "equipment").map(e => e.key) };
  }

  /** The picks' names for the banner. */
  async #labels() {
    const out = {};
    const picks = this.draft?.picks ?? {};
    const byRole = { species: "species", class: "class", background: "background" };
    for ( const [role, step] of Object.entries(byRole) ) {
      if ( picks[role] ) out[step] = this.#catalog?.get(picks[role])?.name ?? T("Nav.Chosen");
    }
    const a = this.draft?.abilities;
    if ( a?.method ) out.abilities = T(`Abilities.${a.method}`);
    if ( this.draft?.details?.name ) out.details = this.draft.details.name;
    if ( this.draft?.portrait?.status === "ready" ) out.portrait = T("Portrait.Ready");
    else if ( this.draft?.portrait?.status === "skipped" ) out.portrait = T("Portrait.Skipped");
    return out;
  }

  /** What the engine knows so far, shown in each step's placeholder pane until PLAN 3.2–3.9 replace it. */
  #summary() {
    const v = this.#validation;
    const built = this.#build ?? v?.built;
    const catalog = this.#catalog;
    const counts = catalog ? Object.fromEntries(Object.entries(catalog.byCategory).map(([k, list]) => [k, list.length])) : {};
    const needsInput = built?.results?.filter(r => r.status === "needsInput") ?? [];
    return {
      counts,
      items: built?.actor?.items?.size ?? 0,
      hp: built?.actor?.system?.attributes?.hp?.max ?? null,
      choices: { total: built?.results?.length ?? 0, open: needsInput.length,
        next: needsInput[0] ? `${needsInput[0].item} — ${needsInput[0].title}` : null },
      equipment: v?.equipment?.items?.length ?? 0,
      methods: readSettings().abilityMethods.map(m => T(`Abilities.${m}`)).join(", ")
    };
  }

  /* -------------------------------------------- */

  /** @inheritDoc */
  async close(options = {}) {
    if ( this.#timer ) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#store.flush().catch(err => console.error(`${MODULE_ID} | saving the draft failed`, err));
    if ( CharacterWizard.#instance === this ) CharacterWizard.#instance = null;
    return super.close(options);
  }

  /** Discard the draft and close (used by the footer's "Start over"). */
  async discardAndClose() {
    await this.#store.discard();
    return this.close();
  }
}

/* -------------------------------------------- */
/*  Actions                                     */
/* -------------------------------------------- */

function onBegin() {
  return this.goTo(BANNER_STEPS[0]);
}

function onPick(event, target) {
  return this.pick(target.dataset.uuid);
}

function onSubclass(event, target) {
  return this.chooseSubclass(target.dataset.uuid);
}

function onMethod(event, target) {
  return this.chooseMethod(target.dataset.method);
}

function onRaise(event, target) {
  return this.spend(target.dataset.ability, 1);
}

function onLower(event, target) {
  return this.spend(target.dataset.ability, -1);
}

function onRoll() {
  return this.rollScores();
}

function onChoice(event, target) {
  return this.openChoice(target.dataset.key);
}

function onItemChoice(event, target) {
  return this.answer({ action: "item", value: target.dataset.uuid });
}

function onSize(event, target) {
  return this.answer({ action: "size", value: target.dataset.key });
}

function onSubclassChoice(event, target) {
  return this.answer({ action: "subclass", value: target.dataset.uuid });
}

function onChoiceAbility(event, target) {
  return this.answer({ action: "ability", value: target.dataset.key });
}

function onAsiRaise(event, target) {
  return this.answer({ action: "raise", value: target.dataset.key });
}

function onAsiLower(event, target) {
  return this.answer({ action: "lower", value: target.dataset.key });
}

function onEquipMode(event, target) {
  return this.setEquipmentMode(target.dataset.role, target.dataset.mode);
}

function onEquipBranch(event, target) {
  return this.chooseEquipmentBranch(target.dataset.role, target.dataset.entry, target.dataset.option);
}

function onEquipRoll(event, target) {
  return this.rollWealth(target.dataset.role);
}

function onSpellTab(event, target) {
  return this.openSpellList(target.dataset.tab);
}

function onSpell(event, target) {
  return this.toggleSpell(target.dataset.kind, target.dataset.uuid);
}

function onDetailRoll(event, target) {
  return this.rollDetail(target.dataset.detail);
}

function onPortraitClear() {
  return this.setPortrait(clearImage);
}

function onPortraitSkip() {
  return this.setPortrait(skipPortrait);
}

function onRingReset() {
  return this.setPortrait(d => {
    setRingColor(d, "ring", null);
    setRingColor(d, "background", null);
  });
}

function onStep(event, target) {
  return this.goTo(target.dataset.step);
}

function onBack() {
  const back = moveStep(this.step, -1, this.draft);
  if ( back ) return this.goTo(back);
  return this.step === BANNER_STEPS[0] ? this.goTo("start") : null;
}

function onNext() {
  const next = moveStep(this.step, 1, this.draft);
  return next ? this.goTo(next) : null;
}

async function onDiscard() {
  const yes = await confirmDialog(T("Discard.Title"), T("Discard.editable"), T("Discard.Confirm"));
  if ( yes ) await this.discardAndClose();
}

/**
 * dnd5e loads each proficiency list (weapons, armor, tools…) the first time an advancement asks for it, which is
 * what makes the first rebuild of a class slow. Warm them in the background when the wizard opens.
 */
function warmTraitLists() {
  const choices = dnd5e.documents?.Trait?.choices;
  if ( !choices ) return;
  const keys = Object.keys(CONFIG.DND5E.traits ?? {});
  Promise.allSettled(keys.map(key => choices(key)))
    .then(() => console.debug(`${MODULE_ID} | proficiency lists ready (${keys.length})`));
}

/** A yes/no dialog. */
function confirmDialog(title, content, yes) {
  return foundry.applications.api.DialogV2.confirm({
    window: { title },
    content: `<p>${foundry.utils.escapeHTML(content)}</p>`,
    yes: { label: yes },
    no: { label: game.i18n.localize("Cancel") },
    modal: true
  });
}

/** Load the step templates as partials (body.hbs picks one by name). */
export function preloadWizardTemplates() {
  return foundry.applications.handlebars.loadTemplates({ ...PART_TEMPLATES,
    ...Object.fromEntries([...new Set(Object.values(STEP_PARTIALS))].map(path => [path, path])) });
}

/** The module's public entry point (used by the sidebar button and the tests; PLAN 3.10 adds the UI entries). */
export function registerWizardApi() {
  const module = game.modules.get(MODULE_ID);
  if ( module ) module.api = Object.assign(module.api ?? {}, { CharacterWizard, openWizard: () => CharacterWizard.open(),
    STATUS });
}
