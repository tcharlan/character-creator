/**
 * The wizard shell (PLAN 3.1, D16/D25): a full-window ApplicationV2 with the step banner, the step pane and the
 * footer. It owns the draft (draft/store.mjs), rebuilds the character from the recipe on every change (D18) and
 * runs the validator to show what still needs attention. The step panes themselves arrive in PLAN 3.2–3.9; until
 * then each step shows what the engine already knows about it.
 */

import { ABILITIES, MODULE_ID, STATUS } from "../contracts.mjs";
import { DraftStore } from "../draft/store.mjs";
import { isEditable } from "../draft/state.mjs";
import { getCatalog, itemName } from "../catalog/catalog.mjs";
import { NO_RESTRICTIONS } from "../catalog/filters.mjs";
import { checkBuilt } from "../rules/validate.mjs";
import { buildCharacter } from "../rules/build.mjs";
import { readSettings, SETTINGS } from "../settings/settings.mjs";
import { bannerSteps, canOpen, moveStep, groupErrors, attention, BANNER_STEPS } from "./steps-model.mjs";
import { applyPick, answerStep, syncRecipe } from "./picks.mjs";
import { optionList, optionDetail, optionDescription, subclassOptions, subclassStep, STEP_CATEGORY } from "./options-step.mjs";
import { abilitiesModel, setMethod, spendPoint, assignValue, cleanScores, hasStrayScores } from "./abilities-step.mjs";
import { choicesModel, answerData, nextOpenChoice, withAnswer } from "./choices-step.mjs";
import { sourceModel, setMode, chooseBranch, setPick, setWealth, EQUIPMENT_SOURCES } from "./equipment-step.mjs";
import { equipmentContext, rollStartingWealth } from "../rules/equipment-items.mjs";
import { spellsModel, toggleSpell } from "./spells-step.mjs";
import { spellContext } from "../rules/spell-facts.mjs";
import { traitReference, summaryCached, summariesReady, loadSummaries, spellMeta } from "./descriptions.mjs";
import { detailsModel, setDetail, setHeightPart, setAmount, alignmentOptions, PERSONALITY } from "./details-step.mjs";
import { portraitModel, setImage, clearImage, skipPortrait, setRingColor } from "./portrait-step.mjs";
import { preparePortrait } from "../portrait/prepare.mjs";
import { reviewModel } from "./review-step.mjs";
import { submitDraft } from "../gm/pending.mjs";
import { createdFor } from "../gm/create.mjs";
import { givablePlayers, giveAndTell, giveDialog } from "../gm/assign.mjs";
import { allowance } from "../ui/entry.mjs";
import { arrowKeys } from "../ui/keyboard.mjs";
import { rollAbilityScores } from "../rules/ability-roll.mjs";
import { rollCharacter } from "../rules/random.mjs";
import { clearRolled } from "../rules/random-check.mjs";
import { ROLLED_DETAILS } from "../rules/random.mjs";
import { postMadeRolls } from "../rules/roll-messages.mjs";
import { ROLL_PURPOSE } from "../rules/roll-record.mjs";
import { DISPLAY_MODES, displayButton, fullscreenPosition, readDisplay, windowPosition } from "./display.mjs";
import { splashFor } from "./splash.mjs";

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
  portrait: `modules/${MODULE_ID}/templates/steps/portrait.hbs`,
  review: `modules/${MODULE_ID}/templates/steps/review.hbs`
};

/** Shared pieces the step templates include. */
const PART_TEMPLATES = { ccAbility: `modules/${MODULE_ID}/templates/parts/ability-picker.hbs` };
/** The browser window's inner size: what fullscreen covers and what a window has to stay inside. */
const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
const display = () => readDisplay(key => game.settings.get(MODULE_ID, key), SETTINGS.DISPLAY);

const T = (key, data) => (data ? game.i18n.format(`CHARCREATOR.${key}`, data) : game.i18n.localize(`CHARCREATOR.${key}`));

/**
 * How long to wait after a change before rebuilding and revalidating. Replaying a character takes a noticeable
 * moment and blocks the browser while it runs, so while the player is still clicking we don't start one: only a
 * pause triggers the rebuild that updates the banner counts and the footer.
 */
const REBUILD_DELAY = 800;

/** The part of a random character each step settles (D31); the steps not listed are always the player's. */
const STEP_PART = Object.freeze({ species: "species", class: "class", background: "background",
  abilities: "abilities", choices: "choices", equipment: "equipment", details: "details" });

export class CharacterWizard extends HandlebarsApplicationMixin(ApplicationV2) {
  /** The open wizard, if any (one per client). */
  static #instance = null;

  #store = new DraftStore();
  #catalog = null;
  /** The catalog with nothing narrowed away, for a kit the GM's allowed list can't fill (standard items). */
  #standard = null;
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
  #submitting = false;
  #brokeDown = false;
  // Set while a step holds its changes back (the ability scores): the rebuild happens when the player leaves.
  #deferred = false;
  #bonuses = {};
  /** Something arrived in the background while the window was still opening: redraw once it has opened. */
  #refreshWanted = false;
  /** A GM's character: the player it goes to when created ("" = the GM keeps it; D29). */
  #assignTo = "";
  /** The player the created character went to, for the outcome. */
  #givenTo = null;
  /** Fullscreen or a window (D28); null until set, when the options decide. */
  #mode = null;
  /** Fullscreen before a minimize, so restoring goes back to it. */
  #restoreFullscreen = false;
  #onViewport = null;
  #saveWindow = null;

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
      display: onDisplay,
      give: onGive,
      begin: onBegin,
      "roll-character": onRollCharacter,
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
      "ring-reset": onRingReset,
      another: onAnother,
      create: onCreate,
      "open-sheet": onOpenSheet,
      finish: onFinish,
      fix: onFix,
      "close-wizard": onCloseWizard
    }
  };

  static PARTS = {
    banner: { template: `modules/${MODULE_ID}/templates/banner.hbs` },
    // Each step's own scrolling column is listed, so a re-render (a roll, a pick) leaves the player where
    // they were rather than at the top.
    body: { template: `modules/${MODULE_ID}/templates/body.hbs`,
      scrollable: ["", ".cc-detail", ".cc-options__list", ".cc-fields", ".cc-art"] },
    footer: { template: `modules/${MODULE_ID}/templates/footer.hbs` }
  };

  /** @inheritDoc */
  _initializeApplicationOptions(options) {
    options = super._initializeApplicationOptions(options);
    const { mode, window: saved } = display();
    Object.assign(options.position, mode === "fullscreen" ? fullscreenPosition(viewport()) : windowPosition(saved, viewport()));
    if ( mode === "fullscreen" ) options.classes = [...options.classes, "cc-fullscreen"];
    return options;
  }

  /** The draft being edited. */
  get draft() {
    return this.#store.draft;
  }

  /** "fullscreen" or "window" (D28). */
  get displayMode() {
    return this.#mode ?? (this.options.classes.includes("cc-fullscreen") ? "fullscreen" : "window");
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
    // The buttons that open the creator don't wait on it: a failure would otherwise show only in the console.
    try {
      const opened = await app.#start();
      if ( !opened ) return null;
      CharacterWizard.#instance = app;
      await app.render({ force: true });
      return app;
    } catch ( err ) {
      console.error(`${MODULE_ID} | the character creator couldn't open`, err);
      ui.notifications?.error(T("Notify.OpenFailed"));
      return null;
    }
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
      case "created": {
        // The GM finished the build while the wizard was closed (D17): show the character, then clear the
        // draft so the sidebar offers a new one.
        const uuid = draft?.result?.actorUuid ?? null;
        const actor = uuid ? await fromUuid(uuid).catch(() => null) : null;
        actor?.sheet?.render(true);
        await this.#store.acknowledge();
        ui.notifications?.info(T(actor ? "Notify.AlreadyCreated" : "Notify.CreatedGone"));
        return false;
      }
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
    this.#standard = await getCatalog({ restrictions: NO_RESTRICTIONS });
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
   * @param {{ wait?: boolean, rebuild?: boolean }} [options]   `wait: true` waits for the save;
   *   `rebuild: false` holds the replay back until the player leaves the step (the ability scores).
   */
  async update(change, { wait = false, rebuild = true } = {}) {
    const saved = this.#store.update(d => {
      change(d);
      d.step = this.#current;
    }).catch(err => {
      console.error(`${MODULE_ID} | the draft couldn't be saved`, err);
      ui.notifications?.error(game.i18n.localize(err?.error?.key ?? "CHARCREATOR.Error.BAD_REQUEST"));
    });
    if ( wait ) await saved;
    if ( rebuild ) this.#schedule();
    else this.#deferred = true;
  }

  /** Go to a step (if its picks are in place). */
  async goTo(step) {
    if ( (step !== "start") && !canOpen(step, this.draft) ) return;
    if ( !this.#visited.includes(this.#current) ) this.#visited.push(this.#current);
    // Arriving at the choices step, open the first one that still needs an answer.
    if ( (step === "choices") && (this.#current !== "choices") ) this.#openChoice = null;
    const held = this.#deferred;
    this.#current = step;
    if ( this.draft ) await this.update(() => null, { rebuild: !held });
    else this.render({ parts: ["banner", "body", "footer"] });
    // The step we just left held its changes back: replay the character now.
    if ( held ) await this.settle();
  }

  /**
   * The Next button. On the Choices step it walks through the choices that still need an answer, and only
   * moves on to the next step once they are all done.
   */
  async next() {
    const choice = this.#nextChoice();
    if ( choice ) return this.openChoice(choice);
    const step = moveStep(this.#current, 1, this.draft);
    if ( step ) await this.goTo(step);
  }

  /** The next choice to walk to from here, or null (also used for the Next button's label). */
  #nextChoice() {
    if ( (this.#current !== "choices") || !this.#build ) return null;
    return nextOpenChoice(choicesModel(this.#build, this.#catalog, this.#openChoice), this.#openChoice);
  }

  /**
   * Choose the species, class or background for the current step (PLAN 3.2). Answers that belonged to the old
   * pick are dropped (picks.mjs).
   */
  async pick(uuid) {
    if ( this.#locked(STEP_PART[this.#current]) ) return;
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
    if ( this.#locked("abilities") ) return;
    await this.update(d => setMethod(d, method), { rebuild: false });
    await this.render({ parts: ["banner", "body", "footer"] });
  }

  /** Point buy: raise or lower one score. */
  async spend(ability, delta) {
    await this.update(d => spendPoint(d, ability, delta), { rebuild: false });
    await this.render({ parts: ["banner", "body", "footer"] });
  }

  /** Standard array and rolled: put a value on an ability (they swap if it was taken). */
  async assign(ability, value) {
    if ( this.#locked("abilities") ) return;
    await this.update(d => assignValue(d, ability, value), { rebuild: false });
    await this.render({ parts: ["banner", "body", "footer"] });
  }

  /**
   * The random character (D31): the dice make everything the GM hasn't left to the player, the rolls go to chat
   * in one message, and the draft remembers them so the GM's copy can check the character against them.
   */
  async rollRandomCharacter() {
    const settings = readSettings();
    if ( this.#busy || (this.draft?.mode === "hardcore") || !settings.hardcore.offered ) return;
    this.#busy = true;
    await this.render({ parts: ["body", "footer"] });
    const made = [];
    const rolled = [];
    // The last replay of the loop: the finished character, so the settle afterwards doesn't repeat it.
    let lastBuild = null;
    try {
      // The loop runs on a copy and is written once, so a half-rolled character is never saved. It starts
      // from the same cleared draft the GM replays from — anything the creator chose for the player (D4
      // auto-select) would otherwise stand where a die should have decided.
      const working = clearRolled(this.draft, settings.hardcore.free);
      working.mode = "hardcore";
      let build = this.#build;
      const roll = async (faces, key) => {
        const die = await new Roll(`1d${faces}`).evaluate();
        made.push(die);
        rolled.push({ key, faces, total: die.total });
        return die.total;
      };
      await rollCharacter({
        draft: working,
        catalog: this.#catalog,
        free: settings.hardcore.free,
        roll,
        rebuild: async draft => {
          build = await buildCharacter({ picks: draft.picks, base: draft.abilities.base, steps: draft.recipe.steps },
            { catalog: this.#catalog, fill: true, withOptions: true });
          lastBuild = build;
          return build;
        },
        equipmentContext: async role => {
          const item = build?.actor?.items?.get(build.roots?.[role]);
          return item ? equipmentContext(build.actor, item, this.#catalog, { standard: this.#standard }) : null;
        },
        abilities: async () => {
          working.abilities.method = "rolled";
          const { messageId, results } = await rollAbilityScores(working);
          working.abilities.roll = { messageId, results };
          // In the order they fell: no arranging them afterwards.
          working.abilities.base = Object.fromEntries(ABILITIES.map((key, i) => [key, results[i] ?? null]));
        },
        alignments: alignmentOptions(),
        tables: field => this.#personalityEntries(field)
      });
      const messageId = await postMadeRolls({ draftId: working.id, purpose: ROLL_PURPOSE.RANDOM, rolls: made,
        flavor: T("Random.Flavor") });
      working.random = { messageId, rolls: rolled };
      // The whole rolled character in one write (update() keeps the draft it is handed, not what it returns).
      this.#current = "review";
      this.#visited = [];
      // Written at once rather than on the autosave's own time: the player is waiting on it.
      const saved = this.update(d => Object.assign(d, working), { rebuild: false });
      await this.#store.flush();
      await saved;
    } catch ( err ) {
      console.error(`${MODULE_ID} | the random character couldn't be rolled`, err);
      ui.notifications?.error(T("Random.Failed"));
    } finally {
      this.#busy = false;
    }
    await this.settleWith(lastBuild);
  }

  /** A personality table's entries, in the order the table lists them (D31 rolls one of them). */
  async #personalityEntries(field) {
    const uuid = (await this.#personalityTables())[field];
    if ( !uuid ) return [];
    try {
      const table = await fromUuid(uuid);
      return [...(table?.results ?? [])]
        .sort((a, b) => (a.range?.[0] ?? 0) - (b.range?.[0] ?? 0))
        .map(r => String(r.description ?? r.text ?? r.name ?? "").trim())
        .filter(Boolean);
    } catch ( err ) {
      console.warn(`${MODULE_ID} | couldn't read the ${field} table`, err);
      return [];
    }
  }

  /** Roll the six scores in this browser and post them to chat (D15). Only possible once (A10). */
  async rollScores() {
    if ( this.draft?.abilities?.roll ) return;   // one roll per draft (A10)
    try {
      const roll = await rollAbilityScores(this.draft);
      await this.update(d => d.abilities.roll = roll, { wait: true });
    } catch ( err ) {
      console.error(`${MODULE_ID} | the roll failed`, err);
      ui.notifications?.error(game.i18n.localize(err?.key ?? "CHARCREATOR.Error.ROLL_INVALID"));
    }
    await this.render({ parts: ["banner", "body", "footer"] });
  }

  /** Open one of the choices in the list, replaying first whatever the last one held back. */
  async openChoice(key) {
    this.#openChoice = key;
    if ( this.#deferred ) return this.settle();
    await this.render({ parts: ["body"] });
  }

  /**
   * Answer the open choice. The click is turned into the data the advancement wants (choices-step.mjs); a
   * click that would break a rule (one pick too many, a granted trait, no points left) changes nothing.
   * @param {{ action?: string, value?: string }} click
   */
  async answer(click) {
    if ( this.#locked("choices") ) return;
    const model = choicesModel(this.#build, this.#catalog, this.#openChoice);
    const open = model.open;
    if ( !open ) return;
    const result = this.#build.results.find(r => r.key === open.key);
    const data = answerData(result, click);
    if ( !data ) {
      // The click changes nothing (one pick too many, a granted trait). A checkbox has already ticked itself,
      // so put the screen back the way the draft says it is.
      await this.render({ parts: ["body"] });
      return;
    }
    this.#openChoice = open.key;
    // The answer is held back like the ability scores are: the screen shows it now, the character is
    // replayed when the player opens another choice or leaves the step.
    await this.update(d => answerStep(d, result, data), { rebuild: false });
    this.#build = withAnswer(this.#build, open.key, data);
    await this.render({ parts: ["banner", "body", "footer"] });
  }

  /** Take a source's items or its starting wealth (D23: the two sources are separate). */
  async setEquipmentMode(role, mode) {
    if ( this.#locked("equipment") ) return;
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
    if ( this.#locked("equipment") ) return;
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

  /**
   * Fill in one of the detail fields. `part` is one half of the height (feet, inches) and `unit` is the unit
   * an amount is stored with (the weight), so what the draft keeps is the sentence a character sheet shows.
   */
  async setDetail(field, value, { part = null, unit = null } = {}) {
    // Only what the dice settled is closed; the name and the rest of the writing stay the player's (D31).
    if ( ROLLED_DETAILS.includes(field) && this.#locked("details") ) return;
    await this.update(d => {
      if ( part ) return setHeightPart(d, part, value);
      if ( unit ) return setAmount(d, field, value, unit);
      return setDetail(d, field, value);
    });
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

  /**
   * Send the character to the GM (PLAN 3.9). With a GM online it's created straight away; otherwise the draft
   * waits as a pending build and the GM's browser picks it up when one joins (D17).
   */
  async createCharacter() {
    if ( this.#submitting || !this.#validation?.ok ) return;
    this.#submitting = true;
    await this.render({ parts: ["body", "footer"] });
    try {
      // 0.3.0 could leave a stray key in the ability scores (the Review list shared a class with them), which the
      // GM's check refuses: clean it before sending.
      if ( hasStrayScores(this.draft) ) await this.update(d => cleanScores(d), { wait: true, rebuild: false });
      const image = this.draft.portrait?.pendingImage ?? null;
      const result = await submitDraft(this.draft, { image });
      if ( result.pending ) {
        // Stored for a GM to pick up (D17): take over what submitDraft wrote.
        this.#store.adopt(this.#store.load().draft ?? { ...this.draft, status: STATUS.SUBMITTED });
      } else if ( result.ok ) {
        // Created while we waited: record it on the draft, the same shape the offline path writes.
        await this.update(d => {
          d.status = STATUS.CREATED;
          d.portrait = { ...d.portrait, pendingImage: null };
          d.result = { actorUuid: result.actorUuid, errors: result.warnings ?? [] };
        }, { wait: true });
        // A GM who chose a player at Review: give it to them now (D29).
        const player = (game.user.isGM && this.#assignTo) ? game.users.get(this.#assignTo) : null;
        const actor = player ? await fromUuid(result.actorUuid) : null;
        if ( actor ) this.#givenTo = await giveAndTell(actor, player);
      } else if ( !result.ok ) {
        await this.update(d => {
          d.status = STATUS.FAILED;
          d.result = { actorUuid: null, errors: (result.errors ?? []).slice(0, 100) };
        }, { wait: true });
      }
    } catch ( err ) {
      console.error(`${MODULE_ID} | the character couldn't be sent`, err);
      ui.notifications?.error(game.i18n.localize("CHARCREATOR.Error.BAD_REQUEST"));
    } finally {
      this.#submitting = false;
    }
    await this.settle();
  }

  /** Open the created character's sheet. */
  async openCharacter() {
    const actor = await fromUuid(this.draft?.result?.actorUuid ?? "");
    actor?.sheet?.render(true);
  }

  /**
   * Start again on a new character, once this one is made and the GM's limit leaves room (A4). The finished
   * draft is let go first — the character itself is the record.
   */
  /** A GM gives the character just made to a player, choosing whom (D29). */
  async giveCreated() {
    const uuid = this.draft?.result?.actorUuid;
    const actor = uuid ? await fromUuid(uuid) : null;
    if ( !actor ) return null;
    const player = await giveDialog(actor);
    if ( player ) {
      this.#givenTo = player;
      await this.render({ parts: ["body"] });
    }
    return player;
  }

  async makeAnother() {
    this.#givenTo = null;
    await this.#store.acknowledge();
    await this.#store.create();
    this.#current = "start";
    this.#visited = [];
    this.#openChoice = null;
    this.#spellTab = null;
    this.#search = {};
    this.#auto.clear();
    this.#build = null;
    this.#validation = null;
    await this.settle();
  }

  /** The player has seen the result: clear a created draft, or return a refused one to editing. */
  async acknowledge({ close = false } = {}) {
    const draft = await this.#store.acknowledge();
    if ( !draft || close ) return this.close();
    await this.settle();
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
    return this.settleWith(null);
  }

  /**
   * Settle, reusing a replay the caller already has. The random character has just replayed the finished
   * character (D31), and nothing it decided afterwards — the equipment, the alignment — changes a replay.
   */
  async settleWith(build) {
    this.#deferred = false;
    await this.#store.flush();
    if ( this.#timer ) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#rebuild({ reuse: build });
    if ( this.rendered ) await this.render({ parts: ["banner", "body", "footer"] });
  }

  /** Rebuild and revalidate after a short pause, so quick clicking stays smooth. */
  #schedule() {
    this.#deferred = false;
    if ( this.#timer ) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#rebuild().then(() => this.rendered && this.render({ parts: ["banner", "body", "footer"] }));
    }, REBUILD_DELAY);
  }

  /**
   * Change the draft now and let the autosave write it when it's ready. The store debounces its writes by a
   * second, so waiting for one here would hold up whatever the player is looking at for that long — it is
   * what made a new draft take over two seconds to open (PLAN 5.4). Closing the wizard flushes the save.
   */
  #saveLater(change) {
    this.#store.update(change).catch(err => {
      console.error(`${MODULE_ID} | the draft couldn't be saved`, err);
      ui.notifications?.error(game.i18n.localize(err?.error?.key ?? "CHARCREATOR.Error.BAD_REQUEST"));
    });
  }

  /** Replay the recipe and validate; the result drives the banner, the pane and the footer. */
  async #rebuild({ reuse = null } = {}) {
    if ( !this.draft ) return;
    this.#busy = true;
    try {
      this.#autoSelect();
      // Rebuild with automatic steps filled in (D18). Its recipe is what the draft keeps: it carries the
      // automatic answers, and leaves out answers that no longer fit (a changed pick, or content the GM
      // stopped allowing — A6).
      // A replay the caller already has (the random character just made one): the draft has not changed
      // in any way that changes it, so it is used as it is.
      this.#build = reuse ?? await buildCharacter({ picks: this.draft.picks, base: this.draft.abilities.base,
        steps: this.draft.recipe.steps }, { catalog: this.#catalog, fill: true, withOptions: true });
      // Once the draft is submitted or created it belongs to the GM's side: read it, never write it.
      if ( isEditable(this.draft) ) {
        const next = syncRecipe(this.draft.recipe.steps, this.#build);
        if ( JSON.stringify(next) !== JSON.stringify(this.draft.recipe.steps) ) {
          this.#saveLater(d => d.recipe.steps = foundry.utils.deepClone(next));
        }
      }
      this.#brokeDown = false;
      this.#bonuses = abilityBonuses(this.#build, this.draft.abilities.base);
      const { errors, equipment } = await checkBuilt(this.draft, this.#build, { catalog: this.#catalog,
        standard: this.#standard, userId: game.user.id, allowedMethods: readSettings().abilityMethods });
      this.#validation = { ok: !errors.length, errors, built: this.#build, equipment };
      await this.#equipmentContexts();
    } catch ( err ) {
      console.error(`${MODULE_ID} | rebuild failed`, err);
      this.#validation = null;
      // Say so rather than showing a quietly empty screen: the draft is safe, the character isn't built.
      if ( !this.#brokeDown ) ui.notifications?.error(T("Nav.BrokeDown"));
      this.#brokeDown = true;
    } finally {
      this.#busy = false;
    }
  }

  /**
   * Add the short explanation each row has (a skill's rules page, a spell's own card). Whatever is loaded is
   * handed out now; the rest is fetched in the background and the step renders again when it arrives, so a
   * click never waits for a compendium read.
   * @param {object[]} rows
   * @param {(row) => string|null} source   The document each row is explained by.
   */
  #described(rows, source) {
    const uuids = rows.map(row => source(row));
    if ( !summariesReady(uuids) ) {
      const step = this.#current;
      loadSummaries(uuids)
        .then(() => this.#refreshBody(() => this.#current === step))
        .catch(err => console.warn(`${MODULE_ID} | couldn't read the descriptions`, err));
    }
    return rows.map((row, i) => ({ ...row, hint: summaryCached(uuids[i]) }));
  }

  /**
   * Redraw the step pane for something fetched in the background (a description, the spell summaries), if it
   * still applies. A fetch can finish while the window is still opening — often, when a draft is resumed and the
   * text is already cached — and a redraw asked for then would be lost, leaving "Reading the description…" until
   * the player changed steps; so it waits for the window to open.
   * @param {() => boolean} stillWanted
   */
  #refreshBody(stillWanted) {
    if ( !stillWanted() ) return null;
    if ( this.rendered ) return this.render({ parts: ["body"] });
    this.#refreshWanted = true;
    return null;
  }

  /** Each source's starting-equipment tree, candidates and proficiency, for the equipment step. */
  async #equipmentContexts() {
    const contexts = {};
    for ( const role of EQUIPMENT_SOURCES ) {
      const item = this.#build?.actor?.items?.get(this.#build.roots?.[role]);
      if ( !item ) continue;
      contexts[role] = { name: item.name,
        ...await equipmentContext(this.#build.actor, item, this.#catalog, { standard: this.#standard }) };
    }
    this.#equipment = contexts;
  }

  /** D4: a category the GM narrowed to a single option is chosen for the player. */
  #autoSelect() {
    for ( const [step, category] of Object.entries(STEP_CATEGORY) ) {
      const only = this.#catalog?.byCategory?.[category];
      if ( only?.length !== 1 || this.draft.picks[step] ) continue;
      const uuid = only[0].uuid.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item.");
      this.#saveLater(d => applyPick(d, step, uuid));
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
    const choice = this.#nextChoice();
    return Object.assign(context, {
      moduleId: MODULE_ID,
      busy: this.#busy,
      brokeDown: this.#brokeDown,
      draft,
      step: this.#current,
      stepTitle: T(`Step.${this.#current}.Title`),
      stepHint: T(`Step.${this.#current}.Hint`),
      steps: bannerSteps({ current: this.#current, draft, errorsByStep, labels, visited: this.#visited }),
      errors: errorsByStep[this.#current] ?? [],
      problems: Object.entries(errorsByStep).map(([step, errors]) => ({ step, title: T(`Step.${step}.Title`),
        errors: errors.map(e => ({ ...e, message: game.i18n.localize(e.key) })) })),
      summary: this.#summary(),
      characters: this.#allowance(),
      // The random character (D31): offered on the start screen, and each rolled step is closed to the player.
      hardcore: this.#hardcore(),
      stepPartial: STEP_PARTIALS[this.#current] ?? null,
      splash: splashFor(this.#current, { picks: draft?.picks, catalog: this.#catalog,
        optionArt: readSettings().optionArt, stepArt: readSettings().stepArt }),
      rulesLabel: T(`Rules.${this.draft?.rules ?? "legacy"}`),
      resuming: this.#started(),
      ...(await this.#stepContext()),
      attention: state,
      backLabel: back ? T(`Step.${back}.Title`) : T("Nav.Start"),
      nextLabel: choice ? T("Nav.NextChoice") : (next ? T("Nav.Next", { step: T(`Step.${next}.Title`) }) : T("Nav.Review")),
      canBack: !!back,
      canNext: !!next || !!choice
    });
  }

  /** Whatever the current step's pane needs (PLAN 3.2: the option steps). */
  async #stepContext() {
    // These steps show what still needs doing where it belongs, so the pane-wide list would only repeat it.
    const ownProblems = ["abilities", "choices", "equipment", "spells", "details", "review"].includes(this.#current);
    return Object.assign({ ownProblems }, await this.#stepPane());
  }

  /** The step pane's own context. */
  async #stepPane() {
    if ( this.#current === "equipment" ) return { equipment: this.#equipmentModel() };
    if ( this.#current === "review" ) {
      const equipment = { items: (this.#validation?.equipment?.items ?? []).map(i => ({
        ...i, name: itemName(i.uuid, this.#catalog) })), currency: this.#validation?.equipment?.currency ?? {} };
      const limit = game.user.isGM ? null : readSettings().characterLimit;
      const made = createdFor(game.user.id).length;
      const model = reviewModel({ built: this.#build, validation: this.#validation, draft: this.draft, equipment,
        busy: this.#submitting, another: (limit === null) || (made < limit) });
      // A GM chooses who the character is for, or keeps it (D29).
      const gm = game.user.isGM ? {
        players: givablePlayers().map(u => ({ id: u.id, name: u.name, selected: u.id === this.#assignTo })),
        keep: !this.#assignTo,
        givenTo: this.#givenTo?.name ?? null,
        givenText: this.#givenTo ? T("Review.GivenTo", { name: this.#givenTo.name }) : null,
        canGive: !this.#givenTo && (givablePlayers().length > 0)
      } : null;
      return { gm, review: { ...model,
        skillsText: model.summary?.skills.join(", ") || "—",
        featuresText: model.summary?.features.join(", ") || "—",
        equipmentText: [model.summary?.equipment.map(i => i.count ? `${i.name} ×${i.count}` : i.name).join(", "),
          model.summary?.currency].filter(Boolean).join(" · ") || "—",
        spellsText: model.summary?.spells.join(", ") ?? "" } };
    }
    if ( this.#current === "portrait" ) {
      const settings = readSettings();
      return { portrait: portraitModel(this.draft, { enabled: settings.portraits.enabled,
        maxSourceBytes: settings.portraits.maxSourceBytes, defaults: settings.ringColors,
        userColor: game.user.color?.css ?? null }) };
    }
    if ( this.#current === "details" ) {
      const tables = this.draft.rules === "legacy" ? await this.#personalityTables() : {};
      return { details: detailsModel(this.draft, { rules: this.draft.rules, tables,
        locked: this.#locked("details") ? ROLLED_DETAILS : [] }) };
    }
    if ( this.#current === "spells" ) {
      const context = spellContext(this.#build, this.#catalog);
      const model = spellsModel(context, this.draft, this.#spellTab, this.#catalog);
      this.#spellTab = model.open?.key ?? null;
      const open = model.open ? { ...model.open, list: this.#described(model.open.list.map(s => ({ ...s,
        meta: spellMeta(this.#catalog?.get?.(s.uuid)) })), s => s.uuid) } : null;
      return { spells: { ...model, open, knownText: model.known.join(", "),
        errors: (this.#validation?.errors ?? []).filter(e => e.step === "spells").map(e => e.key) } };
    }
    if ( this.#current === "choices" ) {
      const choices = choicesModel(this.#build, this.#catalog, this.#openChoice);
      this.#openChoice = choices.open?.key ?? null;
      const widget = choices.open?.widget;
      if ( widget?.type === "Trait" ) {
        choices.open = { ...choices.open,
          widget: { ...widget, list: this.#described(widget.list, o => traitReference(o.key)) } };
      }
      return { choices };
    }
    if ( this.#current === "abilities" ) {
      // The increases from species, background and choices don't depend on the scores themselves, so the
      // final numbers can be shown as the player assigns, without replaying the character for every click.
      const base = this.draft?.abilities?.base ?? {};
      const finals = {};
      for ( const [key, bonus] of Object.entries(this.#bonuses) ) {
        if ( !Number.isInteger(base[key]) ) continue;
        const value = base[key] + bonus;
        finals[key] = { value, mod: Math.floor((value - 10) / 2) };
      }
      return { abilities: abilitiesModel(this.draft, { allowedMethods: readSettings().abilityMethods, finals }) };
    }
    const role = STEP_CATEGORY[this.#current];
    if ( !role ) return {};
    const selected = this.draft?.picks?.[role] ?? null;
    const art = readSettings().optionArt;
    const options = optionList(this.#catalog, this.#current, { search: this.#search[this.#current] ?? "",
      selected, art });
    const detail = selected ? await optionDetail(selected, this.#current, { art }) : null;
    if ( detail ) {
      detail.auto = this.#auto.has(role);
      // The description is enriched in the background; render again when it's ready.
      if ( detail.description === null ) {
        optionDescription(selected, this.#current)
          .then(() => this.#refreshBody(() => this.draft?.picks?.[role] === selected))
          .catch(err => console.warn(`${MODULE_ID} | couldn't read the description`, err));
      }
    }
    let subclass = null;
    if ( (this.#current === "class") && detail?.identifier ) {
      const step = subclassStep(this.#build);
      if ( step ) {
        const chosen = step.data?.uuid ?? null;
        subclass = { list: subclassOptions(this.#catalog, detail.identifier, chosen, art), chosen };
      }
    }
    return { options, detail, subclass };
  }

  /** @inheritDoc */
  _onRender(context, options) {
    super._onRender(context, options);
    if ( this.#refreshWanted ) {
      this.#refreshWanted = false;
      // After this render has finished, not inside it.
      setTimeout(() => this.rendered && this.render({ parts: ["body"] }), 0);
    }
    // The arrow keys move along the step banner and the tab strips, as a tablist should.
    arrowKeys(this.element.querySelector(".cc-banner"), ".cc-step");
    for ( const strip of this.element.querySelectorAll('[role="tablist"]') ) arrowKeys(strip, '[role="tab"]');
    // Checkboxes answer on "change": a click inside a <label> would otherwise fire the action twice.
    for ( const box of this.element.querySelectorAll(".cc-toggle") ) {
      box.addEventListener("change", event => this.answer({ action: event.target.dataset.toggle, value: event.target.dataset.key }));
    }
    // A GM's "who is it for" at Review: remembered here, sent nowhere until Create (D29).
    this.element.querySelector(".cc-owner-pick")?.addEventListener("change", event => this.#assignTo = event.target.value);
    const file = this.element.querySelector(".cc-file__input");
    if ( file ) file.addEventListener("change", event => this.choosePortrait(event.target.files?.[0]));
    for ( const color of this.element.querySelectorAll(".cc-color") ) {
      color.addEventListener("change", event =>
        this.setPortrait(d => setRingColor(d, event.target.dataset.ring, event.target.value)));
    }
    for ( const field of this.element.querySelectorAll("[data-detail]") ) {
      if ( field.tagName === "BUTTON" ) continue;
      const set = event => this.setDetail(event.target.dataset.detail, event.target.value,
        { part: event.target.dataset.part ?? null, unit: event.target.dataset.unit ?? null });
      // A list answers as soon as it's chosen; typed fields wait for a pause.
      if ( field.tagName === "SELECT" ) field.addEventListener("change", set);
      else field.addEventListener("input", foundry.utils.debounce(set, 300));
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
    const items = (resolved?.items ?? []).map(i => ({ name: itemName(i.uuid, this.#catalog), count: i.count > 1 ? i.count : null }));
    const currency = Object.entries(resolved?.currency ?? {}).map(([k, v]) => `${v} ${k.toUpperCase()}`).join(", ");
    return { sources, items, currencyText: currency,
      errors: countedErrors(this.#validation?.errors, "equipment") };
  }

  /**
   * Has the player done anything to this draft yet? A pick the wizard made for them (D4: a category the GM
   * narrowed to one option) doesn't count — otherwise a brand-new draft would offer to carry on where they
   * left off.
   */
  #started() {
    const draft = this.draft;
    if ( !draft ) return false;
    const chosen = Object.entries(draft.picks ?? {}).some(([role, uuid]) => uuid && !this.#auto.has(role));
    return chosen || !!draft.abilities?.method || !!String(draft.details?.name ?? "").trim()
      || (draft.portrait?.status && (draft.portrait.status !== "none"));
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
  /**
   * Hardcore mode as this step sees it (D31): whether to offer it, and whether the dice have settled this step.
   * @returns {{ offered: boolean, rolled: boolean, locked: boolean }}
   */
  #hardcore() {
    const { offered, free } = readSettings().hardcore;
    const rolled = this.draft?.mode === "hardcore";
    const part = STEP_PART[this.#current] ?? null;
    return { offered: offered && !rolled && !this.#started(), rolled,
      locked: rolled && !!part && !free.includes(part) };
  }

  /** Has the draft settled this part by dice, so the player doesn't get to change it (D31)? */
  #locked(part) {
    return (this.draft?.mode === "hardcore") && !readSettings().hardcore.free.includes(part);
  }

  /** How many characters this player may make, and how many they have (A4, PLAN 4.4). */
  #allowance() {
    const made = createdFor(game.user.id).length;
    // A GM's characters have no limit (D29).
    const { limit, left, atLimit, unlimited } = allowance({ limit: game.user.isGM ? null : readSettings().characterLimit, made });
    return { limit, made, left, atLimit, unlimited,
      // Only worth saying when there is a limit and the player is near it.
      show: !unlimited && (made > 0) };
  }

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

  /* -------------------------------------------- */
  /*  Fullscreen or a window (D28)                */
  /* -------------------------------------------- */

  /** @inheritDoc */
  _getFrameButtons(options) {
    const button = displayButton(this.displayMode);
    return [{ icon: button.icon, label: button.label, action: "display" }, ...super._getFrameButtons(options)];
  }

  /** @inheritDoc */
  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    this.#mode = this.displayMode;
    // Fullscreen follows the browser window; a remembered window is saved as the player moves or sizes it.
    this.#onViewport = foundry.utils.debounce(() => {
      if ( !this.rendered || this.minimized ) return;
      this.setPosition(this.displayMode === "fullscreen" ? fullscreenPosition(viewport()) : {});
    }, 100);
    window.addEventListener("resize", this.#onViewport);
    // The window's place is saved under the mode the player chose: a window made for a minimize doesn't change it.
    this.#saveWindow = foundry.utils.debounce(position => this.#remember(display().mode, position), 400);
  }

  /** @inheritDoc */
  _updatePosition(position) {
    // Fullscreen can't be dragged or resized: whatever is asked for, it covers the viewport.
    if ( (this.displayMode === "fullscreen") && !this.minimized ) Object.assign(position, fullscreenPosition(viewport()));
    return super._updatePosition(position);
  }

  /** @inheritDoc */
  _onPosition(position) {
    super._onPosition(position);
    if ( (this.displayMode === "window") && this.rendered && !this.minimized && !this.#restoreFullscreen ) {
      this.#saveWindow?.({ ...this.position });
    }
  }

  /**
   * Switch between fullscreen and a window.
   * @param {"fullscreen"|"window"} mode
   * @param {{ remember?: boolean }} [options]   `remember: false` for a switch the player didn't ask for (a minimize).
   */
  async setDisplay(mode, { remember = true } = {}) {
    if ( !DISPLAY_MODES.includes(mode) || (mode === this.displayMode) ) return;
    if ( this.minimized ) await this.maximize();
    const saved = display().window;
    const leaving = this.displayMode === "window" ? { ...this.position } : null;
    this.#mode = mode;
    this.element.classList.toggle("cc-fullscreen", mode === "fullscreen");
    this.setPosition(mode === "fullscreen" ? fullscreenPosition(viewport()) : windowPosition(saved, viewport()));
    const button = displayButton(mode);
    const control = this.element.querySelector('.window-header [data-action="display"]');
    if ( control ) {
      control.className = `header-control ${button.icon} icon`;
      control.setAttribute("aria-label", game.i18n.localize(button.label));
    }
    if ( remember ) await this.#remember(mode, leaving);
  }

  /** Save this player's choice, and the window's place when there is one to keep. */
  async #remember(mode, position = null) {
    const current = display();
    const window = position ? { left: position.left, top: position.top, width: position.width, height: position.height }
      : current.window;
    if ( (current.mode === mode) && (JSON.stringify(current.window) === JSON.stringify(window)) ) return;
    await game.settings.set(MODULE_ID, SETTINGS.DISPLAY, { mode, window })
      .catch(err => console.warn(`${MODULE_ID} | couldn't remember the window`, err));
  }

  /** @inheritDoc */
  async minimize() {
    // A minimized window lives in a corner, so fullscreen steps down to a window first — and comes back after.
    if ( (this.displayMode === "fullscreen") && !this.minimized ) {
      this.#restoreFullscreen = true;
      await this.setDisplay("window", { remember: false });
    }
    return super.minimize();
  }

  /** @inheritDoc */
  async maximize() {
    await super.maximize();
    if ( this.#restoreFullscreen ) {
      this.#restoreFullscreen = false;
      await this.setDisplay("fullscreen", { remember: false });
    }
  }

  /** @inheritDoc */
  async close(options = {}) {
    if ( this.#onViewport ) window.removeEventListener("resize", this.#onViewport);
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

function onCreate() {
  return this.createCharacter();
}

function onAnother() {
  return this.makeAnother();
}

function onOpenSheet() {
  return this.openCharacter();
}

function onFinish() {
  return this.acknowledge({ close: true });
}

function onFix() {
  return this.acknowledge();
}

function onCloseWizard() {
  return this.close();
}

function onStep(event, target) {
  return this.goTo(target.dataset.step);
}

function onBack() {
  const back = moveStep(this.step, -1, this.draft);
  if ( back ) return this.goTo(back);
  return this.step === BANNER_STEPS[0] ? this.goTo("start") : null;
}

/** The errors of one step, each message once, with how many times it came up. */
function countedErrors(errors, step) {
  const counts = new Map();
  for ( const e of (errors ?? []).filter(x => x.step === step) ) counts.set(e.key, (counts.get(e.key) ?? 0) + 1);
  return [...counts].map(([key, count]) => ({ key, count: count > 1 ? count : null }));
}

/**
 * What each ability gains on top of its base score (species, background, ability increases). Taken from the last
 * replay so the ability step can show the final numbers as the player assigns, without replaying every click.
 */
function abilityBonuses(built, base) {
  const out = {};
  for ( const [key, ability] of Object.entries(built?.actor?.system?.abilities ?? {}) ) {
    // makeScratchActor() starts an unassigned score at 10 (rules/scratch.mjs).
    out[key] = ability.value - (Number.isInteger(base?.[key]) ? base[key] : 10);
  }
  return out;
}

function onNext() {
  return this.next();
}

/** The header button: fullscreen ↔ window. */
function onDisplay() {
  return this.setDisplay(this.displayMode === "fullscreen" ? "window" : "fullscreen");
}

/** Review, for a GM: give the character just made to a player. */
function onGive() {
  return this.giveCreated();
}

/** The start screen: let the dice make the whole character (D31). */
function onRollCharacter() {
  return this.rollRandomCharacter();
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
    openRestrictions: async () => (await import("../settings/restrictions-app.mjs")).RestrictionsApp.open(),
    openPending: async () => (await import("../gm/pending-app.mjs")).PendingApp.open(),
    uploadPortrait: async actor => (await import("../portrait/portrait-app.mjs")).PortraitApp.open(actor),
    STATUS });
}
