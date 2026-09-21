/**
 * Dev-only: the fresh-install test (PLAN 6.4). It installs the release zip into the local dev instance the way a
 * GM would — through Foundry's own "Install Module" with a manifest URL — creates a new dnd5e world with nothing
 * set up, enables the module, adds a player, and has that player create a character with the GM online.
 *
 *   node dev/release.mjs check        (builds dist/module.zip and dist/module.json from HEAD)
 *   node dev/fresh-install.mjs
 *
 * The manifest is served from this PC (127.0.0.1) rather than GitHub, because the repository is private until the
 * owner publishes it; the only difference from the release's module.json is the manifest and download URLs.
 *
 * The dev instance's Data/modules/character-creator is a link to this repository. It is parked outside Data while
 * the test runs and always put back afterwards (if a run is killed, the next run puts it back first). Everything
 * else the test makes — the world, the installed copy — is removed at the end. Localhost only.
 */

/* global game, foundry, CONST, User, fromUuid, document, location, ui -- used inside page.evaluate() */

import { createServer } from "node:http";
import { existsSync, lstatSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DIST = join(ROOT, "dist");
const BASE = new URL(process.env.FOUNDRY_URL ?? "http://localhost:30001");
const DATA = process.env.FOUNDRY_DATA ?? join(homedir(), "FoundryDev");
const MODULE_ID = "character-creator";
const LINK = join(DATA, "Data", "modules", MODULE_ID);
const PARKED = join(DATA, `${MODULE_ID}-dev-link-parked`);
const WORLD = "cc-fresh-install";
const GM = "Gamemaster";
const PLAYER = "Fresh Player";
const SERVE_PORT = 30011;

const log = msg => console.log(`[fresh-install] ${msg}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const url = path => new URL(path, BASE).href;

if ( !["localhost", "127.0.0.1", "[::1]"].includes(BASE.hostname) ) {
  console.error(`Refusing to run against ${BASE.href}: the fresh-install test uses the local dev instance only.`);
  process.exit(2);
}

/* -------------------------------------------- */
/*  The dev link                                */
/* -------------------------------------------- */

const isLink = path => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Put the dev link back, removing an installed copy in its place. Safe to call at any point. */
function restoreLink() {
  if ( !existsSync(PARKED) && !isLink(PARKED) ) return;
  if ( isLink(LINK) ) throw new Error(`Both ${LINK} and ${PARKED} are links — sort them out by hand`);
  if ( existsSync(LINK) ) {
    // A real directory: the copy this test installed. Never a link (checked above), so nothing in the repository.
    rmSync(LINK, { recursive: true, force: true });
    log("removed the installed copy");
  }
  renameSync(PARKED, LINK);
  if ( !isLink(LINK) ) throw new Error(`${LINK} was restored but isn't a link`);
  log("the dev link is back");
}

function parkLink() {
  if ( !isLink(LINK) ) throw new Error(`${LINK} isn't the dev link — stopping rather than touch it`);
  renameSync(LINK, PARKED);
  log(`parked the dev link at ${PARKED}`);
}

/* -------------------------------------------- */
/*  Foundry's setup routes                      */
/* -------------------------------------------- */

async function status() {
  try {
    const res = await fetch(url("/api/status"));
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

async function post(route, body) {
  const res = await fetch(url(route), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { text };
  }
  if ( !res.ok || json.error ) throw new Error(`${body.action ?? "request"}: HTTP ${res.status} ${json.error ?? text.slice(0, 300)}`);
  return json;
}

async function waitFor(test, what, ms) {
  const end = Date.now() + ms;
  while ( Date.now() < end ) {
    const s = await status();
    if ( test(s) ) return s;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function shutdownWorld(browser) {
  const s = await status();
  if ( !s ) throw new Error(`The dev server isn't running at ${BASE.href}`);
  if ( !s.active ) return;
  log(`returning ${s.world} to setup`);
  const gm = await joinAs(browser, GM);
  await gm.context.request.post(url("/setup"), { data: { shutdown: true } });
  await gm.context.close();
  await waitFor(x => x && !x.active, "the world to shut down", 60_000);
}

/* -------------------------------------------- */
/*  Browser                                     */
/* -------------------------------------------- */

async function joinAs(browser, name, errors = []) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  page.on("pageerror", err => errors.push(`${name}: ${err?.stack ?? err}`));
  page.on("console", msg => {
    if ( msg.type() === "error" ) errors.push(`${name}: ${msg.text()}`);
  });
  await page.goto(url("/join"));
  await page.locator('select[name="userid"] option', { hasText: name }).first().waitFor({ state: "attached", timeout: 30_000 });
  await page.selectOption('select[name="userid"]', { label: name });
  await Promise.all([page.waitForURL(/\/game/, { timeout: 30_000 }), page.click('button[name="join"]')]);
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 180_000 });
  return { context, page };
}

/* -------------------------------------------- */
/*  The manifest, served from this PC           */
/* -------------------------------------------- */

function serveRelease() {
  const manifest = JSON.parse(readFileSync(join(DIST, "module.json"), "utf8"));
  const zip = readFileSync(join(DIST, "module.zip"));
  const here = `http://127.0.0.1:${SERVE_PORT}`;
  manifest.manifest = `${here}/module.json`;
  manifest.download = `${here}/module.zip`;
  const server = createServer((req, res) => {
    if ( req.url === "/module.json" ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(manifest));
    } else if ( req.url === "/module.zip" ) {
      res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": zip.length });
      res.end(zip);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise(ok => server.listen(SERVE_PORT, "127.0.0.1", () => ok({ server, manifest })));
}

/* -------------------------------------------- */
/*  The test                                    */
/* -------------------------------------------- */

const checks = [];
const check = (ok, what) => {
  checks.push({ ok: !!ok, what });
  log(`${ok ? "ok  " : "FAIL"} ${what}`);
};

restoreLink();   // a run that was killed part-way
if ( !existsSync(join(DIST, "module.zip")) ) {
  console.error("No dist/module.zip — run `node dev/release.mjs check` first.");
  process.exit(2);
}

const browser = await chromium.launch({ channel: "msedge", headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] });
const { server, manifest } = await serveRelease();
const errors = [];
let worldMade = false;
try {
  await shutdownWorld(browser);
  parkLink();
  await post("/setup", { action: "resetPackages" });

  // 1. Install from the manifest URL, as a GM would.
  log(`installing from ${manifest.manifest}`);
  await post("/setup", { action: "installPackage", type: "module", id: MODULE_ID, manifest: manifest.manifest });
  const installed = JSON.parse(readFileSync(join(LINK, "module.json"), "utf8"));
  check(!isLink(LINK) && (installed.version === manifest.version), `installed v${installed.version} as a real directory`);
  check(!existsSync(join(LINK, "quench")) && !existsSync(join(LINK, "test")), "no tests or Quench batches installed");

  // 2. A new dnd5e world with nothing set up.
  if ( existsSync(join(DATA, "Data", "worlds", WORLD)) ) await post("/setup", { action: "uninstallPackage", type: "world", id: WORLD });
  await post("/create", { action: "createWorld", id: WORLD, title: "Fresh install test", system: "dnd5e" });
  worldMade = true;
  await post("/setup", { action: "launchWorld", world: WORLD });
  await waitFor(x => x?.active && (x.world === WORLD), "the new world", 300_000);
  log("the new world is running");

  // 3. The GM enables the module and adds a player — the only setup.
  const gm = await joinAs(browser, GM, errors);
  const rules = await gm.page.evaluate(async ({ id, player }) => {
    const config = game.settings.get("core", "moduleConfiguration");
    await game.settings.set("core", "moduleConfiguration", { ...config, [id]: true });
    await User.create({ name: player, role: CONST.USER_ROLES.PLAYER });
    return game.settings.get("dnd5e", "rulesVersion");
  }, { id: MODULE_ID, player: PLAYER });
  await gm.page.reload();
  await gm.page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 180_000 });
  check(await gm.page.evaluate(id => game.modules.get(id)?.active, MODULE_ID), `module enabled (${rules} rules)`);

  // 4. The player creates a character with the GM online.
  const player = await joinAs(browser, PLAYER, errors);
  await player.page.evaluate(() => ui.sidebar.changeTab("actors", "primary"));
  const entry = player.page.locator("#actors .cc-entry");
  await entry.waitFor({ timeout: 30_000 });
  check(/Create a character/.test(await entry.innerText()), "the Actors tab offers \"Create a character\"");
  await entry.click();
  await player.page.locator(`#${MODULE_ID}-wizard`).waitFor({ timeout: 30_000 });
  check(true, "the creator opens from that button");

  // The same walkthrough as the Quench batches, which the release doesn't include: its imports are pointed at
  // the installed copy and it is loaded from a blob.
  const walker = readFileSync(join(ROOT, "quench", "wizard.mjs"), "utf8");
  const result = await player.page.evaluate(async ({ source, id }) => {
    const base = `${location.origin}/modules/${id}/scripts/`;
    const code = source.replaceAll("\"../scripts/", `"${base}`).replaceAll("\"./", `"${location.origin}/modules/${id}/quench/`);
    const blob = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    const { walkWizard } = await import(blob);
    const app = foundry.applications.instances.get(`${id}-wizard`);
    await app.settle();
    if ( app.step === "start" ) {
      app.element.querySelector('[data-action="begin"]').click();
      await app.settle();
    }
    await walkWizard(app, { name: "Fresh Install Hero" });
    const problems = app.validation.errors.map(e => e.message ?? JSON.stringify(e));
    app.element.querySelector('[data-action="create"]').click();
    for ( let i = 0; i < 300 && (app.draft?.status !== "created"); i++ ) await new Promise(r => setTimeout(r, 200));
    const actor = app.draft?.result?.actorUuid ? await fromUuid(app.draft.result.actorUuid) : null;
    return {
      problems, status: app.draft?.status, name: actor?.name, level: actor?.system.details.level,
      items: actor?.items.size ?? 0, owner: !!actor?.isOwner, assigned: game.user.character?.id === actor?.id,
      error: JSON.stringify(app.draft?.result?.errors ?? []).slice(0, 400)
    };
  }, { source: walker, id: MODULE_ID });
  check(result.problems.length === 0, `the review had nothing to fix${result.problems.length ? `: ${result.problems.join("; ")}` : ""}`);
  check(result.status === "created", `the GM created the character${result.status === "created" ? "" : ` (status ${result.status}, ${result.error})`}`);
  check(result.name === "Fresh Install Hero" && result.level === 1, `"${result.name}", level ${result.level}, ${result.items} items`);
  check(result.owner && result.assigned, "the player owns it and it is their character");
  const actors = await gm.page.evaluate(() => game.actors.map(a => a.name));
  check(actors.includes("Fresh Install Hero"), "the GM sees it in the Actors tab");

  // Anything from this module in either console is a failure; core's own noise isn't the module's.
  const ours = errors.filter(e => e.includes(MODULE_ID));
  check(ours.length === 0, `no errors from the module${ours.length ? `:\n    ${ours.join("\n    ")}` : ""}`);
  if ( errors.length > ours.length ) log(`other console errors (not the module's):\n    ${errors.filter(e => !ours.includes(e)).join("\n    ")}`);

  await player.context.close();
  await gm.page.evaluate(() => document.getElementById("notifications")?.remove());
  await gm.context.request.post(url("/setup"), { data: { shutdown: true } });
  await gm.context.close();
  await waitFor(x => x && !x.active, "the world to shut down", 60_000);
} catch ( err ) {
  check(false, `stopped: ${err?.stack ?? err}`);
} finally {
  try {
    const s = await status();
    if ( s?.active ) {
      const gm = await joinAs(browser, GM);
      await gm.context.request.post(url("/setup"), { data: { shutdown: true } });
      await gm.context.close();
      await waitFor(x => x && !x.active, "the world to shut down", 60_000);
    }
    if ( worldMade ) await post("/setup", { action: "uninstallPackage", type: "world", id: WORLD }).catch(e => log(`world not removed: ${e.message}`));
  } finally {
    restoreLink();
    await post("/setup", { action: "resetPackages" }).catch(() => null);
    server.close();
    await browser.close();
  }
}

const failed = checks.filter(c => !c.ok);
log(failed.length ? `${failed.length} of ${checks.length} checks failed` : `all ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
