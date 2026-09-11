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

// KeyboardEvent.code -> macOS virtual key code (kVK_*), for macOS hosts
const MAC_KEYS = {
  KeyA: 0x00, KeyS: 0x01, KeyD: 0x02, KeyF: 0x03, KeyH: 0x04, KeyG: 0x05, KeyZ: 0x06, KeyX: 0x07, KeyC: 0x08, KeyV: 0x09,
  IntlBackslash: 0x0a, KeyB: 0x0b, KeyQ: 0x0c, KeyW: 0x0d, KeyE: 0x0e, KeyR: 0x0f, KeyY: 0x10, KeyT: 0x11,
  Digit1: 0x12, Digit2: 0x13, Digit3: 0x14, Digit4: 0x15, Digit6: 0x16, Digit5: 0x17, Equal: 0x18, Digit9: 0x19,
  Digit7: 0x1a, Minus: 0x1b, Digit8: 0x1c, Digit0: 0x1d, BracketRight: 0x1e, KeyO: 0x1f, KeyU: 0x20, BracketLeft: 0x21,
  KeyI: 0x22, KeyP: 0x23, Enter: 0x24, KeyL: 0x25, KeyJ: 0x26, Quote: 0x27, KeyK: 0x28, Semicolon: 0x29,
  Backslash: 0x2a, Comma: 0x2b, Slash: 0x2c, KeyN: 0x2d, KeyM: 0x2e, Period: 0x2f, Tab: 0x30, Space: 0x31,
  Backquote: 0x32, Backspace: 0x33, Escape: 0x35, MetaRight: 0x36, MetaLeft: 0x37, ShiftLeft: 0x38, CapsLock: 0x39,
  AltLeft: 0x3a, ControlLeft: 0x3b, ShiftRight: 0x3c, AltRight: 0x3d, ControlRight: 0x3e, Fn: 0x3f,
  F17: 0x40, NumpadDecimal: 0x41, NumpadMultiply: 0x43, NumpadAdd: 0x45, NumLock: 0x47,
  NumpadDivide: 0x4b, NumpadEnter: 0x4c, NumpadSubtract: 0x4e, F18: 0x4f, F19: 0x50, NumpadEqual: 0x51,
  Numpad0: 0x52, Numpad1: 0x53, Numpad2: 0x54, Numpad3: 0x55, Numpad4: 0x56, Numpad5: 0x57, Numpad6: 0x58, Numpad7: 0x59,
  F20: 0x5a, Numpad8: 0x5b, Numpad9: 0x5c, IntlYen: 0x5d, IntlRo: 0x5e, NumpadComma: 0x5f,
  F5: 0x60, F6: 0x61, F7: 0x62, F3: 0x63, F8: 0x64, F9: 0x65, Lang2: 0x66, F11: 0x67, Lang1: 0x68, F13: 0x69,
  F16: 0x6a, F14: 0x6b, F10: 0x6d, ContextMenu: 0x6e, F12: 0x6f, F15: 0x71, Insert: 0x72, Home: 0x73, PageUp: 0x74,
  Delete: 0x75, F4: 0x76, End: 0x77, F2: 0x78, PageDown: 0x79, F1: 0x7a,
  ArrowLeft: 0x7b, ArrowRight: 0x7c, ArrowDown: 0x7d, ArrowUp: 0x7e,
};

// KeyboardEvent.code -> Linux evdev key code (KEY_* in linux/input-event-codes.h), for Linux hosts
const LINUX_KEYS = {
  Escape: 1, Minus: 12, Equal: 13, Backspace: 14, Tab: 15, BracketLeft: 26, BracketRight: 27, Enter: 28,
  ControlLeft: 29, Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  Comma: 51, Period: 52, Slash: 53, ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58,
  NumLock: 69, ScrollLock: 70, Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74,
  Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82,
  NumpadDecimal: 83, IntlBackslash: 86, F11: 87, F12: 88, IntlRo: 89, Convert: 92, KanaMode: 93, NonConvert: 94,
  NumpadEnter: 96, ControlRight: 97, NumpadDivide: 98, PrintScreen: 99, AltRight: 100,
  Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106, End: 107, ArrowDown: 108, PageDown: 109,
  Insert: 110, Delete: 111, AudioVolumeMute: 113, AudioVolumeDown: 114, AudioVolumeUp: 115, NumpadEqual: 117,
  Pause: 119, NumpadComma: 121, Lang1: 122, Lang2: 123, IntlYen: 124, MetaLeft: 125, MetaRight: 126, ContextMenu: 127,
  MediaTrackNext: 163, MediaPlayPause: 164, MediaTrackPrevious: 165, MediaStop: 166,
};
[...'QWERTYUIOP'].forEach((k, i) => { LINUX_KEYS[`Key${k}`] = 16 + i; });
[...'ASDFGHJKL'].forEach((k, i) => { LINUX_KEYS[`Key${k}`] = 30 + i; });
[...'ZXCVBNM'].forEach((k, i) => { LINUX_KEYS[`Key${k}`] = 44 + i; });
for (let i = 1; i <= 9; i++) LINUX_KEYS[`Digit${i}`] = 1 + i;
LINUX_KEYS.Digit0 = 11;
for (let i = 1; i <= 10; i++) LINUX_KEYS[`F${i}`] = 58 + i;
for (let i = 13; i <= 24; i++) LINUX_KEYS[`F${i}`] = 170 + i;

module.exports = { VK, MAC_KEYS, LINUX_KEYS };
