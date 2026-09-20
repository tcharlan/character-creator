/**
 * The wizard shell (PLAN 3.1, D16/D25): a full-window ApplicationV2 with the step banner, the step pane and the
 * footer. It owns the draft (draft/store.mjs), rebuilds the character from the recipe on every change (D18) and
 * runs the validator to show what still needs attention. The step panes themselves arrive in PLAN 3.2–3.9; until
 * then each step shows what the engine already knows about it.
 */

import { MODULE_ID, STATUS } from "../contracts.mjs";
import { DraftStore } from "../draft/store.mjs";
import { getCatalog } from "../catalog/catalog.mjs";
import { validateDraft } from "../rules/validate.mjs";
import { readSettings } from "../settings/settings.mjs";
import { bannerSteps, canOpen, moveStep, groupErrors, attention, BANNER_STEPS } from "./steps-model.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const T = (key, data) => (data ? game.i18n.format(`CHARCREATOR.${key}`, data) : game.i18n.localize(`CHARCREATOR.${key}`));

/** How long to wait after a change before rebuilding and revalidating. */
const REBUILD_DELAY = 200;

export class CharacterWizard extends HandlebarsApplicationMixin(ApplicationV2) {
  /** The open wizard, if any (one per client). */
  static #instance = null;

  #store = new DraftStore();
  #catalog = null;
  #current = BANNER_STEPS[0];
  #visited = [];
  #validation = null;
  #busy = false;
  #timer = null;

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
      discard: onDiscard
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
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Change the draft and rebuild. Step panes call this.
   * @param {(draft: object) => void} change
   */
  async update(change) {
    await this.#store.update(d => {
      change(d);
      d.step = this.#current;
    });
    this.#schedule();
  }

  /** Go to a step (if its picks are in place). */
  async goTo(step) {
    if ( !canOpen(step, this.draft) ) return;
    if ( !this.#visited.includes(this.#current) ) this.#visited.push(this.#current);
    this.#current = step;
    if ( this.draft ) await this.update(() => null);
    else this.render({ parts: ["banner", "body", "footer"] });
  }

  /**
   * Rebuild and re-render now, instead of waiting for the pause. Returns when the pane matches the draft.
   * (The tests use it; so does anything that must show the result at once.)
   */
  async settle() {
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
      this.#validation = await validateDraft(this.draft, { catalog: this.#catalog, userId: game.user.id,
        allowedMethods: readSettings().abilityMethods });
    } catch ( err ) {
      console.error(`${MODULE_ID} | rebuild failed`, err);
      this.#validation = null;
    } finally {
      this.#busy = false;
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
      attention: state,
      backLabel: back ? T(`Step.${back}.Title`) : T("Nav.Start"),
      nextLabel: next ? T("Nav.Next", { step: T(`Step.${next}.Title`) }) : T("Nav.Review"),
      canBack: !!back,
      canNext: !!next
    });
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
    const built = v?.built;
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

function onStep(event, target) {
  return this.goTo(target.dataset.step);
}

function onBack() {
  const back = moveStep(this.step, -1, this.draft);
  return back ? this.goTo(back) : null;
}

function onNext() {
  const next = moveStep(this.step, 1, this.draft);
  return next ? this.goTo(next) : null;
}

async function onDiscard() {
  const yes = await confirmDialog(T("Discard.Title"), T("Discard.editable"), T("Discard.Confirm"));
  if ( yes ) await this.discardAndClose();
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

/** The module's public entry point (used by the sidebar button and the tests; PLAN 3.10 adds the UI entries). */
export function registerWizardApi() {
  const module = game.modules.get(MODULE_ID);
  if ( module ) module.api = Object.assign(module.api ?? {}, { CharacterWizard, openWizard: () => CharacterWizard.open(),
    STATUS });
}
