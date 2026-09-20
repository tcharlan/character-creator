/**
 * The Species, Class and Background steps (PLAN 3.2): the allowed options, the chosen option's details from its
 * compendium entry (a linked journal page for classes and subclasses, R2/D24), and the art panel.
 */

import { MODULE_ID } from "../contracts.mjs";
import { normalizeUuid } from "../catalog/filters.mjs";

/** Which catalog category each step offers. */
export const STEP_CATEGORY = Object.freeze({ species: "species", class: "class", background: "background" });

/** A list longer than this gets a search box. */
const SEARCHABLE_FROM = 10;

/** Art bigger than a plain icon (dnd5e ships 512 px class art; a GM image may be larger still). */
const LARGE_ART = /systems\/dnd5e\/icons\/classes\//;

const detailCache = new Map();
let journalByItem = null;

/** The option list for a step. */
export function optionList(catalog, step, { search = "", selected = null } = {}) {
  const all = catalog?.byCategory?.[STEP_CATEGORY[step]] ?? [];
  const needle = search.trim().toLowerCase();
  const list = all.filter(e => !needle || e.name.toLowerCase().includes(needle))
    .map(e => ({ uuid: normalizeUuid(e.uuid), name: e.name, img: e.img, selected: normalizeUuid(e.uuid) === selected }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { total: all.length, list, search, searchable: all.length >= SEARCHABLE_FROM };
}

/** Class and subclass descriptions from dnd5e's journal pages, keyed by the item they document. */
async function journalDescriptions() {
  if ( journalByItem ) return journalByItem;
  journalByItem = new Map();
  for ( const pack of game.packs.filter(p => p.documentName === "JournalEntry" && p.visible) ) {
    try {
      for ( const entry of await pack.getDocuments() ) {
        for ( const page of entry.pages ) {
          const item = page.system?.item;
          const html = page.system?.description?.value;
          if ( item && html ) journalByItem.set(normalizeUuid(item), { html, page });
        }
      }
    } catch ( err ) {
      console.warn(`${MODULE_ID} | couldn't read ${pack.collection}`, err);
    }
  }
  return journalByItem;
}

const ordinal = n => `${n}`;
const chip = (label, value) => (value ? `${label} ${value}` : null);

/** Level-0/1 advancements of an item, as a feature list. */
function features(doc) {
  const out = [];
  for ( const adv of Object.values(doc.system?.advancement ?? {}) ) {
    const level = adv.level ?? Math.min(...Object.keys(adv.levels ?? { 0: 0 }).map(Number));
    if ( level > 1 ) continue;
    const title = adv.title || game.i18n.localize(`DND5E.ADVANCEMENT.${adv.type}.Title`) || adv.type;
    out.push({ title, note: adv.type === "ItemGrant" ? game.i18n.localize("CHARCREATOR.Options.Granted")
      : adv.type === "ItemChoice" || adv.type === "Trait" || adv.type === "Subclass"
        ? game.i18n.localize("CHARCREATOR.Options.YouChoose") : "" });
  }
  return out;
}

/** Facts for the art panel, by role. */
function facts(doc, step) {
  const L = key => game.i18n.localize(`CHARCREATOR.Facts.${key}`);
  const rows = [];
  if ( step === "species" ) {
    const size = Object.values(doc.system?.advancement ?? {}).find(a => a.type === "Size")?.configuration?.sizes ?? [];
    const sizes = [...size].map(s => CONFIG.DND5E.actorSizes[s]?.label ?? s).join(", ");
    rows.push({ label: L("Size"), value: sizes || "—" });
    rows.push({ label: L("Speed"), value: doc.system?.movement?.walk ? `${doc.system.movement.walk} ft` : "—" });
    rows.push({ label: L("Type"), value: CONFIG.DND5E.creatureTypes?.[doc.system?.type?.value]?.label ?? doc.system?.type?.value ?? "—" });
    const dark = doc.system?.senses?.darkvision;
    if ( dark ) rows.push({ label: L("Vision"), value: `${game.i18n.localize("DND5E.SenseDarkvision")} ${dark} ft` });
  } else if ( step === "class" ) {
    rows.push({ label: L("HitDie"), value: doc.system?.hitDice ?? doc.system?.hd?.denomination ?? "—" });
    const primary = [...(doc.system?.primaryAbility?.value ?? [])].map(a => CONFIG.DND5E.abilities[a]?.label ?? a).join(", ");
    if ( primary ) rows.push({ label: L("Primary"), value: primary });
    const casting = doc.system?.spellcasting?.ability;
    if ( casting ) rows.push({ label: L("Spellcasting"), value: CONFIG.DND5E.abilities[casting]?.label ?? casting });
    if ( doc.system?.wealth ) rows.push({ label: L("Wealth"), value: String(doc.system.wealth) });
  } else {
    const equipment = (doc.system?.startingEquipment ?? []).length;
    rows.push({ label: L("Equipment"), value: equipment ? ordinal(equipment) : "—" });
    if ( doc.system?.wealth ) rows.push({ label: L("Wealth"), value: String(doc.system.wealth) });
  }
  return rows;
}

/** Chips under the heading. */
function chips(doc, step) {
  const out = [];
  if ( step === "class" ) {
    out.push(chip(game.i18n.localize("CHARCREATOR.Facts.HitDie"), doc.system?.hitDice));
    const primary = [...(doc.system?.primaryAbility?.value ?? [])].map(a => CONFIG.DND5E.abilities[a]?.label ?? a).join(" / ");
    out.push(primary || null);
  }
  if ( step === "species" ) {
    out.push(doc.system?.movement?.walk ? `${game.i18n.localize("CHARCREATOR.Facts.Speed")} ${doc.system.movement.walk} ft` : null);
  }
  const source = doc.system?.source?.label ?? doc.system?.source?.book;
  out.push(source || null);
  return out.filter(Boolean);
}

/**
 * The details pane for one option. Cached per UUID.
 * @param {string} uuid
 * @param {"species"|"class"|"background"} step
 */
export async function optionDetail(uuid, step) {
  const key = `${step}:${uuid}`;
  if ( detailCache.has(key) ) return detailCache.get(key);
  const doc = await fromUuid(uuid);
  if ( !doc ) return null;
  let html = doc.system?.description?.value ?? "";
  let artNote = game.i18n.localize("CHARCREATOR.Options.ArtIcon");
  if ( step === "class" ) {
    const page = (await journalDescriptions()).get(normalizeUuid(uuid));
    if ( page?.html ) html = page.html;
  }
  if ( LARGE_ART.test(doc.img ?? "") ) artNote = game.i18n.localize("CHARCREATOR.Options.ArtSystem");
  const enriched = await CONFIG.ux.TextEditor.implementation.enrichHTML(html, { relativeTo: doc, secrets: false });
  const detail = {
    uuid, name: doc.name, img: doc.img, description: enriched, chips: chips(doc, step), features: features(doc),
    facts: facts(doc, step), largeArt: LARGE_ART.test(doc.img ?? ""), artNote,
    identifier: doc.system?.identifier ?? null
  };
  detailCache.set(key, detail);
  return detail;
}

/** Subclasses for a class, from the catalog (the class's own identifier links them). */
export function subclassOptions(catalog, identifier, selected) {
  return (catalog?.byCategory?.subclass ?? [])
    .filter(e => e.system?.classIdentifier === identifier)
    .map(e => ({ uuid: normalizeUuid(e.uuid), name: e.name, img: e.img, selected: normalizeUuid(e.uuid) === selected }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The Subclass step of the current build, when the class grants one at level 1. */
export function subclassStep(built) {
  return built?.results?.find(r => r.type === "Subclass" && r.level === 1) ?? null;
}

/** Forget the cached details (the catalog changed). */
export function clearOptionCache() {
  detailCache.clear();
  journalByItem = null;
}
