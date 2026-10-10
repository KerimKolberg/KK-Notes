using KKNotes.Core.Ink;
using KKNotes.Native.Ink;
using Microsoft.UI;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.UI;

namespace KKNotes.Native;

public sealed partial class MainWindow : Window
{
    /// <summary>The current app's swatches (<c>COLOR_PALETTE</c>).</summary>
    private static readonly string[] PenColors = ["#1f1f24", "#2563eb", "#16a34a", "#dc2626", "#8b5a2b", "#7c3aed", "#ea580c", "#ec4899"];
    private static readonly string[] HighlighterColors = ["#facc15", "#4ade80", "#f472b6", "#60a5fa", "#fb923c"];
    /// <summary>Half a unit is for writing small zoomed in, as in the current app.</summary>
    private static readonly double[] PenWidths = [0.5, 1, 2, 3, 5, 8];
    private static readonly double[] HighlighterWidths = [8, 16, 24, 32];

    /// <summary>Prediction choices: -1 is the system's own look-ahead, 0 is off.</summary>
    private static readonly int[] PredictionChoices = [-1, 0, 10, 20, 30];

    private readonly InkSurface _ink;
    private readonly DispatcherQueueTimer _statsTimer;
    private DateTime _statsSince = DateTime.UtcNow;
    private bool _toolbarUpdating;
    private double _labelledPredictionMs;

    public MainWindow(string? snapshotPath = null, string? demo = null)
    {
        InitializeComponent();
        ExtendsContentIntoTitleBar = false;

        IntPtr hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        _ink = new InkSurface(InkPanel, hwnd);
        _ink.ToolChanged += _ => DispatcherQueue.TryEnqueue(RefreshToolbar);
        InkPanel.Loaded += async (_, _) =>
        {
            _ink.Start();
            if (snapshotPath is null) return;
            if (demo == "small")
            {
                _ink.AddStrokes(DemoPage.SmallWriting());
                _ink.SetView(DemoPage.SmallWritingViewZoom, 0, 0);
            }
            else
            {
                _ink.AddStrokes(DemoPage.Strokes());
            }
            bool saved = await _ink.SaveSnapshotAsync(snapshotPath);
            Log.Write(saved ? "Snapshot done, closing" : "Snapshot failed, closing");
            Close();
        };

        if (AppWindow.Presenter is OverlappedPresenter overlapped) overlapped.Maximize();

        PresentBox.SelectedIndex = 0;
        RefreshPredictionChoices();
        RefreshToolbar();

        _statsTimer = DispatcherQueue.CreateTimer();
        _statsTimer.Interval = TimeSpan.FromMilliseconds(500);
        _statsTimer.Tick += (_, _) => UpdateStats();
        _statsTimer.Start();

        Closed += (_, _) =>
        {
            _statsTimer.Stop();
            _ink.Dispose();
        };
    }

    // ---- Toolbar -----------------------------------------------------------------------------

    private void OnToolClick(object sender, RoutedEventArgs e)
    {
        string tag = (string)((FrameworkElement)sender).Tag;
        _ink.UpdateSettings(s => tag switch
        {
            "ballpoint" => s with { Tool = Tool.Pen, Brush = Brushes.Ballpoint },
            "fountain" => s with { Tool = Tool.Pen, Brush = Brushes.Fountain },
            "highlighter" => s with { Tool = Tool.Highlighter },
            _ => s with { Tool = Tool.StrokeEraser },
        });
        RefreshToolbar();
    }

    private void RefreshToolbar()
    {
        var s = _ink.Settings;
        BallpointButton.IsChecked = s.Tool == Tool.Pen && s.Brush == Brushes.Ballpoint;
        FountainButton.IsChecked = s.Tool == Tool.Pen && s.Brush == Brushes.Fountain;
        HighlighterButton.IsChecked = s.Tool == Tool.Highlighter;
        EraserButton.IsChecked = s.Tool == Tool.StrokeEraser;

        Swatches.Children.Clear();
        Widths.Children.Clear();
        if (s.Tool == Tool.StrokeEraser) return;

        bool highlighter = s.Tool == Tool.Highlighter;
        string selectedColor = highlighter ? s.HighlighterColor : s.PenColor;
        foreach (string color in highlighter ? HighlighterColors : PenColors)
        {
            var button = SwatchButton(new Ellipse { Width = 20, Height = 20, Fill = SolidBrush(color) }, color == selectedColor);
            button.Click += (_, _) =>
            {
                _ink.UpdateSettings(x => highlighter ? x with { HighlighterColor = color } : x with { PenColor = color });
                RefreshToolbar();
            };
            Swatches.Children.Add(button);
        }

        double selectedWidth = highlighter ? s.HighlighterWidth : s.PenWidth;
        foreach (double width in highlighter ? HighlighterWidths : PenWidths)
        {
            double dot = highlighter ? 4 + width / 2 : 3 + width * 1.6;
            var content = new Grid { Width = 24, Height = 24 };
            content.Children.Add(new Ellipse
            {
                Width = dot,
                Height = dot,
                Fill = SolidBrush(selectedColor),
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            });
            var button = SwatchButton(content, width == selectedWidth);
            ToolTipService.SetToolTip(button, $"{width} px");
            button.Click += (_, _) =>
            {
                _ink.UpdateSettings(x => highlighter ? x with { HighlighterWidth = width } : x with { PenWidth = width });
                RefreshToolbar();
            };
            Widths.Children.Add(button);
        }
    }

    private static Button SwatchButton(UIElement content, bool selected) => new()
    {
        Content = content,
        Padding = new Thickness(3),
        MinWidth = 0,
        MinHeight = 0,
        CornerRadius = new CornerRadius(16),
        BorderThickness = new Thickness(2),
        BorderBrush = selected ? SolidBrush("#2563eb") : new SolidColorBrush(Colors.Transparent),
        Background = new SolidColorBrush(Colors.Transparent),
    };

    private static SolidColorBrush SolidBrush(string hex)
    {
        uint rgb = Convert.ToUInt32(hex[1..], 16);
        return new SolidColorBrush(Color.FromArgb(255, (byte)(rgb >> 16), (byte)(rgb >> 8), (byte)rgb));
    }

    private void RefreshPredictionChoices()
    {
        _toolbarUpdating = true;
        int selected = Math.Max(0, Array.IndexOf(PredictionChoices, _ink.PredictionMs));
        PredictionBox.Items.Clear();
        double system = _ink.SystemPredictionMs;
        PredictionBox.Items.Add(system > 0 ? $"Prediction: system ({system:0} ms)" : "Prediction: system");
        PredictionBox.Items.Add("Prediction: off");
        PredictionBox.Items.Add("Prediction: 10 ms");
        PredictionBox.Items.Add("Prediction: 20 ms");
        PredictionBox.Items.Add("Prediction: 30 ms");
        PredictionBox.SelectedIndex = selected;
        _toolbarUpdating = false;
    }

    private void OnPredictionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_toolbarUpdating || PredictionBox.SelectedIndex < 0) return;
        _ink.PredictionMs = PredictionChoices[PredictionBox.SelectedIndex];
    }

    private void OnPresentChanged(object sender, SelectionChangedEventArgs e) => _ink.VSync = PresentBox.SelectedIndex == 1;

    private void OnZoomAwareClick(object sender, RoutedEventArgs e) => _ink.ZoomAwareInk = ZoomAwareButton.IsChecked == true;

    private void OnUndoClick(object sender, RoutedEventArgs e) => _ink.Undo();
    private void OnRedoClick(object sender, RoutedEventArgs e) => _ink.Redo();
    private void OnClearClick(object sender, RoutedEventArgs e) => _ink.Clear();
    private void OnFitClick(object sender, RoutedEventArgs e) => _ink.ResetView();
    private void OnFullScreenClick(object sender, RoutedEventArgs e) => ToggleFullScreen();

    private void OnStatsClick(object sender, RoutedEventArgs e) =>
        StatsText.Visibility = StatsButton.IsChecked == true ? Visibility.Visible : Visibility.Collapsed;

    // ---- Keyboard ----------------------------------------------------------------------------

    private void OnUndoAccelerator(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs e)
    {
        _ink.Undo();
        e.Handled = true;
    }

    private void OnRedoAccelerator(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs e)
    {
        _ink.Redo();
        e.Handled = true;
    }

    private void OnFitAccelerator(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs e)
    {
        _ink.ResetView();
        e.Handled = true;
    }

    private void OnFullScreenAccelerator(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs e)
    {
        ToggleFullScreen();
        e.Handled = true;
    }

    private void OnEscapeAccelerator(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs e)
    {
        if (AppWindow.Presenter.Kind != AppWindowPresenterKind.FullScreen) return;
        ToggleFullScreen();
        e.Handled = true;
    }

    /// <summary>
    /// Windows' own full screen. In the current app it made the mouse pointer lag in the web view
    /// (HANDOFF.md); a native window should not have that problem, which is one of the things to try.
    /// </summary>
    private void ToggleFullScreen()
    {
        bool full = AppWindow.Presenter.Kind == AppWindowPresenterKind.FullScreen;
        AppWindow.SetPresenter(full ? AppWindowPresenterKind.Overlapped : AppWindowPresenterKind.FullScreen);
        if (full && AppWindow.Presenter is OverlappedPresenter overlapped) overlapped.Maximize();
        FullScreenIcon.Glyph = full ? "î€" : "îœ¿";
    }

    // ---- Measurements --------------------------------------------------------------------------

    private void UpdateStats()
    {
        var now = DateTime.UtcNow;
        double seconds = Math.Max(0.001, (now - _statsSince).TotalSeconds);
        _statsSince = now;
        var s = _ink.Stats.Take(seconds);
        // The system's prediction time is known once the input thread has made its predictor.
        if (_ink.SystemPredictionMs != _labelledPredictionMs)
        {
            _labelledPredictionMs = _ink.SystemPredictionMs;
            RefreshPredictionChoices();
        }
        if (StatsText.Visibility != Visibility.Visible) return;

        int hz = _ink.RefreshRate;
        string age = s.AgeMsAvg is double avg ? $"{avg:0.0} ms (max {s.AgeMsMax:0.0})" : "–";
        int errors = _ink.InputErrors;
        StatsText.Text = (errors > 0 ? $"⚠ {errors} input errors (see %TEMP%\\KKNotes.Native.log) · " : "") +
            $"{(hz > 0 ? $"{hz} Hz" : "? Hz")} · {s.FramesPerSecond:0} frames/s · pen {s.SamplesPerSecond:0} samples/s · " +
            $"input age at present {age} · draw {s.DrawMsAvg:0.00} ms (max {s.DrawMsMax:0.00}) · zoom {_ink.Zoom:P0} · " +
            $"frame latency {(_ink.FrameLatencySet ? "1" : "default")} · input on {_ink.InputThreadInfo} · pen: {_ink.PenInfo}";
    }
}
