using KKNotes.Core.Ink;

namespace KKNotes.Native.Ink;

/// <summary>
/// Strokes for the <c>--snapshot</c> check: one of each kind the prototype draws, built through
/// the same <see cref="StrokeBuilder"/> a pen goes through.
/// </summary>
internal static class DemoPage
{
    public static IEnumerable<Stroke> Strokes()
    {
        // Loops like handwriting, in the default 1 px ballpoint.
        yield return Build(Brushes.PenStyle(Brushes.Ballpoint, "#1f1f24", 1, "pen"), StrokeTools.Pen,
            Range(400, t => (60 + t * 640, 100 + Math.Sin(t * 60) * 14 + Math.Cos(t * 23) * 4, 0.5, 0)));

        // A broader blue ballpoint.
        yield return Build(Brushes.PenStyle(Brushes.Ballpoint, "#2563eb", 3, "pen"), StrokeTools.Pen,
            Range(300, t => (60 + t * 640, 180 + Math.Sin(t * 30) * 20, 0.5, 0)));

        // The fountain pen with pressure rising from feather-light to full, and the pen leaning more and more.
        yield return Build(Brushes.PenStyle(Brushes.Fountain, "#1f1f24", 3, "pen"), StrokeTools.Pen,
            Range(400, t => (60 + t * 640, 270 + Math.Sin(t * 18) * 30, 0.05 + 0.95 * t, 0.8 * t)));

        // A zigzag: sharp corners.
        yield return Build(Brushes.PenStyle(Brushes.Ballpoint, "#dc2626", 2, "pen"), StrokeTools.Pen,
            Range(240, t => (60 + t * 640, 360 + Math.Abs((t * 12 % 2) - 1) * 50, 0.5, 0)));

        // A circle in green.
        yield return Build(Brushes.PenStyle(Brushes.Ballpoint, "#16a34a", 2, "pen"), StrokeTools.Pen,
            Range(200, t => (160 + Math.Cos(t * 2 * Math.PI) * 60, 520 + Math.Sin(t * 2 * Math.PI) * 60, 0.5, 0)));

        // A dot.
        yield return Build(Brushes.PenStyle(Brushes.Ballpoint, "#7c3aed", 6, "pen"), StrokeTools.Pen,
            [new InkPoint(320, 520, 0.6)]);

        // The highlighter over the first line and across the blue one: ink must stay dark under it.
        yield return Build(Brushes.HighlighterStyle("#facc15", 16), StrokeTools.Highlighter,
            Range(100, t => (50 + t * 400, 100 + t * 80, 0.5, 0)));
    }

    // ---- Small handwriting (`--demo small`) ------------------------------------------------

    /// <summary>The zoom the small-writing snapshot is looked at, so its letters are big enough to see.</summary>
    public const double SmallWritingViewZoom = 10;

    /// <summary>
    /// The same small handwriting twice, as written at 400 % (letters about 4 page units tall,
    /// sampled every 0.1 unit as a pen at 267 Hz does when writing slowly at that zoom). Above, as
    /// both apps outlined it before (thresholds in page units); below, with
    /// <see cref="StrokeStyle.WritingZoom"/>.
    /// </summary>
    public static IEnumerable<Stroke> SmallWriting()
    {
        foreach (var (zoom, b) in new[] { (1.0, 16.0), (4.0, 34.0) })
        {
            var style = Brushes.PenStyle(Brushes.Ballpoint, "#1f1f24", 1, "pen") with { WritingZoom = zoom };
            var rng = new Random(7);
            Stroke Write(params List<(double X, double Y)>[] parts) => Build(style, StrokeTools.Pen, Hand(parts.SelectMany(p => p).ToList(), rng));

            // A cursive run of loops that ends curling up.
            yield return Write(Curve(t => (6 + 0.9 * t - 1.4 * Math.Sin(t), b - 1.6 * (1 - Math.Cos(t))), 0, 8 * Math.PI + 1.4));
            // A "t": stem with a hook at its foot, then a crossbar that flicks down as the pen lifts.
            yield return Write(Line(34, b - 4, 34, b - 0.6), Arc(34.6, b - 0.6, 0.6, Math.PI, 0.2));
            yield return Write(Line(32.8, b - 3, 35.8, b - 3), Arc(35.8, b - 2.6, 0.4, -Math.PI / 2, 0.6));
            // An "i" and its dot.
            yield return Write(Line(39, b - 2.6, 39, b - 0.6), Arc(39.6, b - 0.6, 0.6, Math.PI, 0.2));
            yield return Write(Line(39, b - 4.2, 39.12, b - 4.1));
            // An "o", closed with a little overlap.
            yield return Write(Arc(44, b - 1.2, 1.2, -Math.PI / 2, -Math.PI / 2 - 2 * Math.PI - 0.5));
            // An "e": the bar, then round over the top and back under.
            yield return Write(Line(48, b - 1.2, 50, b - 1.2), Arc(49, b - 1.2, 1, 0, -2 * Math.PI + 0.7));
            // A "g"-like descender with a closing hook.
            yield return Write(Arc(54, b - 1.2, 1.1, 0, -2 * Math.PI), Line(55.1, b - 1.2, 55.1, b + 2), Arc(54.1, b + 2, 1, 0, Math.PI * 0.9));
        }
    }

    private static List<(double X, double Y)> Curve(Func<double, (double X, double Y)> f, double t0, double t1, int n = 2000)
    {
        var points = new List<(double, double)>(n + 1);
        for (int i = 0; i <= n; i++) points.Add(f(t0 + (t1 - t0) * i / n));
        return points;
    }

    private static List<(double X, double Y)> Line(double x0, double y0, double x1, double y1) =>
        Curve(t => (x0 + (x1 - x0) * t, y0 + (y1 - y0) * t), 0, 1, 200);

    /// <summary>An arc around (cx, cy) from angle a0 to a1 (y points down, so a growing angle turns clockwise).</summary>
    private static List<(double X, double Y)> Arc(double cx, double cy, double r, double a0, double a1) =>
        Curve(t => (cx + r * Math.Cos(t), cy + r * Math.Sin(t)), a0, a1, 600);

    /// <summary>A path as a pen reports it: a sample every ~0.1 unit along it, each a little off.</summary>
    private static IEnumerable<InkPoint> Hand(List<(double X, double Y)> path, Random rng)
    {
        const double step = 0.104;
        double carried = 0;
        yield return new InkPoint(path[0].X, path[0].Y, 0.5);
        for (int i = 1; i < path.Count; i++)
        {
            double dx = path[i].X - path[i - 1].X, dy = path[i].Y - path[i - 1].Y;
            carried += Math.Sqrt(dx * dx + dy * dy);
            if (carried < step) continue;
            carried = 0;
            double jx = (rng.NextDouble() - 0.5) * 0.06, jy = (rng.NextDouble() - 0.5) * 0.06;
            yield return new InkPoint(path[i].X + jx, path[i].Y + jy, 0.45 + rng.NextDouble() * 0.1);
        }
        yield return new InkPoint(path[^1].X, path[^1].Y, 0.5);
    }

    private static IEnumerable<InkPoint> Range(int count, Func<double, (double X, double Y, double P, double Tilt)> at)
    {
        for (int i = 0; i < count; i++)
        {
            var (x, y, p, tilt) = at(i / (double)(count - 1));
            yield return new InkPoint(x, y, p, tilt);
        }
    }

    private static Stroke Build(StrokeStyle style, string tool, IEnumerable<InkPoint> points)
    {
        var builder = new StrokeBuilder(tool, style, "pen", 0);
        foreach (var p in points) builder.Add(p);
        return builder.Build();
    }
}
