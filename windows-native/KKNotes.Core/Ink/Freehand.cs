// A C# port of perfect-freehand 1.2.3 (getStroke, getStrokePoints, getStrokeOutlinePoints),
// the library the current app draws every freehand stroke with. Ported line for line, quirks
// included, so a stroke has the same outline in both apps.
//
// perfect-freehand: MIT License, Copyright (c) 2021 Stephen Ruiz Ltd.
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software
// and associated documentation files (the "Software"), to deal in the Software without
// restriction, including without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
// Software is furnished to do so, subject to the following conditions: The above copyright
// notice and this permission notice shall be included in all copies or substantial portions of
// the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
// PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
// LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.

namespace KKNotes.Core.Ink;

/// <summary>Options for <see cref="Freehand.GetStroke"/>; the defaults are perfect-freehand's.</summary>
public sealed record FreehandOptions
{
    public double Size { get; init; } = 16;
    public double Thinning { get; init; } = 0.5;
    public double Smoothing { get; init; } = 0.5;
    public double Streamline { get; init; } = 0.5;
    public bool SimulatePressure { get; init; } = true;
    public Func<double, double> Easing { get; init; } = static t => t;
    public bool StartCap { get; init; } = true;
    /// <summary>Taper length at the start, in page units (0 = none).</summary>
    public double StartTaper { get; init; }
    public bool EndCap { get; init; } = true;
    public double EndTaper { get; init; }
    /// <summary>Whether the stroke is complete (the pen has lifted).</summary>
    public bool Last { get; init; }
}

/// <summary>A point after streamlining, with what the outline needs to know about it.</summary>
public struct StrokePoint
{
    public Vec2 Point;
    public double Pressure;
    /// <summary>Unit vector from this point back to the previous one.</summary>
    public Vec2 Vector;
    public double Distance;
    public double RunningLength;
}

public static class Freehand
{
    private const double RateOfPressureChange = 0.275;
    private const double FixedPi = Math.PI + 0.0001;
    private const int StartCapSegments = 13;
    private const int EndCapSegments = 29;
    private const int CornerCapSegments = 13;
    /// <summary>
    /// The length at the end of a line skipped as noise, in the units of the points. A constant
    /// in perfect-freehand, and a lot of a letter written small at a high zoom: see
    /// <see cref="StrokeOutline.Get"/> for how the app deals with that without changing the library.
    /// </summary>
    public const double EndNoiseThreshold = 3;
    private const double MinStreamlineT = 0.15;
    private const double StreamlineTRange = 0.85;
    private const double MinRadius = 0.01;
    private const double DefaultFirstPressure = 0.25;
    private const double DefaultPressure = 0.5;

    /// <summary>The polygon that surrounds the line through <paramref name="points"/>.</summary>
    public static List<Vec2> GetStroke(IReadOnlyList<InkPoint> points, FreehandOptions options) =>
        GetStrokeOutlinePoints(GetStrokePoints(points, options), options);

    private static bool IsValidPressure(double p) => p >= 0; // false for NaN, which stands for "none"

    public static List<StrokePoint> GetStrokePoints(IReadOnlyList<InkPoint> points, FreehandOptions options)
    {
        if (points.Count == 0) return [];

        double t = MinStreamlineT + (1 - options.Streamline) * StreamlineTRange;

        var pts = new List<(double X, double Y, double P)>(points.Count + 4);
        foreach (var p in points) pts.Add((p.X, p.Y, p.Pressure));

        // Two points get three more between them, to avoid "dash" lines on tapered strokes.
        // As in the original, the added points carry no pressure.
        if (pts.Count == 2)
        {
            var last = pts[1];
            pts.RemoveAt(1);
            var first = pts[0];
            for (int i = 1; i < 5; i++)
            {
                double k = i / 4.0;
                pts.Add((first.X + (last.X - first.X) * k, first.Y + (last.Y - first.Y) * k, double.NaN));
            }
        }

        // One point gets a second one 1 unit away.
        if (pts.Count == 1)
        {
            var only = pts[0];
            pts.Add((only.X + 1, only.Y + 1, only.P));
        }

        var strokePoints = new List<StrokePoint>(pts.Count)
        {
            new()
            {
                Point = new Vec2(pts[0].X, pts[0].Y),
                Pressure = IsValidPressure(pts[0].P) ? pts[0].P : DefaultFirstPressure,
                Vector = new Vec2(1, 1),
                Distance = 0,
                RunningLength = 0,
            },
        };

        bool hasReachedMinimumLength = false;
        double runningLength = 0;
        var prev = strokePoints[0];
        int max = pts.Count - 1;

        for (int i = 1; i < pts.Count; i++)
        {
            var input = new Vec2(pts[i].X, pts[i].Y);
            Vec2 point = options.Last && i == max ? input : Vec2.Lrp(prev.Point, input, t);

            if (prev.Point == point) continue;

            double distance = Vec2.Dist(point, prev.Point);
            runningLength += distance;

            // At the start, wait until the line is `size` long, to avoid noise. (The distance
            // still counts towards the running length, as in the original.)
            if (i < max && !hasReachedMinimumLength)
            {
                if (runningLength < options.Size) continue;
                hasReachedMinimumLength = true;
            }

            prev = new StrokePoint
            {
                Point = point,
                Pressure = IsValidPressure(pts[i].P) ? pts[i].P : DefaultPressure,
                Vector = Vec2.Uni(prev.Point - point),
                Distance = distance,
                RunningLength = runningLength,
            };
            strokePoints.Add(prev);
        }

        var head = strokePoints[0];
        head.Vector = strokePoints.Count > 1 ? strokePoints[1].Vector : new Vec2(0, 0);
        strokePoints[0] = head;
        return strokePoints;
    }

    private static double StrokeRadius(double size, double thinning, double pressure, Func<double, double> easing) =>
        size * easing(0.5 - thinning * (0.5 - pressure));

    private static double SimulatePressure(double prevPressure, double distance, double size)
    {
        double sp = Math.Min(1, distance / size);
        double rp = Math.Min(1, 1 - sp);
        return Math.Min(1, prevPressure + (rp - prevPressure) * (sp * RateOfPressureChange));
    }

    /// <summary>Average of the first few pressures, so a stroke does not start fat.</summary>
    private static double InitialPressure(List<StrokePoint> points, bool simulate, double size)
    {
        double acc = points[0].Pressure;
        int n = Math.Min(10, points.Count);
        for (int i = 0; i < n; i++)
        {
            double pressure = points[i].Pressure;
            if (simulate) pressure = SimulatePressure(acc, points[i].Distance, size);
            acc = (acc + pressure) / 2;
        }
        return acc;
    }

    public static List<Vec2> GetStrokeOutlinePoints(List<StrokePoint> points, FreehandOptions options)
    {
        double size = options.Size;
        double smoothing = options.Smoothing;
        double thinning = options.Thinning;
        bool simulate = options.SimulatePressure;
        var easing = options.Easing;
        bool capStart = options.StartCap;
        bool capEnd = options.EndCap;
        bool isComplete = options.Last;

        if (points.Count == 0 || size <= 0) return [];

        double totalLength = points[^1].RunningLength;
        double taperStart = options.StartTaper;
        double taperEnd = options.EndTaper;
        double minDistance = Math.Pow(size * smoothing, 2);

        var leftPts = new List<Vec2>(points.Count + 32);
        var rightPts = new List<Vec2>(points.Count + 32);

        double prevPressure = InitialPressure(points, simulate, size);
        double radius = StrokeRadius(size, thinning, points[^1].Pressure, easing);
        double? firstRadius = null;
        Vec2 prevVector = points[0].Vector;
        Vec2 prevLeftPoint = points[0].Point;
        Vec2 prevRightPoint = prevLeftPoint;
        Vec2 tempLeftPoint = prevLeftPoint;
        Vec2 tempRightPoint = prevRightPoint;
        bool isPrevPointSharpCorner = false;

        for (int i = 0; i < points.Count; i++)
        {
            var sp = points[i];
            double pressure = sp.Pressure;
            bool isLastPoint = i == points.Count - 1;

            // Skip noise at the end of the line.
            if (!isLastPoint && totalLength - sp.RunningLength < EndNoiseThreshold) continue;

            if (thinning != 0)
            {
                if (simulate) pressure = SimulatePressure(prevPressure, sp.Distance, size);
                radius = StrokeRadius(size, thinning, pressure, easing);
            }
            else
            {
                radius = size / 2;
            }

            firstRadius ??= radius;

            double taperStartStrength = sp.RunningLength < taperStart
                ? TaperStartEase(sp.RunningLength / taperStart)
                : 1;
            double taperEndStrength = totalLength - sp.RunningLength < taperEnd
                ? TaperEndEase((totalLength - sp.RunningLength) / taperEnd)
                : 1;
            radius = Math.Max(MinRadius, radius * Math.Min(taperStartStrength, taperEndStrength));

            Vec2 nextVector = (!isLastPoint ? points[i + 1] : points[i]).Vector;
            double nextDpr = !isLastPoint ? Vec2.Dpr(sp.Vector, nextVector) : 1.0;
            double prevDpr = Vec2.Dpr(sp.Vector, prevVector);

            bool isPointSharpCorner = prevDpr < 0 && !isPrevPointSharpCorner;
            bool isNextPointSharpCorner = nextDpr < 0;

            if (isPointSharpCorner || isNextPointSharpCorner)
            {
                // A sharp corner: draw a rounded cap around it and move on.
                Vec2 offset = Vec2.Per(prevVector) * radius;
                double step = 1.0 / CornerCapSegments;
                for (double t = 0; t <= 1; t += step)
                {
                    tempLeftPoint = Vec2.RotAround(sp.Point - offset, sp.Point, FixedPi * t);
                    leftPts.Add(tempLeftPoint);
                    tempRightPoint = Vec2.RotAround(sp.Point + offset, sp.Point, FixedPi * -t);
                    rightPts.Add(tempRightPoint);
                }
                prevLeftPoint = tempLeftPoint;
                prevRightPoint = tempRightPoint;
                if (isNextPointSharpCorner) isPrevPointSharpCorner = true;
                continue;
            }

            isPrevPointSharpCorner = false;

            if (isLastPoint)
            {
                Vec2 offset = Vec2.Per(sp.Vector) * radius;
                leftPts.Add(sp.Point - offset);
                rightPts.Add(sp.Point + offset);
                continue;
            }

            // A regular point: project it to either side, keeping a side's point only when it is
            // far enough from the last one kept there.
            Vec2 off = Vec2.Per(Vec2.Lrp(nextVector, sp.Vector, nextDpr)) * radius;

            tempLeftPoint = sp.Point - off;
            if (i <= 1 || Vec2.Dist2(prevLeftPoint, tempLeftPoint) > minDistance)
            {
                leftPts.Add(tempLeftPoint);
                prevLeftPoint = tempLeftPoint;
            }

            tempRightPoint = sp.Point + off;
            if (i <= 1 || Vec2.Dist2(prevRightPoint, tempRightPoint) > minDistance)
            {
                rightPts.Add(tempRightPoint);
                prevRightPoint = tempRightPoint;
            }

            prevPressure = pressure;
            prevVector = sp.Vector;
        }

        // Caps. Tapered ends have none; a single point becomes a dot.
        Vec2 firstPoint = points[0].Point;
        Vec2 lastPoint = points.Count > 1 ? points[^1].Point : points[0].Point + new Vec2(1, 1);
        var startCap = new List<Vec2>();
        var endCap = new List<Vec2>();

        if (points.Count == 1)
        {
            if (!(taperStart != 0 || taperEnd != 0) || isComplete)
            {
                double r = firstRadius is double fr && fr != 0 ? fr : radius;
                return DrawDot(firstPoint, r);
            }
        }
        else
        {
            if (taperStart != 0 || (taperEnd != 0 && points.Count == 1))
            {
                // Tapered start: nothing to add.
            }
            else if (capStart)
            {
                DrawRoundStartCap(startCap, firstPoint, rightPts[0], StartCapSegments);
            }
            else
            {
                DrawFlatStartCap(startCap, firstPoint, leftPts[0], rightPts[0]);
            }

            Vec2 direction = Vec2.Per(-points[^1].Vector);

            if (taperEnd != 0 || (taperStart != 0 && points.Count == 1))
            {
                endCap.Add(lastPoint);
            }
            else if (capEnd)
            {
                DrawRoundEndCap(endCap, lastPoint, direction, radius, EndCapSegments);
            }
            else
            {
                DrawFlatEndCap(endCap, lastPoint, direction, radius);
            }
        }

        // Left side, around the end, back along the right side, around the start.
        rightPts.Reverse();
        var outline = new List<Vec2>(leftPts.Count + endCap.Count + rightPts.Count + startCap.Count);
        outline.AddRange(leftPts);
        outline.AddRange(endCap);
        outline.AddRange(rightPts);
        outline.AddRange(startCap);
        return outline;
    }

    private static double TaperStartEase(double t) => t * (2 - t);

    private static double TaperEndEase(double t)
    {
        t -= 1;
        return t * t * t + 1;
    }

    private static List<Vec2> DrawDot(Vec2 center, double radius)
    {
        Vec2 offsetPoint = center + new Vec2(1, 1);
        Vec2 start = Vec2.Prj(center, Vec2.Uni(Vec2.Per(center - offsetPoint)), -radius);
        var dot = new List<Vec2>(StartCapSegments);
        double step = 1.0 / StartCapSegments;
        for (double t = step; t <= 1; t += step) dot.Add(Vec2.RotAround(start, center, FixedPi * 2 * t));
        return dot;
    }

    private static void DrawRoundStartCap(List<Vec2> cap, Vec2 center, Vec2 rightPoint, int segments)
    {
        double step = 1.0 / segments;
        for (double t = step; t <= 1; t += step) cap.Add(Vec2.RotAround(rightPoint, center, FixedPi * t));
    }

    private static void DrawFlatStartCap(List<Vec2> cap, Vec2 center, Vec2 leftPoint, Vec2 rightPoint)
    {
        Vec2 corners = leftPoint - rightPoint;
        Vec2 a = corners * 0.5;
        Vec2 b = corners * 0.51;
        cap.Add(center - a);
        cap.Add(center - b);
        cap.Add(center + b);
        cap.Add(center + a);
    }

    private static void DrawRoundEndCap(List<Vec2> cap, Vec2 center, Vec2 direction, double radius, int segments)
    {
        Vec2 start = Vec2.Prj(center, direction, radius);
        double step = 1.0 / segments;
        for (double t = step; t < 1; t += step) cap.Add(Vec2.RotAround(start, center, FixedPi * 3 * t));
    }

    private static void DrawFlatEndCap(List<Vec2> cap, Vec2 center, Vec2 direction, double radius)
    {
        cap.Add(center + direction * radius);
        cap.Add(center + direction * (radius * 0.99));
        cap.Add(center - direction * (radius * 0.99));
        cap.Add(center - direction * radius);
    }
}
