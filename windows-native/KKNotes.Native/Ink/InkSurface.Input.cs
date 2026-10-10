using KKNotes.Core.Ink;
using KKNotes.Native.Interop;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Input;
using VirtualKeyModifiers = Windows.System.VirtualKeyModifiers;

namespace KKNotes.Native.Ink;

/// <summary>
/// Pen, mouse and touch, on the input thread.
/// <list type="bullet">
/// <item><b>Pen</b> draws with the tool (or erases: the eraser end, or the barrel button held).
/// Every sample the digitiser reported since the last event is used
/// (<c>GetIntermediatePoints</c>), and the system's predictor says where the pen is heading.</item>
/// <item><b>Mouse</b> draws with the left button, pans with the middle one; the wheel scrolls,
/// Ctrl+wheel zooms, Shift+wheel scrolls sideways.</item>
/// <item><b>Touch</b> never draws: one finger pans, two pinch to zoom, with inertia. A palm resting
/// while the pen is near is ignored (<see cref="TouchGate"/>).</item>
/// </list>
/// </summary>
internal sealed partial class InkSurface
{
    private DispatcherQueueController? _inputThread;
    private InputPointerSource? _input;
    private PointerPredictor? _predictor;
    private TimeSpan _systemPredictionTime;
    private volatile int _predictionMs = -1; // -1: the system's own prediction time; 0: off
    private GestureRecognizer? _gestures;
    private DispatcherQueueTimer? _barrelTimer;

    // Input-thread state.
    private uint? _activePointer;
    private Tool _activeTool;
    private ulong _lastTimestamp;
    private Vec2 _eraseLast;
    private uint? _panPointer;
    private Windows.Foundation.Point _panLast;
    private readonly HashSet<uint> _touches = [];
    private readonly TouchGate _touchGate = new();
    private BarrelState _barrel = BarrelState.Idle;
    private bool _barrelDown;
    private bool _penEraserEnd;

    /// <summary>
    /// How far ahead the system predicts the pen: -1 for its own default, 0 for none, else ms.
    /// </summary>
    public int PredictionMs
    {
        get => _predictionMs;
        set
        {
            _predictionMs = value;
            _inputThread?.DispatcherQueue.TryEnqueue(ApplyPredictionTime);
        }
    }

    /// <summary>The system predictor's own look-ahead, in ms (0 until the input source exists).</summary>
    public double SystemPredictionMs => _systemPredictionTime.TotalMilliseconds;

    private void StartInput()
    {
        _inputThread = DispatcherQueueController.CreateOnDedicatedThread();
        _inputThread.DispatcherQueue.TryEnqueue(() =>
        {
            try
            {
                CreateInputSource();
                InputThreadInfo = "own thread";
            }
            catch (Exception ex)
            {
                // Should not happen, but a pen on the UI thread is better than no pen.
                Log.Write($"Input source on its own thread failed, using the UI thread: {ex}");
                InputThreadInfo = $"UI thread ({ex.GetType().Name})";
                _uiQueue.TryEnqueue(CreateInputSource);
            }
        });
    }

    private void CreateInputSource()
    {
        var input = _panel.CreateCoreIndependentInputSource(
            InputPointerSourceDeviceKinds.Pen | InputPointerSourceDeviceKinds.Mouse | InputPointerSourceDeviceKinds.Touch);
        input.PointerPressed += OnPointerPressed;
        input.PointerMoved += OnPointerMoved;
        input.PointerReleased += OnPointerReleased;
        input.PointerExited += OnPointerExited;
        input.PointerCaptureLost += OnPointerCaptureLost;
        input.PointerWheelChanged += OnPointerWheelChanged;
        input.Cursor = InputSystemCursor.Create(InputSystemCursorShape.Cross);

        _predictor = PointerPredictor.CreateForInputPointerSource(input);
        _systemPredictionTime = _predictor.PredictionTime;
        ApplyPredictionTime();

        _gestures = new GestureRecognizer
        {
            GestureSettings = GestureSettings.ManipulationTranslateX | GestureSettings.ManipulationTranslateY
                | GestureSettings.ManipulationScale | GestureSettings.ManipulationTranslateInertia
                | GestureSettings.ManipulationScaleInertia,
            ShowGestureFeedback = false,
        };
        _gestures.ManipulationUpdated += OnManipulationUpdated;

        _barrelTimer = DispatcherQueue.GetForCurrentThread().CreateTimer();
        _barrelTimer.IsRepeating = false;
        _barrelTimer.Tick += (_, _) => OnBarrelTick();

        _input = input;
        Log.Write($"Input source ready (pen, mouse, touch); system prediction {_systemPredictionTime.TotalMilliseconds:0.#} ms");
    }

    private void ApplyPredictionTime()
    {
        if (_predictor is null) return;
        int ms = _predictionMs;
        _predictor.PredictionTime = ms > 0 ? TimeSpan.FromMilliseconds(ms) : _systemPredictionTime;
    }

    private void StopInput()
    {
        var thread = _inputThread;
        _inputThread = null;
        if (thread is null) return;
        thread.DispatcherQueue.TryEnqueue(() =>
        {
            if (_input is { } input)
            {
                input.PointerPressed -= OnPointerPressed;
                input.PointerMoved -= OnPointerMoved;
                input.PointerReleased -= OnPointerReleased;
                input.PointerExited -= OnPointerExited;
                input.PointerCaptureLost -= OnPointerCaptureLost;
                input.PointerWheelChanged -= OnPointerWheelChanged;
            }
            _barrelTimer?.Stop();
        });
        _ = thread.ShutdownQueueAsync();
    }

    // ---- Pointer events ------------------------------------------------------------------

    private void OnPointerPressed(InputPointerSource sender, PointerEventArgs e)
    {
        var pt = e.CurrentPoint;
        double now = Win32.NowMs();
        switch (pt.PointerDeviceType)
        {
            case PointerDeviceType.Touch:
                TouchDown(pt, now);
                return;
            case PointerDeviceType.Mouse:
                if (pt.Properties.IsMiddleButtonPressed)
                {
                    _panPointer = pt.PointerId;
                    _panLast = pt.Position;
                    return;
                }
                if (!pt.Properties.IsLeftButtonPressed) return;
                break;
            case PointerDeviceType.Pen:
                NotePen(pt, now);
                break;
            default:
                return;
        }

        if (_activePointer is uint active)
        {
            // One stroke at a time. The same pointer pressing again means its release was never
            // seen (lifted outside the panel, say): close that stroke rather than wait for ever.
            if (active != pt.PointerId) return;
            FinishStroke(null);
        }
        _activePointer = pt.PointerId;
        _activeTool = EffectiveTool(pt);
        _lastTimestamp = pt.Timestamp;
        var p = ToInk(pt);

        if (_activeTool == Tool.StrokeEraser)
        {
            _eraseLast = new Vec2(p.X, p.Y);
            lock (_sync)
            {
                _ring = _eraseLast;
                EraseAlongLocked(_eraseLast, _eraseLast);
            }
        }
        else
        {
            var settings = _settings;
            string pointerType = pt.PointerDeviceType == PointerDeviceType.Pen ? "pen" : "mouse";
            var builder = _activeTool == Tool.Highlighter
                ? new StrokeBuilder(StrokeTools.Highlighter, Brushes.HighlighterStyle(settings.HighlighterColor, settings.HighlighterWidth), pointerType, now)
                : new StrokeBuilder(StrokeTools.Pen, Brushes.PenStyle(settings.Brush, settings.PenColor, settings.PenWidth, pointerType), pointerType, now);
            builder.Add(p);
            lock (_sync)
            {
                _wet = builder;
                _predicted.Clear();
                _ring = null;
                _newestInputUs = (long)pt.Timestamp;
            }
        }
        Stats.AddSamples(1);
        RequestFrame();
    }

    private void OnPointerMoved(InputPointerSource sender, PointerEventArgs e)
    {
        var pt = e.CurrentPoint;
        double now = Win32.NowMs();
        switch (pt.PointerDeviceType)
        {
            case PointerDeviceType.Touch:
                if (_touches.Contains(pt.PointerId)) _gestures?.ProcessMoveEvents(e.GetIntermediatePoints());
                return;
            case PointerDeviceType.Mouse when _panPointer == pt.PointerId:
                lock (_sync) SetCameraLocked(_camera.PanBy(pt.Position.X - _panLast.X, pt.Position.Y - _panLast.Y));
                _panLast = pt.Position;
                RequestFrame();
                return;
            case PointerDeviceType.Pen:
                NotePen(pt, now);
                break;
        }

        if (_activePointer != pt.PointerId)
        {
            UpdateHoverRing(pt);
            return;
        }

        // Every sample since the last event, oldest first (the list's order is not documented).
        var points = e.GetIntermediatePoints().Where(q => q.Timestamp > _lastTimestamp).OrderBy(q => q.Timestamp).ToList();
        if (points.Count == 0) return;
        _lastTimestamp = points[^1].Timestamp;

        if (_activeTool == Tool.StrokeEraser)
        {
            lock (_sync)
            {
                foreach (var q in points)
                {
                    var p = ToInk(q);
                    var here = new Vec2(p.X, p.Y);
                    EraseAlongLocked(_eraseLast, here);
                    _eraseLast = here;
                }
                _ring = _eraseLast;
            }
        }
        else
        {
            List<InkPoint>? predicted = null;
            if (_predictionMs != 0 && _predictor is not null)
            {
                predicted = [];
                foreach (var q in _predictor.GetPredictedPoints(pt)) predicted.Add(ToInk(q));
            }
            lock (_sync)
            {
                if (_wet is { } wet)
                {
                    foreach (var q in points) wet.Add(ToInk(q));
                    _predicted.Clear();
                    if (predicted is not null) _predicted.AddRange(predicted);
                    _newestInputUs = (long)points[^1].Timestamp;
                }
            }
        }
        Stats.AddSamples(points.Count);
        RequestFrame();
    }

    private void OnPointerReleased(InputPointerSource sender, PointerEventArgs e)
    {
        var pt = e.CurrentPoint;
        switch (pt.PointerDeviceType)
        {
            case PointerDeviceType.Touch:
                if (_touches.Remove(pt.PointerId)) _gestures?.ProcessUpEvent(pt);
                return;
            case PointerDeviceType.Mouse when _panPointer == pt.PointerId:
                _panPointer = null;
                return;
        }

        // The stroke is closed before the button is read: lifting the tip and releasing the
        // barrel button are often one motion, and reading the button first would end a hold
        // before the stroke it was for (README "Stylus buttons").
        if (_activePointer == pt.PointerId) FinishStroke(pt);
        if (pt.PointerDeviceType == PointerDeviceType.Pen) NotePen(pt, Win32.NowMs());
        UpdateHoverRing(pt);
    }

    private void OnPointerExited(InputPointerSource sender, PointerEventArgs e)
    {
        var pt = e.CurrentPoint;
        if (_activePointer == pt.PointerId) return; // still drawing: the stroke goes on past the edge
        if (pt.PointerDeviceType == PointerDeviceType.Pen && !pt.IsInContact)
        {
            // The pen left range: a held button can no longer be seen to come up.
            _barrelDown = false;
            (_barrel, var action) = BarrelButton.Cancel(_barrel);
            _barrelTimer?.Stop();
            Apply(action);
            _touchGate.PenLeft(Win32.NowMs());
        }
        lock (_sync) _ring = null;
        RequestFrame();
    }

    private void OnPointerCaptureLost(InputPointerSource sender, PointerEventArgs e)
    {
        var pt = e.CurrentPoint;
        if (_touches.Remove(pt.PointerId)) _gestures?.CompleteGesture();
        if (_activePointer == pt.PointerId) FinishStroke(null);
    }

    private void OnPointerWheelChanged(InputPointerSource sender, PointerEventArgs e)
    {
        var pt = e.CurrentPoint;
        double delta = pt.Properties.MouseWheelDelta;
        bool ctrl = (e.KeyModifiers & VirtualKeyModifiers.Control) != 0;
        bool shift = (e.KeyModifiers & VirtualKeyModifiers.Shift) != 0;
        lock (_sync)
        {
            if (ctrl) SetCameraLocked(_camera.ZoomAt(Math.Pow(1.0015, delta), pt.Position.X, pt.Position.Y));
            else if (pt.Properties.IsHorizontalMouseWheel) SetCameraLocked(_camera.PanBy(-delta * 0.6, 0));
            else if (shift) SetCameraLocked(_camera.PanBy(delta * 0.6, 0));
            else SetCameraLocked(_camera.PanBy(0, delta * 0.6));
        }
        RequestFrame();
    }

    // ---- Strokes and erasing ---------------------------------------------------------------

    private void FinishStroke(PointerPoint? last)
    {
        _activePointer = null;
        if (_activeTool == Tool.StrokeEraser)
        {
            lock (_sync)
            {
                if (_erasing.Count > 0)
                {
                    _page.Remove(_erasing);
                    _erasing.Clear();
                    _erasingVersion++;
                }
            }
        }
        else
        {
            lock (_sync)
            {
                if (_wet is { } wet)
                {
                    if (last is not null && last.Timestamp > _lastTimestamp) wet.Add(ToInk(last));
                    _page.Add(wet.Build());
                }
                _wet = null;
                _predicted.Clear();
            }
        }
        RequestFrame();
    }

    /// <summary>Marks the strokes the eraser crosses going from a to b; called with <see cref="_sync"/> held.</summary>
    private void EraseAlongLocked(Vec2 a, Vec2 b)
    {
        bool any = false;
        foreach (var stroke in _page.Strokes)
        {
            if (!_erasing.Contains(stroke) && HitTest.StrokeHitBySegment(stroke, a, b, HitTest.StrokeEraserRadius))
            {
                _erasing.Add(stroke);
                any = true;
            }
        }
        if (any) _erasingVersion++;
    }

    private void UpdateHoverRing(PointerPoint pt)
    {
        bool eraser = pt.PointerDeviceType != PointerDeviceType.Touch
            && (_settings.Tool == Tool.StrokeEraser || (pt.PointerDeviceType == PointerDeviceType.Pen && _penEraserEnd));
        Vec2? ring = null;
        if (eraser)
        {
            var (x, y) = _camera.ToPage(pt.Position.X, pt.Position.Y);
            ring = new Vec2(x, y);
        }
        lock (_sync)
        {
            if (_ring == ring) return;
            _ring = ring;
        }
        RequestFrame();
    }

    private InkPoint ToInk(PointerPoint pt)
    {
        var (x, y) = _camera.ToPage(pt.Position.X, pt.Position.Y);
        if (pt.PointerDeviceType != PointerDeviceType.Pen) return new InkPoint(x, y, InkDefaults.DefaultPressure);
        var props = pt.Properties;
        return new InkPoint(x, y, InkDefaults.NormalizePressure(props.Pressure), InkDefaults.TiltMagnitude(props.XTilt, props.YTilt));
    }

    // ---- The pen's buttons ---------------------------------------------------------------

    /// <summary>The tool a pen or mouse press draws with.</summary>
    private Tool EffectiveTool(PointerPoint pt)
    {
        if (pt.PointerDeviceType == PointerDeviceType.Pen)
        {
            // The eraser end. Windows reports some pens' second button this way too.
            if (_penEraserEnd) return Tool.StrokeEraser;
            if (pt.Properties.IsBarrelButtonPressed)
            {
                // A press that touches the page is a stroke with the button held, not a click.
                _barrel = BarrelButton.Consume(_barrel);
                return InkSettings.HoldTool;
            }
        }
        return _settings.Tool;
    }

    /// <summary>Follows the pen's buttons on every pen event, in contact or hovering.</summary>
    private void NotePen(PointerPoint pt, double now)
    {
        var props = pt.Properties;
        _touchGate.PenSeen(now, inRange: true);
        if (_touches.Count > 0)
        {
            // The pen arrived mid-gesture: whatever the fingers were doing was probably a palm.
            _touches.Clear();
            _gestures?.CompleteGesture();
        }

        _penEraserEnd = props.IsEraser || props.IsInverted;
        bool barrel = props.IsBarrelButtonPressed;
        if (barrel != _barrelDown)
        {
            _barrelDown = barrel;
            BarrelAction action;
            if (barrel)
            {
                (_barrel, action) = BarrelButton.Down(_barrel, now);
                _barrelTimer!.Interval = TimeSpan.FromMilliseconds(BarrelButton.ClickMs);
                _barrelTimer.Start();
            }
            else
            {
                (_barrel, action) = BarrelButton.Up(_barrel, now);
                _barrelTimer!.Stop();
            }
            Apply(action);
        }

        PenInfo = string.Join(" ", new[]
        {
            pt.IsInContact ? "tip" : "hover",
            barrel ? "barrel" : null,
            props.IsEraser ? "eraser" : null,
            props.IsInverted ? "inverted" : null,
        }.Where(s => s is not null))
            + $" Â· pressure {props.Pressure:0.00} Â· tilt {props.XTilt:0}Â°/{props.YTilt:0}Â°";
    }

    private void OnBarrelTick()
    {
        double now = Win32.NowMs();
        (_barrel, var action) = BarrelButton.Tick(_barrel, now, InkSettings.HoldTool, _settings.Tool);
        if (_barrel.Phase == BarrelPhase.Pending)
        {
            // The timer fired a little early: wait out the rest.
            _barrelTimer!.Interval = TimeSpan.FromMilliseconds(Math.Max(1, BarrelButton.ClickMs - (now - _barrel.PressedAt)));
            _barrelTimer.Start();
        }
        Apply(action);
    }

    private void Apply(BarrelAction action)
    {
        switch (action.Kind)
        {
            case BarrelActionKind.Click:
                SetTool(BarrelButton.Toggle(_settings.Tool, InkSettings.ClickToggleA, InkSettings.ClickToggleB));
                break;
            case BarrelActionKind.HoldStart:
            case BarrelActionKind.HoldEnd:
                SetTool(action.Tool);
                break;
        }
    }

    // ---- Touch -----------------------------------------------------------------------------

    private void TouchDown(PointerPoint pt, double now)
    {
        // A finger landing while the pen is near (or a stroke is under way) is a palm.
        if (_activePointer is not null || !_touchGate.AllowsTouch(now)) return;
        _touches.Add(pt.PointerId);
        _gestures?.ProcessDownEvent(pt);
    }

    private void OnManipulationUpdated(GestureRecognizer sender, ManipulationUpdatedEventArgs args)
    {
        lock (_sync)
        {
            var camera = _camera;
            if (args.Delta.Scale != 1) camera = camera.ZoomAt(args.Delta.Scale, args.Position.X, args.Position.Y);
            SetCameraLocked(camera.PanBy(args.Delta.Translation.X, args.Delta.Translation.Y));
        }
        RequestFrame();
    }
}
