using System.Diagnostics;
using System.Numerics;
using System.Runtime.CompilerServices;
using KKNotes.Core.Ink;
using KKNotes.Core.View;
using KKNotes.Native.Interop;
using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.Geometry;
using Windows.Foundation;
using Windows.UI;

namespace KKNotes.Native.Ink;

/// <summary>
/// The render thread. A frame is drawn as soon as something changes, not on a timer:
/// <list type="bullet">
/// <item>Finished strokes are kept in a <b>dry</b> bitmap the size of the view, redrawn only when
/// the page moves or the strokes change (a new stroke is added to it rather than redrawn).</item>
/// <item>Each frame copies the dry bitmap, then outlines and fills the stroke in progress
/// (<b>wet</b>) with the predicted points on its end, so its cost does not grow with the page.</item>
/// <item>The frame is presented straight away (sync interval 0): DWM shows the newest finished
/// frame at its next refresh, so a pen sample waits for at most one frame of drawing. With the
/// DXGI device's frame latency at 1, the CPU cannot run ahead of the screen and queue up lag.</item>
/// </list>
/// </summary>
internal sealed partial class InkSurface
{
    private static readonly Color DeskColor = Color.FromArgb(255, 0xE4, 0xE4, 0xE7);
    private static readonly Color PageEdgeColor = Color.FromArgb(255, 0xC8, 0xC8, 0xCE);
    private static readonly Color RingColor = Color.FromArgb(255, 0x6B, 0x6B, 0x75);

    private readonly AutoResetEvent _frameRequested = new(false);
    private Thread? _renderThread;

    // Render-thread state.
    private CanvasDevice? _device;
    private CanvasSwapChain? _swapChain;
    private CanvasRenderTarget? _dry;
    private Stroke[] _rStrokes = [];
    private int _rStrokesVersion = -1;
    private HashSet<Stroke> _rErasing = [];
    private int _rErasingVersion = -1;
    private readonly List<InkPoint> _rWet = new(4096);
    private PageCamera? _dryCamera;
    private Stroke[] _dryStrokes = [];
    private int _dryErasingVersion = -1;
    private readonly ConditionalWeakTable<Stroke, CanvasGeometry> _geometries = new();
    private long _framesPresented;

    private void RequestFrame() => _frameRequested.Set();

    private void StartRenderThread()
    {
        _renderThread = new Thread(RenderLoop) { IsBackground = true, Name = "Ink render", Priority = ThreadPriority.AboveNormal };
        _renderThread.Start();
    }

    private void StopRenderThread()
    {
        _frameRequested.Set();
        _renderThread?.Join(1000);
    }

    private void RenderLoop()
    {
        CreateDevice();
        while (!_disposed)
        {
            _frameRequested.WaitOne(500);
            if (_disposed) break;
            try
            {
                RenderFrame();
                SaveSnapshotIfAsked();
            }
            catch (Exception ex) when (_device is not null && _device.IsDeviceLost(ex.HResult))
            {
                // The GPU was reset (a driver update, a dock): start again on a new device.
                Log.Write("GPU device lost; making a new one");
                _dry?.Dispose();
                _dry = null;
                _swapChain = null;
                _geometries.Clear();
                _device?.Dispose();
                CreateDevice();
                lock (_sync) _resizePending = true;
                RequestFrame();
            }
            catch (Exception ex)
            {
                // A frame that fails must not take the render thread with it.
                Log.Write($"Frame failed: {ex}");
            }
        }
        _dry?.Dispose();
        _swapChain?.Dispose();
        _device?.Dispose();
    }

    /// <summary>Whether DXGI accepted a frame latency of 1 (shown in the stats).</summary>
    public bool FrameLatencySet { get; private set; }

    private void CreateDevice()
    {
        _device = new CanvasDevice();
        FrameLatencySet = Win32.SetMaximumFrameLatency(_device, 1);
        Log.Write($"GPU device ready; maximum frame latency 1: {(FrameLatencySet ? "set" : "NOT set")}");
    }

    // ---- Snapshot (`--snapshot`) ---------------------------------------------------------

    private string? _snapshotPath;
    private TaskCompletionSource<bool>? _snapshotDone;

    /// <summary>Saves the page as the next frame shows it (finished strokes only) to a PNG.</summary>
    public Task<bool> SaveSnapshotAsync(string path)
    {
        var done = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (_sync)
        {
            _snapshotPath = path;
            _snapshotDone = done;
        }
        RequestFrame();
        return done.Task;
    }

    private void SaveSnapshotIfAsked()
    {
        string? path;
        TaskCompletionSource<bool>? done;
        lock (_sync)
        {
            if (_dry is null || _dryCamera is null) return;
            path = _snapshotPath;
            done = _snapshotDone;
            _snapshotPath = null;
            _snapshotDone = null;
        }
        if (path is null || done is null) return;
        try
        {
            _dry.SaveAsync(path, CanvasBitmapFileFormat.Png).AsTask().GetAwaiter().GetResult();
            Log.Write($"Snapshot saved: {path}");
            done.SetResult(true);
        }
        catch (Exception ex)
        {
            Log.Write($"Snapshot failed: {ex}");
            done.SetResult(false);
        }
    }

    private void RenderFrame()
    {
        var device = _device!;

        // ---- Take what this frame needs, briefly holding the lock --------------------------
        PageCamera camera;
        double viewWidth, viewHeight, pageWidth, pageHeight;
        float scale;
        bool resize;
        StrokeStyle? wetStyle = null;
        Vec2? ring;
        long newestInputUs;
        lock (_sync)
        {
            camera = _camera;
            viewWidth = _viewWidth;
            viewHeight = _viewHeight;
            pageWidth = _page.Width;
            pageHeight = _page.Height;
            scale = _compositionScale;
            resize = _resizePending;
            _resizePending = false;
            if (_page.Version != _rStrokesVersion)
            {
                _rStrokes = [.. _page.Strokes];
                _rStrokesVersion = _page.Version;
            }
            if (_erasingVersion != _rErasingVersion)
            {
                _rErasing = [.. _erasing];
                _rErasingVersion = _erasingVersion;
            }
            _rWet.Clear();
            if (_wet is { } wet)
            {
                wet.CopyTo(_rWet);
                _rWet.AddRange(_predicted);
                wetStyle = wet.Style;
            }
            ring = _ring;
            newestInputUs = _newestInputUs;
        }

        if (viewWidth < 1 || viewHeight < 1) return;
        long started = Stopwatch.GetTimestamp();

        if (_swapChain is null || resize) EnsureSwapChain(device, (float)viewWidth, (float)viewHeight, scale);
        var swapChain = _swapChain!;

        UpdateDry(camera, viewWidth, viewHeight, pageWidth, pageHeight);

        using (var ds = swapChain.CreateDrawingSession(DeskColor))
        {
            ds.DrawImage(_dry!);
            if (wetStyle is not null && _rWet.Count > 0)
            {
                ds.Transform = PageToView(camera);
                using var geometry = BuildGeometry(device, StrokeOutline.Get(_rWet, wetStyle, complete: false), Brushes.SmoothOutline(wetStyle));
                Fill(ds, geometry, wetStyle);
                ds.Transform = Matrix3x2.Identity;
                DrawDeskAround(ds, camera, viewWidth, viewHeight, pageWidth, pageHeight);
            }
            if (ring is Vec2 r)
            {
                var (cx, cy) = camera.ToView(r.X, r.Y);
                float radius = (float)Math.Max(4, HitTest.StrokeEraserRadius * camera.Zoom);
                ds.DrawCircle((float)cx, (float)cy, radius, RingColor, 1.5f);
                ds.FillCircle((float)cx, (float)cy, 1.2f, RingColor);
            }
        }
        double drawMs = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
        swapChain.Present(_vsync ? 1 : 0);
        if (++_framesPresented == 1) Log.Write("First frame presented");

        double? ageMs = null;
        if (wetStyle is not null && newestInputUs > 0)
        {
            double age = (Win32.NowMicroseconds() - newestInputUs) / 1000.0;
            // Pointer timestamps should be on the performance counter's clock; if this one is
            // not, say nothing rather than something wrong.
            if (age >= 0 && age < 1000) ageMs = age;
        }
        Stats.AddFrame(drawMs, ageMs);
    }

    private void EnsureSwapChain(CanvasDevice device, float width, float height, float scale)
    {
        float dpi = 96 * scale;
        Log.Write($"Swap chain {(_swapChain is null ? "created" : "resized")}: {width:0} x {height:0} DIPs at {dpi:0} dpi");
        if (_swapChain is null)
        {
            var swapChain = new CanvasSwapChain(device, width, height, dpi);
            _swapChain = swapChain;
            // The panel is a XAML element: it takes its swap chain on the UI thread.
            _uiQueue.TryEnqueue(() => { if (!_disposed) _panel.SwapChain = swapChain; });
        }
        else
        {
            _swapChain.ResizeBuffers(width, height, dpi);
        }
        _dry?.Dispose();
        _dry = new CanvasRenderTarget(device, width, height, dpi);
        _dryCamera = null;
    }

    private static Matrix3x2 PageToView(PageCamera camera) =>
        Matrix3x2.CreateScale((float)camera.Zoom) * Matrix3x2.CreateTranslation((float)camera.OffsetX, (float)camera.OffsetY);

    /// <summary>Brings the bitmap of finished strokes up to date, adding to it when it can.</summary>
    private void UpdateDry(PageCamera camera, double viewWidth, double viewHeight, double pageWidth, double pageHeight)
    {
        var dry = _dry!;
        bool sameView = _dryCamera == camera && _dryErasingVersion == _rErasingVersion;
        if (sameView && ReferenceEquals(_dryStrokes, _rStrokes)) return;

        if (sameView && IsExtensionOf(_rStrokes, _dryStrokes))
        {
            // Only strokes added since: draw just those on top.
            using var ds = dry.CreateDrawingSession();
            ds.Transform = PageToView(camera);
            for (int i = _dryStrokes.Length; i < _rStrokes.Length; i++) DrawStroke(ds, _rStrokes[i]);
            ds.Transform = Matrix3x2.Identity;
            DrawDeskAround(ds, camera, viewWidth, viewHeight, pageWidth, pageHeight);
        }
        else
        {
            using var ds = dry.CreateDrawingSession();
            ds.Clear(DeskColor);
            var (left, top) = camera.ToView(0, 0);
            ds.FillRectangle((float)left, (float)top, (float)(pageWidth * camera.Zoom), (float)(pageHeight * camera.Zoom), Colors.White);
            ds.Transform = PageToView(camera);
            foreach (var stroke in _rStrokes)
            {
                if (!_rErasing.Contains(stroke)) DrawStroke(ds, stroke);
            }
            ds.Transform = Matrix3x2.Identity;
            DrawDeskAround(ds, camera, viewWidth, viewHeight, pageWidth, pageHeight);
        }
        _dryCamera = camera;
        _dryStrokes = _rStrokes;
        _dryErasingVersion = _rErasingVersion;
    }

    private static bool IsExtensionOf(Stroke[] now, Stroke[] before)
    {
        if (now.Length < before.Length) return false;
        for (int i = 0; i < before.Length; i++)
        {
            if (!ReferenceEquals(now[i], before[i])) return false;
        }
        return true;
    }

    /// <summary>
    /// Paints the desk around the page, over anything drawn past its edges. Ink is clipped to the
    /// page this way rather than with a layer, because a layer would start transparent and the
    /// highlighter's blend needs the paper underneath it.
    /// </summary>
    private static void DrawDeskAround(CanvasDrawingSession ds, PageCamera camera, double viewWidth, double viewHeight, double pageWidth, double pageHeight)
    {
        var (l, t) = camera.ToView(0, 0);
        var (r, b) = camera.ToView(pageWidth, pageHeight);
        float w = (float)viewWidth, h = (float)viewHeight;
        float fl = (float)l, ft = (float)t, fr = (float)r, fb = (float)b;
        if (ft > 0) ds.FillRectangle(0, 0, w, ft, DeskColor);
        if (fb < h) ds.FillRectangle(0, fb, w, h - fb, DeskColor);
        if (fl > 0) ds.FillRectangle(0, ft, fl, fb - ft, DeskColor);
        if (fr < w) ds.FillRectangle(fr, ft, w - fr, fb - ft, DeskColor);
        ds.DrawRectangle(fl - 0.5f, ft - 0.5f, fr - fl + 1, fb - ft + 1, PageEdgeColor, 1);
    }

    private void DrawStroke(CanvasDrawingSession ds, Stroke stroke)
    {
        if (!_geometries.TryGetValue(stroke, out var geometry))
        {
            geometry = BuildGeometry(_device!, StrokeOutline.Get(stroke.Points, stroke.Style, complete: true), Brushes.SmoothOutline(stroke.Style));
            _geometries.AddOrUpdate(stroke, geometry);
        }
        Fill(ds, geometry, stroke.Style);
    }

    /// <summary>
    /// Fills an outline. Ink is painted over the page. A highlighter (or marker) multiplies in the
    /// current app, which on paper is a tint that leaves dark ink dark; here it is drawn with a
    /// Min blend of that tint, which looks the same except that overlapping passes do not darken.
    /// </summary>
    private static void Fill(CanvasDrawingSession ds, CanvasGeometry geometry, StrokeStyle style)
    {
        var color = ParseColor(style.Color);
        if (style.CompositeOperation == "multiply")
        {
            double a = Math.Clamp(style.Opacity, 0, 1);
            byte Tint(byte c) => (byte)Math.Round(255 - (255 - c) * a);
            ds.Blend = CanvasBlend.Min;
            ds.FillGeometry(geometry, Color.FromArgb(255, Tint(color.R), Tint(color.G), Tint(color.B)));
            ds.Blend = CanvasBlend.SourceOver;
        }
        else
        {
            color.A = (byte)Math.Round(255 * Math.Clamp(style.Opacity, 0, 1));
            ds.FillGeometry(geometry, color);
        }
    }

    /// <summary>
    /// The outline as a path: hard polygon edges, or quadratic curves through the midpoints of
    /// its vertices (<c>outlineToPath2D</c>), filled with the nonzero rule as the canvas does.
    /// </summary>
    private static CanvasGeometry BuildGeometry(ICanvasResourceCreator device, List<Vec2> outline, bool smooth)
    {
        if (outline.Count == 0) return CanvasGeometry.CreateRectangle(device, 0, 0, 0, 0);
        static Vector2 V(Vec2 p) => new((float)p.X, (float)p.Y);
        if (outline.Count < 3) return CanvasGeometry.CreateCircle(device, V(outline[0]), 0.5f);

        using var path = new CanvasPathBuilder(device);
        path.SetFilledRegionDetermination(CanvasFilledRegionDetermination.Winding);
        path.BeginFigure(V(outline[0]));
        int n = outline.Count;
        if (smooth)
        {
            for (int i = 0; i < n; i++)
            {
                var a = outline[i];
                var b = outline[(i + 1) % n];
                path.AddQuadraticBezier(V(a), new Vector2((float)((a.X + b.X) / 2), (float)((a.Y + b.Y) / 2)));
            }
        }
        else
        {
            for (int i = 1; i < n; i++) path.AddLine(V(outline[i]));
        }
        path.EndFigure(CanvasFigureLoop.Closed);
        return CanvasGeometry.CreatePath(path);
    }

    private static Color ParseColor(string hex)
    {
        if (hex.Length == 7 && hex[0] == '#' && uint.TryParse(hex.AsSpan(1), System.Globalization.NumberStyles.HexNumber, null, out uint rgb))
        {
            return Color.FromArgb(255, (byte)(rgb >> 16), (byte)(rgb >> 8), (byte)rgb);
        }
        return Color.FromArgb(255, 0x1F, 0x1F, 0x24);
    }
}

file static class Colors
{
    public static readonly Color White = Color.FromArgb(255, 255, 255, 255);
}
