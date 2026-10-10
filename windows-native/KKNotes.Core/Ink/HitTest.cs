namespace KKNotes.Core.Ink;

/// <summary>
/// Which strokes the stroke eraser takes (<c>engine/hitTest.ts</c>). The eraser's sweep from one
/// sample to the next is tested as a segment against each of the stroke's segments, so a fast
/// sweep with sparse samples still registers.
/// </summary>
public static class HitTest
{
    /// <summary>
    /// The stroke eraser's hit radius in page units: small on purpose, because it removes whole
    /// strokes and its size is a precision, not a width.
    /// </summary>
    public const double StrokeEraserRadius = 3;

    public static bool StrokeHitBySegment(Stroke stroke, Vec2 a, Vec2 b, double eraserRadius)
    {
        var sweep = new BBox(
            Math.Min(a.X, b.X) - eraserRadius,
            Math.Min(a.Y, b.Y) - eraserRadius,
            Math.Max(a.X, b.X) + eraserRadius,
            Math.Max(a.Y, b.Y) + eraserRadius);
        if (!sweep.Intersects(stroke.BBox)) return false;

        double threshold = eraserRadius + stroke.Style.Size / 2;
        double thresholdSq = threshold * threshold;
        var pts = stroke.Points;
        if (pts.Count == 0) return false;
        if (pts.Count == 1) return PointToSegmentDistanceSq(new Vec2(pts[0].X, pts[0].Y), a, b) <= thresholdSq;
        for (int i = 1; i < pts.Count; i++)
        {
            var p = new Vec2(pts[i - 1].X, pts[i - 1].Y);
            var q = new Vec2(pts[i].X, pts[i].Y);
            if (SegmentToSegmentDistanceSq(a, b, p, q) <= thresholdSq) return true;
        }
        return false;
    }

    public static double PointToSegmentDistanceSq(Vec2 p, Vec2 a, Vec2 b)
    {
        Vec2 ab = b - a;
        double len2 = Vec2.Dpr(ab, ab);
        double t = len2 == 0 ? 0 : Math.Clamp(Vec2.Dpr(p - a, ab) / len2, 0, 1);
        return Vec2.Dist2(p, a + ab * t);
    }

    public static double SegmentToSegmentDistanceSq(Vec2 a, Vec2 b, Vec2 c, Vec2 d)
    {
        if (SegmentsIntersect(a, b, c, d)) return 0;
        return Math.Min(
            Math.Min(PointToSegmentDistanceSq(a, c, d), PointToSegmentDistanceSq(b, c, d)),
            Math.Min(PointToSegmentDistanceSq(c, a, b), PointToSegmentDistanceSq(d, a, b)));
    }

    private static double Cross(Vec2 o, Vec2 a, Vec2 b) => (a.X - o.X) * (b.Y - o.Y) - (a.Y - o.Y) * (b.X - o.X);

    private static bool SegmentsIntersect(Vec2 a, Vec2 b, Vec2 c, Vec2 d)
    {
        double d1 = Cross(c, d, a), d2 = Cross(c, d, b), d3 = Cross(a, b, c), d4 = Cross(a, b, d);
        return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
    }
}
