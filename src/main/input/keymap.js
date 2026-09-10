// KeyboardEvent.code -> [Windows virtual-key, extended-key flag]
const VK = {
  Escape: [0x1b], Backspace: [0x08], Tab: [0x09], Enter: [0x0d], Space: [0x20], CapsLock: [0x14],
  ShiftLeft: [0xa0], ShiftRight: [0xa1], ControlLeft: [0xa2], ControlRight: [0xa3, 1],
  AltLeft: [0xa4], AltRight: [0xa5, 1], MetaLeft: [0x5b, 1], MetaRight: [0x5c, 1], ContextMenu: [0x5d, 1],
  PageUp: [0x21, 1], PageDown: [0x22, 1], End: [0x23, 1], Home: [0x24, 1],
  ArrowLeft: [0x25, 1], ArrowUp: [0x26, 1], ArrowRight: [0x27, 1], ArrowDown: [0x28, 1],
  PrintScreen: [0x2c, 1], Insert: [0x2d, 1], Delete: [0x2e, 1], Pause: [0x13], ScrollLock: [0x91],
  NumLock: [0x90, 1], NumpadMultiply: [0x6a], NumpadAdd: [0x6b], NumpadSubtract: [0x6d],
  NumpadDecimal: [0x6e], NumpadDivide: [0x6f, 1], NumpadEnter: [0x0d, 1],
  Semicolon: [0xba], Equal: [0xbb], Comma: [0xbc], Minus: [0xbd], Period: [0xbe], Slash: [0xbf],
  Backquote: [0xc0], BracketLeft: [0xdb], Backslash: [0xdc], BracketRight: [0xdd], Quote: [0xde],
  IntlBackslash: [0xe2],
  AudioVolumeMute: [0xad, 1], AudioVolumeDown: [0xae, 1], AudioVolumeUp: [0xaf, 1],
  MediaTrackNext: [0xb0, 1], MediaTrackPrevious: [0xb1, 1], MediaStop: [0xb2, 1], MediaPlayPause: [0xb3, 1],
};
for (let i = 0; i < 26; i++) VK[`Key${String.fromCharCode(65 + i)}`] = [0x41 + i];
for (let i = 0; i < 10; i++) {
  VK[`Digit${i}`] = [0x30 + i];
  VK[`Numpad${i}`] = [0x60 + i];
}
for (let i = 1; i <= 24; i++) VK[`F${i}`] = [0x6f + i];

// KeyboardEvent.code -> nut.js Key enum name (macOS / Linux hosts)
const NUT_KEYS = {
  Escape: 'Escape', Backspace: 'Backspace', Tab: 'Tab', Enter: 'Enter', Space: 'Space', CapsLock: 'CapsLock',
  ShiftLeft: 'LeftShift', ShiftRight: 'RightShift', ControlLeft: 'LeftControl', ControlRight: 'RightControl',
  AltLeft: 'LeftAlt', AltRight: 'RightAlt', MetaLeft: 'LeftSuper', MetaRight: 'RightSuper',
  PageUp: 'PageUp', PageDown: 'PageDown', End: 'End', Home: 'Home', Insert: 'Insert', Delete: 'Delete',
  ArrowLeft: 'Left', ArrowUp: 'Up', ArrowRight: 'Right', ArrowDown: 'Down',
  Semicolon: 'Semicolon', Equal: 'Equal', Comma: 'Comma', Minus: 'Minus', Period: 'Period', Slash: 'Slash',
  Backquote: 'Grave', BracketLeft: 'LeftBracket', Backslash: 'Backslash', BracketRight: 'RightBracket', Quote: 'Quote',
  NumpadEnter: 'Enter',
};
for (let i = 0; i < 26; i++) NUT_KEYS[`Key${String.fromCharCode(65 + i)}`] = String.fromCharCode(65 + i);
for (let i = 0; i < 10; i++) {
  NUT_KEYS[`Digit${i}`] = `Num${i}`;
  NUT_KEYS[`Numpad${i}`] = `NumPad${i}`;
}
for (let i = 1; i <= 24; i++) NUT_KEYS[`F${i}`] = `F${i}`;

module.exports = { VK, NUT_KEYS };
