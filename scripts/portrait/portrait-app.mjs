/**
 * "Upload portrait" for a character that already exists (PLAN 4.3, A5): the same picture pipeline the wizard's
 * portrait step uses — checked and resized in the player's browser (`prepare.mjs`), saved by the GM
 * (`upload.mjs` → `gm/portrait.mjs`). A GM has to be online; this one doesn't wait in the offline queue.
 */

import { MODULE_ID } from "../contracts.mjs";
import { readSettings } from "../settings/settings.mjs";
import { preparePortrait } from "./prepare.mjs";
import { uploadPortrait } from "./upload.mjs";
import { dialogState, dialogModel, setDialogImage, setDialogRing } from "./portrait-model.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const T = key => game.i18n.localize(`CHARCREATOR.${key}`);

export class PortraitApp extends HandlebarsApplicationMixin(ApplicationV2) {
  #actor;
  #state;

  constructor(actor, options = {}) {
    super({ ...options, id: `character-creator-portrait-${actor.id}` });
    this.#actor = actor;
    this.#state = dialogState(actor.prototypeToken?.ring ?? {});
  }

  static DEFAULT_OPTIONS = {
    classes: ["character-creator", "cc-portrait-dialog"],
    tag: "div",
    window: { title: "CHARCREATOR.Portrait.UploadTitle", icon: "fa-solid fa-image", resizable: false },
    position: { width: 460, height: "auto" },
    actions: { clear: onClear, save: onSave, cancel: onCancel, "ring-reset": onRingReset }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/portrait-dialog.hbs` }
  };

  /** The actor this is for. */
  get actor() {
    return this.#actor;
  }

  /** The dialog's state (for tests). */
  get state() {
    return this.#state;
  }

  /** Open it for one character. Anyone who owns the character may; the GM's browser does the saving (D13). */
  static async open(actor) {
    if ( !actor?.isOwner ) {
      ui.notifications?.warn(T("Error.NOT_OWNER"));
      return null;
    }
    const existing = foundry.applications.instances.get(`character-creator-portrait-${actor.id}`);
    if ( existing?.rendered ) {
      existing.bringToFront();
      return existing;
    }
    const app = new PortraitApp(actor);
    await app.render({ force: true });
    return app;
  }

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const settings = readSettings();
    return Object.assign(context, {
      moduleId: MODULE_ID,
      ...dialogModel(this.#state, {
        name: this.#actor.name,
        current: this.#actor.img,
        isOwner: this.#actor.isOwner,
        uploads: settings.portraits.enabled,
        gmOnline: !!game.users.activeGM,
        defaults: settings.ringColors,
        userColor: game.user.color?.css ?? null,
        maxSourceBytes: settings.portraits.maxSourceBytes
      })
    });
  }

  /** @inheritDoc */
  _onRender(context, options) {
    super._onRender(context, options);
    const file = this.element.querySelector(".cc-file__input");
    if ( file ) file.addEventListener("change", event => this.choose(event.target.files?.[0]));
    for ( const color of this.element.querySelectorAll(".cc-color") ) {
      color.addEventListener("change", event => this.setRing(event.target.dataset.ring, event.target.value));
    }
  }

  /** Check and resize the chosen file, here in the player's browser. */
  async choose(file) {
    if ( !file ) return;
    try {
      const image = await preparePortrait(file);
      setDialogImage(this.#state, image);
    } catch ( err ) {
      const key = err?.error?.key ?? "CHARCREATOR.Error.BAD_IMAGE";
      console.warn(`${MODULE_ID} | the portrait couldn't be used`, err);
      this.#state.error = game.i18n.localize(key);
    }
    await this.render({ parts: ["body"] });
  }

  /** Put the picture back. */
  async clear() {
    setDialogImage(this.#state, null);
    await this.render({ parts: ["body"] });
  }

  /** One of the ring colours. */
  async setRing(key, value) {
    setDialogRing(this.#state, key, value);
    await this.render({ parts: ["body"] });
  }

  /** Send it to the GM, who saves it on the character (D13, D22). */
  async save() {
    if ( !this.#state.image || this.#state.saving ) return null;
    this.#state.saving = true;
    this.#state.error = null;
    await this.render({ parts: ["body"] });
    try {
      const res = await uploadPortrait(this.#actor.uuid, this.#state.image, this.#state.ring);
      if ( res?.ok ) {
        ui.notifications?.info(T("Portrait.Uploaded"));
        await this.close();
        return res;
      }
      const first = res?.errors?.[0];
      this.#state.error = game.i18n.localize(first?.key ?? "CHARCREATOR.Error.UPLOAD_FAILED");
    } catch ( err ) {
      const key = err?.error?.key ?? "CHARCREATOR.Error.UPLOAD_FAILED";
      console.warn(`${MODULE_ID} | the portrait couldn't be saved`, err);
      this.#state.error = game.i18n.localize(key);
    }
    this.#state.saving = false;
    await this.render({ parts: ["body"] });
    return null;
  }
}

/* -------------------------------------------- */

function onClear() {
  return this.clear();
}

function onSave() {
  return this.save();
}

function onCancel() {
  return this.close();
}

function onRingReset(event, target) {
  return this.setRing(target.dataset.ring, "");
}
