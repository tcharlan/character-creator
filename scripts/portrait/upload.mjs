/**
 * "Upload portrait" after creation (A5), player side: sends a prepared image to the active GM. A GM must be
 * online — unlike a portrait sent with a submission, it doesn't wait in the offline queue.
 */

import { QUERIES } from "../contracts.mjs";
import { PortraitError } from "./prepare.mjs";

/**
 * @param {string} actorUuid
 * @param {{ mime, data, width, height }} image   From preparePortrait().
 * @param {{ ring?: string|null, background?: string|null, effects?: number }} [ring]
 * @returns {Promise<{ ok: true, path: string }|{ ok: false, errors: object[] }>}
 * @throws {PortraitError} GM_OFFLINE when no GM is online.
 */
export async function uploadPortrait(actorUuid, image, ring) {
  const gm = game.users.activeGM;
  if ( !gm ) throw new PortraitError("GM_OFFLINE");
  return gm.query(QUERIES.UPLOAD_PORTRAIT, { actorUuid, image, ...(ring ? { ring } : {}) }, { timeout: 60_000 });
}
