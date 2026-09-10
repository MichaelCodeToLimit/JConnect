const { NUT_KEYS } = require('./keymap');

// macOS / Linux input through nut.js (optional dependency).
function create() {
  const { mouse, keyboard, Key, Button, Point } = require('@nut-tree-fork/nut-js');
  mouse.config.autoDelayMs = 0;
  mouse.config.mouseSpeed = 100000;
  keyboard.config.autoDelayMs = 0;

  let chain = Promise.resolve();
  let pendingMove = null;
  const queue = (fn) => { chain = chain.then(fn).catch(() => {}); };
  const buttons = [Button.LEFT, Button.MIDDLE, Button.RIGHT];

  return {
    name: 'nut',
    move: (pt) => {
      const scheduled = pendingMove !== null;
      pendingMove = pt;
      if (!scheduled) {
        queue(async () => {
          const target = pendingMove;
          pendingMove = null;
          await mouse.setPosition(new Point(Math.round(target.x), Math.round(target.y)));
        });
      }
    },
    button: (b, down) => {
      const btn = buttons[b];
      if (btn !== undefined) queue(() => (down ? mouse.pressButton(btn) : mouse.releaseButton(btn)));
    },
    wheel: (dx, dy) => queue(async () => {
      const steps = (v) => Math.max(1, Math.round(Math.abs(v) / 40));
      if (dy > 0) await mouse.scrollDown(steps(dy));
      if (dy < 0) await mouse.scrollUp(steps(dy));
      if (dx > 0) await mouse.scrollRight(steps(dx));
      if (dx < 0) await mouse.scrollLeft(steps(dx));
    }),
    key: (code, down) => {
      const k = Key[NUT_KEYS[code]];
      if (k !== undefined) queue(() => (down ? keyboard.pressKey(k) : keyboard.releaseKey(k)));
    },
    text: (s) => queue(() => keyboard.type(s)),
    close() {},
  };
}

module.exports = { create };
