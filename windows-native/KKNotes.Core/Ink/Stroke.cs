namespace KKNotes.Core.Ink;

/// <summary>
/// One input sample in page units (a page is 794 × 1123 for A4, y down), as the
/// <c>.notex</c> file stores it (<c>src/inking/types.ts: InkPoint</c>).
/// </summary>
/// <param name="Pressure">In (0, 1]. A device that reports 0 gets <see cref="InkDefaults.DefaultPressure"/>.</param>
/// <param name="Tilt">Lean of the pen in 0..1 (0 upright, 1 flat at 70° or more); 0 when not reported.</param>
public readonly record struct InkPoint(double X, double Y, double Pressure, double Tilt = 0);

/// <summary>Axis-aligned bounds in page units.</summary>
public readonly record struct BBox(double MinX, double MinY, double MaxX, double MaxY)
{
    public bool Intersects(BBox o) => MinX <= o.MaxX && MaxX >= o.MinX && MinY <= o.MaxY && MaxY >= o.MinY;
}

/// <summary>
/// How a stroke is drawn, frozen when it starts. Field for field the <c>style</c> object of a
/// <c>.notex</c> stroke; only what the prototype draws is modelled so far.
/// </summary>
public sealed record StrokeStyle
{
    public required string Color { get; init; }
    public required double Size { get; init; }
    public double Opacity { get; init; } = 1;
    public string CompositeOperation { get; init; } = "source-over";
    public double Thinning { get; init; }
    public double Smoothing { get; init; } = 0.5;
    public double Streamline { get; init; } = 0.5;
    public bool SimulatePressure { get; init; }
    public double TaperStart { get; init; }
    public double TaperEnd { get; init; }
    public string Pattern { get; init; } = "solid";
    public string Arrowheads { get; init; } = "none";
    /// <summary>Pen preset (<c>ballpoint</c>, <c>fountain</c>, …); null for highlighter strokes.</summary>
    public string? Brush { get; init; }
}

/// <summary>The tools a freehand stroke can come from, as the file names them.</summary>
public static class StrokeTools
{
    public const string Pen = "pen";
    public const string Highlighter = "highlighter";
}

/// <summary>A committed freehand stroke. Immutable, so it can be shared between threads.</summary>
public sealed class Stroke
{
    public Stroke(string id, string tool, InkPoint[] points, StrokeStyle style, BBox bbox, string pointerType, double createdAt)
    {
        Id = id;
        Tool = tool;
        Points = points;
        Style = style;
        BBox = bbox;
        PointerType = pointerType;
        CreatedAt = createdAt;
    }

    public string Id { get; }
    public string Tool { get; }
    public IReadOnlyList<InkPoint> Points { get; }
    public StrokeStyle Style { get; }
    public BBox BBox { get; }
    /// <summary><c>pen</c>, <c>touch</c> or <c>mouse</c>.</summary>
    public string PointerType { get; }
    public double CreatedAt { get; }
}

public static class InkDefaults
{
    /// <summary>Pressure substituted when a device reports 0 (mouse, many touch digitisers).</summary>
    public const double DefaultPressure = 0.5;

    /// <summary>Tilt at which the pen counts as fully flat, in degrees from vertical.</summary>
    public const double MaxTiltDegrees = 70;

    /// <summary>
    /// Pressure as the current app stores it: clamped to (0, 1], with 0 (or nonsense) mapped to
    /// <see cref="DefaultPressure"/>.
    /// </summary>
    public static double NormalizePressure(double pressure) =>
        double.IsFinite(pressure) && pressure > 0 ? Math.Min(1, pressure) : DefaultPressure;

    /// <summary>
    /// Lean of the pen in 0..1 from the two tilt axes (degrees from vertical), as
    /// <c>brushes.ts: tiltMagnitude</c> computes it.
    /// </summary>
    public static double TiltMagnitude(double tiltX, double tiltY)
    {
        double x = double.IsFinite(tiltX) ? tiltX : 0;
        double y = double.IsFinite(tiltY) ? tiltY : 0;
        if (x == 0 && y == 0) return 0;
        double degrees = Math.Min(90, Math.Sqrt(x * x + y * y));
        return Math.Min(1, degrees / MaxTiltDegrees);
    }
}
