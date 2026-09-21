import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDisplay, fullscreenPosition, windowPosition, displayButton, readDisplay, WINDOW_DEFAULT, WINDOW_MIN }
  from "../scripts/wizard/display.mjs";

/* Fullscreen or a window (D28): the choice and the window's place are remembered, and never left off-screen. */

const SCREEN = { width: 1920, height: 1080 };

test("a new player opens fullscreen, with no window remembered", () => {
  assert.deepEqual(normalizeDisplay(undefined), { mode: "fullscreen", window: null });
  assert.deepEqual(normalizeDisplay({ mode: "sideways" }), { mode: "fullscreen", window: null });
  assert.deepEqual(readDisplay(() => { throw new Error("not registered"); }, "wizardDisplay"),
    { mode: "fullscreen", window: null }, "a setting that can't be read falls back too");
});

test("a remembered window is kept only with all four numbers, rounded", () => {
  assert.deepEqual(normalizeDisplay({ mode: "window", window: { left: 10.4, top: 20.6, width: 1000, height: 700 } }),
    { mode: "window", window: { left: 10, top: 21, width: 1000, height: 700 } });
  assert.deepEqual(normalizeDisplay({ mode: "window", window: { left: 10, top: "x", width: 1000, height: 700 } }),
    { mode: "window", window: null });
});

test("fullscreen covers the viewport", () => {
  assert.deepEqual(fullscreenPosition(SCREEN), { left: 0, top: 0, width: 1920, height: 1080, scale: 1 });
});

test("with nothing remembered the window is the usual size, centred", () => {
  assert.deepEqual(windowPosition(null, SCREEN), { left: 320, top: 160, ...WINDOW_DEFAULT, scale: 1 });
});

test("a remembered window comes back where it was", () => {
  const saved = { left: 100, top: 50, width: 1100, height: 800 };
  assert.deepEqual(windowPosition(saved, SCREEN), { ...saved, scale: 1 });
});

test("a window remembered on a bigger screen is pulled back on, and not below the smallest useful size", () => {
  const pos = windowPosition({ left: 2400, top: 1300, width: 400, height: 300 }, SCREEN);
  assert.equal(pos.width, WINDOW_MIN.width);
  assert.equal(pos.height, WINDOW_MIN.height);
  assert.equal(pos.left, SCREEN.width - WINDOW_MIN.width, "inside the right edge");
  assert.equal(pos.top, SCREEN.height - WINDOW_MIN.height, "inside the bottom edge");
  const small = windowPosition({ left: -50, top: -50, width: 3000, height: 2000 }, { width: 800, height: 500 });
  assert.deepEqual(small, { left: 0, top: 0, width: 800, height: 500, scale: 1 }, "never bigger than the screen");
});

test("the header button says what it will do", () => {
  assert.equal(displayButton("fullscreen").label, "CHARCREATOR.Display.ToWindow");
  assert.equal(displayButton("window").label, "CHARCREATOR.Display.ToFullscreen");
  assert.notEqual(displayButton("fullscreen").icon, displayButton("window").icon);
});
