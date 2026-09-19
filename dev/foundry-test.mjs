/* global CONFIG, game, Hooks, quench */
/*
 * Dev-only: run the module's Quench batches in the local dev Foundry, unattended.
 *   npm run test:foundry                       both test worlds, as Player A
 *   npm run test:foundry -- --world modern-test
 *   npm run test:foundry -- --batch spike-1-2  only batches whose key contains this text
 *
 * For each world it: starts the dev server if needed, switches worlds through Foundry's own setup
 * routes (GM "return to setup", then launchWorld), logs in through /join in headless Edge, runs the
 * batches, and writes test-results/<world>.json. Exits 1 on any failure.
 *
 * Only ever talks to localhost (convention 8: never the live world).
 * Env: FOUNDRY_URL (default http://localhost:30001), FOUNDRY_DATA (default ~/FoundryDev),
 *      FOUNDRY_ADMIN_KEY (only if the dev instance has an admin password), CC_PLAYER, CC_GM.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const FOUNDRY_ROOT = resolve(REPO, "..");
const BASE = new URL(process.env.FOUNDRY_URL ?? "http://localhost:30001");
const DATA = process.env.FOUNDRY_DATA ?? join(homedir(), "FoundryDev");
const PLAYER = process.env.CC_PLAYER ?? "Player A";
const GM = process.env.CC_GM ?? "Gamemaster";
const WORLDS = ["legacy-test", "modern-test"];
const MODULE_ID = "character-creator";

if ( !["localhost", "127.0.0.1", "[::1]"].includes(BASE.hostname) ) {
  console.error(`Refusing to run against ${BASE.href}: tests only run on the local dev instance.`);
  process.exit(2);
}

const args = process.argv.slice(2);
const argValue = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const worlds = argValue("--world") ? [argValue("--world")] : WORLDS;
const batchFilter = argValue("--batch") ?? "";
const verbose = args.includes("--verbose");
const RUN_TIMEOUT_MS = Number(process.env.CC_RUN_TIMEOUT_MS ?? 15 * 60_000);

const url = path => new URL(path, BASE).href;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = msg => console.log(`[foundry-test] ${msg}`);
const title = t => t.fullTitle.replace(/^\S+_root /, "");

/* -------------------------------------------- */
/*  Server and worlds                           */
/* -------------------------------------------- */

async function status() {
  try {
    const res = await fetch(url("/api/status"));
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function waitFor(predicate, what, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while ( Date.now() < end ) {
    const s = await status();
    if ( predicate(s) ) return s;
    await sleep(1000);
  }
  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${what}`);
}

let serverProcess = null;
/**
 * Start the dev server unless one answers. A server started right after the previous run's server stopped
 * can exit at once (its data path still locked), so an early exit is retried a few times, and the
 * server's last output lines are shown if it never comes up.
 */
async function ensureServer() {
  if ( await status() ) return;
  for ( let attempt = 1; ; attempt++ ) {
    log(`starting the dev server (${DATA}, port ${BASE.port})${attempt > 1 ? `, attempt ${attempt}` : ""}`);
    const output = [];
    let exited = null;
    serverProcess = spawn(process.execPath,
      [join(FOUNDRY_ROOT, "main.js"), `--dataPath=${DATA}`, `--port=${BASE.port}`, "--noupnp"],
      { stdio: ["ignore", "pipe", "pipe"] });
    for ( const stream of [serverProcess.stdout, serverProcess.stderr] ) {
      stream.on("data", chunk => output.push(...String(chunk).split(/\r?\n/).filter(Boolean)));
    }
    serverProcess.on("exit", code => exited = code);
    const end = Date.now() + 60_000;
    while ( Date.now() < end && exited === null ) {
      if ( await status() ) return;
      await sleep(1000);
    }
    const tail = output.slice(-8).join("\n  ");
    serverProcess.kill();
    serverProcess = null;
    if ( exited === null || attempt >= 3 ) {
      throw new Error(`The dev server didn't start (${exited === null ? "timed out after 60s" : `exit code ${exited}`}):\n  ${tail}`);
    }
    log(`the dev server exited with code ${exited}; retrying in 10s\n  ${tail}`);
    await sleep(10_000);
  }
}

async function postSetup(body, request = null) {
  const data = { ...body };
  if ( process.env.FOUNDRY_ADMIN_KEY ) data.adminPassword = process.env.FOUNDRY_ADMIN_KEY;
  if ( request ) return request.post(url("/setup"), { data });
  return fetch(url("/setup"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
  });
}

async function ensureWorld(browser, world) {
  const s = await status();
  if ( s?.active && s.world === world ) return;
  if ( s?.active ) {
    log(`returning ${s.world} to setup (as ${GM})`);
    const gm = await joinAs(browser, GM);
    await postSetup({ shutdown: true }, gm.context.request);
    await gm.context.close();
    await waitFor(x => x && !x.active, "the world to shut down", 60_000);
  }
  log(`launching ${world}`);
  const res = await postSetup({ action: "launchWorld", world });
  if ( !res.ok ) throw new Error(`launchWorld ${world} failed: HTTP ${res.status} ${await res.text()}`);
  await waitFor(x => x?.active && x.world === world, `${world} to be ready`, 300_000);
}

/* -------------------------------------------- */
/*  Browser                                     */
/* -------------------------------------------- */

async function joinAs(browser, userName) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  const errors = [];
  const notes = [];   // console lines from this module ("character-creator | …"), saved in test-results
  page.on("pageerror", err => errors.push(String(err?.stack ?? err)));
  page.on("console", msg => {
    if ( msg.type() === "error" ) errors.push(msg.text());
    else if ( msg.text().startsWith(`${MODULE_ID} |`) ) notes.push(msg.text());
    if ( verbose ) console.log(`    [${userName} ${msg.type()}] ${msg.text().slice(0, 300)}`);
  });
  await page.goto(url("/join"));
  const option = page.locator('select[name="userid"] option', { hasText: userName });
  // The join page renders its user list after load; wait for the option to appear.
  const found = await option.first().waitFor({ state: "attached", timeout: 30_000 }).then(() => true, () => false);
  if ( !found ) throw new Error(`No user named "${userName}" in this world`);
  if ( await option.first().isDisabled() ) {
    throw new Error(`"${userName}" is already connected — close that session (e.g. your browser tab) and retry`);
  }
  await page.selectOption('select[name="userid"]', { label: userName });
  await Promise.all([
    page.waitForURL(/\/game/, { timeout: 30_000 }).catch(() => null),
    page.click('button[name="join"]')
  ]);
  if ( !page.url().includes("/game") ) {
    const notice = await page.locator("#notifications").innerText().catch(() => "");
    throw new Error(`Could not join as "${userName}" (still on ${page.url()}). ${notice}`.trim());
  }
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 180_000 });
  return { context, page, errors, notes };
}

/** This module's Quench batch keys in the page that contain `filter`. */
function listBatches(page, filter) {
  return page.evaluate(({ moduleId, filter }) => {
    if ( !globalThis.quench ) throw new Error("Quench is not active in this world");
    return [...quench._testBatches.keys()].filter(k => k.startsWith(`${moduleId}.`) && k.includes(filter));
  }, { moduleId: MODULE_ID, filter });
}

/** Run the given Quench batches in the page; resolves with Quench's JSON report (parsed). */
async function runBatches(page, keys) {
  const json = await page.evaluate(async ({ keys, timeoutMs }) => {
    // Quench browses __snapshots__/ for every batch before running, which a Player-role user may
    // not do (FILES_BROWSE). We use no snapshots, so skip that step in this test page only.
    if ( !globalThis.game.user.isGM ) {
      quench.snapshots.loadBatchSnaps = async () => {
        quench.snapshots.resetCache();
        return {};
      };
    }
    // Quench's reporter writes into its results window; unrendered, the run never finishes.
    quench.app.render(true);
    for ( let i = 0; i < 100 && !quench.app.rendered; i++ ) await new Promise(r => setTimeout(r, 100));
    const report = new Promise(resolveReport => Hooks.once("quenchReports", r => resolveReport(r.json)));
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(
      `Quench run did not finish within ${timeoutMs / 1000}s`)), timeoutMs));
    await Promise.race([quench.runBatches(keys), timeout]);
    return Promise.race([report, timeout]);
  }, { keys, timeoutMs: RUN_TIMEOUT_MS });
  return JSON.parse(json);
}

/**
 * Batches whose key ends in "@gm" need a GM online while they run (run after the others, in registration
 * order). Batches ending in "@nogm" need no GM online and run last before the GM joins, so they can
 * leave state for a GM batch to pick up (quench/pending.mjs).
 */
const needsGM = key => key.endsWith("@gm");
const noGM = key => key.endsWith("@nogm");

/* -------------------------------------------- */
/*  Main                                        */
/* -------------------------------------------- */

async function main() {
  await ensureServer();
  const browser = await chromium.launch({
    channel: "msedge", headless: true,
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"]
  });
  // Never leave a headless session logged in (it would block the next run's join).
  for ( const signal of ["SIGINT", "SIGTERM"] ) {
    process.once(signal, async () => {
      await browser.close().catch(() => null);
      if ( serverProcess ) serverProcess.kill();
      process.exit(130);
    });
  }
  const summary = [];
  let failed = false;

  try {
    for ( const world of worlds ) {
      const result = { world, user: PLAYER, passes: 0, failures: 0, pending: 0, errors: [] };
      summary.push(result);
      try {
        await ensureWorld(browser, world);
        log(`${world}: joining as ${PLAYER}`);
        const session = await joinAs(browser, PLAYER);
        const started = Date.now();
        const keys = await listBatches(session.page, batchFilter);
        if ( !keys.length ) throw new Error(`No batches match "${batchFilter}"`);
        const report = { passes: [], failures: [], pending: [] };
        const merge = r => {
          for ( const k of ["passes", "failures", "pending"] ) report[k].push(...(r[k] ?? []));
        };
        const alone = [...keys.filter(k => !needsGM(k) && !noGM(k)), ...keys.filter(noGM)];
        const withGM = keys.filter(needsGM);
        if ( alone.length ) merge(await runBatches(session.page, alone));
        let gm = null;
        if ( withGM.length ) {
          log(`${world}: joining as ${GM} for ${withGM.join(", ")}`);
          gm = await joinAs(browser, GM);
          // The GM's copy of the module registers the test query handlers at quenchReady.
          await gm.page.waitForFunction(id => `${id}.spikeSubmit` in CONFIG.queries, MODULE_ID, { timeout: 60_000 });
          await session.page.waitForFunction(() => !!game.users.activeGM, null, { timeout: 30_000 });
          merge(await runBatches(session.page, withGM));
          await gm.context.close();
        }
        result.batches = keys;
        result.seconds = Math.round((Date.now() - started) / 100) / 10;
        result.passes = report.passes?.length ?? 0;
        result.failures = report.failures?.length ?? 0;
        result.pending = report.pending?.length ?? 0;
        result.moduleErrors = [...session.errors, ...(gm?.errors ?? [])].filter(e => e.includes(MODULE_ID));
        await mkdir(join(REPO, "test-results"), { recursive: true });
        await writeFile(join(REPO, "test-results", `${world}.json`),
          JSON.stringify({ ...result, consoleErrors: session.errors, gmConsoleErrors: gm?.errors ?? [],
            notes: [...session.notes, ...(gm?.notes ?? [])], report }, null, 2));

        console.log(`\n${world} (${PLAYER}) — ${keys.join(", ")}`);
        for ( const t of report.passes ?? [] ) console.log(`  ✔ ${title(t)}`);
        for ( const t of report.pending ?? [] ) console.log(`  – ${title(t)} (skipped)`);
        for ( const t of report.failures ?? [] ) {
          console.log(`  ✘ ${title(t)}\n      ${String(t.err?.message ?? "").split("\n")[0].slice(0, 400)}`);
        }
        for ( const e of result.moduleErrors ) console.log(`  ✘ console error from ${MODULE_ID}: ${e.slice(0, 300)}`);
        await session.context.close();
        if ( result.failures || result.moduleErrors.length || !result.passes ) failed = true;
      } catch ( err ) {
        result.errors.push(err.message);
        console.log(`\n${world}: ✘ ${err.message}`);
        failed = true;
      }
    }
  } finally {
    await browser.close();
    if ( serverProcess ) serverProcess.kill();
  }

  console.log("\nSummary");
  for ( const r of summary ) {
    console.log(`  ${r.world}: ${r.passes} passed, ${r.failures} failed, ${r.pending} skipped`
      + `${r.errors.length ? `, ERROR: ${r.errors.join("; ")}` : ""}${r.seconds ? ` (${r.seconds}s)` : ""}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
