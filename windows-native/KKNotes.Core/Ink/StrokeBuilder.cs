namespace KKNotes.Core.Ink;

/// <summary>
/// Collects the samples of the stroke being drawn (<c>engine/strokeBuilder.ts</c>).
/// Samples closer than <see cref="MinSampleSpacing"/> to the last one kept are held back: they
/// add nothing a screen can show, and each is a vertex outlined again on every frame. The newest
/// held one is put on the end when the stroke is built, so it ends exactly where the pen did.
/// The spacing is on screen: divided by the zoom the stroke is written at
/// (<see cref="StrokeStyle.WritingZoom"/>), or small writing at a high zoom loses most of its samples.
/// </summary>
public sealed class StrokeBuilder
{
    public const double MinSampleSpacing = 0.4;

    private readonly List<InkPoint> _samples = new(512);
    /// <summary>The spacing for this stroke: <see cref="MinSampleSpacing"/> on screen, whatever the zoom.</summary>
    private readonly double _spacing;
    private InkPoint? _held;
    private double _minX = double.PositiveInfinity, _minY = double.PositiveInfinity;
    private double _maxX = double.NegativeInfinity, _maxY = double.NegativeInfinity;

    public StrokeBuilder(string tool, StrokeStyle style, string pointerType, double createdAt)
    {
        Tool = tool;
        Style = style;
        PointerType = pointerType;
        CreatedAt = createdAt;
        _spacing = MinSampleSpacing / style.NoiseScale;
    }

    public string Id { get; } = StrokeIds.Create();
    public string Tool { get; }
    public StrokeStyle Style { get; }
    public string PointerType { get; }
    public double CreatedAt { get; }

    public IReadOnlyList<InkPoint> Points => _samples;

    public int Count => _samples.Count;

    public void Add(InkPoint point)
    {
        if (_samples.Count > 0)
        {
            var prev = _samples[^1];
            double dx = point.X - prev.X, dy = point.Y - prev.Y;
            if (dx * dx + dy * dy < _spacing * _spacing)
            {
                if (dx != 0 || dy != 0) _held = point;
                return;
            }
        }
        _held = null;
        Keep(point);
    }

    private void Keep(InkPoint point)
    {
        _samples.Add(point);
        _minX = Math.Min(_minX, point.X);
        _minY = Math.Min(_minY, point.Y);
        _maxX = Math.Max(_maxX, point.X);
        _maxY = Math.Max(_maxY, point.Y);
    }

    /// <summary>The samples as the stroke would be built now, including a held last one.</summary>
    public void CopyTo(List<InkPoint> into)
    {
        into.Clear();
        into.AddRange(_samples);
        if (_held is InkPoint h) into.Add(h);
    }

    public Stroke Build()
    {
        if (_held is InkPoint h)
        {
            _held = null;
            Keep(h);
        }
        double pad = Padding(Style);
        var bbox = new BBox(_minX - pad, _minY - pad, _maxX + pad, _maxY + pad);
        return new Stroke(Id, Tool, _samples.ToArray(), Style, bbox, PointerType, CreatedAt);
    }

    /// <summary>Room around a freehand path: widest half-width plus antialiasing slop.</summary>
    public static double Padding(StrokeStyle style) =>
        style.Size * 0.5 * (1 + Math.Max(0, style.Thinning)) + Brushes.Padding(style) + 2;
}

public static class StrokeIds
{
    /// <summary>A new stroke id: random and URL-safe, like the current app's.</summary>
    public static string Create() => Guid.NewGuid().ToString("N")[..21];
}
