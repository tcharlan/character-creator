/**
 * A GM's own characters (D29). A GM can use the creator like a player; the character is theirs until they give
 * it to a player — at Review, from the finished screen, or later from the Actors tab's context menu. Giving makes
 * the player its owner and, if they have no character yet, their character.
 */

import { MODULE_ID } from "../contracts.mjs";

const T = (key, data) => (data ? game.i18n.format(`CHARCREATOR.${key}`, data) : game.i18n.localize(`CHARCREATOR.${key}`));

/** The players a GM can give a character to, by name. */
export function givablePlayers() {
  return game.users.filter(u => !u.isGM).sort((a, b) => a.name.localeCompare(b.name));
}

/** Can this user give this actor away? GMs, for characters. */
export function canGive(actor) {
  return !!actor && game.user.isGM && (actor.type === "character");
}

/**
 * Give a character to a player: they own it, and it becomes their character if they have none.
 * @returns {Promise<{ assigned: boolean }>}   `assigned` = it became the player's character.
 */
export async function giveToPlayer(actor, user) {
  if ( !game.user.isGM ) throw new Error("Only a GM can give a character to a player");
  if ( !actor || !user || user.isGM ) throw new Error("A character and a player are needed");
  await actor.update({ [`ownership.${user.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });
  const assigned = !user.character;
  if ( assigned ) await user.update({ character: actor.id });
  return { assigned };
}

/** Give a character to a player, asking which one. Returns the player, or null. */
export async function giveDialog(actor) {
  if ( !canGive(actor) ) return null;
  const players = givablePlayers();
  if ( !players.length ) {
    ui.notifications?.warn(T("Assign.NoPlayers"));
    return null;
  }
  const escape = foundry.utils.escapeHTML;
  const options = players.map(u => `<option value="${u.id}">${escape(u.name)}</option>`).join("");
  const id = await foundry.applications.api.DialogV2.prompt({
    window: { title: T("Assign.Title"), icon: "fa-solid fa-user-plus" },
    content: `<div class="form-group"><label>${escape(T("Assign.Label"))}</label><select name="player">${options}</select></div>`
      + `<p class="hint">${escape(T("Assign.Hint"))}</p>`,
    ok: { label: T("Assign.Confirm"), callback: (event, button) => button.form.elements.player.value },
    rejectClose: false
  });
  const user = id ? game.users.get(id) : null;
  if ( !user ) return null;
  return giveAndTell(actor, user);
}

/** Give, and say how it went. Returns the player, or null if it failed. */
export async function giveAndTell(actor, user) {
  try {
    await giveToPlayer(actor, user);
    ui.notifications?.info(T("Assign.Done", { actor: actor.name, name: user.name }));
    return user;
  } catch ( err ) {
    console.error(`${MODULE_ID} | ${actor?.name} couldn't be given to ${user?.name}`, err);
    ui.notifications?.error(T("Assign.Failed", { actor: actor?.name ?? "", name: user?.name ?? "" }));
    return null;
  }
}
