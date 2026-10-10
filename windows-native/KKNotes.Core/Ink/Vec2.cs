namespace KKNotes.Core.Ink;

/// <summary>A 2-D vector in page units. The operations mirror perfect-freehand's <c>vec.ts</c>.</summary>
public readonly record struct Vec2(double X, double Y)
{
    public static Vec2 operator +(Vec2 a, Vec2 b) => new(a.X + b.X, a.Y + b.Y);
    public static Vec2 operator -(Vec2 a, Vec2 b) => new(a.X - b.X, a.Y - b.Y);
    public static Vec2 operator -(Vec2 a) => new(-a.X, -a.Y);
    public static Vec2 operator *(Vec2 a, double n) => new(a.X * n, a.Y * n);

    /// <summary>Perpendicular rotation: <c>[y, -x]</c>.</summary>
    public static Vec2 Per(Vec2 a) => new(a.Y, -a.X);

    public static double Dpr(Vec2 a, Vec2 b) => a.X * b.X + a.Y * b.Y;

    public static double Len(Vec2 a) => Math.Sqrt(a.X * a.X + a.Y * a.Y);

    public static double Dist(Vec2 a, Vec2 b) => Len(a - b);

    public static double Dist2(Vec2 a, Vec2 b)
    {
        double dx = a.X - b.X, dy = a.Y - b.Y;
        return dx * dx + dy * dy;
    }

    public static Vec2 Uni(Vec2 a)
    {
        double l = Len(a);
        return new(a.X / l, a.Y / l);
    }

    /// <summary>Interpolate from <paramref name="a"/> to <paramref name="b"/> by <paramref name="t"/>.</summary>
    public static Vec2 Lrp(Vec2 a, Vec2 b, double t) => a + (b - a) * t;

    /// <summary>Project <paramref name="a"/> in direction <paramref name="b"/> by <paramref name="c"/>.</summary>
    public static Vec2 Prj(Vec2 a, Vec2 b, double c) => a + b * c;

    /// <summary>Rotate <paramref name="a"/> around <paramref name="c"/> by <paramref name="r"/> radians.</summary>
    public static Vec2 RotAround(Vec2 a, Vec2 c, double r)
    {
        double s = Math.Sin(r), co = Math.Cos(r);
        double px = a.X - c.X, py = a.Y - c.Y;
        return new(px * co - py * s + c.X, px * s + py * co + c.Y);
    }
}
