/* Generates the Character Creator wizard mockup artboards (PLAN 3.0) as .dc.html files + canvas.json. */
const fs = require("fs");
const path = require("path");
const OUT = path.join(__dirname, "project");
fs.mkdirSync(OUT, { recursive: true });

const C = {
  ground: "#0f1114", base: "#14171b", panel: "#1a1e24", raised: "#222831", line: "#313844", lineSoft: "#262c35",
  text: "#ede6d8", muted: "#aaa396", faint: "#7f796e", gold: "#d4ad57", goldDeep: "#8a6a2a", ember: "#d9784a",
  ok: "#8fbf8a", warn: "#e0a15a", bad: "#e27d6d"
};
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* Inline stroke glyphs (stand-ins for compendium icons). */
const GLYPH = {
  shield: '<path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z"/>',
  flame: '<path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-3 2-4 2-7 1.5 1 3 2 3 4 0-3 0-5 0-7z"/>',
  leaf: '<path d="M5 19c0-8 5-14 14-14 0 9-6 14-14 14z"/><path d="M5 19l8-8"/>',
  star: '<path d="M12 3l2.6 5.6 6 .6-4.5 4 1.3 6-5.4-3.2-5.4 3.2 1.3-6-4.5-4 6-.6z"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  crown: '<path d="M3 8l4 4 5-7 5 7 4-4-2 11H5z"/>',
  mountain: '<path d="M2 20l7-12 4 6 3-4 6 10z"/>',
  moon: '<path d="M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z"/>',
  sword: '<path d="M14 4h6v6L9 21l-3-3z"/><path d="M5 15l4 4"/>',
  book: '<path d="M4 5c3-1 6-1 8 1 2-2 5-2 8-1v14c-3-1-6-1-8 1-2-2-5-2-8-1z"/><path d="M12 6v14"/>',
  hand: '<path d="M7 12V6a1.5 1.5 0 0 1 3 0v5V4a1.5 1.5 0 0 1 3 0v7V5a1.5 1.5 0 0 1 3 0v8c0 4-2 7-6 7s-6-3-6-6l-1-3a1.5 1.5 0 0 1 3-1z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
  harp: '<path d="M6 21V4c6 0 12 5 12 12H6"/><path d="M9 8v8M12 10v6M15 13v3"/>',
  paw: '<circle cx="7" cy="9" r="2"/><circle cx="12" cy="6" r="2"/><circle cx="17" cy="9" r="2"/><path d="M8 17c0-3 2-5 4-5s4 2 4 5-2 3-4 3-4 0-4-3z"/>',
  bow: '<path d="M5 3c8 3 11 9 8 18"/><path d="M5 3l8 18"/>',
  dagger: '<path d="M15 3l3 3-9 9-3-3z"/><path d="M6 12l-3 3 3 3 3-3"/>',
  fist: '<path d="M6 10h12v6a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4z"/><path d="M9 10V7M12 10V6M15 10V7"/>',
  orb: '<circle cx="12" cy="12" r="8"/><path d="M8 12a4 4 0 0 1 4-4"/>',
  scroll: '<path d="M6 4h11a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z"/><path d="M9 8h7M9 12h7M9 16h4"/>',
  check: '<path d="M5 12l4 4 10-10"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  hourglass: '<path d="M7 3h10M7 21h10M8 3c0 5 8 6 8 9s-8 4-8 9M16 3c0 5-8 6-8 9s8 4 8 9"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="15" r="1"/><circle cx="15" cy="9" r="1"/><circle cx="9" cy="15" r="1"/>',
  chevronL: '<path d="M15 5l-7 7 7 7"/>',
  chevronR: '<path d="M9 5l7 7-7 7"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-5 5-7 8-7s7 2 8 7"/>'
};
const svg = (name, size = 20, color = "currentColor", sw = 1.6) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPH[name]}</svg>`;

const STEPS = ["Species", "Class", "Background", "Abilities", "Choices", "Equipment", "Spells", "Details", "Portrait", "Review"];
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

/** The step banner: `picks` = names shown under completed steps, `current` = index. */
function banner(current, picks, width) {
  const w = Math.floor(width / STEPS.length);
  return `<nav aria-label="Creation steps" style="display: flex; flex-shrink: 0; height: 84px; background: ${C.base}; border-bottom: 1px solid ${C.line};">
${STEPS.map((name, i) => {
    const done = i < current;
    const cur = i === current;
    const color = cur ? C.text : done ? C.text : C.faint;
    const edge = cur ? C.gold : done ? C.goldDeep : "transparent";
    const bg = cur ? C.panel : "transparent";
    const pick = picks[i] ?? (cur ? "Choosing…" : "");
    return `<button type="button" ${cur ? 'aria-current="step" ' : ""}style="width: ${w}px; flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 2px; padding: 0 14px; background: ${bg}; border: 0; border-right: 1px solid ${C.lineSoft}; border-bottom: 3px solid ${edge}; color: ${color}; text-align: left;">
<span style="font-family: {{display}}; font-size: 12px; letter-spacing: 0.12em; color: ${cur ? C.gold : done ? C.goldDeep : C.faint};">${ROMAN[i]}</span>
<span style="font-family: {{display}}; font-size: 15px; font-weight: 600; letter-spacing: 0.04em;">${name}</span>
<span style="font-size: 12px; color: ${done ? C.muted : C.faint}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: ${w - 28}px;">${esc(pick)}</span>
</button>`;
  }).join("\n")}
</nav>`;
}

function footer(back, next, status, { nextDisabled = false } = {}) {
  return `<footer style="height: 64px; flex-shrink: 0; display: flex; align-items: center; gap: 16px; padding: 0 28px; background: ${C.base}; border-top: 1px solid ${C.line};">
<button type="button" style="display: flex; align-items: center; gap: 6px; height: 44px; padding: 0 18px; background: transparent; color: ${C.text}; border: 1px solid ${C.line}; border-radius: 6px; font-family: {{body}}; font-size: 15px;">${svg("chevronL", 16)}${esc(back)}</button>
<span style="flex-grow: 1; font-size: 13px; color: ${C.muted};">${status}</span>
<button type="button" ${nextDisabled ? 'disabled="" ' : ""}style="display: flex; align-items: center; gap: 6px; height: 44px; padding: 0 22px; background: ${nextDisabled ? C.raised : C.gold}; color: ${nextDisabled ? C.faint : "#1a1408"}; border: 0; border-radius: 6px; font-family: {{display}}; font-size: 15px; font-weight: 700; letter-spacing: 0.05em;">${esc(next)}${svg("chevronR", 16)}</button>
</footer>`;
}

/** Left column: selectable options with an emblem. */
function optionList(label, options, selected, { width = 300, note = "" } = {}) {
  return `<section aria-label="${esc(label)}" style="width: ${width}px; flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; padding: 18px 14px; background: ${C.base}; border-right: 1px solid ${C.line}; overflow: hidden;">
<div style="display: flex; align-items: baseline; justify-content: space-between; padding: 0 8px 8px;">
<h2 style="margin: 0; font-family: {{display}}; font-size: 13px; letter-spacing: 0.14em; text-transform: uppercase; color: ${C.muted};">${esc(label)}</h2>
<span style="font-size: 12px; color: ${C.faint};">${esc(note)}</span>
</div>
${options.map(([name, glyph, sub]) => {
    const sel = name === selected;
    return `<button type="button" aria-pressed="${sel}" style="display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 6px 10px; background: ${sel ? C.raised : "transparent"}; border: 1px solid ${sel ? C.goldDeep : "transparent"}; border-radius: 6px; color: ${sel ? C.text : C.muted}; text-align: left; font-family: {{body}};">
<span style="width: 34px; height: 34px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: ${sel ? "#2c2416" : C.panel}; color: ${sel ? C.gold : C.muted};">${svg(glyph, 20)}</span>
<span style="display: flex; flex-direction: column; gap: 1px;">
<span style="font-size: 15px; font-weight: ${sel ? 700 : 500};">${esc(name)}</span>
${sub ? `<span style="font-size: 12px; color: ${C.faint};">${esc(sub)}</span>` : ""}
</span>
</button>`;
  }).join("\n")}
</section>`;
}

const chip = (t, tone = "plain") => `<span style="display: inline-flex; align-items: center; height: 28px; padding: 0 12px; border-radius: 14px; font-size: 13px; background: ${tone === "gold" ? "#2c2416" : C.raised}; color: ${tone === "gold" ? C.gold : C.text}; border: 1px solid ${tone === "gold" ? C.goldDeep : C.line};">${esc(t)}</span>`;
const sectionTitle = t => `<h3 style="margin: 0; font-family: {{display}}; font-size: 13px; letter-spacing: 0.14em; text-transform: uppercase; color: ${C.gold};">${esc(t)}</h3>`;
const placeholder = t => `<p style="margin: 0; font-size: 15px; line-height: 1.55; color: ${C.muted}; font-style: italic;">${esc(t)}</p>`;

/** Right panel: an emblem medallion for a 256 px compendium icon (D24), with caption. */
function medallion(glyph, caption, size = 216) {
  return `<div style="display: flex; flex-direction: column; align-items: center; gap: 12px;">
<div style="width: ${size}px; height: ${size}px; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: radial-gradient(circle at 50% 40%, #2a2419 0%, ${C.panel} 62%, ${C.base} 100%); border: 1px solid ${C.goldDeep}; box-shadow: 0 0 0 6px ${C.base}, 0 0 0 7px ${C.lineSoft};">
<div style="width: ${Math.round(size * 0.56)}px; height: ${Math.round(size * 0.56)}px; display: flex; align-items: center; justify-content: center; border-radius: 12px; background: #16130d; border: 1px solid #3a3020; color: ${C.gold};">${svg(glyph, Math.round(size * 0.34), C.gold, 1.3)}</div>
</div>
<span style="font-size: 12px; color: ${C.faint}; text-align: center;">${esc(caption)}</span>
</div>`;
}

function facts(rows) {
  return `<dl style="margin: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; width: 100%;">
${rows.map(([k, v]) => `<div style="display: flex; flex-direction: column; gap: 2px;"><dt style="font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: ${C.faint};">${esc(k)}</dt><dd style="margin: 0; font-size: 15px; color: ${C.text};">${esc(v)}</dd></div>`).join("\n")}
</dl>`;
}

function rightPanel(inner, width = 330) {
  return `<aside style="width: ${width}px; flex-shrink: 0; display: flex; flex-direction: column; align-items: center; gap: 22px; padding: 26px 24px; background: ${C.base}; border-left: 1px solid ${C.line}; overflow: hidden;">
${inner}
</aside>`;
}

function centre(inner) {
  return `<section style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 18px; padding: 26px 34px; overflow: hidden;">
${inner}
</section>`;
}

function heading(title, sub) {
  return `<header style="display: flex; flex-direction: column; gap: 6px;">
<h1 style="margin: 0; font-family: {{display}}; font-size: 40px; font-weight: 700; letter-spacing: 0.03em; line-height: 1.05; color: ${C.text};">${esc(title)}</h1>
<span style="font-size: 14px; color: ${C.muted};">${esc(sub)}</span>
</header>`;
}

function featureList(items) {
  return `<ul style="margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px;">
${items.map(([name, note]) => `<li style="display: flex; gap: 12px; align-items: baseline; padding: 10px 14px; background: ${C.panel}; border: 1px solid ${C.lineSoft}; border-radius: 6px;"><span style="font-family: {{display}}; font-size: 15px; font-weight: 600; color: ${C.text}; min-width: 150px;">${esc(name)}</span><span style="font-size: 14px; color: ${C.muted};">${esc(note)}</span></li>`).join("\n")}
</ul>`;
}

/** A whole artboard. */
function board({ title, width = 1280, height = 720, current, picks, body, footerHtml, pairing = "A" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700&amp;family=Alegreya+Sans:ital,wght@0,400;0,500;0,700;1,400&amp;family=Cormorant+Garamond:wght@500;600;700&amp;family=Spectral:ital,wght@0,400;0,500;0,600;1,400&amp;display=swap">
<style>
body{margin:0;background:${C.ground}}
a{color:${C.gold}}a:hover{color:#f0cd7a}
</style>
</helmet>
<div style="width: ${width}px; height: ${height}px; box-sizing: border-box; display: flex; flex-direction: column; background: ${C.ground}; color: ${C.text}; font-family: {{body}}; overflow: hidden;">
${current === null ? "" : banner(current, picks, width)}
<main style="flex-grow: 1; min-height: 0; display: flex;">
${body}
</main>
${footerHtml ?? ""}
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"pairing":{"editor":"enum","options":["A","B"],"default":"${pairing}","section":"Type"},"$preview":{"width":${width},"height":${height}}}'>
class Component extends DCLogic {
  renderVals() {
    const b = (this.props.pairing ?? "${pairing}") === "B";
    return {
      display: b ? "Cormorant Garamond, Georgia, serif" : "Cinzel, Georgia, serif",
      body: b ? "Spectral, Georgia, serif" : "Alegreya Sans, Segoe UI, sans-serif"
    };
  }
}
</script>
</body>
</html>
`;
}

/* ---------------------------------------------------------------- */
/*  Screens                                                         */
/* ---------------------------------------------------------------- */

const SPECIES14 = [["Dragonborn", "flame", "Draconic ancestry"], ["Half-Elf", "leaf"], ["Half-Orc", "fist"], ["High Elf", "star", "Elf"],
  ["Hill Dwarf", "mountain", "Dwarf"], ["Human", "user"], ["Lightfoot Halfling", "paw", "Halfling"], ["Rock Gnome", "orb", "Gnome"], ["Tiefling", "moon"]];

function speciesBody(w, big = false) {
  return `${optionList("Species", SPECIES14, "High Elf", { width: big ? 380 : 300, note: "9 allowed" })}
${centre(`${heading("High Elf", "Elf · 2014 rules · from the System Reference Document")}
<div style="display: flex; flex-wrap: wrap; gap: 8px;">${chip("+2 Dexterity", "gold")}${chip("+1 Intelligence", "gold")}${chip("Medium")}${chip("Speed 30 ft")}${chip("Darkvision 60 ft")}${chip("Humanoid")}</div>
${placeholder("[The species description from its compendium entry, shown as written, with its links.]")}
${sectionTitle("Traits")}
${featureList([["Keen Senses", "Proficiency in Perception"], ["Fey Ancestry", "Advantage against being charmed"], ["Trance", "4 hours of meditation instead of sleep"], ["Cantrip", "One wizard cantrip, chosen in step V"], ["Extra Language", "One language, chosen in step V"]])}`)}
${rightPanel(`${medallion("star", "Compendium icon (256 px), shown at its own size", big ? 280 : 216)}
${facts([["Size", "Medium"], ["Speed", "30 ft"], ["Type", "Humanoid"], ["Vision", "Darkvision 60 ft"]])}
<p style="margin: 0; font-size: 13px; line-height: 1.5; color: ${C.faint}; text-align: center;">Your GM can give each option its own image (Phase 4); it then fills this panel.</p>`, big ? 440 : 330)}`;
}

const screens = {};

screens["Main.dc.html"] = { title: "Species — 1280×720", w: 1280, h: 720, src: board({
  title: "Step I — Species", current: 0, picks: [], width: 1280,
  body: speciesBody(1280),
  footerHtml: footer("Start", "Next: Class", "Draft saved a moment ago")
}) };

const CLASSES24 = [["Barbarian", "fist"], ["Bard", "harp"], ["Cleric", "sun"], ["Druid", "leaf"], ["Fighter", "sword"], ["Monk", "hand"],
  ["Paladin", "shield"], ["Ranger", "bow"], ["Rogue", "dagger"], ["Sorcerer", "flame"], ["Warlock", "eye"], ["Wizard", "book"]];

screens["Class.dc.html"] = { title: "Class — 2024, with class art", w: 1280, h: 720, src: board({
  title: "Step II — Class", current: 1, picks: ["Human"], width: 1280,
  body: `${optionList("Class", CLASSES24, "Cleric", { note: "12 allowed" })}
${centre(`${heading("Cleric", "2024 rules · level 1")}
<div style="display: flex; flex-wrap: wrap; gap: 8px;">${chip("Hit die d8", "gold")}${chip("Primary: Wisdom", "gold")}${chip("Saves: Wis, Cha")}${chip("Light & medium armor, shields")}${chip("Simple weapons")}</div>
${placeholder("[The class description from its compendium entry.]")}
${sectionTitle("At level 1")}
${featureList([["Spellcasting", "3 cantrips, 4 prepared spells — chosen in step VII"], ["Divine Order", "Protector or Thaumaturge — chosen in step V"], ["Skills", "Choose 2 — in step V"]])}
<p style="margin: 0; font-size: 13px; color: ${C.faint};">Subclass: chosen at level 3, outside the creator.</p>`)}
${rightPanel(`<figure style="margin: 0; display: flex; flex-direction: column; align-items: center; gap: 10px;">
<div style="width: 280px; height: 280px; display: flex; align-items: center; justify-content: center; border-radius: 8px; background: radial-gradient(circle at 50% 35%, #3a3120 0%, #1d1a14 70%); border: 1px solid ${C.goldDeep}; color: ${C.gold};">${svg("sun", 120, C.gold, 1)}</div>
<figcaption style="font-size: 12px; color: ${C.faint}; text-align: center;">dnd5e class art (512 px) fills the frame</figcaption>
</figure>
${facts([["Hit points", "8 + Con"], ["Spellcasting", "Wisdom"], ["Armor", "Light, medium, shields"], ["Starting gear", "Items or 110 GP"]])}`)}`,
  footerHtml: footer("Species", "Next: Background", "Draft saved a moment ago")
}) };

function abilityRow(abbr, name, score, cost) {
  const btn = (g, label, disabled) => `<button type="button" aria-label="${label} ${name}" ${disabled ? 'disabled="" ' : ""}style="width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; background: ${disabled ? C.panel : C.raised}; color: ${disabled ? C.faint : C.text}; border: 1px solid ${C.line}; border-radius: 6px;">${svg(g, 18)}</button>`;
  return `<div style="display: flex; align-items: center; gap: 14px; padding: 8px 14px; background: ${C.panel}; border: 1px solid ${C.lineSoft}; border-radius: 6px;">
<span style="width: 150px; display: flex; flex-direction: column;"><span style="font-family: {{display}}; font-size: 16px; font-weight: 600;">${name}</span><span style="font-size: 12px; color: ${C.faint}; letter-spacing: 0.1em;">${abbr}</span></span>
${btn("minus", "Lower", score <= 8)}
<span style="width: 56px; text-align: center; font-family: {{display}}; font-size: 28px; font-weight: 700; color: ${C.text};">${score}</span>
${btn("plus", "Raise", score >= 15)}
<span style="flex-grow: 1; text-align: right; font-size: 14px; color: ${C.muted};">costs ${cost}</span>
</div>`;
}

screens["Abilities.dc.html"] = { title: "Ability scores — point buy", w: 1280, h: 720, src: board({
  title: "Step IV — Ability scores", current: 3, picks: ["Human", "Cleric", "Sage"], width: 1280,
  body: `${centre(`${heading("Ability scores", "Point buy · 27 points · each score 8–15 before increases")}
<div role="tablist" aria-label="Method" style="display: flex; gap: 0; border: 1px solid ${C.line}; border-radius: 8px; overflow: hidden; width: max-content;">
<button type="button" role="tab" aria-selected="true" style="height: 44px; padding: 0 22px; background: ${C.raised}; color: ${C.gold}; border: 0; border-right: 1px solid ${C.line}; font-family: {{display}}; font-size: 14px; font-weight: 700; letter-spacing: 0.05em;">Point buy</button>
<button type="button" role="tab" aria-selected="false" style="height: 44px; padding: 0 22px; background: transparent; color: ${C.muted}; border: 0; border-right: 1px solid ${C.line}; font-family: {{display}}; font-size: 14px; letter-spacing: 0.05em;">Standard array</button>
<button type="button" role="tab" aria-selected="false" style="height: 44px; padding: 0 22px; background: transparent; color: ${C.muted}; border: 0; font-family: {{display}}; font-size: 14px; letter-spacing: 0.05em;">Roll 4d6</button>
</div>
<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px;">
${abilityRow("STR", "Strength", 8, 0)}
${abilityRow("INT", "Intelligence", 12, 4)}
${abilityRow("DEX", "Dexterity", 13, 5)}
${abilityRow("WIS", "Wisdom", 15, 9)}
${abilityRow("CON", "Constitution", 14, 7)}
${abilityRow("CHA", "Charisma", 10, 2)}
</div>
<p style="margin: 0; font-size: 13px; color: ${C.faint};">Rolling posts the dice to chat for everyone to see; rolled scores can't be rolled again without starting over.</p>`)}
${rightPanel(`<div style="display: flex; flex-direction: column; align-items: center; gap: 4px;">
<span style="font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: ${C.faint};">Points left</span>
<span style="font-family: {{display}}; font-size: 72px; font-weight: 700; line-height: 1; color: ${C.gold};">0</span>
<span style="font-size: 13px; color: ${C.muted};">of 27 spent exactly</span>
</div>
<table style="width: 100%; border-collapse: collapse; font-size: 14px;">
<thead><tr style="color: ${C.faint}; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;"><th scope="col" style="text-align: left; padding: 6px 0; font-weight: 500;">Final</th><th scope="col" style="text-align: right; font-weight: 500;">Base</th><th scope="col" style="text-align: right; font-weight: 500;">Sage</th><th scope="col" style="text-align: right; font-weight: 500;">Score</th><th scope="col" style="text-align: right; font-weight: 500;">Mod</th></tr></thead>
<tbody>
${[["STR", 8, "", 8, "−1"], ["DEX", 13, "", 13, "+1"], ["CON", 14, "+1", 15, "+2"], ["INT", 12, "", 12, "+1"], ["WIS", 15, "+2", 17, "+3"], ["CHA", 10, "", 10, "+0"]].map(([a, b, inc, s, m]) =>
  `<tr style="border-top: 1px solid ${C.lineSoft};"><th scope="row" style="text-align: left; padding: 7px 0; font-weight: 600; color: ${C.text};">${a}</th><td style="text-align: right; color: ${C.muted};">${b}</td><td style="text-align: right; color: ${C.gold};">${inc}</td><td style="text-align: right; font-weight: 700;">${s}</td><td style="text-align: right; color: ${C.muted};">${m}</td></tr>`).join("\n")}
</tbody>
</table>
<p style="margin: 0; font-size: 12px; color: ${C.faint}; text-align: center;">Increases come from your background (2024) or species (2014).</p>`)}`,
  footerHtml: footer("Background", "Next: Choices", "Draft saved a moment ago")
}) };

function choiceItem(title, status, tone, selected) {
  const color = tone === "done" ? C.ok : tone === "todo" ? C.warn : C.muted;
  const glyph = tone === "done" ? "check" : tone === "todo" ? "alert" : "lock";
  return `<button type="button" aria-pressed="${selected}" style="display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 6px 12px; background: ${selected ? C.raised : "transparent"}; border: 1px solid ${selected ? C.goldDeep : "transparent"}; border-radius: 6px; color: ${C.text}; text-align: left; font-family: {{body}};">
<span style="color: ${color}; display: flex;">${svg(glyph, 18, color)}</span>
<span style="display: flex; flex-direction: column;"><span style="font-size: 14px; font-weight: ${selected ? 700 : 500};">${esc(title)}</span><span style="font-size: 12px; color: ${C.faint};">${esc(status)}</span></span>
</button>`;
}

function skill(name, state) {
  // state: "on" | "off" | "held" | "off-list"
  const on = state === "on" || state === "held";
  const disabled = state === "held";
  return `<label style="display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 14px; background: ${state === "on" ? "#2c2416" : C.panel}; border: 1px solid ${state === "on" ? C.goldDeep : C.lineSoft}; border-radius: 6px; font-size: 15px; color: ${disabled ? C.faint : C.text};">
<input type="checkbox" ${on ? 'checked="" ' : ""}${disabled ? 'disabled="" ' : ""}style="width: 18px; height: 18px; accent-color: ${C.gold};">
<span style="flex-grow: 1;">${esc(name)}</span>
${state === "held" ? `<span style="font-size: 12px; color: ${C.faint};">from Sage</span>` : ""}
</label>`;
}

screens["Choices.dc.html"] = { title: "Choices — a Trait step", w: 1280, h: 720, src: board({
  title: "Step V — Choices", current: 4, picks: ["Human", "Cleric", "Sage", "Point buy"], width: 1280,
  body: `<section aria-label="Choices to make" style="width: 300px; flex-shrink: 0; display: flex; flex-direction: column; gap: 4px; padding: 18px 14px; background: ${C.base}; border-right: 1px solid ${C.line};">
<h2 style="margin: 0; padding: 0 8px 8px; font-family: {{display}}; font-size: 13px; letter-spacing: 0.14em; text-transform: uppercase; color: ${C.muted};">Choices · 3 of 5 made</h2>
${choiceItem("Human · Skillful", "Stealth", "done", false)}
${choiceItem("Human · Versatile", "Magic Initiate (Cleric)", "done", false)}
${choiceItem("Sage · Ability increases", "+2 Wisdom, +1 Constitution", "done", false)}
${choiceItem("Cleric · Skill proficiencies", "Choose 2 — 1 chosen", "todo", true)}
${choiceItem("Cleric · Divine Order", "Protector or Thaumaturge", "todo", false)}
</section>
${centre(`${heading("Skill proficiencies", "Cleric · choose 2 from the class list")}
<div style="display: flex; align-items: center; gap: 12px;">${chip("1 of 2 chosen", "gold")}<span style="font-size: 13px; color: ${C.faint};">Skills you already have are marked and can't be picked again.</span></div>
<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 14px;">
${skill("History", "held")}
${skill("Insight", "on")}
${skill("Medicine", "off")}
${skill("Persuasion", "off")}
${skill("Religion", "off")}
</div>`)}
${rightPanel(`<div style="width: 100%; display: flex; flex-direction: column; gap: 12px;">
${sectionTitle("Build so far")}
${facts([["Skills", "Arcana, History, Insight, Stealth"], ["Tools", "Calligrapher's supplies"], ["Feats", "Magic Initiate"], ["Languages", "Common, +2"]])}
</div>
<div style="width: 100%; padding: 14px; background: ${C.panel}; border: 1px solid ${C.lineSoft}; border-radius: 6px; font-size: 13px; line-height: 1.5; color: ${C.muted};">Each change rebuilds the character from your choices, so this panel is always what the GM will create.</div>`)}`,
  footerHtml: footer("Abilities", "Next: Equipment", "2 choices left")
}) };

function radioCard(label, lines, checked, name) {
  return `<label style="display: flex; gap: 12px; padding: 12px 14px; background: ${checked ? "#2c2416" : C.panel}; border: 1px solid ${checked ? C.goldDeep : C.lineSoft}; border-radius: 6px; cursor: pointer;">
<input type="radio" name="${name}" ${checked ? 'checked="" ' : ""}style="width: 18px; height: 18px; margin-top: 2px; accent-color: ${C.gold};">
<span style="display: flex; flex-direction: column; gap: 3px;"><span style="font-size: 15px; font-weight: 600; color: ${C.text};">${esc(label)}</span>${lines.map(l => `<span style="font-size: 13px; color: ${C.muted};">${esc(l)}</span>`).join("")}</span>
</label>`;
}

screens["Equipment.dc.html"] = { title: "Equipment — 2014 with rolled wealth", w: 1280, h: 720, src: board({
  title: "Step VI — Equipment", current: 5, picks: ["Hill Dwarf", "Cleric", "Acolyte", "Standard array", "5 of 5"], width: 1280,
  body: `${centre(`${heading("Starting equipment", "Class and background are separate choices")}
<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; min-height: 0;">
<div style="display: flex; flex-direction: column; gap: 10px;">
${sectionTitle("Cleric")}
<div role="radiogroup" aria-label="Weapon" style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;">
${radioCard("Mace", [], false, "w")}
${radioCard("Warhammer", ["You're proficient (Hill Dwarf)"], true, "w")}
</div>
<div role="radiogroup" aria-label="Armor" style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px;">
${radioCard("Scale mail", [], false, "a")}
${radioCard("Leather", [], false, "a")}
${radioCard("Chain mail", ["Proficient"], true, "a")}
</div>
<div role="radiogroup" aria-label="Ranged" style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;">
${radioCard("Light crossbow, 20 bolts", [], false, "r")}
${radioCard("Any simple weapon", ["Handaxe ▾"], true, "r")}
</div>
<p style="margin: 0; font-size: 13px; color: ${C.muted};">Also: shield, holy symbol, priest's pack or explorer's pack.</p>
</div>
<div style="display: flex; flex-direction: column; gap: 10px;">
${sectionTitle("Acolyte")}
${radioCard("Take the Acolyte's equipment", ["Holy symbol, prayer book, 5 sticks of incense,", "vestments, common clothes, pouch with 15 gp"], true, "b")}
<div style="margin-top: 6px; padding: 14px; background: ${C.panel}; border: 1px dashed ${C.goldDeep}; border-radius: 6px; display: flex; flex-direction: column; gap: 10px;">
<span style="font-size: 14px; color: ${C.text};">Or take the Cleric's starting wealth instead of its items: <strong style="color: ${C.gold};">5d4 × 10 gp</strong></span>
<button type="button" style="align-self: flex-start; display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 16px; background: ${C.raised}; color: ${C.text}; border: 1px solid ${C.goldDeep}; border-radius: 6px; font-family: {{display}}; font-size: 14px; font-weight: 600;">${svg("dice", 18, C.gold)}Roll for gold</button>
<span style="font-size: 12px; color: ${C.faint};">The roll is posted to chat. Your background's equipment is kept either way.</span>
</div>
</div>
</div>`)}
${rightPanel(`<div style="width: 100%; display: flex; flex-direction: column; gap: 12px;">
${sectionTitle("You'll carry")}
${facts([["Items", "14"], ["Weight", "96 lb"], ["Gold", "15 gp"], ["Armor class", "18 with shield"]])}
</div>
<ul style="width: 100%; margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; font-size: 14px; color: ${C.muted};">
<li>Warhammer · Chain mail · Shield</li><li>Handaxe · Holy symbol</li><li>Priest's pack (9 items)</li><li>Acolyte's pouch (15 gp)</li>
</ul>`)}`,
  footerHtml: footer("Choices", "Next: Spells", "Draft saved a moment ago")
}) };

function spell(name, state, school) {
  const sel = state === "on";
  const locked = state === "known";
  return `<label style="display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 12px; background: ${sel ? "#2c2416" : C.panel}; border: 1px solid ${sel ? C.goldDeep : C.lineSoft}; border-radius: 6px; color: ${locked ? C.faint : C.text}; font-size: 14px;">
<input type="checkbox" ${sel || locked ? 'checked="" ' : ""}${locked ? 'disabled="" ' : ""}style="width: 18px; height: 18px; accent-color: ${C.gold};">
<span style="flex-grow: 1;">${esc(name)}</span><span style="font-size: 12px; color: ${C.faint};">${locked ? "from High Elf" : esc(school)}</span>
</label>`;
}

screens["Spells.dc.html"] = { title: "Spells — Wizard spellbook", w: 1280, h: 720, src: board({
  title: "Step VII — Spells", current: 6, picks: ["High Elf", "Wizard", "Sage", "Point buy", "5 of 5", "Items"], width: 1280,
  body: `${centre(`${heading("Spells", "Wizard · level 1 · spellcasting ability Intelligence")}
<div role="tablist" aria-label="Spell lists" style="display: flex; gap: 8px;">
<button type="button" role="tab" aria-selected="true" style="height: 44px; padding: 0 18px; background: ${C.raised}; color: ${C.gold}; border: 1px solid ${C.goldDeep}; border-radius: 6px; font-family: {{display}}; font-size: 14px; font-weight: 700;">Cantrips 2 / 3</button>
<button type="button" role="tab" aria-selected="false" style="height: 44px; padding: 0 18px; background: transparent; color: ${C.muted}; border: 1px solid ${C.line}; border-radius: 6px; font-family: {{display}}; font-size: 14px;">Spellbook 0 / 6</button>
<button type="button" role="tab" aria-selected="false" style="height: 44px; padding: 0 18px; background: transparent; color: ${C.muted}; border: 1px solid ${C.line}; border-radius: 6px; font-family: {{display}}; font-size: 14px;">Prepared 0 / 4</button>
</div>
<div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 10px;">
${spell("Acid Splash", "off", "Conjuration")}${spell("Chill Touch", "off", "Necromancy")}${spell("Dancing Lights", "off", "Evocation")}
${spell("Fire Bolt", "known", "")}${spell("Light", "on", "Evocation")}${spell("Mage Hand", "on", "Conjuration")}
${spell("Mending", "off", "Transmutation")}${spell("Message", "off", "Transmutation")}${spell("Minor Illusion", "off", "Illusion")}
${spell("Poison Spray", "off", "Conjuration")}${spell("Prestidigitation", "off", "Transmutation")}${spell("Ray of Frost", "off", "Evocation")}
${spell("Shocking Grasp", "off", "Evocation")}${spell("True Strike", "off", "Divination")}
</div>`)}
${rightPanel(`<div style="width: 100%; display: flex; flex-direction: column; gap: 14px;">
${sectionTitle("Your spellcasting")}
${facts([["Cantrips", "3 (+1 from High Elf)"], ["Spellbook", "6 level-1 spells"], ["Prepared", "4 from the book"], ["Slots", "2 × level 1"]])}
</div>
<div style="width: 100%; padding: 14px; background: ${C.panel}; border: 1px solid ${C.lineSoft}; border-radius: 6px; font-size: 13px; line-height: 1.5; color: ${C.muted};">[Selected spell's description from its compendium entry.]</div>`)}`,
  footerHtml: footer("Equipment", "Next: Details", "1 cantrip, 6 spellbook spells and 4 prepared left")
}) };

screens["Review.dc.html"] = { title: "Review — with problems to fix", w: 1280, h: 720, src: board({
  title: "Step X — Review", current: 9, picks: ["High Elf", "Wizard", "Sage", "Point buy", "5 of 5", "Items", "3 · 6 · 4", "Ilyra", "Uploaded"], width: 1280,
  body: `${centre(`<div style="display: flex; gap: 24px; align-items: center;">
<div style="width: 112px; height: 112px; flex-shrink: 0; border-radius: 50%; border: 3px solid ${C.gold}; background: radial-gradient(circle at 50% 35%, #3a3120, ${C.panel}); display: flex; align-items: center; justify-content: center; color: ${C.muted};">${svg("user", 56, C.muted, 1.2)}</div>
${heading("Ilyra", "High Elf Wizard · level 1 · Sage")}
</div>
<div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px;">
${[["Hit points", "7"], ["Armor class", "13"], ["Speed", "30 ft"], ["Proficiency", "+2"]].map(([k, v]) => `<div style="padding: 14px; background: ${C.panel}; border: 1px solid ${C.lineSoft}; border-radius: 6px; display: flex; flex-direction: column; gap: 4px;"><span style="font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: ${C.faint};">${k}</span><span style="font-family: {{display}}; font-size: 30px; font-weight: 700;">${v}</span></div>`).join("")}
</div>
<div style="display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px;">
${[["STR", 8, "−1"], ["DEX", 16, "+3"], ["CON", 13, "+1"], ["INT", 17, "+3"], ["WIS", 12, "+1"], ["CHA", 10, "+0"]].map(([a, s, m]) => `<div style="padding: 10px; text-align: center; background: ${C.panel}; border: 1px solid ${C.lineSoft}; border-radius: 6px;"><div style="font-size: 11px; letter-spacing: 0.12em; color: ${C.faint};">${a}</div><div style="font-family: {{display}}; font-size: 24px; font-weight: 700;">${s}</div><div style="font-size: 13px; color: ${C.muted};">${m}</div></div>`).join("")}
</div>
${facts([["Skills", "Arcana, History, Insight, Perception"], ["Spells", "Fire Bolt, Light, Mage Hand + 6 in the book"], ["Equipment", "Quarterstaff, spellbook, scholar's pack…"], ["Features", "Darkvision, Fey Ancestry, Trance, Arcane Recovery"]])}`)}
${rightPanel(`<div style="width: 100%; display: flex; flex-direction: column; gap: 12px;">
<h2 style="margin: 0; display: flex; align-items: center; gap: 8px; font-family: {{display}}; font-size: 16px; color: ${C.warn};">${svg("alert", 18, C.warn)}2 things to fix</h2>
<div style="padding: 12px 14px; background: #2a1e14; border: 1px solid #5a3d22; border-radius: 6px; display: flex; flex-direction: column; gap: 6px;"><span style="font-size: 14px; color: ${C.text};">Prepare 4 spells from your spellbook (1 prepared).</span><a href="#spells" style="font-size: 14px; font-weight: 600;">Go to Spells</a></div>
<div style="padding: 12px 14px; background: #2a1e14; border: 1px solid #5a3d22; border-radius: 6px; display: flex; flex-direction: column; gap: 6px;"><span style="font-size: 14px; color: ${C.text};">Choose one language from High Elf.</span><a href="#choices" style="font-size: 14px; font-weight: 600;">Go to Choices</a></div>
</div>
<p style="margin: 0; font-size: 12px; color: ${C.faint};">The same checks run again on the GM's side when you create the character.</p>`)}`,
  footerHtml: footer("Portrait", "Create character", "Fix the list to continue", { nextDisabled: true })
}) };

function stateCard(glyph, tone, title, body, actions) {
  const color = { gold: C.gold, ok: C.ok, warn: C.warn, bad: C.bad }[tone];
  return `<section style="display: flex; flex-direction: column; gap: 14px; padding: 26px; background: ${C.panel}; border: 1px solid ${C.line}; border-top: 3px solid ${color}; border-radius: 8px;">
<div style="display: flex; align-items: center; gap: 12px;"><span style="color: ${color}; display: flex;">${svg(glyph, 28, color)}</span><h2 style="margin: 0; font-family: {{display}}; font-size: 22px; font-weight: 700; color: ${C.text};">${esc(title)}</h2></div>
${body}
<div style="display: flex; gap: 10px; margin-top: auto;">${actions}</div>
</section>`;
}
const smallBtn = (t, primary) => `<button type="button" style="height: 44px; padding: 0 18px; background: ${primary ? C.gold : "transparent"}; color: ${primary ? "#1a1408" : C.text}; border: ${primary ? "0" : `1px solid ${C.line}`}; border-radius: 6px; font-family: {{display}}; font-size: 14px; font-weight: ${primary ? 700 : 500};">${esc(t)}</button>`;
const para = t => `<p style="margin: 0; font-size: 15px; line-height: 1.55; color: ${C.muted};">${t}</p>`;

screens["States.dc.html"] = { title: "Special states", w: 1280, h: 720, src: board({
  title: "Special states", current: null, picks: [], width: 1280,
  body: `<div style="flex-grow: 1; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; padding: 30px 34px;">
${stateCard("hourglass", "gold", "Waiting for a GM", para("No GM is online, so <strong style=\"color: " + C.text + ";\">Ilyra</strong> will be created as soon as one joins. Your portrait is kept with it. You can close this window."), smallBtn("Close", true))}
${stateCard("check", "ok", "Ilyra is ready", para("Your GM created your character while you were away. It's now your assigned character.") + para("The portrait couldn't be saved: uploads are turned off. Ask your GM, or upload one later from the sheet."), smallBtn("Open character sheet", true) + smallBtn("Dismiss", false))}
${stateCard("alert", "warn", "This step can't be completed here", para("Your GM's settings leave too few options for <strong style=\"color: " + C.text + ";\">Fighting Style</strong> (1 needed, 0 allowed). Ask your GM to allow more options, or choose a different class."), smallBtn("Back to Class", true))}
${stateCard("lock", "bad", "Your GM couldn't create Ilyra", `<ul style="margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 8px; font-size: 15px; color: ${C.muted};"><li>A class skill isn't on the class list. <a href="#choices">Go to Choices</a></li><li>Your rolled scores don't match the roll in chat. <a href="#abilities">Go to Abilities</a></li></ul>`, smallBtn("Fix and resubmit", true) + smallBtn("Start over", false))}
</div>`,
  footerHtml: ""
}) };

screens["Species-1920.dc.html"] = { title: "Species — 1920×1080, pairing B", w: 1920, h: 1080, src: board({
  title: "Step I — Species (1920)", current: 0, picks: [], width: 1920, height: 1080, pairing: "B",
  body: speciesBody(1920, true),
  footerHtml: footer("Start", "Next: Class", "Draft saved a moment ago")
}) };

/* ---------------------------------------------------------------- */
/*  Canvas index                                                    */
/* ---------------------------------------------------------------- */

const layout = [
  ["Main.dc.html", 0, 0], ["Class.dc.html", 1360, 0], ["Abilities.dc.html", 2720, 0],
  ["Choices.dc.html", 0, 840], ["Equipment.dc.html", 1360, 840], ["Spells.dc.html", 2720, 840],
  ["Review.dc.html", 0, 1680], ["States.dc.html", 1360, 1680],
  ["Species-1920.dc.html", 0, 2520]
];
const boards = {};
for ( const [file, x, y] of layout ) {
  const s = screens[file];
  fs.writeFileSync(path.join(OUT, file), s.src);
  boards[file] = { x, y, w: s.w, h: s.h, title: s.title };
}
const canvas = {
  v: 3,
  createdOnFiles: { v: 1, at: new Date().toISOString().replace(/\.\d+Z$/, "Z") },
  title: "Character Creator Wizard Mockups",
  launch: { view: "canvas" },
  pages: [],
  boards,
  order: layout.map(l => l[0]),
  notes: {
    heading: { x: 0, y: -300, text: "Character Creator — wizard mockups (PLAN 3.0)", kind: "title1", maxW: 3920 }
  },
  designSystems: []
};
fs.writeFileSync(path.join(OUT, "canvas.json"), JSON.stringify(canvas, null, 2));
console.log(Object.keys(boards).join(", "));
