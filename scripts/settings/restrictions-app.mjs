/**
 * The GM's "allowed content" screen (PLAN 4.1): which species, backgrounds, classes, subclasses, feats, spells
 * and equipment players may use, which packs those come from, and how ability scores may be set.
 *
 * The lists are built from the catalog itself, with restrictions turned off, so the GM picks from exactly what
 * this world could offer. Saving writes the `restrictions` and `abilityMethods` settings that the catalog and
 * the validator already read (PLAN 2.10) — nothing downstream changes.
 */

import { MODULE_ID } from "../contracts.mjs";
import { CATEGORIES, NO_RESTRICTIONS } from "../catalog/filters.mjs";
import { getCatalog, itemPacks } from "../catalog/catalog.mjs";
import { SETTINGS, readSettings } from "./settings.mjs";
import { arrowKeys } from "../ui/keyboard.mjs";
import { editorState, restrictionsModel, toStored, toStoredArt, toggleEntry, allowAll, allowNone, allowThese,
  disallowThese, togglePack, toggleMethod, setArt, setStepArt, toStoredStepArt, toggleHardcore, toggleRandomPart,
  toStoredHardcore, TABS } from "./restrictions-model.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const T = (key, data) => (data ? game.i18n.format(`CHARCREATOR.${key}`, data) : game.i18n.localize(`CHARCREATOR.${key}`));

export class RestrictionsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** The open screen, if any. */
  static #instance = null;

  #state = null;
  #everything = {};
  #packs = [];
  #tab = TABS[0];
  #search = "";
  /** The compendium the open category is narrowed to ("" = all of them), and the duplicates-only filter. */
  #pack = "";
  #onlyDuplicates = false;
  #saving = false;

  static DEFAULT_OPTIONS = {
    id: "character-creator-restrictions",
    classes: ["character-creator", "cc-restrictions"],
    tag: "div",
    window: { title: "CHARCREATOR.Restrictions.Title", icon: "fa-solid fa-list-check", resizable: true },
    position: { width: 900, height: 700 },
    actions: {
      // Not "tab": ApplicationV2 keeps that action for its own tab groups and never passes it on (RESEARCH.md).
      "show-tab": onTab,
      entry: onEntry,
      "allow-all": onAllowAll,
      "allow-none": onAllowNone,
      "allow-these": onAllowThese,
      "disallow-these": onDisallowThese,
      duplicates: onDuplicates,
      hardcore: onHardcore,
      "random-part": onRandomPart,
      pack: onPack,
      art: onArt,
      "art-clear": onArtClear,
      "step-art": onStepArt,
      "step-art-clear": onStepArtClear,
      method: onMethod,
      save: onSave,
      cancel: onCancel
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/restrictions.hbs`, scrollable: ["", ".cc-list"] }
  };

  /** Open it (GMs only), reading the catalog with restrictions off. */
  static async open() {
    if ( !game.user.isGM ) {
      ui.notifications?.warn(T("Restrictions.GMOnly"));
      return null;
    }
    if ( RestrictionsApp.#instance?.rendered ) {
      RestrictionsApp.#instance.bringToFront();
      return RestrictionsApp.#instance;
    }
    const app = new RestrictionsApp();
    await app.#load();
    RestrictionsApp.#instance = app;
    await app.render({ force: true });
    return app;
  }

  /** The state being edited (for tests). */
  get state() {
    return this.#state;
  }

  /** Everything this world could offer, by category (for tests). */
  get everything() {
    return this.#everything;
  }

  async #load() {
    const settings = readSettings();
    this.#state = editorState(settings.restrictions, settings.abilityMethods, settings.optionArt, settings.stepArt,
      settings.hardcore);
    // With no restrictions: the full list to choose from, including what the GM has switched off.
    const catalog = await getCatalog({ restrictions: NO_RESTRICTIONS });
    this.#everything = Object.fromEntries(CATEGORIES.map(c => [c, catalog.byCategory[c] ?? []]));
    this.#packs = itemPacks();
  }

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const model = restrictionsModel({ state: this.#state, everything: this.#everything, packs: this.#packs,
      tab: this.#tab, search: this.#search, pack: this.#pack, onlyDuplicates: this.#onlyDuplicates });
    return Object.assign(context, {
      moduleId: MODULE_ID,
      saving: this.#saving,
      ...model,
      tabs: model.tabs.map(t => ({ ...t, label: T(`Restrictions.Tab.${t.key}`) })),
      category: model.category ? { ...model.category, entries: model.category.entries.map(e => ({ ...e,
        artTooltip: T(e.art ? "Restrictions.ArtChange" : "Restrictions.ArtSet"),
        alsoInText: e.duplicate ? T("Restrictions.AlsoIn", { packs: e.alsoIn.join(", ") }) : "" })) } : null,
      duplicateWarning: model.category?.duplicates
        ? T("Restrictions.Duplicates", { count: model.category.duplicates }) : "",
      warnings: model.warnings.map(w => ({ ...w, message: T(`Restrictions.Warning.${w.key}`,
        { category: T(`Restrictions.Tab.${w.category}`) }) })),
      methods: (model.abilities ?? []).map(m => ({ ...m, label: T(`Abilities.${m.key}`) })),
      backdrops: model.backdrops ? model.backdrops.map(b => ({ ...b, label: T(b.labelKey) })) : null,
      hardcore: model.hardcore
        ? { ...model.hardcore, parts: model.hardcore.parts.map(p => ({ ...p, label: T(`Random.${p.part}`) })) } : null
    });
  }

  /** @inheritDoc */
  _onRender(context, options) {
    super._onRender(context, options);
    arrowKeys(this.element.querySelector(".cc-restrict__tabs"), '[role="tab"]');
    this.element.querySelector(".cc-pack-filter")?.addEventListener("change", event => {
      this.#pack = event.target.value;
      this.render({ parts: ["body"] });
    });
    const search = this.element.querySelector(".cc-search input");
    if ( search ) {
      search.addEventListener("input", foundry.utils.debounce(event => {
        this.#search = event.target.value;
        this.render({ parts: ["body"] });
      }, 200));
    }
  }

  /** Show a tab; the filters start clear on each one. */
  async show(tab) {
    if ( !TABS.includes(tab) ) return;
    this.#tab = tab;
    this.#search = "";
    this.#pack = "";
    this.#onlyDuplicates = false;
    await this.render({ parts: ["body"] });
  }

  /** Show only the options that appear in more than one compendium, or all of them again. */
  async toggleDuplicates() {
    this.#onlyDuplicates = !this.#onlyDuplicates;
    await this.render({ parts: ["body"] });
    return this.#onlyDuplicates;
  }

  /** Change the state and redraw. */
  async change(mutate) {
    mutate(this.#state);
    await this.render({ parts: ["body"] });
  }

  /** The UUIDs currently listed (what a search narrowed to). */
  shownUuids() {
    return [...this.element.querySelectorAll("[data-action='entry']")].map(el => el.dataset.uuid);
  }

  /**
   * Ask for a picture for one option (D24). Foundry's own file browser, so the GM picks from what this
   * world already holds; nothing is uploaded or fetched from elsewhere.
   */
  async pickArt(uuid, current = null) {
    return this.#pickImage(current, (state, path) => setArt(state, uuid, path));
  }

  /** Ask for a background for one step of the creator (D28), the same way. */
  async pickStepArt(step, current = null) {
    return this.#pickImage(current, (state, path) => setStepArt(state, step, path));
  }

  async #pickImage(current, apply) {
    const FilePicker = foundry.applications.apps.FilePicker.implementation;
    return new Promise(resolve => {
      new FilePicker({
        type: "image",
        current: current ?? undefined,
        callback: async path => {
          await this.change(state => apply(state, path));
          resolve(path);
        }
      }).render({ force: true });
    });
  }

  /** Write the settings. The catalog invalidates itself on the change, so open wizards follow. */
  async save() {
    if ( this.#saving ) return;
    this.#saving = true;
    await this.render({ parts: ["body"] });
    try {
      await game.settings.set(MODULE_ID, SETTINGS.RESTRICTIONS, toStored(this.#state));
      await game.settings.set(MODULE_ID, SETTINGS.ABILITY_METHODS, [...this.#state.abilityMethods]);
      await game.settings.set(MODULE_ID, SETTINGS.OPTION_ART, toStoredArt(this.#state));
      await game.settings.set(MODULE_ID, SETTINGS.STEP_ART, toStoredStepArt(this.#state));
      await game.settings.set(MODULE_ID, SETTINGS.HARDCORE, toStoredHardcore(this.#state));
      ui.notifications?.info(T("Restrictions.Saved"));
      await this.close();
    } catch ( err ) {
      console.error(`${MODULE_ID} | the restrictions couldn't be saved`, err);
      ui.notifications?.error(T("Error.BAD_REQUEST"));
      this.#saving = false;
      await this.render({ parts: ["body"] });
    }
  }

  /** @inheritDoc */
  _onClose(options) {
    super._onClose(options);
    if ( RestrictionsApp.#instance === this ) RestrictionsApp.#instance = null;
  }
}

/* -------------------------------------------- */
/*  Actions                                     */
/* -------------------------------------------- */

function onTab(event, target) {
  return this.show(target.dataset.tab);
}

function onEntry(event, target) {
  const { category, uuid } = target.dataset;
  const everything = (this.everything[category] ?? []).map(e => e.uuid);
  return this.change(state => toggleEntry(state, category, uuid, everything));
}

function onAllowAll(event, target) {
  return this.change(state => allowAll(state, target.dataset.category));
}

function onAllowNone(event, target) {
  return this.change(state => allowNone(state, target.dataset.category));
}

/** Allow (or disallow) everything the filters leave on screen — a whole compendium, say. */
function onAllowThese(event, target) {
  const shown = this.shownUuids();
  const category = target.dataset.category;
  const all = (this.everything[category] ?? []).map(e => e.uuid);
  return this.change(state => allowThese(state, category, shown, all));
}

function onDisallowThese(event, target) {
  const shown = this.shownUuids();
  const category = target.dataset.category;
  const all = (this.everything[category] ?? []).map(e => e.uuid);
  return this.change(state => disallowThese(state, category, shown, all));
}

/** Show only the options that appear in more than one compendium. */
function onDuplicates() {
  return this.toggleDuplicates();
}

/** Hardcore mode (D31): offer it at all, and which parts the player still chooses. */
function onHardcore() {
  return this.change(state => toggleHardcore(state));
}

function onRandomPart(event, target) {
  return this.change(state => toggleRandomPart(state, target.dataset.part));
}

function onStepArt(event, target) {
  return this.pickStepArt(target.dataset.step, target.dataset.art || null);
}

function onStepArtClear(event, target) {
  return this.change(state => setStepArt(state, target.dataset.step, null));
}

function onArt(event, target) {
  return this.pickArt(target.dataset.uuid, target.dataset.art || null);
}

function onArtClear(event, target) {
  return this.change(state => setArt(state, target.dataset.uuid, null));
}

function onPack(event, target) {
  const all = [...this.element.querySelectorAll("[data-action='pack']")].map(el => el.dataset.pack);
  return this.change(state => togglePack(state, target.dataset.pack, all));
}

function onMethod(event, target) {
  return this.change(state => toggleMethod(state, target.dataset.method));
}

function onSave() {
  return this.save();
}

function onCancel() {
  return this.close();
}

/** Put the screen in Foundry's own settings window, and on the module's API. */
export function registerRestrictionsApp() {
  game.settings.registerMenu(MODULE_ID, "restrictionsMenu", {
    name: "CHARCREATOR.Restrictions.MenuName",
    label: "CHARCREATOR.Restrictions.MenuLabel",
    hint: "CHARCREATOR.Restrictions.MenuHint",
    icon: "fa-solid fa-list-check",
    type: RestrictionsMenu,
    restricted: true
  });
}

/** Foundry opens a menu by constructing its `type` and calling `render`. */
class RestrictionsMenu extends foundry.applications.api.ApplicationV2 {
  render() {
    // Foundry's settings window doesn't wait on this: a failure would otherwise show nowhere but the console.
    return RestrictionsApp.open().catch(err => {
      console.error(`${MODULE_ID} | the allowed content screen couldn't open`, err);
      ui.notifications?.error(T("Restrictions.OpenFailed"));
      return null;
    });
  }
}
