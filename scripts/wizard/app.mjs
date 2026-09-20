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
import { applyPick, answerStep } from "./picks.mjs";
import { optionList, optionDetail, optionDescription, subclassOptions, subclassStep, STEP_CATEGORY } from "./options-step.mjs";
import { abilitiesModel, setMethod, spendPoint, assignValue } from "./abilities-step.mjs";
import { rollAbilityScores } from "../rules/ability-roll.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** Templates for the step panes (PLAN 3.2–3.9 fill these in; the rest fall back to the placeholder). */
const STEP_PARTIALS = {
  start: `modules/${MODULE_ID}/templates/steps/start.hbs`,
  species: `modules/${MODULE_ID}/templates/steps/options.hbs`,
  class: `modules/${MODULE_ID}/templates/steps/options.hbs`,
  background: `modules/${MODULE_ID}/templates/steps/options.hbs`,
  abilities: `modules/${MODULE_ID}/templates/steps/abilities.hbs`
};
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
      roll: onRoll
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
      const next = this.#build.recipe.steps;
      if ( JSON.stringify(next) !== JSON.stringify(this.draft.recipe.steps) ) {
        await this.#store.update(d => d.recipe.steps = foundry.utils.deepClone(next));
      }
      const { errors, equipment } = await checkBuilt(this.draft, this.#build, { catalog: this.#catalog,
        userId: game.user.id, allowedMethods: readSettings().abilityMethods });
      this.#validation = { ok: !errors.length, errors, built: this.#build, equipment };
    } catch ( err ) {
      console.error(`${MODULE_ID} | rebuild failed`, err);
      this.#validation = null;
    } finally {
      this.#busy = false;
    }
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
  return foundry.applications.handlebars.loadTemplates([...new Set(Object.values(STEP_PARTIALS))]);
}

/** The module's public entry point (used by the sidebar button and the tests; PLAN 3.10 adds the UI entries). */
export function registerWizardApi() {
  const module = game.modules.get(MODULE_ID);
  if ( module ) module.api = Object.assign(module.api ?? {}, { CharacterWizard, openWizard: () => CharacterWizard.open(),
    STATUS });
}
