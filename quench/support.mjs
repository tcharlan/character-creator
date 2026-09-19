/*
 * Test support for the Quench suites (not shipped logic): a stand-in player that answers steps from
 * the options the rules adapter offers, and an id-independent snapshot to compare characters.
 */

const norm = u => u?.replace?.(/^(Compendium\.[^.]+\.[^.]+\.)(?!Item\.)/, "$1Item.") ?? u;

/** Does a trait key match a pool entry ("skills:*", "weapon:mar:*", "tool:art", "skills:acr")? */
function inPool(key, pool) {
  return pool.some(p => (p.endsWith("*") ? key.startsWith(p.slice(0, -1)) : key === p || key.startsWith(`${p}:`)));
}

/** A legal answer for a step, from its options — the first allowed options, like a quick player. */
export function answer(options) {
  switch ( options.type ) {
    case "Trait": {
      const allowed = new Set(options.allowed);
      const chosen = options.grants.filter(g => allowed.has(g));
      for ( const { count, pool } of options.choices ) {
        const picks = options.allowed.filter(k => inPool(k, pool) && !chosen.includes(k)).slice(0, count);
        chosen.push(...picks);
      }
      return { chosen };
    }
    case "ItemChoice":
      return { selected: options.options.slice(0, options.count), ...(options.abilityOptions[0] ? { ability: options.abilityOptions[0] } : {}) };
    case "ItemGrant":
      return { selected: options.items.filter(i => !i.optional).map(i => i.uuid),
        ...(options.abilityOptions[0] ? { ability: options.abilityOptions[0] } : {}) };
    case "AbilityScoreImprovement": {
      const assignments = { ...options.fixed };
      let points = options.points;
      for ( const k of options.improvable ) {
        if ( points <= 0 ) break;
        if ( options.locked.includes(k) || assignments[k] ) continue;
        const add = Math.min(options.cap ?? 2, points);
        assignments[k] = add;
        points -= add;
      }
      return { type: "asi", assignments };
    }
    case "Size": return { size: options.sizes[0] };
    case "Subclass": return { uuid: options.options[0] };
    default: return {};
  }
}

/**
 * Complete a character the way the wizard will: build (auto-filling), answer the first step that needs
 * input, rebuild (D18), until nothing needs input.
 * @param {Function} build   rules/build.mjs buildCharacter
 * @param {object} input     { picks, base }
 * @param {object} catalog
 * @param {Record<string, object>} [overrides]  "<item name>/<title>" → data, instead of the quick answer.
 */
export async function complete(build, input, catalog, overrides = {}) {
  let steps = [];
  let rebuilds = 0;
  for ( let i = 0; i < 40; i++ ) {
    const b = await build({ ...input, steps }, { catalog, withOptions: true });
    rebuilds++;
    const need = b.results.find(r => r.status === "needsInput");
    if ( !need ) return { built: b, steps: b.recipe.steps, rebuilds };
    const data = overrides[`${need.item}/${need.title}`] ?? answer(need.options);
    steps = [...b.recipe.steps, { path: need.path, advancementId: need.advancementId, level: need.level, data }];
  }
  throw new Error("did not converge");
}

/** UUID of a catalog entry by name and category. */
export function pick(catalog, category, name) {
  const e = catalog.byCategory[category].find(x => x.name === name);
  if ( !e ) throw new Error(`${category} "${name}" not in the catalog`);
  return norm(e.uuid);
}

/** Id-independent snapshot: system source + each item (sorted) with source, origin and advancement values. */
export function snapshot(actor) {
  const label = new Map(actor.items.map(i => [i.id, `@${norm(i._stats?.compendiumSource) ?? i.name}`]));
  const swap = v => {
    if ( typeof v === "string" ) return norm(label.get(v) ?? (v.includes(".") ? v.split(".").map(p => label.get(p) ?? p).join(".") : v));
    if ( Array.isArray(v) ) return v.map(swap);
    if ( v && typeof v === "object" ) return Object.fromEntries(Object.entries(v).map(([k, x]) => [label.get(k) ?? norm(k), swap(x)]));
    return v;
  };
  const src = actor.toObject();
  const items = src.items.map(i => ({ name: i.name, type: i.type, src: norm(i._stats?.compendiumSource) ?? null,
    origin: swap(i.flags?.dnd5e?.advancementOrigin ?? null),
    advancement: swap(Object.fromEntries(Object.values(i.system.advancement ?? {}).map(a => [a._id, a.value ?? null])))
  })).sort((a, b) => `${a.src}${a.name}${a.origin}`.localeCompare(`${b.src}${b.name}${b.origin}`));
  return { system: swap(src.system), items };
}

/** Differences between two snapshots (empty values on both sides are ignored). */
export function differences(a, b) {
  const fa = foundry.utils.flattenObject(JSON.parse(JSON.stringify(a)));
  const fb = foundry.utils.flattenObject(JSON.parse(JSON.stringify(b)));
  const empty = v => v == null || (typeof v === "object" && !Object.keys(v).length);
  const out = [];
  for ( const k of new Set([...Object.keys(fa), ...Object.keys(fb)]) ) {
    if ( JSON.stringify(fa[k]) !== JSON.stringify(fb[k]) && !(empty(fa[k]) && empty(fb[k])) ) out.push([k, fa[k], fb[k]]);
  }
  return out;
}

/** Record every client-side database write; returns stop() → writes. */
export function watchDb() {
  const writes = [];
  const ids = [];
  for ( const doc of ["Actor", "Item", "User", "ActiveEffect", "ChatMessage"] ) {
    for ( const op of ["preCreate", "preUpdate", "preDelete"] ) {
      const hook = `${op}${doc}`;
      ids.push([hook, Hooks.on(hook, d => writes.push({ hook, name: d?.name ?? null }))]);
    }
  }
  return () => {
    for ( const [hook, id] of ids ) Hooks.off(hook, id);
    return writes;
  };
}

/** JSON of every object/array `initial` in the Actor and Item schemas (shared-default guard, spike 1.2). */
export function schemaInitials() {
  const out = {};
  const walk = (field, path, seen) => {
    if ( !field || seen.has(field) ) return;
    seen.add(field);
    if ( field.initial && typeof field.initial === "object" ) out[path] = JSON.stringify(field.initial);
    for ( const [k, f] of Object.entries(field.fields ?? {}) ) walk(f, `${path}.${k}`, seen);
    if ( field.element ) walk(field.element, `${path}[]`, seen);
    if ( field.model?.schema ) walk(field.model.schema, path, seen);
  };
  for ( const [doc, models] of [["Actor", CONFIG.Actor.dataModels], ["Item", CONFIG.Item.dataModels]] ) {
    for ( const [type, model] of Object.entries(models ?? {}) ) walk(model.schema, `${doc}.${type}`, new Set());
  }
  return out;
}
