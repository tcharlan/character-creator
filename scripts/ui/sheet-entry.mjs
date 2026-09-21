/**
 * Ways into "Upload portrait" for a character that already exists (PLAN 4.3, A5): a control in the character
 * sheet's header menu, and an entry in the Actors sidebar's context menu. Both open the same dialog, and both
 * only appear for a character this player owns.
 */

import { MODULE_ID } from "../contracts.mjs";
import { readSettings } from "../settings/settings.mjs";
import { PortraitApp } from "../portrait/portrait-app.mjs";
import { canGive, giveDialog } from "../gm/assign.mjs";

const T = key => game.i18n.localize(`CHARCREATOR.${key}`);

/** Can this user put a picture on this character? (A GM offline is said in the dialog, not hidden here.) */
export function canUploadFor(actor) {
  return !!actor && (actor.type === "character") && actor.isOwner && readSettings().portraits.enabled;
}

/**
 * Register both entry points. Foundry names a header-control hook after each class in the sheet's chain
 * (`getHeaderControls<ClassName>`), so `ActorSheetV2` catches every actor sheet, whatever the system's own
 * class is called (RESEARCH.md → Header controls and context menus).
 */
export function registerSheetEntry() {
  Hooks.on("getHeaderControlsActorSheetV2", (app, controls) => {
    const actor = app.document;
    if ( !actor || (actor.type !== "character") ) return;
    controls.push({
      icon: "fa-solid fa-image",
      label: "CHARCREATOR.Portrait.UploadTitle",
      action: `${MODULE_ID}-portrait`,
      visible: () => canUploadFor(actor),
      onClick: () => PortraitApp.open(actor)
    });
  });

  Hooks.on("getActorContextOptions", (directory, options) => {
    options.push({
      name: T("Portrait.UploadTitle"),
      label: T("Portrait.UploadTitle"),
      icon: '<i class="fa-solid fa-image"></i>',
      condition: li => canUploadFor(actorFrom(directory, li)),
      visible: li => canUploadFor(actorFrom(directory, li)),
      callback: li => PortraitApp.open(actorFrom(directory, li)),
      onClick: li => PortraitApp.open(actorFrom(directory, li))
    });
    // A GM's characters are theirs until they give them to a player (D29).
    options.push({
      name: T("Assign.Menu"),
      label: T("Assign.Menu"),
      icon: '<i class="fa-solid fa-user-plus"></i>',
      condition: li => canGive(actorFrom(directory, li)),
      visible: li => canGive(actorFrom(directory, li)),
      callback: li => giveDialog(actorFrom(directory, li)),
      onClick: li => giveDialog(actorFrom(directory, li))
    });
  });
}

/** The actor a context-menu entry was opened on. */
function actorFrom(directory, li) {
  const id = li?.dataset?.entryId ?? li?.closest?.("[data-entry-id]")?.dataset?.entryId;
  return id ? directory.collection.get(id) : null;
}
