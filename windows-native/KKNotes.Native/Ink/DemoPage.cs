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
