using System.Diagnostics;
using System.Runtime.InteropServices;
using WinRT;

namespace KKNotes.Native.Interop;

/// <summary>The few Win32 and DXGI calls the prototype needs that WinUI and Win2D do not expose.</summary>
internal static unsafe class Win32
{
    private static readonly Guid IidDirect3DDxgiInterfaceAccess = new("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1");
    private static readonly Guid IidDxgiDevice1 = new("77DB970F-6276-48BA-BA28-070143B4392C");

    /// <summary>
    /// Lets the CPU queue at most <paramref name="frames"/> frames ahead of the display. DXGI's
    /// default is 3, and every queued frame is a frame of ink lag; Win2D does not expose it, so it
    /// is set on the device's <c>IDXGIDevice1</c> directly. Returns false if it could not be set.
    /// </summary>
    public static bool SetMaximumFrameLatency(object direct3DDevice, uint frames)
    {
        IntPtr unknown = ((IWinRTObject)direct3DDevice).NativeObject.ThisPtr;
        Guid iidAccess = IidDirect3DDxgiInterfaceAccess;
        if (Marshal.QueryInterface(unknown, in iidAccess, out IntPtr access) < 0) return false;
        try
        {
            // IDirect3DDxgiInterfaceAccess::GetInterface is slot 3, after IUnknown's three.
            Guid iidDevice = IidDxgiDevice1;
            IntPtr dxgiDevice;
            var getInterface = (delegate* unmanaged[Stdcall]<IntPtr, Guid*, IntPtr*, int>)(*(*(void***)access + 3));
            if (getInterface(access, &iidDevice, &dxgiDevice) < 0) return false;
            try
            {
                // IDXGIDevice1::SetMaximumFrameLatency: IUnknown (3) + IDXGIObject (4) + IDXGIDevice (5) = slot 12.
                var setLatency = (delegate* unmanaged[Stdcall]<IntPtr, uint, int>)(*(*(void***)dxgiDevice + 12));
                return setLatency(dxgiDevice, frames) >= 0;
            }
            finally
            {
                Marshal.Release(dxgiDevice);
            }
        }
        finally
        {
            Marshal.Release(access);
        }
    }

    /// <summary>Now, in microseconds of the performance counter (the clock pointer timestamps use).</summary>
    public static long NowMicroseconds() => (long)(Stopwatch.GetTimestamp() * (1_000_000.0 / Stopwatch.Frequency));

    /// <summary>Now, in milliseconds, for timings that only need differences.</summary>
    public static double NowMs() => Stopwatch.GetTimestamp() * (1000.0 / Stopwatch.Frequency);

    /// <summary>The refresh rate of the monitor the window is on, in Hz (0 if unknown).</summary>
    public static int RefreshRate(IntPtr hwnd)
    {
        IntPtr monitor = MonitorFromWindow(hwnd, MonitorDefaultToNearest);
        var info = new MonitorInfoEx { cbSize = (uint)Marshal.SizeOf<MonitorInfoEx>() };
        if (!GetMonitorInfoW(monitor, ref info)) return 0;
        var mode = new DevMode { dmSize = (ushort)Marshal.SizeOf<DevMode>() };
        return EnumDisplaySettingsW(info.szDevice, EnumCurrentSettings, ref mode) ? (int)mode.dmDisplayFrequency : 0;
    }

    private const uint MonitorDefaultToNearest = 2;
    private const int EnumCurrentSettings = -1;

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMonitorInfoW(IntPtr monitor, ref MonitorInfoEx info);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumDisplaySettingsW(string deviceName, int modeNum, ref DevMode devMode);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MonitorInfoEx
    {
        public uint cbSize;
        public int rcMonitorLeft, rcMonitorTop, rcMonitorRight, rcMonitorBottom;
        public int rcWorkLeft, rcWorkTop, rcWorkRight, rcWorkBottom;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }

    /// <summary>DEVMODEW, display variant (220 bytes).</summary>
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DevMode
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public ushort dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
        public uint dmFields;
        public int dmPositionX, dmPositionY;
        public uint dmDisplayOrientation, dmDisplayFixedOutput;
        public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public ushort dmLogPixels;
        public uint dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
        public uint dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
    }
}
