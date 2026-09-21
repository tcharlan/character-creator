/**
 * Dev-only: the README's screenshots (PLAN 6.1), taken from the local dev world so they can be taken again for
 * each release. It walks a character through the wizard as a player and opens the GM's two screens, saving each
 * view into docs/images/. Localhost only; it leaves the player's draft as it found it.
 *
 *   node dev/screenshots.mjs [--world legacy-test]
 *
 * Needs the dev server running with that world active and nobody joined as the users it uses (CC_PLAYER,
 * default "Player B", and CC_GM, default "Gamemaster").
 */

/* global game, foundry, document -- used inside page.evaluate(), which runs in the browser */

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(resolve(HERE, ".."), "docs", "images");
const BASE = new URL(process.env.FOUNDRY_URL ?? "http://localhost:30001");
const PLAYER = process.env.CC_PLAYER ?? "Player B";
const GM = process.env.CC_GM ?? "Gamemaster";

if ( !["localhost", "127.0.0.1", "[::1]"].includes(BASE.hostname) ) {
  console.error(`Refusing to run against ${BASE.href}: screenshots come from the local dev instance only.`);
  process.exit(2);
}

async function joinAs(browser, name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(new URL("/join", BASE).href);
  await page.locator('select[name="userid"] option', { hasText: name }).first().waitFor({ state: "attached", timeout: 30_000 });
  await page.selectOption('select[name="userid"]', { label: name });
  await Promise.all([page.waitForURL(/\/game/, { timeout: 30_000 }), page.click('button[name="join"]')]);
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 180_000 });
  // The headless browser's "no hardware acceleration" warning isn't part of the module.
  await page.evaluate(() => document.getElementById("notifications")?.remove());
  return { context, page };
}

/** Save one application window. */
async function shot(page, id, name) {
  await page.evaluate(() => document.getElementById("notifications")?.remove());
  await page.waitForTimeout(700);
  await page.locator(`#${id}`).screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`[screenshots] ${name}.png`);
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] });
try {
  const player = await joinAs(browser, PLAYER);
  const id = "character-creator-wizard";
  const step = async (name, go) => {
    await player.page.evaluate(go);
    await shot(player.page, id, name);
  };

  await player.page.evaluate(async () => {
    const ID = "character-creator";
    globalThis.ccSaved = game.user.getFlag(ID, "draft") ?? null;
    await game.user.unsetFlag(ID, "draft");
    globalThis.ccApp = await game.modules.get(ID).api.openWizard();
    await globalThis.ccApp.settle();
  });
  await shot(player.page, id, "01-start");

  await step("02-species", async () => {
    const ID = "character-creator";
    const app = globalThis.ccApp;
    const { getCatalog } = await import(`/modules/${ID}/scripts/catalog/catalog.mjs`);
    const catalog = await getCatalog();
    const norm = u => u.replace(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item.");
    const find = (category, name) => catalog.byCategory[category].find(e => e.name === name) ?? catalog.byCategory[category][0];
    const legacy = game.settings.get("dnd5e", "rulesVersion") === "legacy";
    globalThis.ccPicks = {
      species: norm(find("species", legacy ? "High Elf" : "Elf, High").uuid),
      class: norm(find("class", "Wizard").uuid),
      background: norm(find("background", legacy ? "Acolyte" : "Sage").uuid)
    };
    await app.goTo("species");
    await app.pick(globalThis.ccPicks.species);
    await app.settle();
  });

  await step("03-class", async () => {
    const app = globalThis.ccApp;
    await app.goTo("class");
    await app.pick(globalThis.ccPicks.class);
    await app.goTo("background");
    await app.pick(globalThis.ccPicks.background);
    await app.goTo("class");
    await app.settle();
  });

  await step("04-abilities", async () => {
    const app = globalThis.ccApp;
    await app.goTo("abilities");
    await app.chooseMethod("standardArray");
    const values = { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 };
    for ( const [key, value] of Object.entries(values) ) await app.assign(key, value);
    await app.settle();
  });

  await step("05-choices", async () => {
    const app = globalThis.ccApp;
    await app.goTo("choices");
    await app.settle();
    const skills = app.build.results.find(r => (r.type === "Trait") && (r.options?.allowed ?? []).some(k => k.startsWith("skills:")));
    if ( skills ) await app.openChoice(skills.key);
    await new Promise(r => setTimeout(r, 1500));   // the skill explanations arrive from the compendium
    await app.render({ parts: ["body"] });
  });

  await step("06-equipment", async () => {
    const app = globalThis.ccApp;
    await app.goTo("equipment");
    await app.settle();
  });

  await step("07-spells", async () => {
    const app = globalThis.ccApp;
    await app.goTo("spells");
    await app.settle();
    await new Promise(r => setTimeout(r, 1500));   // the spell descriptions arrive from the compendium
    await app.render({ parts: ["body"] });
  });

  await step("08-details", async () => {
    const app = globalThis.ccApp;
    await app.goTo("details");
    await app.setDetail("name", "Elowen Brightquill");
    await app.settle();
  });

  // The review shows a finished character: the tests' own walkthrough fills in every step (dev instance only —
  // the Quench batches are there because the module is linked from the repository).
  await step("09-review", async () => {
    const ID = "character-creator";
    await globalThis.ccApp.close();
    await game.user.unsetFlag(ID, "draft");
    const { walkWizard } = await import(`/modules/${ID}/quench/wizard.mjs`);
    globalThis.ccApp = await game.modules.get(ID).api.openWizard();
    await globalThis.ccApp.settle();
    await walkWizard(globalThis.ccApp, { name: "Brenna Stoutheart" });
    await globalThis.ccApp.settle();
  });

  await player.page.evaluate(async () => {
    const ID = "character-creator";
    await globalThis.ccApp.close();
    if ( globalThis.ccSaved ) await game.user.setFlag(ID, "draft", globalThis.ccSaved);
    else await game.user.unsetFlag(ID, "draft");
  });
  await player.context.close();

  const gm = await joinAs(browser, GM);
  await gm.page.evaluate(async () => {
    const app = await game.modules.get("character-creator").api.openRestrictions();
    await app.show("class");
  });
  await shot(gm.page, "character-creator-restrictions", "10-gm-allowed-content");
  await gm.page.evaluate(async () => {
    foundry.applications.instances.get("character-creator-restrictions")?.close();
    await game.modules.get("character-creator").api.openPending();
  });
  await shot(gm.page, "character-creator-pending", "11-gm-pending");
  await gm.context.close();
} finally {
  await browser.close();
}
