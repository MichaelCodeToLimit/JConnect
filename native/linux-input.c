// JConnect input helper for Linux.
//
// JConnect starts this helper and sends it one command per line on stdin:
//   M x y            move the pointer to (x, y) in X screen pixels
//   B button down    press (1) or release (0) a button: 0 left, 1 middle, 2 right, 3 back, 4 forward
//   W dx dy          scroll by browser wheel deltas, in pixels
//   K keycode down   press (1) or release (0) a Linux evdev key code
//   T codepoint      type one Unicode character
//
// Events go through the X server's XTEST extension, so they reach apps in an X11 session.
// The helper prints "ready" when it can send them, or "error <reason>" before it exits.

#define _DEFAULT_SOURCE
#include <errno.h>
#include <math.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <X11/XKBlib.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/keysym.h>
#include <X11/extensions/XTest.h>

// One wheel notch scrolls about 100 pixels in a browser. X sends each notch as a click of button 4, 5, 6 or 7.
#define PIXELS_PER_NOTCH 100.0
// Spare key codes used to type characters the keyboard layout doesn't have, and how long they keep a character
// after typing stops.
#define SCRATCH_KEYS 4
#define SCRATCH_IDLE_MS 300

static Display *dpy;
static int min_keycode, max_keycode;
static int buttons_down[10];
static int keys_down[256];
static double wheel_x, wheel_y;

static KeyCode scratch[SCRATCH_KEYS];
static KeySym scratch_sym[SCRATCH_KEYS];
static int scratch_count, scratch_next, scratch_in_use;

// Report X errors instead of letting Xlib end the helper.
static int report_x_error(Display *display, XErrorEvent *event) {
  char text[128];
  XGetErrorText(display, event->error_code, text, sizeof text);
  fprintf(stderr, "X error: %s\n", text);
  return 0;
}

static void move_to(int x, int y) {
  XTestFakeMotionEvent(dpy, -1, x, y, CurrentTime);
  XFlush(dpy);
}

// Browsers number the buttons 0 left, 1 middle, 2 right, 3 back and 4 forward. X numbers them 1, 2, 3, 8 and 9.
static void press_button(int button, int down) {
  static const unsigned int x_button[] = { 1, 2, 3, 8, 9 };
  if (button < 0 || button > 4) return;
  unsigned int b = x_button[button];
  buttons_down[b] = down;
  XTestFakeButtonEvent(dpy, b, down ? True : False, CurrentTime);
  XFlush(dpy);
}

static void click(unsigned int button, int count) {
  for (int i = 0; i < count; i++) {
    XTestFakeButtonEvent(dpy, button, True, CurrentTime);
    XTestFakeButtonEvent(dpy, button, False, CurrentTime);
  }
}

// Small deltas add up until they make a notch. Whatever is left over is dropped when the direction changes.
static int notches(double *left_over, double delta) {
  if ((delta > 0 && *left_over < 0) || (delta < 0 && *left_over > 0)) *left_over = 0;
  *left_over += delta;
  int count = (int)(*left_over / PIXELS_PER_NOTCH);
  *left_over -= count * PIXELS_PER_NOTCH;
  return count;
}

static void scroll(double dx, double dy) {
  int down = notches(&wheel_y, dy);
  int right = notches(&wheel_x, dx);
  // Positive browser deltas scroll down and to the right.
  if (down) click(down > 0 ? 5 : 4, abs(down));
  if (right) click(right > 0 ? 7 : 6, abs(right));
  XFlush(dpy);
}

// X key codes are evdev key codes plus 8.
static void press_key(int evdev, int down) {
  int keycode = evdev + 8;
  if (keycode < min_keycode || keycode > max_keycode) return;
  keys_down[keycode] = down;
  XTestFakeKeyEvent(dpy, (unsigned int)keycode, down ? True : False, CurrentTime);
  XFlush(dpy);
}

// Latin-1 characters have keysyms equal to their code points. Every other character is 0x1000000 plus its code point.
static KeySym keysym_for(unsigned long cp) {
  switch (cp) {
    case '\n':
    case '\r': return XK_Return;
    case '\t': return XK_Tab;
    case '\b': return XK_BackSpace;
    default: break;
  }
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) return NoSymbol;
  return cp <= 0xff ? (KeySym)cp : (KeySym)(0x1000000 | cp);
}

static int is_scratch(int keycode) {
  for (int i = 0; i < scratch_count; i++) {
    if (scratch[i] == keycode) return 1;
  }
  return 0;
}

// Key codes with nothing on them can stand in for any character for a moment.
static void find_scratch_keys(void) {
  int per = 0;
  KeySym *map = XGetKeyboardMapping(dpy, (KeyCode)min_keycode, max_keycode - min_keycode + 1, &per);
  if (!map) return;
  for (int kc = max_keycode; kc >= min_keycode && scratch_count < SCRATCH_KEYS; kc--) {
    int empty = 1;
    for (int i = 0; i < per && empty; i++) empty = map[(kc - min_keycode) * per + i] == NoSymbol;
    if (empty) scratch[scratch_count++] = (KeyCode)kc;
  }
  XFree(map);
}

static void set_scratch(int i, KeySym sym) {
  KeySym syms[2] = { sym, sym };
  XChangeKeyboardMapping(dpy, scratch[i], 2, syms, 1);
  XSync(dpy, False);
  scratch_sym[i] = sym;
}

static KeyCode scratch_key(KeySym sym) {
  if (scratch_count == 0) return 0;
  int i = scratch_next;
  scratch_next = (scratch_next + 1) % scratch_count;
  set_scratch(i, sym);
  scratch_in_use = 1;
  // Apps pick up keyboard mapping changes on their own time, so give them a moment before the key arrives.
  usleep(25 * 1000);
  return scratch[i];
}

static void restore_scratch_keys(void) {
  for (int i = 0; i < scratch_count; i++) {
    if (scratch_sym[i] != NoSymbol) set_scratch(i, NoSymbol);
  }
  scratch_in_use = 0;
}

// Keep Xlib's copy of the keyboard mapping current, so keys are looked up in the layout in use right now.
static void read_x_events(void) {
  while (XPending(dpy)) {
    XEvent event;
    XNextEvent(dpy, &event);
    if (event.type == MappingNotify) XRefreshKeyboardMapping(&event.xmapping);
  }
}

// Finds a key that types the keysym in the current layout, with or without Shift.
static int find_key(KeySym sym, int group, KeyCode *code, int *shift) {
  for (int kc = min_keycode; kc <= max_keycode; kc++) {
    if (is_scratch(kc)) continue;
    for (int level = 0; level < 2; level++) {
      if (XkbKeycodeToKeysym(dpy, (KeyCode)kc, group, level) == sym) {
        *code = (KeyCode)kc;
        *shift = level;
        return 1;
      }
    }
  }
  return 0;
}

static void tap(KeyCode code, int shift) {
  KeyCode shift_key = shift ? XKeysymToKeycode(dpy, XK_Shift_L) : 0;
  if (shift_key) XTestFakeKeyEvent(dpy, shift_key, True, CurrentTime);
  XTestFakeKeyEvent(dpy, code, True, CurrentTime);
  XTestFakeKeyEvent(dpy, code, False, CurrentTime);
  if (shift_key) XTestFakeKeyEvent(dpy, shift_key, False, CurrentTime);
  XFlush(dpy);
}

static void type_character(unsigned long cp) {
  KeySym sym = keysym_for(cp);
  if (sym == NoSymbol) return;
  read_x_events();
  for (int i = 0; i < scratch_count; i++) {
    if (scratch_sym[i] == sym) {
      tap(scratch[i], 0);
      return;
    }
  }
  XkbStateRec state;
  if (XkbGetState(dpy, XkbUseCoreKbd, &state) != Success) memset(&state, 0, sizeof state);
  KeyCode code = 0;
  int shift = 0;
  if (find_key(sym, state.group, &code, &shift)) {
    // With Caps Lock on, letters come out in the other case.
    KeySym lower, upper;
    XConvertCase(sym, &lower, &upper);
    if ((state.locked_mods & LockMask) && lower != upper) shift = !shift;
    tap(code, shift);
    return;
  }
  code = scratch_key(sym);
  if (code) tap(code, 0);
}

// Never leave buttons or keys held down, or spare keys standing in for characters, when JConnect goes away.
static void release_all(void) {
  for (unsigned int b = 1; b < 10; b++) {
    if (buttons_down[b]) XTestFakeButtonEvent(dpy, b, False, CurrentTime);
  }
  for (int kc = 0; kc < 256; kc++) {
    if (keys_down[kc]) XTestFakeKeyEvent(dpy, (unsigned int)kc, False, CurrentTime);
  }
  restore_scratch_keys();
  XSync(dpy, False);
}

static double clamp(double value, double low, double high) {
  return value < low ? low : value > high ? high : value;
}

// Reads up to max numbers separated by spaces. Returns how many there were, or -1 if anything else is on the line.
static int numbers(const char *text, double *out, int max) {
  int count = 0;
  for (;;) {
    while (*text == ' ') text++;
    if (*text == '\0') return count;
    if (count == max) return -1;
    char *end;
    double value = strtod(text, &end);
    if (end == text || !isfinite(value)) return -1;
    out[count++] = clamp(value, -2000000, 2000000);
    text = end;
  }
}

static void handle(const char *line) {
  double a[3];
  if (line[0] == '\0' || (line[1] != ' ' && line[1] != '\0')) return;
  int n = numbers(line + 1, a, 3);
  if (n < 0) return;
  switch (line[0]) {
    case 'M':
      if (n >= 2) move_to((int)lround(a[0]), (int)lround(a[1]));
      break;
    case 'B':
      if (n >= 2) press_button((int)a[0], a[1] != 0);
      break;
    case 'W':
      if (n >= 2) scroll(clamp(a[0], -10000, 10000), clamp(a[1], -10000, 10000));
      break;
    case 'K':
      if (n >= 2) press_key((int)a[0], a[1] != 0);
      break;
    case 'T':
      if (n >= 1 && a[0] >= 0) type_character((unsigned long)a[0]);
      break;
    default:
      break;
  }
}

int main(void) {
  setvbuf(stdout, NULL, _IOLBF, 0);

  dpy = XOpenDisplay(NULL);
  if (!dpy) {
    printf("error JConnect couldn't connect to the X server%s.\n", getenv("DISPLAY") ? "" : ", because DISPLAY isn't set");
    return 2;
  }
  int event_base, error_base, major, minor;
  if (!XTestQueryExtension(dpy, &event_base, &error_base, &major, &minor)) {
    printf("error The X server doesn't have the XTEST extension, which remote control needs.\n");
    return 2;
  }
  XSetErrorHandler(report_x_error);
  // Keep working while another app has grabbed the X server.
  XTestGrabControl(dpy, True);
  XDisplayKeycodes(dpy, &min_keycode, &max_keycode);
  if (max_keycode > 255) max_keycode = 255;
  find_scratch_keys();
  printf("ready\n");

  char buffer[4096];
  size_t length = 0;
  for (;;) {
    struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN };
    int ready = poll(&input, 1, scratch_in_use ? SCRATCH_IDLE_MS : -1);
    if (ready < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (ready == 0) {
      restore_scratch_keys();
      continue;
    }
    ssize_t n = read(STDIN_FILENO, buffer + length, sizeof buffer - length);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) break;
    length += (size_t)n;
    size_t start = 0;
    for (size_t i = 0; i < length; i++) {
      if (buffer[i] != '\n') continue;
      buffer[i] = '\0';
      handle(buffer + start);
      start = i + 1;
    }
    memmove(buffer, buffer + start, length - start);
    length -= start;
    // No command is this long.
    if (length == sizeof buffer) length = 0;
  }

  release_all();
  XCloseDisplay(dpy);
  return 0;
}
