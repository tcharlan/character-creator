import { MODULE_ID } from "../scripts/main.mjs";

/*
 * Art inventory for the cinematic wizard (PLAN 3.0, D24): what image every species, class, subclass and background
 * option carries in the allowed content, and whether a journal page linked to it has art (an image page in the
 * same entry, or an <img> in the page text). Research: it logs the inventory and asserts only that it ran.
 */

const OPTION_CATEGORIES = ["species", "class", "subclass", "background"];

/** Rough kind of an image path. */
function kindOf(img) {
  if ( !img ) return "none";
  if ( img.startsWith("icons/svg/") || img.includes("mystery-man") ) return "default";
  if ( img.startsWith("icons/") ) return "core-icon";
  if ( img.startsWith("systems/dnd5e/") ) return img.endsWith(".svg") ? "dnd5e-svg" : "dnd5e-art";
  return "other";
}

export function registerArtBatch(quench) {
  const rules = () => game.settings.get("dnd5e", "rulesVersion");

  quench.registerBatch(`${MODULE_ID}.art`, ({ describe, it, assert }) => {
    describe("Art inventory for option cards (research, PLAN 3.0)", () => {
      it("lists each option's image and any linked journal art", async function() {
        this.timeout(300_000);
        const catalog = await (await import("../scripts/catalog/catalog.mjs")).getCatalog();
        // Journal pages that point at an item (dnd5e class/subclass pages), with art found in their entry.
        const journalArt = new Map();
        const journals = game.packs.filter(p => p.documentName === "JournalEntry");
        console.log(`${MODULE_ID} | art journals (${rules()}): ${JSON.stringify(journals.map(p => ({ pack: p.collection, visible: p.visible })))}`);
        for ( const pack of journals.filter(p => p.visible) ) {
          for ( const entry of await pack.getDocuments() ) {
            const images = entry.pages.filter(p => p.type === "image" && p.src).map(p => p.src);
            for ( const page of entry.pages ) {
              const item = page.system?.item;
              if ( !item ) continue;
              const html = `${page.system?.description?.value ?? ""}${page.text?.content ?? ""}`;
              const inline = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map(m => m[1]);
              journalArt.set(item.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item."), { page: `${pack.collection}/${page.name}`,
                images: [...images, ...inline] });
            }
          }
        }
        const report = {};
        for ( const cat of OPTION_CATEGORIES ) {
          report[cat] = catalog.byCategory[cat].map(e => {
            const uuid = e.uuid.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item.");
            const j = journalArt.get(uuid);
            return { name: e.name, img: e.img ?? null, kind: kindOf(e.img), journal: j ? j.images.slice(0, 3) : null };
          });
        }
        const counts = Object.fromEntries(OPTION_CATEGORIES.map(c => [c, report[c].reduce((m, r) => {
          m[r.kind] = (m[r.kind] ?? 0) + 1;
          if ( r.journal?.length ) m.journalArt = (m.journalArt ?? 0) + 1;
          return m;
        }, {})]));
        console.log(`${MODULE_ID} | art journal links (${rules()}): ${journalArt.size}`);
        console.log(`${MODULE_ID} | art counts (${rules()}): ${JSON.stringify(counts)}`);
        console.log(`${MODULE_ID} | art detail (${rules()}): ${JSON.stringify(report)}`);
        assert.isAbove(report.class.length, 0);
      });
    });
  }, { displayName: "Character Creator: Art inventory (research)" });
}
