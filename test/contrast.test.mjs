import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/*
 * The palette has to be readable (PLAN 5.2, WCAG AA): every text colour against every surface it can sit on.
 * The values come from the stylesheet itself, so a change to the palette is checked here rather than by eye.
 */

const css = await readFile(new URL("../styles/character-creator.css", import.meta.url), "utf8");

/** A custom property's value from the `.character-creator` block. */
function token(name) {
  const found = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"));
  assert.ok(found, `--${name} is missing`);
  return found[1];
}

const channel = v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const luminance = hex => {
  const [r, g, b] = hex.replace("#", "").match(/../g).map(x => parseInt(x, 16) / 255).map(channel);
  return (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const SURFACES = ["cc-ground", "cc-base", "cc-panel", "cc-raised"];
const TEXT = ["cc-text", "cc-muted", "cc-faint", "cc-gold", "cc-ok", "cc-warn", "cc-bad"];

test("every text colour is readable on every surface (WCAG AA, 4.5:1)", () => {
  const poor = [];
  for ( const text of TEXT ) {
    for ( const surface of SURFACES ) {
      const value = ratio(token(text), token(surface));
      if ( value < 4.5 ) poor.push(`${text} on ${surface}: ${value.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(poor, []);
});

test("the gold accent is readable as a line as well as as text (3:1)", () => {
  // Borders and the focus outline are drawn in gold: they only have to stand out, not be read.
  for ( const surface of SURFACES ) {
    assert.ok(ratio(token("cc-gold-deep"), token(surface)) >= 3,
      `cc-gold-deep on ${surface}: ${ratio(token("cc-gold-deep"), token(surface)).toFixed(2)}:1`);
  }
});

test("motion is asked for, not assumed", () => {
  assert.match(css, /@media \(prefers-reduced-motion: no-preference\)/,
    "transitions belong inside a no-preference query, so a player who asks for less gets none");
});

test("text stays readable over a step's backdrop at its brightest (D28)", () => {
  // The worst case is a white picture: darkened by the brightness filter, faded over the ground by the opacity.
  const number = name => {
    const found = css.match(new RegExp(`--${name}:\\s*([0-9.]+)`));
    assert.ok(found, `--${name} is missing`);
    return Number(found[1]);
  };
  const opacity = number("cc-splash-art-opacity");
  const brightness = number("cc-splash-art-brightness");
  const ground = token("cc-ground").replace("#", "").match(/../g).map(x => parseInt(x, 16));
  const worst = `#${ground.map(g => Math.round((255 * brightness * opacity) + (g * (1 - opacity))))
    .map(v => v.toString(16).padStart(2, "0")).join("")}`;
  const poor = TEXT.map(text => [text, ratio(token(text), worst)]).filter(([, value]) => value < 4.5)
    .map(([text, value]) => `${text} on ${worst}: ${value.toFixed(2)}:1`);
  assert.deepEqual(poor, []);
});
