/**
 * The GM's pending-characters panel (PLAN 4.2): builds waiting for a GM (D17) and builds the validator refused,
 * with the reasons. Creating one here runs exactly the path a live submit runs (gm/submit.mjs), so nothing is
 * special-cased; the panel only decides *when*.
 */

import { MODULE_ID, DRAFT_FLAG } from "../contracts.mjs";
import { getCatalog } from "../catalog/catalog.mjs";
import { processPending, processFor, retryFor } from "./pending.mjs";
import { queueRows, pendingModel } from "./pending-model.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const T = (key, data) => (data ? game.i18n.format(`CHARCREATOR.${key}`, data) : game.i18n.localize(`CHARCREATOR.${key}`));

/** The players' drafts as the model wants them. */
export function draftUsers() {
  return game.users.map(u => ({ id: u.id, name: u.name, isGM: u.isGM,
    draft: u.getFlag(MODULE_ID, DRAFT_FLAG) ?? null }));
}

/** The rows a GM has outstanding right now (also used for the sidebar count). */
export function currentQueue(catalog = null) {
  return queueRows(draftUsers(), { names: uuid => (uuid ? catalog?.get?.(uuid)?.name ?? null : null) });
}

export class PendingApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static #instance = null;

  #catalog = null;
  #busy = null;
  #hooks = [];

  static DEFAULT_OPTIONS = {
    id: "character-creator-pending",
    classes: ["character-creator", "cc-pending"],
    tag: "div",
    window: { title: "CHARCREATOR.Pending.Title", icon: "fa-solid fa-hourglass-half", resizable: true },
    position: { width: 720, height: 560 },
    actions: { create: onCreate, retry: onRetry, all: onAll }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/pending.hbs`, scrollable: ["", ".cc-queue"] }
  };

  /** Open the panel (GMs only). */
  static async open() {
    if ( !game.user.isGM ) {
      ui.notifications?.warn(T("Pending.GMOnly"));
      return null;
    }
    if ( PendingApp.#instance?.rendered ) {
      PendingApp.#instance.bringToFront();
      return PendingApp.#instance;
    }
    const app = new PendingApp();
    PendingApp.#instance = app;
    // The names of the picks come from the catalog, so it is read before the first draw rather than during it.
    await app.loadCatalog();
    await app.render({ force: true });
    return app;
  }

  /** The rows on screen (for tests). */
  get rows() {
    return currentQueue(this.#catalog);
  }

  /** Read the catalog once, for the names of each draft's picks. */
  async loadCatalog() {
    if ( !this.#catalog ) this.#catalog = await getCatalog().catch(() => null);
    return this.#catalog;
  }

  /** @inheritDoc */
  async _preFirstRender(context, options) {
    await super._preFirstRender(context, options);
    await this.loadCatalog();
  }

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const model = pendingModel(currentQueue(this.#catalog), { busy: this.#busy });
    return Object.assign(context, {
      moduleId: MODULE_ID,
      ...model,
      rows: model.rows.map(row => ({ ...row,
        errors: row.errors.map(e => ({ ...e, message: game.i18n.localize(e.key),
          stepLabel: e.step ? T(`Step.${e.step}.Title`) : null })) }))
    });
  }

  /** @inheritDoc */
  _onRender(context, options) {
    super._onRender(context, options);
    if ( this.#hooks.length ) return;
    // A draft changing anywhere is what this panel is about; follow it.
    const redraw = () => (this.rendered ? this.render({ parts: ["body"] }) : null);
    this.#hooks.push(["updateUser", Hooks.on("updateUser", redraw)]);
    this.#hooks.push(["createActor", Hooks.on("createActor", redraw)]);
  }

  /** @inheritDoc */
  _onClose(options) {
    super._onClose(options);
    for ( const [hook, id] of this.#hooks ) Hooks.off(hook, id);
    this.#hooks = [];
    if ( PendingApp.#instance === this ) PendingApp.#instance = null;
  }

  /** Create one player's waiting build now. */
  async createFor(userId) {
    const user = game.users.get(userId);
    if ( !user || this.#busy ) return null;
    this.#busy = userId;
    await this.render({ parts: ["body"] });
    let status = null;
    try {
      status = await processFor(user);
    } catch ( err ) {
      console.error(`${MODULE_ID} | the build for ${user.name} couldn't be created`, err);
      ui.notifications?.error(T("Error.BAD_REQUEST"));
    } finally {
      this.#busy = null;
    }
    await this.render({ parts: ["body"] });
    return status;
  }

  /** Put a refused build back in the queue and let the processor try it again. */
  async retry(userId) {
    const user = game.users.get(userId);
    if ( !user || this.#busy ) return null;
    this.#busy = userId;
    await this.render({ parts: ["body"] });
    try {
      await retryFor(user);
    } catch ( err ) {
      console.error(`${MODULE_ID} | the build for ${user.name} couldn't be tried again`, err);
      ui.notifications?.error(T("Error.BAD_REQUEST"));
    } finally {
      this.#busy = null;
    }
    await this.render({ parts: ["body"] });
    return null;
  }

  /** Work through everything waiting. */
  async createAll() {
    if ( this.#busy ) return null;
    this.#busy = "all";
    await this.render({ parts: ["body"] });
    try {
      return await processPending();
    } finally {
      this.#busy = null;
      await this.render({ parts: ["body"] });
    }
  }
}

/* -------------------------------------------- */

function onCreate(event, target) {
  return this.createFor(target.dataset.user);
}

function onRetry(event, target) {
  return this.retry(target.dataset.user);
}

function onAll() {
  return this.createAll();
}

/** Put the panel in Foundry's settings window, and on the module's API. */
export function registerPendingApp() {
  game.settings.registerMenu(MODULE_ID, "pendingMenu", {
    name: "CHARCREATOR.Pending.MenuName",
    label: "CHARCREATOR.Pending.MenuLabel",
    hint: "CHARCREATOR.Pending.MenuHint",
    icon: "fa-solid fa-hourglass-half",
    type: PendingMenu,
    restricted: true
  });
}

/** Foundry opens a menu by constructing its `type` and calling `render`. */
class PendingMenu extends foundry.applications.api.ApplicationV2 {
  render() {
    return PendingApp.open();
  }
}
