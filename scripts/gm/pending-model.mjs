/**
 * What the GM's pending-characters panel shows (PLAN 4.2). Pure: the app brings the players' drafts and the
 * names from the catalog; everything here is plain data.
 *
 * Two kinds of row: a build **waiting** for a GM (submitted while none was online, D17) and one the validator
 * **refused**, which the player has to fix — the panel shows why.
 */

import { STATUS } from "../contracts.mjs";

/** Oldest first, waiting before refused: what a GM would work through. */
const ORDER = Object.freeze({ waiting: 0, failed: 1 });

/**
 * One row per player with something outstanding.
 * @param {{ id: string, name: string, isGM: boolean, draft: object|null }[]} users
 * @param {{ names?: (uuid: string) => string|null }} [options]   Catalog lookup for the picks.
 * @returns {{ userId, player, kind, draftId, character, picks, updatedAt, errors }[]}
 */
export function queueRows(users, { names = () => null } = {}) {
  const rows = [];
  for ( const user of users ?? [] ) {
    const draft = user?.draft;
    if ( user?.isGM || !draft ) continue;
    const kind = draft.status === STATUS.SUBMITTED ? "waiting" : draft.status === STATUS.FAILED ? "failed" : null;
    if ( !kind ) continue;
    rows.push({
      userId: user.id,
      player: user.name,
      kind,
      draftId: draft.id,
      character: String(draft.details?.name ?? "").trim(),
      picks: ["species", "class", "background"].map(role => names(draft.picks?.[role])).filter(Boolean),
      updatedAt: draft.updatedAt ?? 0,
      hasPortrait: !!draft.portrait?.pendingImage,
      errors: (draft.result?.errors ?? []).map(e => ({ code: e.code, key: e.key, step: e.step }))
    });
  }
  return rows.sort((a, b) => (ORDER[a.kind] - ORDER[b.kind]) || (a.updatedAt - b.updatedAt));
}

/** How many of each kind, for the panel's heading and the sidebar. */
export function queueCounts(rows) {
  return {
    waiting: rows.filter(r => r.kind === "waiting").length,
    failed: rows.filter(r => r.kind === "failed").length,
    total: rows.length
  };
}

/**
 * The panel.
 * @param {ReturnType<queueRows>} rows
 * @param {{ busy?: string|null }} [options]   The user whose build is being created right now.
 */
export function pendingModel(rows, { busy = null } = {}) {
  const counts = queueCounts(rows);
  return {
    rows: rows.map(row => ({ ...row,
      busy: row.userId === busy,
      picksText: row.picks.join(" · "),
      // A refused build is the player's to fix; the GM can only try it again once whatever refused it changed.
      canCreate: row.kind === "waiting",
      canRetry: row.kind === "failed" })),
    counts,
    empty: !counts.total,
    busy
  };
}
