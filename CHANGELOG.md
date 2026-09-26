# Changelog

## 0.4.2

- Faster creator: typing a name or filling in details is instant, and choosing equipment, spells or a portrait no
  longer replays the whole character (about 130 ms instead of 385 ms). The character is only replayed when
  something it is built from changes — a pick, an answer or an ability score.

## 0.4.1

- Equipment: where your allowed content can't fill part of a starting kit ("any simple weapon" with no weapons
  allowed, say), the standard items are offered instead, so a character can always be equipped — a random
  character could otherwise be left with nothing.
- Review: items from a compendium outside your allowed content are named properly instead of showing their raw id.
- Allowed content: two compendiums with the same name (the system's "Character Origins" and a book's) are told
  apart by where they came from, in the filter, on each row and on the Compendiums tab.

## 0.4.0

- **Random character (hardcore):** players can let the dice make a character — species, class, background, the
  scores in the order they fall, the choices, the starting gear (never the gold instead), alignment and personality. The rolls go to chat and
  are final, and the GM's browser checks the character against them. Spells, the portrait and the name stay the
  player's, and the GM chooses on **Allowed content → Random characters** which parts (if any) the player still
  picks, or turns the mode off.
- Details: personality traits, ideals, bonds and flaws are asked for in both rule sets now, not only 2014 ones,
  and can still be rolled wherever the world has a table for that background.
- Allowed content: each category can be narrowed to one compendium, and **Allow these** / **Disallow these** then apply
  to the whole of it at once (with a search, to what the search leaves).
- Allowed content: every option shows which compendium it comes from, by name.
- Allowed content: an option that appears in more than one compendium is marked, with a warning above the list and a way
  to show only those. Allowing both copies is still allowed — the mark just makes it obvious.

## 0.3.2

- Choices: languages or skills you already get (Common, say) are shown ticked and greyed out, and the count is only
  what you pick yourself ("Chosen: 0 / 2", not "1 / 3").
- Fixed: continuing a character could leave "Reading the description…" on screen until you changed steps.
- Removed the small explanatory notes around the creator (where an option's picture comes from, how the character is
  checked, how portraits are resized, and similar).
- Fixed: large lock pictures in the descriptions of some 2024 options. They are dnd5e's "Free Rules content" notices,
  which dnd5e marks to be shown only on its own journal pages; the creator now leaves them out, and keeps any picture in
  a description inside its column.

## 0.3.1

- Fixed: the "Who is it for?" list at Review was squashed into a small box.
- Fixed: for a GM, choosing a player there also disturbed the ability scores, so the character was refused. Drafts
  affected in 0.3.0 are cleaned up when you press Create.

## 0.3.0

- GMs can use the creator for characters of their own (no character limit), and give them to a player at Review or
  later with **Give to a player…** (on the finished screen, or right-click the character in the Actors tab).

## 0.2.2

- Fixed: in worlds with older or imported items, the Allowed content screen (and the character creator) could fail to
  open, with "object is not iterable" in the console. Items whose data is stored in an older shape are now read
  correctly, and a compendium that can't be read is skipped instead of stopping everything.
- If either screen still can't open, it now says so on screen instead of silently doing nothing.

## 0.2.1

- Fixed: the tabs down the side of the Allowed content screen did nothing when clicked.
- The Allowed content tab for pictures behind each step is now called **Step backdrops**, so it isn't confused with
  the Backgrounds category.

## 0.2.0

- The creator opens fullscreen, with a button in its header to switch to a movable, resizable window and back.
  Each player's choice, and where they left the window, is remembered.
- A backdrop behind every step: an emblem drawn for the step, over a blurred picture of what the player chose.
- GMs can set a picture of their own behind any step (Allowed content → Backgrounds).

## 0.1.0

The first release.

- A step-by-step creator for level 1 dnd5e characters, 2014 and 2024 rules: species, class, background,
  ability scores (point buy, standard array or rolled), the choices those bring, starting equipment or gold,
  spells, details and a portrait.
- Player-role users need no extra permissions: the GM's browser checks and creates the character. Characters
  sent while no GM is online wait and are created when one logs in.
- The draft is saved as the player works and survives closing the creator and reloading.
- Allowed content for the GM: which species, backgrounds, classes, subclasses, feats, spells, equipment,
  compendiums and ability score methods players may use, and pictures of your own per option.
- Pending characters: what is waiting for a GM, and anything the creator refused, with the reason.
- Settings for characters per player, the folder for new characters, the login prompt, portrait uploads and
  their size, and default token ring colours.
- Portrait upload with a token ring, at creation and later from the character sheet.
- Works with content from official books and imported compendiums as well as the SRD.
- Keyboard navigation, and text contrast checked to WCAG AA.
