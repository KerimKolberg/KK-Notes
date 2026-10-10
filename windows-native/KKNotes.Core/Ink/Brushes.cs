namespace KKNotes.Core.Ink;

/// <summary>
/// The pen presets of the current app (<c>src/inking/engine/brushes.ts</c>), with the same
/// numbers. Only the brush id is stored on a stroke; the rest is looked up when it is drawn.
/// The prototype draws ballpoint and fountain faithfully; the pencil's grain and the marker's
/// and brush's bleed are not drawn yet (their outlines are).
/// </summary>
public sealed record BrushDefinition(
    string Id,
    double SizeScale,
    double Opacity,
    string Composite,
    double Thinning,
    double Smoothing,
    double Streamline,
    string Easing,
    bool VelocityWidth,
    double TaperStart,
    double TaperEnd,
    double VelocityTaper,
    double VelocityTaperMax,
    bool FlatCap,
    bool SmoothOutline,
    double TiltResponse);

public static class Brushes
{
    public const string Ballpoint = "ballpoint";
    public const string Fountain = "fountain";

    // Streamline is a running lerp towards each new sample, so the ink ends a little short of
    // the nib; the ballpoint's 0.2 keeps that under 1.5 px at writing speed (see brushes.ts).
    private static readonly Dictionary<string, BrushDefinition> Definitions = new()
    {
        ["ballpoint"] = new("ballpoint", 1, 1, "source-over", 0.08, 0.5, 0.2, "linear", false, 0, 0, 0, 0, false, false, 0),
        ["fountain"] = new("fountain", 1.15, 1, "source-over", 0.78, 0.62, 0.3, "ease-in-out", false, 2, 4, 8, 30, false, true, 0.15),
        ["pencil"] = new("pencil", 1, 0.82, "source-over", 0.5, 0.35, 0.25, "ease-out", false, 0, 0, 0, 0, false, true, 1),
        ["marker"] = new("marker", 2.4, 0.62, "multiply", 0, 0.5, 0.5, "linear", false, 0, 0, 0, 0, true, true, 0),
        ["brush"] = new("brush", 2.1, 0.78, "source-over", 0.95, 0.92, 0.72, "ease-in", true, 8, 26, 10, 36, false, true, 0.25),
    };

    /// <summary>The named brush, falling back to the ballpoint for unknown ids.</summary>
    public static BrushDefinition ById(string? id) =>
        id is not null && Definitions.TryGetValue(id, out var b) ? b : Definitions[Ballpoint];

    /// <summary>The brush a stroke was drawn with; null for strokes from other tools.</summary>
    public static BrushDefinition? Of(StrokeStyle style) => style.Brush is null ? null : ById(style.Brush);

    public static Func<double, double> EasingFor(StrokeStyle style) => Of(style)?.Easing switch
    {
        "ease-in" => static t => t * t,
        "ease-out" => static t => t * (2 - t),
        "ease-in-out" => static t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
        _ => static t => t,
    };

    /// <summary>The thinnest a pen can be, in page units (<c>MIN_STROKE_SIZE</c>): for writing small zoomed in.</summary>
    public const double MinStrokeSize = 0.25;

    /// <summary>Up to this width a pen is fine, and smooths less the finer it is.</summary>
    private const double FineSize = 1.5;

    /// <summary>
    /// The input smoothing for a pen <paramref name="size"/> wide (<c>fineStreamline</c>): smoothing lags each
    /// sample behind the pen, which in letters a few units high rounds off their curves, so a fine pen keeps
    /// more of what the hand did, down to 40 % of the brush's smoothing at the finest width.
    /// </summary>
    public static double FineStreamline(double streamline, double size)
    {
        if (size >= FineSize) return streamline;
        double t = Math.Clamp((size - MinStrokeSize) / (FineSize - MinStrokeSize), 0, 1);
        return streamline * (0.4 + 0.6 * t);
    }

    /// <summary>Style of a new pen stroke (<c>brushStyle</c>).</summary>
    public static StrokeStyle PenStyle(string brushId, string color, double size, string pointerType)
    {
        var brush = ById(brushId);
        double width = Math.Max(MinStrokeSize, size * brush.SizeScale);
        return new StrokeStyle
        {
            Color = color,
            Size = width,
            Opacity = brush.Opacity,
            CompositeOperation = brush.Composite,
            Thinning = brush.Thinning,
            Smoothing = brush.Smoothing,
            Streamline = FineStreamline(brush.Streamline, width),
            // A device without pressure gets life from velocity, except for even-width brushes.
            SimulatePressure = brush.VelocityWidth || (pointerType != "pen" && brush.Thinning > 0.2),
            TaperStart = brush.TaperStart,
            TaperEnd = brush.TaperEnd,
            Brush = brush.Id,
        };
    }

    public const double HighlighterOpacity = 0.35;
    public const double DefaultHighlighterWidth = 16;

    /// <summary>Style of a new highlighter stroke (<c>toolStyles.ts</c>): constant width, multiply.</summary>
    public static StrokeStyle HighlighterStyle(string color, double width) => new()
    {
        Color = color,
        Size = width,
        Opacity = HighlighterOpacity,
        CompositeOperation = "multiply",
        Thinning = 0,
        Smoothing = 0.6,
        Streamline = 0.6,
        SimulatePressure = false,
    };

    /// <summary>Effective pressure of a leaning pencil (<c>pencilPressure</c>).</summary>
    public static double PencilPressure(double pressure, double tilt, double response)
    {
        double p = double.IsFinite(pressure) ? Math.Clamp(pressure, 0, 1) : 0.5;
        double t = Math.Clamp(tilt, 0, 1) * response;
        return Math.Min(1, p * (1 + 0.9 * t));
    }

    /// <summary>Width multiplier of a leaning pencil (<c>pencilWidthScale</c>).</summary>
    public static double PencilWidthScale(double tilt, double response) => 1 + 0.9 * Math.Clamp(tilt, 0, 1) * response;

    /// <summary>Extra bounding-box room a brush needs (<c>brushPadding</c>, without bleed).</summary>
    public static double Padding(StrokeStyle style)
    {
        var brush = Of(style);
        if (brush is null) return 0;
        return brush.TiltResponse > 0 ? style.Size * (PencilWidthScale(1, brush.TiltResponse) - 1) / 2 : 0;
    }

    /// <summary>Speed at one end of a stroke, as distance per sample (<c>endSpeed</c>).</summary>
    public static double EndSpeed(IReadOnlyList<InkPoint> points, bool atStart, int window = 4)
    {
        int n = points.Count;
        if (n < 2) return 0;
        int count = Math.Min(window, n - 1);
        double distance = 0;
        for (int i = 0; i < count; i++)
        {
            var a = atStart ? points[i] : points[n - 1 - i];
            var b = atStart ? points[i + 1] : points[n - 2 - i];
            distance += Math.Sqrt((b.X - a.X) * (b.X - a.X) + (b.Y - a.Y) * (b.Y - a.Y));
        }
        return distance / count;
    }

    /// <summary>Taper at each end: the style's own plus, for a nib, a term for the pen's speed.</summary>
    public static (double Start, double End) Tapers(IReadOnlyList<InkPoint> points, StrokeStyle style)
    {
        var brush = Of(style);
        if (brush is null || brush.VelocityTaper == 0) return (style.TaperStart, style.TaperEnd);
        double Scale(double speed) => Math.Min(brush.VelocityTaperMax, speed * brush.VelocityTaper * 0.1);
        return (style.TaperStart + Scale(EndSpeed(points, true)), style.TaperEnd + Scale(EndSpeed(points, false)));
    }

    /// <summary>perfect-freehand options for a style (<c>toFreehandOptions</c>).</summary>
    public static FreehandOptions FreehandOptionsFor(StrokeStyle style, bool complete, IReadOnlyList<InkPoint> points)
    {
        var brush = Of(style);
        var (taperStart, taperEnd) = Tapers(points, style);
        bool cap = brush is null || !brush.FlatCap;
        return new FreehandOptions
        {
            Size = style.Size,
            Thinning = style.Thinning,
            Smoothing = style.Smoothing,
            Streamline = style.Streamline,
            SimulatePressure = style.SimulatePressure,
            Easing = EasingFor(style),
            StartCap = cap,
            StartTaper = cap ? taperStart : 0,
            EndCap = cap,
            EndTaper = cap ? taperEnd : 0,
            Last = complete,
        };
    }

    /// <summary>
    /// Samples as perfect-freehand gets them: brushes that respond to tilt fold the pen's lean
    /// into the pressure (<c>freehandSamples</c>).
    /// </summary>
    public static IReadOnlyList<InkPoint> FreehandSamples(IReadOnlyList<InkPoint> points, StrokeStyle style)
    {
        var brush = Of(style);
        if (brush is null || brush.TiltResponse == 0) return points;
        bool tilted = false;
        foreach (var p in points)
        {
            if (p.Tilt != 0) { tilted = true; break; }
        }
        if (!tilted) return points;
        var result = new InkPoint[points.Count];
        for (int i = 0; i < result.Length; i++)
        {
            var p = points[i];
            result[i] = p with { Pressure = PencilPressure(p.Pressure, p.Tilt, brush.TiltResponse) };
        }
        return result;
    }

    /// <summary>Whether the outline is drawn with smooth curves (true) or as a hard polygon.</summary>
    public static bool SmoothOutline(StrokeStyle style) => Of(style)?.SmoothOutline ?? true;
}

/// <summary>The outline of a stroke, ready to fill (<c>strokeOutline.ts: getStrokeOutline</c>).</summary>
public static class StrokeOutline
{
    /// <summary>Pens finer than this are outlined scaled up to it (<c>OUTLINE_BASE_SIZE</c>).</summary>
    private const double OutlineBaseSize = 2;

    /// <summary>How much a stroke <paramref name="size"/> wide is scaled up for its width alone (<c>outlineScale</c>).</summary>
    public static double WidthScale(double size) => size > 0 && size < OutlineBaseSize ? OutlineBaseSize / size : 1;

    /// <summary>
    /// How much a stroke is scaled up to be outlined (<c>strokeOutlineScale</c>): for its width or for the zoom
    /// it was written at, whichever asks for more.
    /// </summary>
    public static double Scale(StrokeStyle style) => Math.Max(WidthScale(style.Size), style.NoiseScale);

    /// <summary>
    /// The outline. A stroke written at a zoom above 100 % (<see cref="StrokeStyle.WritingZoom"/>), or with a pen
    /// finer than 2 units, is outlined as if it were that much bigger (<see cref="Scale"/>), then scaled back:
    /// its points, size and tapers are multiplied before perfect-freehand and the outline divided after.
    /// <para>
    /// Everything perfect-freehand measures is relative to the size, except one constant: it skips
    /// the last <see cref="Freehand.EndNoiseThreshold"/> (3) units of every line as noise. That was
    /// tuned for 100 %, where 3 units are 3 pixels; at 400 %, or for a fine pen, they are most of a
    /// small letter, and the skipped end is joined on straight, which twists into a thin neck and a
    /// dot wherever the pen curls as it lifts. Scaling shrinks the skip, and nothing else changes. It
    /// is done here, around the library, exactly as the current app does it around the JavaScript
    /// original (<c>strokeOutline.ts</c>), tapers worked out at the stroke's own size and then scaled.
    /// </para>
    /// </summary>
    public static List<Vec2> Get(IReadOnlyList<InkPoint> points, StrokeStyle style, bool complete)
    {
        if (points.Count == 0) return [];
        var samples = Brushes.FreehandSamples(points, style);
        var options = Brushes.FreehandOptionsFor(style, complete, points);
        double k = Scale(style);
        if (k == 1) return Freehand.GetStroke(samples, options);

        var scaled = new InkPoint[samples.Count];
        for (int i = 0; i < scaled.Length; i++) scaled[i] = samples[i] with { X = samples[i].X * k, Y = samples[i].Y * k };
        var outline = Freehand.GetStroke(scaled, options with
        {
            Size = options.Size * k,
            StartTaper = options.StartTaper * k,
            EndTaper = options.EndTaper * k,
        });
        for (int i = 0; i < outline.Count; i++) outline[i] = new Vec2(outline[i].X / k, outline[i].Y / k);
        return outline;
    }
}
