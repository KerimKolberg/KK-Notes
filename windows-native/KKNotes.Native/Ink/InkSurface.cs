using KKNotes.Core.Ink;
using KKNotes.Core.View;
using KKNotes.Native.Interop;
using Microsoft.Graphics.Canvas.UI.Xaml;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;

namespace KKNotes.Native.Ink;

/// <summary>
/// The page and the pen. Three threads share it:
/// <list type="bullet">
/// <item>the UI thread sets the tool, colour and width, and asks for undo, redo and clear;</item>
/// <item>an input thread receives pen, mouse and touch from the panel's independent input source,
/// so a busy UI thread never holds the pen back (<c>InkSurface.Input.cs</c>);</item>
/// <item>a render thread draws a frame whenever something changed and hands it to the compositor
/// at once (<c>InkSurface.Render.cs</c>).</item>
/// </list>
/// Everything the input thread writes and the render thread reads is guarded by <see cref="_sync"/>.
/// </summary>
internal sealed partial class InkSurface : IDisposable
{
    private readonly CanvasSwapChainPanel _panel;
    private readonly IntPtr _hwnd;
    private readonly DispatcherQueue _uiQueue;
    private readonly object _sync = new();

    // ---- Shared scene (guarded by _sync) -------------------------------------------------
    private readonly InkPage _page = new();
    private PageCamera _camera = PageCamera.Identity;
    private bool _cameraFitted;
    private double _viewWidth, _viewHeight;
    private float _compositionScale = 1;
    private bool _resizePending;
    /// <summary>The stroke being drawn, or null.</summary>
    private StrokeBuilder? _wet;
    /// <summary>Where the system predicts the pen is going next, drawn after the wet stroke but never kept.</summary>
    private readonly List<InkPoint> _predicted = [];
    /// <summary>Strokes the eraser has crossed during this drag: hidden now, removed on release.</summary>
    private readonly HashSet<Stroke> _erasing = [];
    private int _erasingVersion;
    /// <summary>Where the eraser ring is drawn, in page units, or null when there is none.</summary>
    private Vec2? _ring;
    /// <summary>Timestamp (µs) of the newest sample in the scene, to measure how old a frame's input is.</summary>
    private long _newestInputUs;

    private volatile InkSettings _settings = InkSettings.Default;
    private volatile bool _vsync;
    private volatile bool _disposed;

    public InkSurface(CanvasSwapChainPanel panel, IntPtr hwnd)
    {
        _panel = panel;
        _hwnd = hwnd;
        _uiQueue = DispatcherQueue.GetForCurrentThread();
        _panel.SizeChanged += OnPanelSizeChanged;
        _panel.CompositionScaleChanged += OnCompositionScaleChanged;
    }

    public FrameStats Stats { get; } = new();

    /// <summary>Raised on any thread when the tool changes (the pen's barrel button changes it too).</summary>
    public event Action<Tool>? ToolChanged;

    public InkSettings Settings => _settings;

    /// <summary>Wait for the display before handing over a frame (true), or hand it over at once (false).</summary>
    public bool VSync
    {
        get => _vsync;
        set
        {
            _vsync = value;
            RequestFrame();
        }
    }

    /// <summary>Which thread the pen arrives on, for the stats line.</summary>
    public string InputThreadInfo { get; private set; } = "starting";

    /// <summary>What the pen reported last: tip, buttons, pressure and tilt (the "pen button test").</summary>
    public string PenInfo { get; private set; } = "no pen yet";

    public int RefreshRate => Win32.RefreshRate(_hwnd);

    public double Zoom => _camera.Zoom;

    public void Start()
    {
        _compositionScale = _panel.CompositionScaleX;
        Log.Write($"Ink surface starting: {_panel.ActualWidth:0} x {_panel.ActualHeight:0} DIPs, scale {_compositionScale:0.##}, display {RefreshRate} Hz");
        UpdateViewSize(_panel.ActualWidth, _panel.ActualHeight);
        StartRenderThread();
        StartInput();
    }

    public void UpdateSettings(Func<InkSettings, InkSettings> change)
    {
        Tool before, after;
        lock (_sync)
        {
            before = _settings.Tool;
            _settings = change(_settings);
            after = _settings.Tool;
            if (_ring is not null && after != Tool.StrokeEraser) _ring = null;
        }
        if (before != after) ToolChanged?.Invoke(after);
        RequestFrame();
    }

    private void SetTool(Tool tool) => UpdateSettings(s => s with { Tool = tool });

    public void Undo()
    {
        lock (_sync) _page.Undo();
        RequestFrame();
    }

    public void Redo()
    {
        lock (_sync) _page.Redo();
        RequestFrame();
    }

    /// <summary>Puts finished strokes on the page (the snapshot's demo page).</summary>
    public void AddStrokes(IEnumerable<Stroke> strokes)
    {
        lock (_sync)
        {
            foreach (var stroke in strokes) _page.Add(stroke);
        }
        RequestFrame();
    }

    public void Clear()
    {
        lock (_sync) _page.Clear();
        RequestFrame();
    }

    /// <summary>Back to the page fitted to the width of the window.</summary>
    public void ResetView()
    {
        lock (_sync) _camera = PageCamera.FitWidth(_viewWidth, _viewHeight, _page.Width, _page.Height);
        RequestFrame();
    }

    private void OnPanelSizeChanged(object sender, SizeChangedEventArgs e) =>
        UpdateViewSize(e.NewSize.Width, e.NewSize.Height);

    private void OnCompositionScaleChanged(Microsoft.UI.Xaml.Controls.SwapChainPanel sender, object args)
    {
        lock (_sync)
        {
            _compositionScale = sender.CompositionScaleX;
            _resizePending = true;
        }
        RequestFrame();
    }

    private void UpdateViewSize(double width, double height)
    {
        if (width <= 0 || height <= 0) return;
        lock (_sync)
        {
            _viewWidth = width;
            _viewHeight = height;
            if (!_cameraFitted)
            {
                _camera = PageCamera.FitWidth(width, height, _page.Width, _page.Height);
                _cameraFitted = true;
            }
            else
            {
                _camera = _camera.Clamped(width, height, _page.Width, _page.Height);
            }
            _resizePending = true;
        }
        RequestFrame();
    }

    /// <summary>Moves the page; called with <see cref="_sync"/> held.</summary>
    private void SetCameraLocked(PageCamera camera) =>
        _camera = camera.Clamped(_viewWidth, _viewHeight, _page.Width, _page.Height);

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _panel.SizeChanged -= OnPanelSizeChanged;
        _panel.CompositionScaleChanged -= OnCompositionScaleChanged;
        StopInput();
        StopRenderThread();
    }
}
