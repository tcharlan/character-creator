/**
 * Dev-only: draws the step sigils in assets/splash/ (D28) — the module's own line drawings, one per wizard step,
 * shown large and faded behind each step. They share a seal-like frame and one gold stroke; the colour and the
 * fading are the stylesheet's. Edit a drawing here and run:
 *
 *   node dev/sigils.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "assets", "splash");
const GOLD = "#d4ad57";
const C = 200;   // centre of the 400 × 400 drawing

const r2 = n => Math.round(n * 100) / 100;
const polar = (r, deg, cx = C, cy = C) => [r2(cx + (r * Math.cos((deg - 90) * Math.PI / 180))),
  r2(cy + (r * Math.sin((deg - 90) * Math.PI / 180)))];
const pts = list => list.map(p => p.join(",")).join(" ");

/** The seal every sigil sits in: two rings and twenty-four ticks between them. */
function frame() {
  const ticks = Array.from({ length: 24 }, (_, i) => {
    const [x1, y1] = polar(178, i * 15);
    const [x2, y2] = polar(i % 2 ? 184 : 188, i * 15);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }).join("");
  return `<circle cx="${C}" cy="${C}" r="192" stroke-width="3"/><circle cx="${C}" cy="${C}" r="174" stroke-width="1.5"/>${ticks}`;
}

/** A four-pointed star. */
const star = (cx, cy, r, w = r / 4) =>
  `<path d="M${cx} ${cy - r} L${cx + w} ${cy - w} L${cx + r} ${cy} L${cx + w} ${cy + w} L${cx} ${cy + r} L${cx - w} ${cy + w} L${cx - r} ${cy} L${cx - w} ${cy - w} Z"/>`;

/** A leaf: an almond shape from (x, y), pointing along `deg`. */
function leaf(x, y, deg, length = 26, width = 9) {
  const tip = polar(length, deg, x, y);
  const mid = polar(length / 2, deg, x, y);
  const a = polar(width, deg - 90, mid[0], mid[1]);
  const b = polar(width, deg + 90, mid[0], mid[1]);
  return `<path d="M${x} ${y} Q${a.join(" ")} ${tip.join(" ")} Q${b.join(" ")} ${x} ${y} Z"/>`;
}

const DRAWINGS = {
  // The start: an open doorway under a star — the way in.
  start: () => `
    <path d="M140 300 V185 A60 60 0 0 1 260 185 V300"/>
    <path d="M158 300 V190 A42 42 0 0 1 242 190 V300"/>
    <path d="M120 300 H280 M130 314 H270 M142 328 H258"/>
    <path d="M200 232 L186 300 M200 232 L214 300" stroke-width="1.5"/>
    ${star(200, 96, 26)}
    <circle cx="200" cy="96" r="6"/>`,

  // Species: mountains under a crescent moon, pines at their feet.
  species: () => `
    <path d="M52 292 L142 160 L184 214 L240 128 L348 292"/>
    <path d="M142 160 L128 181 L142 176 L154 186 L163 187 M240 128 L222 156 L240 148 L254 164 L262 158"/>
    <path d="M290 84 A34 34 0 1 0 318 138 A28 28 0 1 1 290 84 Z"/>
    ${[[104, 300], [128, 306], [272, 304], [298, 298]].map(([x, y]) =>
      `<path d="M${x} ${y - 46} L${x - 14} ${y - 18} H${x - 6} L${x - 18} ${y} H${x + 18} L${x + 6} ${y - 18} H${x + 14} Z"/>`).join("")}
    <path d="M60 318 H340" stroke-width="1.5"/>`,

  // Class: a shield over a crossed sword and staff.
  class: () => `
    <path d="M112 112 L288 288 M104 132 L132 104 M96 96 L118 118"/>
    <path d="M288 112 L112 288"/>
    <circle cx="298" cy="102" r="14"/>
    <path d="M200 124 L268 148 V214 C268 262 236 292 200 308 C164 292 132 262 132 214 V148 Z" fill="#0f1114"/>
    <path d="M200 142 L252 160 V214 C252 250 228 274 200 288 C172 274 148 250 148 214 V160 Z" stroke-width="1.5"/>
    ${star(200, 214, 30)}`,

  // Background: a road winding to the horizon, a signpost beside it.
  background: () => `
    <path d="M60 236 H340" stroke-width="1.5"/>
    <path d="M150 330 C170 290 250 290 214 262 C190 244 196 238 204 236"/>
    <path d="M250 330 C240 300 290 284 236 262 C214 252 210 240 208 236"/>
    <path d="M118 318 V128"/>
    <path d="M118 140 H196 L212 154 L196 168 H118 M118 186 H52 L38 200 L52 214 H118"/>
    <circle cx="300" cy="150" r="22"/>
    <path d="M300 112 V120 M300 180 V188 M262 150 H270 M330 150 H338 M273 123 L279 129 M321 171 L327 177 M273 177 L279 171 M321 129 L327 123" stroke-width="1.5"/>`,

  // Abilities: a twenty-sided die, seen face on.
  abilities: () => {
    const o = Array.from({ length: 6 }, (_, i) => polar(128, i * 60));
    const [top, right, left] = [polar(74, 0), polar(74, 120), polar(74, 240)];
    const edges = [[o[0], top], [o[1], top], [o[1], right], [o[2], right], [o[3], right], [o[3], left], [o[4], left],
      [o[5], left], [o[5], top]];
    return `<polygon points="${pts(o)}"/><polygon points="${pts([top, right, left])}"/>
      ${edges.map(([a, b]) => `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>`).join("")}
      <text x="200" y="${C + 22}" text-anchor="middle" font-family="Georgia, serif" font-size="32" fill="${GOLD}" stroke="none">20</text>`;
  },

  // Choices: a path that branches, and branches again.
  choices: () => `
    <path d="M200 320 V250 M200 250 C200 220 140 214 140 180 M200 250 V172 M200 250 C200 220 260 214 260 180"/>
    <path d="M140 180 C140 150 104 144 104 118 M140 180 C140 150 170 144 170 118 M260 180 C260 150 230 144 230 118 M260 180 C260 150 296 144 296 118 M200 172 V110"/>
    ${[[200, 320, 10], [200, 250, 8], [140, 180, 8], [260, 180, 8], [200, 172, 7]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#0f1114"/>`).join("")}
    ${[[104, 110], [170, 110], [200, 100], [230, 110], [296, 110]].map(([x, y]) => star(x, y, 12, 3)).join("")}`,

  // Equipment: an anvil with a hammer laid across it.
  equipment: () => `
    <path d="M96 188 H292 C292 214 262 222 238 222 V244 C238 256 250 262 262 266 V290 H138 V266 C150 262 162 256 162 244 V222 H140 C112 222 96 206 96 188 Z"/>
    <path d="M122 290 H278 V306 H122 Z"/>
    <path d="M180 170 L268 90" stroke-width="5"/>
    <path d="M236 96 L262 70 L300 108 L274 134 Z" fill="#0f1114"/>
    <path d="M120 150 L106 138 M132 136 L126 118 M148 132 L150 114" stroke-width="1.5"/>`,

  // Spells: a seven-pointed circle of warding.
  spells: () => {
    const seven = Array.from({ length: 7 }, (_, i) => polar(112, i * (360 / 7)));
    const heptagram = Array.from({ length: 7 }, (_, i) => seven[(i * 3) % 7]);
    const runes = Array.from({ length: 14 }, (_, i) => {
      const [x, y] = polar(146, (i * (360 / 14)) + 12.9);
      return `<circle cx="${x}" cy="${y}" r="${i % 2 ? 3 : 5}"/>`;
    }).join("");
    return `<circle cx="${C}" cy="${C}" r="132"/><circle cx="${C}" cy="${C}" r="160" stroke-width="1.5"/>
      <polygon points="${pts(heptagram)}"/>${seven.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="9" fill="#0f1114"/>`).join("")}
      <circle cx="${C}" cy="${C}" r="36"/>${star(C, C, 22, 6)}${runes}`;
  },

  // Details: a quill over a half-written page.
  details: () => `
    <path d="M110 110 H262 V300 H110 Z"/>
    <path d="M132 146 H240 M132 172 H232 M132 198 H240 M132 224 H200" stroke-width="1.5"/>
    <path d="M300 84 C250 110 214 170 196 250 C232 214 282 160 300 84 Z" fill="#0f1114"/>
    <path d="M300 84 C262 138 226 196 196 250 M196 250 L186 272" />
    <path d="M276 126 L262 118 M262 150 L246 140 M246 176 L230 164 M230 200 L214 188" stroke-width="1.5"/>
    <path d="M232 294 H292 L286 318 H238 Z"/>`,

  // Portrait: an oval frame with a figure in it.
  portrait: () => `
    <ellipse cx="200" cy="198" rx="92" ry="122"/>
    <ellipse cx="200" cy="198" rx="78" ry="108" stroke-width="1.5"/>
    <circle cx="200" cy="170" r="34"/>
    <path d="M136 280 C142 232 170 216 200 216 C230 216 258 232 264 280"/>
    ${star(200, 62, 14, 4)}
    <path d="M150 330 H250 M170 318 H230" stroke-width="1.5"/>`,

  // Review: a laurel wreath around a star, tied at the foot.
  review: () => {
    const leaves = [];
    for ( let i = 0; i < 8; i++ ) {
      const deg = 204 + (i * 18);
      leaves.push(leaf(...polar(112, deg), deg - 30), leaf(...polar(112, 360 - deg), 30 - deg));
      leaves.push(leaf(...polar(112, deg + 9), deg + 9 + 200, 20, 7), leaf(...polar(112, 351 - deg), 160 - (351 - deg) + 180, 20, 7));
    }
    const arc = (from, to, sweep) => `<path d="M${polar(112, from).join(" ")} A112 112 0 0 ${sweep} ${polar(112, to).join(" ")}"/>`;
    return `${arc(192, 344, 1)}${arc(168, 16, 0)}${leaves.join("")}${star(200, 196, 52, 14)}<circle cx="200" cy="196" r="10"/>
      <path d="M200 312 C184 300 170 306 172 318 C174 330 190 324 200 312 C210 324 226 330 228 318 C230 306 216 300 200 312 Z M200 312 L186 340 M200 312 L214 340" stroke-width="1.5"/>`;
  }
};

mkdirSync(OUT, { recursive: true });
for ( const [step, draw] of Object.entries(DRAWINGS) ) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" fill="none" stroke="${GOLD}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
  <!-- Character Creator: ${step} sigil. Original artwork, MIT like the rest of the module. -->
  ${frame()}
  ${draw().trim()}
</svg>
`;
  writeFileSync(join(OUT, `${step}.svg`), svg);
  console.log(`[sigils] ${step}.svg`);
}
