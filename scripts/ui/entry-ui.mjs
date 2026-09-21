/**
 * The entry points (PLAN 3.10): a button in the Actors sidebar and a prompt once a session, both saying what
 * `entry.mjs` decided. Everything here only reads — opening the wizard is the only thing a click does.
 */

import { MODULE_ID, DRAFT_FLAG } from "../contracts.mjs";
import { draftState } from "../draft/state.mjs";
import { createdFor } from "../gm/create.mjs";
import { readSettings } from "../settings/settings.mjs";
import { CharacterWizard } from "../wizard/app.mjs";
import { PendingApp, currentQueue } from "../gm/pending-app.mjs";
import { entryState, loginPrompt } from "./entry.mjs";
import { registerSheetEntry } from "./sheet-entry.mjs";

const T = key => game.i18n.localize(key);

/** What this user's entry points should offer right now. */
export function currentEntry() {
  const world = { worldId: game.world.id, rules: game.settings.get("dnd5e", "rulesVersion") };
  const { state } = draftState(game.user.getFlag(MODULE_ID, DRAFT_FLAG), world);
  const waiting = game.user.isGM ? currentQueue().length : 0;
  return entryState({ state, created: createdFor(game.user.id).length, limit: readSettings().characterLimit,
    isGM: game.user.isGM, waiting });
}

/** Put the button in (or take it out of) one rendered Actors directory. */
export function renderEntryButton(root) {
  const actions = root?.querySelector(".directory-header .header-actions");
  if ( !actions ) return null;
  for ( const old of actions.querySelectorAll(".cc-entry") ) old.remove();
  const entry = currentEntry();
  if ( !entry.visible ) return null;
  const make = ({ kind, label, tooltip, icon, count }, onClick) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `cc-entry cc-entry--${kind}`;
    button.dataset.tooltip = T(tooltip);
    button.innerHTML = `<i class="${icon}" inert></i><span></span>`;
    button.querySelector("span").textContent = count ? game.i18n.format(label, { count }) : T(label);
    button.addEventListener("click", onClick);
    return button;
  };
  // Their own character; and for a GM, what players sent while no GM was online.
  const button = make(entry, () => openWizard());
  if ( entry.queue ) actions.prepend(make(entry.queue, () => PendingApp.open()));
  actions.prepend(button);
  return button;
}

/** Open the wizard from an entry point; a second click while it opens does nothing. */
let opening = false;
async function openWizard() {
  if ( opening ) return null;
  opening = true;
  try {
    return await CharacterWizard.open();
  } catch ( err ) {
    console.error(`${MODULE_ID} | the wizard couldn't be opened`, err);
    ui.notifications?.error(T("Error.BAD_REQUEST"));
    return null;
  } finally {
    opening = false;
    refreshEntryPoints();
  }
}

/** Every rendered Actors directory: the sidebar tab, and a popped-out copy of it. */
function directories() {
  const ActorDirectory = foundry.applications.sidebar.tabs.ActorDirectory;
  const apps = [...foundry.applications.instances.values()].filter(a => (a instanceof ActorDirectory) && a.rendered);
  if ( ui.actors?.rendered && !apps.includes(ui.actors) ) apps.push(ui.actors);
  return apps;
}

/** Re-read the draft and update every rendered Actors directory (the label follows the draft). */
export function refreshEntryPoints() {
  for ( const app of directories() ) renderEntryButton(app.element);
}

/** The prompt, once per session: a notification carrying the same button. Exported for the Quench batch. */
export function promptOnLogin() {
  const entry = currentEntry();
  const prompt = loginPrompt(entry, { showOnLogin: readSettings().showOnLogin, hasCharacter: !!game.user.character,
    isGM: game.user.isGM });
  if ( !prompt ) return null;
  const offered = prompt.kind === "queue" ? entry.queue : entry;
  const label = foundry.utils.escapeHTML(offered.count ? game.i18n.format(offered.label, { count: offered.count })
    : T(offered.label));
  const message = `${foundry.utils.escapeHTML(T(prompt.message))} `
    + `<button type="button" class="cc-entry-prompt" data-cc-entry="${prompt.kind}">${label}</button>`;
  // Our own markup, from lang/en.json: nothing here comes from a player, so it isn't escaped away again.
  return ui.notifications?.info(message, { escape: false, clean: false, permanent: prompt.permanent, console: false });
}

/**
 * Register the entry points. Called once, when the world is ready.
 */
export function registerEntryPoints() {
  Hooks.on("renderActorDirectory", (app, element) => renderEntryButton(element));
  // The label follows the draft, the character limit and the characters already made.
  Hooks.on("updateUser", user => {
    if ( user.id === game.user.id ) refreshEntryPoints();
  });
  Hooks.on("createActor", () => refreshEntryPoints());
  Hooks.on("deleteActor", () => refreshEntryPoints());
  Hooks.on("updateSetting", setting => {
    if ( String(setting?.key ?? "").startsWith(`${MODULE_ID}.`) ) refreshEntryPoints();
  });
  // The notification is removed by its own click handler; this one does the opening.
  document.getElementById("notifications")?.addEventListener("click", event => {
    const offered = event.target.closest("[data-cc-entry]");
    if ( offered ) return offered.dataset.ccEntry === "queue" ? PendingApp.open() : openWizard();
  });
  // A character that already exists can be given a picture too (PLAN 4.3, A5).
  registerSheetEntry();
  refreshEntryPoints();
  promptOnLogin();
}
