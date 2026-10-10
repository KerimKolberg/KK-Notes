---
name: winui-build-run
description: Build, run and debug the native Windows (WinUI 3) version of KK-Notes in windows-native/. Use when creating the WinUI project, building it, launching it for the owner to test with the pen, or fixing build errors. Windows only.
---

# Building and running the WinUI 3 app

Read `windows-native/HANDOFF.md` first if you have not this session.

## Prerequisites (check, do not assume)

Run these in PowerShell and report what is missing instead of guessing:

```powershell
dotnet --list-sdks                      # needs .NET 8 or newer
dotnet new list winui                   # WinUI templates, from Visual Studio's workload
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -Name AllowDevelopmentWithoutDevLicense  # Developer Mode = 1
```

Visual Studio 2022 with the **WinUI application development** workload is the supported way to get
the Windows App SDK and templates. If the templates are missing from `dotnet new`, ask the owner to
install that workload rather than pulling unofficial template packs.

## Project shape

- `windows-native/KKNotes.Native.sln`, app project `windows-native/KKNotes.Native/`.
- **Unpackaged** (`<WindowsPackageType>None</WindowsPackageType>`) so it runs from `dotnet run` and
  needs no signing; `<WindowsAppSDKSelfContained>true</WindowsAppSDKSelfContained>`.
- Target `net8.0-windows10.0.22621.0` (or newer), `x64` (the Z13 is x64).
- Pure logic (the `.notex` model, the stroke outline, geometry) in a separate class library with an
  xUnit test project, so it is tested without a window.

## Commands

```powershell
dotnet build windows-native\KKNotes.Native.sln -c Debug -p:Platform=x64
dotnet test  windows-native\KKNotes.Core.Tests                     # once tests exist
dotnet run   --project windows-native\KKNotes.Native -c Debug -p:Platform=x64
```

- `dotnet run` blocks until the window is closed. Start it in the background, or tell the owner the
  window is up and wait for them to say they are done.
- A crash at startup in an unpackaged app is usually a missing Windows App SDK runtime or a
  bootstrap issue: read the Event Viewer (Application log) or run with a debugger attached.

## Testing with the owner

- Say exactly what to try: which tool, what to draw, at which refresh rate (60 / 180 Hz).
- For latency, compare against the current app on the same page, the same strokes.
- Ask for a screenshot when the result is visual; never claim the ink "feels" right yourself.
