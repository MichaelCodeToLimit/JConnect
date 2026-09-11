// JConnect input helper for macOS.
//
// JConnect starts this helper and sends it one command per line on stdin:
//   M x y            move the pointer to (x, y) in global display points
//   B button down    press (1) or release (0) a button: 0 left, 1 middle, 2 right, 3 back, 4 forward
//   W dx dy          scroll by browser wheel deltas, in pixels
//   K keycode down   press (1) or release (0) a macOS virtual key code
//   T codepoint      type one Unicode character
//
// macOS delivers these events only after JConnect is allowed under
// System Settings → Privacy & Security → Accessibility.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

let source = CGEventSource(stateID: .hidSystemState)
// Let the person at the Mac keep using their own mouse and keyboard at the same time.
source?.localEventsSuppressionInterval = 0

struct Click {
  var button = -1
  var time: TimeInterval = 0
  var point = CGPoint.zero
  var count = 0
}

var position = CGEvent(source: nil)?.location ?? .zero
var buttonsDown = Set<Int>()
var heldModifiers = Set<CGKeyCode>()
var capsLock = false
var lastClick = Click()

let modifierFlags: [CGKeyCode: CGEventFlags] = [
  0x37: .maskCommand, 0x36: .maskCommand,
  0x38: .maskShift, 0x3C: .maskShift,
  0x3A: .maskAlternate, 0x3D: .maskAlternate,
  0x3B: .maskControl, 0x3E: .maskControl,
  0x3F: .maskSecondaryFn,
]
let capsLockKey: CGKeyCode = 0x39
let arrowKeys: Set<CGKeyCode> = [0x7B, 0x7C, 0x7D, 0x7E]
// Function keys and the navigation block carry the Fn flag on real Mac keyboards.
let functionKeys: Set<CGKeyCode> = [
  0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D, 0x67, 0x6F,
  0x69, 0x6B, 0x71, 0x6A, 0x40, 0x4F, 0x50, 0x5A,
  0x72, 0x73, 0x74, 0x75, 0x77, 0x79,
]
let keypadKeys: Set<CGKeyCode> = [
  0x41, 0x43, 0x45, 0x47, 0x4B, 0x4C, 0x4E, 0x51,
  0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5B, 0x5C,
]

func modifierState() -> CGEventFlags {
  var flags = CGEventFlags()
  for key in heldModifiers {
    if let flag = modifierFlags[key] { flags.insert(flag) }
  }
  if capsLock { flags.insert(.maskAlphaShift) }
  return flags
}

func mouseEventTypes(_ button: Int) -> (down: CGEventType, up: CGEventType, dragged: CGEventType, button: CGMouseButton) {
  switch button {
  case 0: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged, .left)
  case 2: return (.rightMouseDown, .rightMouseUp, .rightMouseDragged, .right)
  default: return (.otherMouseDown, .otherMouseUp, .otherMouseDragged, .center)
  }
}

// Browsers number the middle button 1 and the right button 2; macOS swaps them.
func macButtonNumber(_ button: Int) -> Int64 {
  switch button {
  case 1: return 2
  case 2: return 1
  default: return Int64(button)
  }
}

func post(_ event: CGEvent) {
  event.post(tap: .cghidEventTap)
}

func move(to point: CGPoint) {
  position = point
  var type = CGEventType.mouseMoved
  var button = CGMouseButton.left
  let held = [0, 2, 1, 3, 4].first { buttonsDown.contains($0) }
  if let held = held {
    let types = mouseEventTypes(held)
    type = types.dragged
    button = types.button
  }
  guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return }
  if let held = held { event.setIntegerValueField(.mouseEventButtonNumber, value: macButtonNumber(held)) }
  event.flags = modifierState()
  post(event)
}

func press(_ button: Int, _ down: Bool) {
  guard (0...4).contains(button) else { return }
  let types = mouseEventTypes(button)
  guard let event = CGEvent(mouseEventSource: source, mouseType: down ? types.down : types.up, mouseCursorPosition: position, mouseButton: types.button) else { return }
  if down {
    let now = ProcessInfo.processInfo.systemUptime
    let near = abs(position.x - lastClick.point.x) <= 4 && abs(position.y - lastClick.point.y) <= 4
    let again = button == lastClick.button && near && now - lastClick.time <= NSEvent.doubleClickInterval
    lastClick = Click(button: button, time: now, point: position, count: again ? lastClick.count + 1 : 1)
    buttonsDown.insert(button)
  } else {
    buttonsDown.remove(button)
  }
  // The click count is what turns two clicks into a double-click on macOS.
  event.setIntegerValueField(.mouseEventClickState, value: Int64(button == lastClick.button ? lastClick.count : 1))
  event.setIntegerValueField(.mouseEventButtonNumber, value: macButtonNumber(button))
  event.flags = modifierState()
  post(event)
}

func scroll(dx: Int32, dy: Int32) {
  // Browsers report positive deltas for scrolling down and right; macOS uses positive for up and left.
  guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0) else { return }
  event.flags = modifierState()
  post(event)
}

func key(_ code: CGKeyCode, _ down: Bool) {
  if code == capsLockKey || modifierFlags[code] != nil {
    if code == capsLockKey {
      if down { capsLock.toggle() }
    } else if down {
      heldModifiers.insert(code)
    } else {
      heldModifiers.remove(code)
    }
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { return }
    event.type = .flagsChanged
    event.flags = modifierState()
    post(event)
    return
  }
  guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { return }
  var flags = modifierState()
  if arrowKeys.contains(code) { flags.formUnion([.maskSecondaryFn, .maskNumericPad]) }
  if functionKeys.contains(code) { flags.insert(.maskSecondaryFn) }
  if keypadKeys.contains(code) { flags.insert(.maskNumericPad) }
  event.flags = flags
  post(event)
}

func typeCharacter(_ value: UInt32) {
  guard let scalar = Unicode.Scalar(value) else { return }
  var units = Array(String(scalar).utf16)
  for down in [true, false] {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
    event.flags = []
    event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
    post(event)
  }
}

// Never leave buttons or modifier keys held down when JConnect goes away.
func releaseAll() {
  for button in buttonsDown { press(button, false) }
  for code in heldModifiers { key(code, false) }
}

func number(_ text: Substring) -> Double? {
  guard let value = Double(text), value.isFinite else { return nil }
  return min(max(value, -2_000_000), 2_000_000)
}

print(AXIsProcessTrusted() ? "ready" : "untrusted")

while let line = readLine() {
  let parts = line.split(separator: " ")
  guard let first = parts.first else { continue }
  let command = String(first)
  let args = parts.dropFirst().compactMap { number($0) }
  guard args.count == parts.count - 1 else { continue }
  switch command {
  case "M" where args.count >= 2:
    move(to: CGPoint(x: args[0], y: args[1]))
  case "B" where args.count >= 2:
    press(Int(args[0]), args[1] != 0)
  case "W" where args.count >= 2:
    scroll(dx: Int32(min(max(args[0], -10000), 10000)), dy: Int32(min(max(args[1], -10000), 10000)))
  case "K" where args.count >= 2 && args[0] >= 0 && args[0] <= 0x7F:
    key(CGKeyCode(args[0]), args[1] != 0)
  case "T" where args.count >= 1 && args[0] >= 0:
    typeCharacter(UInt32(args[0]))
  default:
    break
  }
}

releaseAll()
