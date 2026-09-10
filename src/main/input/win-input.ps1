$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class JConnectInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct HARDWAREINPUT { public uint uMsg; public uint wParamH; public uint wParamL; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);

  const uint KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4;
  const uint LEFTDOWN = 0x2, LEFTUP = 0x4, RIGHTDOWN = 0x8, RIGHTUP = 0x10, MIDDLEDOWN = 0x20, MIDDLEUP = 0x40;
  const uint XDOWN = 0x80, XUP = 0x100, WHEEL = 0x800, HWHEEL = 0x1000;

  static void Send(INPUT input) { SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))); }

  static void Mouse(uint flags, uint data) {
    INPUT i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; Send(i);
  }

  static void Key(ushort vk, bool extended, bool down) {
    INPUT i = new INPUT(); i.type = 1;
    i.u.ki.wVk = vk; i.u.ki.wScan = (ushort)MapVirtualKey(vk, 0);
    i.u.ki.dwFlags = (extended ? KEYEVENTF_EXTENDEDKEY : 0) | (down ? 0 : KEYEVENTF_KEYUP);
    Send(i);
  }

  static void Unicode(int codePoint) {
    foreach (char c in char.ConvertFromUtf32(codePoint)) {
      for (int pass = 0; pass < 2; pass++) {
        INPUT i = new INPUT(); i.type = 1; i.u.ki.wScan = c;
        i.u.ki.dwFlags = KEYEVENTF_UNICODE | (pass == 1 ? KEYEVENTF_KEYUP : 0);
        Send(i);
      }
    }
  }

  public static void Run() {
    try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
    Console.Out.WriteLine("ready"); Console.Out.Flush();
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      string[] p = line.Split(' ');
      try {
        switch (p[0]) {
          case "M": SetCursorPos(int.Parse(p[1]), int.Parse(p[2])); break;
          case "B": {
            int b = int.Parse(p[1]); bool d = p[2] == "1";
            uint f = b == 0 ? (d ? LEFTDOWN : LEFTUP) : b == 1 ? (d ? MIDDLEDOWN : MIDDLEUP) : b == 2 ? (d ? RIGHTDOWN : RIGHTUP) : (d ? XDOWN : XUP);
            Mouse(f, b == 3 ? 1u : b == 4 ? 2u : 0u);
            break;
          }
          case "W": {
            int dx = int.Parse(p[1]), dy = int.Parse(p[2]);
            if (dy != 0) Mouse(WHEEL, unchecked((uint)(-dy)));
            if (dx != 0) Mouse(HWHEEL, unchecked((uint)dx));
            break;
          }
          case "K": Key((ushort)int.Parse(p[1]), p[2] == "1", p[3] == "1"); break;
          case "T": Unicode(int.Parse(p[1])); break;
        }
      } catch (Exception) { }
    }
  }
}
'@
[JConnectInput]::Run()
