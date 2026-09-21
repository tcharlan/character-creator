/**
 * Dev-only: build and publish a release (PLAN 6.2). No dependencies: git makes the zip, it is listed here from its
 * central directory (the `tar` on PATH may be GNU tar, which can't read zips), and the GitHub CLI publishes it.
 *
 *   node dev/release.mjs version 0.2.0   set the version in module.json and package.json, and the download URL
 *   node dev/release.mjs check           build dist/module.zip from HEAD and check what is (and isn't) in it
 *   node dev/release.mjs publish         check, tag v<version>, push, and create the GitHub release
 *
 * The zip is `git archive` of the committed tree, so it holds exactly what is committed, minus everything
 * .gitattributes marks export-ignore (the tests, the Quench batches, the docs, the dev tools). The Quench
 * batches in particular must never ship: they create and delete characters and change settings.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DIST = join(ROOT, "dist");
const ZIP = join(DIST, "module.zip");

// With stdio inherited, execFileSync returns nothing to trim.
const run = (cmd, args, options = {}) => String(execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...options }) ?? "").trim();
const readJSON = path => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const writeJSON = (path, value) => writeFileSync(join(ROOT, path), `${JSON.stringify(value, null, 2)}\n`);
const log = msg => console.log(`[release] ${msg}`);
const fail = msg => {
  console.error(`[release] ${msg}`);
  process.exit(1);
};

/** What must be in the zip, and what must not. */
const REQUIRED = ["module.json", "LICENSE", "README.md", "CHANGELOG.md", "lang/en.json"];
const FORBIDDEN = [/^test\//, /^quench\//, /^docs\//, /^mockups\//, /^dev\//, /^CLAUDE\.md$/, /^package(-lock)?\.json$/,
  /^node_modules\//, /^test-results\//, /^\.git/, /^eslint\.config\.mjs$/];

/** Set the version everywhere it is written. */
function setVersion(version) {
  if ( !/^\d+\.\d+\.\d+$/.test(version ?? "") ) fail(`"${version}" isn't a version like 1.2.3`);
  const manifest = readJSON("module.json");
  manifest.version = version;
  manifest.download = `${manifest.url}/releases/download/v${version}/module.zip`;
  writeJSON("module.json", manifest);
  const pkg = readJSON("package.json");
  pkg.version = version;
  writeJSON("package.json", pkg);
  log(`version ${version} in module.json and package.json; add a CHANGELOG entry, commit, then publish`);
}

/** The names in a zip, read from its central directory (no zip64: a module is far below 4 GB). */
export function zipEntries(path) {
  const zip = readFileSync(path);
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if ( end < 0 ) fail(`${path} isn't a zip`);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const names = [];
  for ( let i = 0; i < count; i++ ) {
    if ( zip.readUInt32LE(at) !== 0x02014b50 ) fail(`${path}: bad central directory`);
    const nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    names.push(zip.toString("utf8", at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extra + comment;
  }
  return names;
}

/** Every file in a directory, recursively, relative to the root. */
function walk(dir, base = dir) {
  const out = [];
  for ( const entry of readdirSync(dir, { withFileTypes: true }) ) {
    const path = join(dir, entry.name);
    if ( entry.isDirectory() ) out.push(...walk(path, base));
    else out.push(path.slice(base.length + 1).replace(/\\/g, "/"));
  }
  return out;
}

/** Build dist/module.zip and dist/module.json from HEAD, and check them. Returns the manifest. */
function check() {
  const manifest = readJSON("module.json");
  const problems = [];
  if ( manifest.download !== `${manifest.url}/releases/download/v${manifest.version}/module.zip` ) {
    problems.push(`module.json download URL doesn't match version ${manifest.version}`);
  }
  if ( readJSON("package.json").version !== manifest.version ) problems.push("package.json has a different version");
  if ( !readFileSync(join(ROOT, "CHANGELOG.md"), "utf8").includes(`## ${manifest.version}`) ) {
    problems.push(`CHANGELOG.md has no "## ${manifest.version}" section`);
  }

  mkdirSync(DIST, { recursive: true });
  run("git", ["archive", "--format=zip", "--output", ZIP, "HEAD"]);
  const committed = JSON.parse(run("git", ["show", "HEAD:module.json"]));
  writeFileSync(join(DIST, "module.json"), `${JSON.stringify(committed, null, 2)}\n`);
  if ( committed.version !== manifest.version ) problems.push("module.json on disk differs from the committed one — commit first");

  const entries = zipEntries(ZIP).filter(e => !e.endsWith("/"));
  for ( const path of [...REQUIRED, ...committed.esmodules, ...committed.styles, ...committed.languages.map(l => l.path)] ) {
    if ( !entries.includes(path) ) problems.push(`missing from the zip: ${path}`);
  }
  for ( const entry of entries ) {
    if ( FORBIDDEN.some(re => re.test(entry)) ) problems.push(`should not be in the zip: ${entry}`);
  }
  // Every template the code asks for has to travel with it.
  for ( const file of walk(join(ROOT, "scripts")) ) {
    const source = readFileSync(join(ROOT, "scripts", file), "utf8");
    for ( const [path] of source.matchAll(/templates\/[\w/.-]+\.hbs/g) ) {
      if ( !entries.includes(path) ) problems.push(`scripts/${file} asks for ${path}, which isn't in the zip`);
    }
  }
  // The fonts ship with their licences (A9).
  for ( const font of entries.filter(e => e.startsWith("fonts/") && e.endsWith(".woff2")) ) {
    if ( !entries.some(e => e.startsWith("fonts/OFL")) ) problems.push(`${font} ships without its OFL licence`);
  }

  const size = statSync(ZIP).size;
  log(`${entries.length} files, ${(size / 1024).toFixed(0)} KB — ${ZIP}`);
  if ( problems.length ) fail(`not releasable:\n  ${problems.join("\n  ")}`);
  log(`v${committed.version} is releasable`);
  return committed;
}

/** Tag, push and publish the release on GitHub. */
function publish() {
  if ( run("git", ["status", "--porcelain"]) ) fail("the working tree has changes — commit or stash them first");
  if ( run("git", ["branch", "--show-current"]) !== "main" ) fail("release from main");
  const manifest = check();
  const tag = `v${manifest.version}`;
  if ( run("git", ["tag", "--list", tag]) ) fail(`${tag} already exists`);
  const notes = changelogSection(manifest.version);
  const notesFile = join(DIST, "notes.md");
  writeFileSync(notesFile, notes);
  run("git", ["tag", "-a", tag, "-m", `Character Creator ${tag}`]);
  run("git", ["push", "origin", "main", tag], { stdio: "inherit" });
  run("gh", ["release", "create", tag, ZIP, join(DIST, "module.json"), "--title", `Character Creator ${tag}`,
    "--notes-file", notesFile], { stdio: "inherit" });
  log(`published ${tag}`);
}

/** The CHANGELOG entry for one version, for the release notes. */
function changelogSection(version) {
  const text = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  const start = text.indexOf(`## ${version}`);
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next < 0 ? undefined : next).trim();
}

// Run as a command, not when fresh-install.mjs borrows zipEntries.
const [command, arg] = process.argv.slice(2);
if ( import.meta.url !== pathToFileURL(process.argv[1]).href ) { /* imported */ }
else if ( command === "version" ) setVersion(arg);
else if ( command === "check" ) check();
else if ( command === "publish" ) publish();
else fail("usage: node dev/release.mjs version <x.y.z> | check | publish");

