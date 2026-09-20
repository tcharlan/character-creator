/**
 * Short explanations for the things a player picks (PLAN 3.11): what a skill, tool or language is for, and what
 * a spell does. Everything comes from the compendium the GM already allows — dnd5e's rules journal for traits,
 * the spell's own card for spells — so nothing is bundled.
 *
 * Loading a document takes a moment, so a summary is fetched off the render path and kept: the screen asks for
 * whatever is already there (`summaryCached`), starts the rest (`loadSummaries`) and renders again when they
 * arrive, the same way the option descriptions work.
 */

import { MODULE_ID } from "../contracts.mjs";

/** The longest summary shown under an option. */
const MAX_LENGTH = 220;

const cache = new Map();   // uuid → summary ("" when the document has nothing to say)
const jobs = new Map();

/**
 * The rules page dnd5e links for a trait key ("skills:his", "tool:thief", "languages:standard:elvish"), or null.
 * The key's parts walk `CONFIG.DND5E` the way dnd5e's own `Trait.keyLabel` does.
 */
export function traitReference(key) {
  const C = globalThis.CONFIG?.DND5E;
  const parts = String(key ?? "").split(":");
  const trait = parts.shift();
  const config = C?.traits?.[trait];
  if ( !config ) return null;
  let node = C[config.configKey ?? trait];
  for ( const part of parts ) {
    if ( !node || (typeof node === "string") ) return null;
    node = (node.children ?? node)[part];
  }
  return (typeof node === "object" ? node?.reference : null) ?? null;
}

/** The summary already loaded for this document, or null (nothing loaded, or nothing to say). */
export function summaryCached(uuid) {
  return cache.get(uuid) || null;
}

/** Have all of these been looked up yet? */
export function summariesReady(uuids) {
  return uuids.every(uuid => !uuid || cache.has(uuid));
}

/** The first sentence or so of some HTML, as plain text. */
export function firstSentence(html, { max = MAX_LENGTH } = {}) {
  let plain;
  if ( globalThis.document ) {
    const div = document.createElement("div");
    div.innerHTML = String(html ?? "");
    plain = div.textContent ?? "";
  } else plain = String(html ?? "").replace(/<[^>]*>/g, " ");   // outside a browser (unit tests)
  const text = plain.replace(/\s+/g, " ").trim();
  if ( !text ) return "";
  const stop = text.search(/\.\s|\.$/);
  const sentence = (stop > 0) && (stop < max) ? text.slice(0, stop + 1) : text;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/**
 * Load one document's summary (journal page or item description). Resolves with the text, or "" when there is
 * none; failures are kept as "" so a missing document isn't looked up over and over.
 */
export function loadSummary(uuid) {
  if ( !uuid ) return Promise.resolve("");
  if ( cache.has(uuid) ) return Promise.resolve(cache.get(uuid));
  if ( jobs.has(uuid) ) return jobs.get(uuid);
  const job = (async () => {
    let summary = "";
    try {
      const doc = await fromUuid(uuid);
      summary = firstSentence(doc?.text?.content ?? doc?.system?.description?.value ?? "");
    } catch ( err ) {
      console.warn(`${MODULE_ID} | couldn't read ${uuid}`, err);
    }
    cache.set(uuid, summary);
    jobs.delete(uuid);
    return summary;
  })();
  jobs.set(uuid, job);
  return job;
}

/** Load several at once (the list on screen). */
export function loadSummaries(uuids) {
  return Promise.all([...new Set(uuids.filter(Boolean))].map(uuid => loadSummary(uuid)));
}

/** Level and school of a spell, from the catalog index: "Cantrip · Evocation", "Level 1 · Abjuration". */
export function spellMeta(entry) {
  const C = globalThis.CONFIG?.DND5E;
  const level = entry?.system?.level;
  const school = C?.spellSchools?.[entry?.system?.school]?.label ?? entry?.system?.school ?? "";
  const levelLabel = level === 0 ? (C?.spellLevels?.[0] ?? "Cantrip") : (C?.spellLevels?.[level] ?? (level ? `Level ${level}` : ""));
  return [levelLabel, school].filter(Boolean).join(" · ");
}
