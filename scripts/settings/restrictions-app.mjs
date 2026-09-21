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
import { editorState, restrictionsModel, toStored, toStoredArt, toggleEntry, allowAll, allowNone, allowOnly,
  togglePack, toggleMethod, setArt, TABS } from "./restrictions-model.mjs";

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
  #saving = false;

  static DEFAULT_OPTIONS = {
    id: "character-creator-restrictions",
    classes: ["character-creator", "cc-restrictions"],
    tag: "div",
    window: { title: "CHARCREATOR.Restrictions.Title", icon: "fa-solid fa-list-check", resizable: true },
    position: { width: 900, height: 700 },
    actions: {
      tab: onTab,
      entry: onEntry,
      "allow-all": onAllowAll,
      "allow-none": onAllowNone,
      "allow-shown": onAllowShown,
      pack: onPack,
      art: onArt,
      "art-clear": onArtClear,
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
    this.#state = editorState(settings.restrictions, settings.abilityMethods, settings.optionArt);
    // With no restrictions: the full list to choose from, including what the GM has switched off.
    const catalog = await getCatalog({ restrictions: NO_RESTRICTIONS });
    this.#everything = Object.fromEntries(CATEGORIES.map(c => [c, catalog.byCategory[c] ?? []]));
    this.#packs = itemPacks();
  }

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const model = restrictionsModel({ state: this.#state, everything: this.#everything, packs: this.#packs,
      tab: this.#tab, search: this.#search });
    return Object.assign(context, {
      moduleId: MODULE_ID,
      saving: this.#saving,
      ...model,
      tabs: model.tabs.map(t => ({ ...t, label: T(`Restrictions.Tab.${t.key}`) })),
      category: model.category ? { ...model.category, entries: model.category.entries.map(e => ({ ...e,
        artTooltip: T(e.art ? "Restrictions.ArtChange" : "Restrictions.ArtSet") })) } : null,
      warnings: model.warnings.map(w => ({ ...w, message: T(`Restrictions.Warning.${w.key}`,
        { category: T(`Restrictions.Tab.${w.category}`) }) })),
      methods: (model.abilities ?? []).map(m => ({ ...m, label: T(`Abilities.${m.key}`) }))
    });
  }

  /** @inheritDoc */
  _onRender(context, options) {
    super._onRender(context, options);
    arrowKeys(this.element.querySelector(".cc-restrict__tabs"), '[role="tab"]');
    const search = this.element.querySelector(".cc-search input");
    if ( search ) {
      search.addEventListener("input", foundry.utils.debounce(event => {
        this.#search = event.target.value;
        this.render({ parts: ["body"] });
      }, 200));
    }
  }

  /** Show a tab; the search box starts empty on each one. */
  async show(tab) {
    if ( !TABS.includes(tab) ) return;
    this.#tab = tab;
    this.#search = "";
    await this.render({ parts: ["body"] });
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
    const FilePicker = foundry.applications.apps.FilePicker.implementation;
    return new Promise(resolve => {
      new FilePicker({
        type: "image",
        current: current ?? undefined,
        callback: async path => {
          await this.change(state => setArt(state, uuid, path));
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

function onAllowShown(event, target) {
  const shown = this.shownUuids();
  return this.change(state => allowOnly(state, target.dataset.category, shown));
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
    return RestrictionsApp.open();
  }
}
