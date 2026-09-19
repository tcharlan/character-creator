/*
 * Dev-only: prepare a test world (PLAN 0.4–0.5). Paste into the browser console as the GM in
 * "legacy-test" or "modern-test". Safe to run twice. Never run it in a real campaign world.
 *
 * - Sets dnd5e.rulesVersion from the world id (legacy-test → legacy, modern-test → modern).
 * - Creates the test users if missing: Assistant GM, Player A, Player B, Player C (default roles,
 *   no extra permissions, no passwords — the dev instance is local-only).
 */
(async () => {
  const RULES = { "legacy-test": "legacy", "modern-test": "modern" };
  const rules = RULES[game.world.id];
  if ( !rules ) return console.error(`seed-world: "${game.world.id}" is not a test world; nothing done.`);
  if ( !game.user.isGM ) return console.error("seed-world: run this as the GM.");

  const USERS = [
    { name: "Assistant GM", role: CONST.USER_ROLES.ASSISTANT },
    { name: "Player A", role: CONST.USER_ROLES.PLAYER },
    { name: "Player B", role: CONST.USER_ROLES.PLAYER },
    { name: "Player C", role: CONST.USER_ROLES.PLAYER }
  ];
  const missing = USERS.filter(u => !game.users.getName(u.name));
  if ( missing.length ) await User.implementation.createDocuments(missing);
  console.log(`seed-world: created ${missing.length} user(s):`, missing.map(u => u.name));

  const current = game.settings.get("dnd5e", "rulesVersion");
  if ( current === rules ) return console.log(`seed-world: rulesVersion already "${rules}". Done.`);
  await game.settings.set("dnd5e", "rulesVersion", rules);
  console.log(`seed-world: rulesVersion "${current}" → "${rules}". Reloading…`);
  foundry.utils.debouncedReload();
})();
