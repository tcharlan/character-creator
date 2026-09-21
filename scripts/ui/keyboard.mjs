/**
 * Keyboard handling the browser doesn't give us for free (PLAN 5.2). Everything in this module is built from
 * real buttons, so tabbing and Enter already work; what a group of tabs also owes the player is the arrow keys.
 */

/** Which keys move which way in a group. */
const NEXT = new Set(["ArrowRight", "ArrowDown"]);
const PREVIOUS = new Set(["ArrowLeft", "ArrowUp"]);

/**
 * Let the arrow keys move along a row (or column) of controls, with Home and End at the ends. The control the
 * arrow lands on is focused and clicked, which is what a tab is expected to do.
 * @param {HTMLElement} container   The element holding the group.
 * @param {string} selector         The controls inside it.
 */
export function arrowKeys(container, selector) {
  if ( !container ) return;
  container.addEventListener("keydown", event => {
    if ( !NEXT.has(event.key) && !PREVIOUS.has(event.key) && !["Home", "End"].includes(event.key) ) return;
    const items = [...container.querySelectorAll(selector)].filter(el => !el.disabled);
    const from = items.indexOf(event.target.closest(selector));
    if ( from < 0 ) return;
    const to = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : NEXT.has(event.key) ? (from + 1) % items.length
          : (from - 1 + items.length) % items.length;
    const target = items[to];
    if ( !target || (target === event.target) ) return;
    event.preventDefault();
    target.focus();
    target.click();
  });
}
