using System.Globalization;
using System.Text;
using System.Text.Json;
using Jint;
using KKNotes.Core.Ink;

namespace KKNotes.Core.Tests;

/// <summary>
/// The C# port of perfect-freehand against the library itself: the same strokes go through the
/// real JavaScript build (run by Jint) and through <see cref="Freehand"/>, and the outlines must
/// agree point for point. That is what keeps a note looking the same in both apps.
/// </summary>
public class FreehandTests
{
    private static readonly Lazy<Engine> Js = new(() =>
    {
        var engine = new Engine();
        engine.Execute("var exports = {};");
        engine.Execute(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Reference", "perfect-freehand-1.2.3.js")));
        return engine;
    });

    private static string Num(double v) => v.ToString("R", CultureInfo.InvariantCulture);

    private static string JsEasing(string name) => name switch
    {
        "ease-in" => "t => t * t",
        "ease-out" => "t => t * (2 - t)",
        "ease-in-out" => "t => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t)",
        _ => "t => t",
    };

    private static List<Vec2> Reference(IReadOnlyList<InkPoint> points, FreehandOptions o, string easing)
    {
        var sb = new StringBuilder("JSON.stringify(exports.getStroke([");
        foreach (var p in points) sb.Append($"{{x:{Num(p.X)},y:{Num(p.Y)},pressure:{Num(p.Pressure)}}},");
        sb.Append($"],{{size:{Num(o.Size)},thinning:{Num(o.Thinning)},smoothing:{Num(o.Smoothing)},");
        sb.Append($"streamline:{Num(o.Streamline)},simulatePressure:{(o.SimulatePressure ? "true" : "false")},");
        sb.Append($"easing:{JsEasing(easing)},");
        sb.Append($"start:{{cap:{(o.StartCap ? "true" : "false")},taper:{Num(o.StartTaper)}}},");
        sb.Append($"end:{{cap:{(o.EndCap ? "true" : "false")},taper:{Num(o.EndTaper)}}},");
        sb.Append($"last:{(o.Last ? "true" : "false")}}}))");
        string json = Js.Value.Evaluate(sb.ToString()).AsString();
        return JsonSerializer.Deserialize<double[][]>(json)!.Select(a => new Vec2(a[0], a[1])).ToList();
    }

    /// <summary>
    /// The app's outline against the library's. A stroke written zoomed in goes through the
    /// library scaled up by its zoom and comes back scaled down, which is what the current app
    /// would do around the JavaScript original, so the reference does the same.
    /// </summary>
    private static void AssertSameOutline(IReadOnlyList<InkPoint> points, StrokeStyle style, bool complete)
    {
        var samples = Brushes.FreehandSamples(points, style);
        var options = Brushes.FreehandOptionsFor(style, complete, points);
        double k = style.NoiseScale;
        var scaledSamples = samples.Select(p => p with { X = p.X * k, Y = p.Y * k }).ToList();
        var scaledOptions = options with { Size = options.Size * k, StartTaper = options.StartTaper * k, EndTaper = options.EndTaper * k };
        var expected = Reference(scaledSamples, scaledOptions, Brushes.Of(style)?.Easing ?? "linear")
            .Select(v => new Vec2(v.X / k, v.Y / k)).ToList();
        var actual = StrokeOutline.Get(points, style, complete);

        Assert.NotEmpty(expected);
        Assert.Equal(expected.Count, actual.Count);
        for (int i = 0; i < expected.Count; i++)
        {
            Assert.True(
                Math.Abs(expected[i].X - actual[i].X) < 1e-7 && Math.Abs(expected[i].Y - actual[i].Y) < 1e-7,
                $"point {i}: expected {expected[i]}, got {actual[i]}");
        }
    }

    // ---- Strokes to try -------------------------------------------------------------------

    /// <summary>Something like handwriting: loops of varying speed and pressure.</summary>
    private static InkPoint[] Writing(int seed, int count)
    {
        var rng = new Random(seed);
        var pts = new InkPoint[count];
        double x = 100, y = 200;
        for (int i = 0; i < count; i++)
        {
            double t = i * 0.15;
            x += 1.5 + Math.Cos(t * 1.7) * 3 + rng.NextDouble() * 0.4;
            y += Math.Sin(t * 2.3) * 4 + rng.NextDouble() * 0.4;
            double pressure = 0.2 + 0.7 * (0.5 + 0.5 * Math.Sin(t * 0.9));
            double tilt = 0.3 + 0.3 * Math.Sin(t * 0.4);
            pts[i] = new InkPoint(x, y, pressure, tilt);
        }
        return pts;
    }

    /// <summary>A zigzag, which turns back on itself and exercises the sharp-corner caps.</summary>
    private static InkPoint[] Zigzag()
    {
        var pts = new List<InkPoint>();
        for (int i = 0; i < 6; i++)
        {
            double baseX = 50 + i * 30;
            for (int k = 0; k < 8; k++) pts.Add(new InkPoint(baseX + k * 2, 100 + (i % 2 == 0 ? k * 6 : 48 - k * 6), 0.6));
        }
        return pts.ToArray();
    }

    private static InkPoint[] Slow()
    {
        var pts = new InkPoint[60];
        for (int i = 0; i < pts.Length; i++) pts[i] = new InkPoint(10 + i * 0.3, 10 + Math.Sin(i * 0.1) * 0.5, 0.5);
        return pts;
    }

    public static IEnumerable<object[]> Strokes()
    {
        yield return ["writing", Writing(1, 200)];
        yield return ["writing-long", Writing(2, 1200)];
        yield return ["zigzag", Zigzag()];
        yield return ["slow", Slow()];
        yield return ["dot", new[] { new InkPoint(40, 40, 0.7) }];
        yield return ["two", new[] { new InkPoint(40, 40, 0.7), new InkPoint(60, 45, 0.3) }];
        yield return ["three", new[] { new InkPoint(40, 40, 0.7), new InkPoint(42, 41, 0.6), new InkPoint(60, 45, 0.3) }];
        yield return ["repeated", new[] { new InkPoint(5, 5, 0.5), new InkPoint(5, 5, 0.5), new InkPoint(5, 5, 0.5), new InkPoint(9, 7, 0.5) }];
    }

    public static IEnumerable<object[]> Cases()
    {
        var styles = new (string Name, Func<StrokeStyle> Style)[]
        {
            ("ballpoint 1", () => Brushes.PenStyle("ballpoint", "#1f1f24", 1, "pen")),
            ("ballpoint 5", () => Brushes.PenStyle("ballpoint", "#1f1f24", 5, "pen")),
            ("fountain", () => Brushes.PenStyle("fountain", "#1f1f24", 3, "pen")),
            ("fountain mouse", () => Brushes.PenStyle("fountain", "#1f1f24", 3, "mouse")),
            ("pencil", () => Brushes.PenStyle("pencil", "#1f1f24", 4, "pen")),
            ("marker", () => Brushes.PenStyle("marker", "#1f1f24", 4, "pen")),
            ("brush", () => Brushes.PenStyle("brush", "#1f1f24", 4, "pen")),
            ("highlighter", () => Brushes.HighlighterStyle("#facc15", 16)),
            ("ballpoint 1 written at 400 %", () => Brushes.PenStyle("ballpoint", "#1f1f24", 1, "pen") with { WritingZoom = 4 }),
            ("fountain written at 250 %", () => Brushes.PenStyle("fountain", "#1f1f24", 3, "pen") with { WritingZoom = 2.5 }),
        };
        foreach (var stroke in Strokes())
        {
            foreach (var (name, style) in styles)
            {
                foreach (bool complete in new[] { false, true })
                {
                    yield return [$"{stroke[0]} / {name} / {(complete ? "complete" : "live")}", stroke[1], style(), complete];
                }
            }
        }
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void MatchesPerfectFreehand(string name, InkPoint[] points, StrokeStyle style, bool complete)
    {
        _ = name;
        AssertSameOutline(points, style, complete);
    }

    // ---- Writing small at a high zoom ------------------------------------------------------

    /// <summary>
    /// Ten units to the right, then a curl of radius 1 that turns back up and over: the end of a
    /// small letter. Sampled every 0.1 unit, as slow writing at 400 % is.
    /// </summary>
    private static Stroke CurlStroke(double writingZoom)
    {
        var style = Brushes.PenStyle(Brushes.Ballpoint, "#000000", 1, "pen") with { WritingZoom = writingZoom };
        var b = new StrokeBuilder(StrokeTools.Pen, style, "pen", 0);
        for (double x = 0; x < 10; x += 0.1) b.Add(new InkPoint(x, 0, 0.5));
        for (double a = 0; a <= Math.PI * 1.25; a += 0.1 / 1.0) b.Add(new InkPoint(10 + Math.Sin(a), -1 + Math.Cos(a), 0.5));
        return b.Build();
    }

    /// <summary>Nonzero-winding point-in-polygon, as the outline is filled.</summary>
    private static bool Inside(List<Vec2> polygon, double x, double y)
    {
        int winding = 0;
        for (int i = 0; i < polygon.Count; i++)
        {
            var a = polygon[i];
            var b = polygon[(i + 1) % polygon.Count];
            double cross = (b.X - a.X) * (y - a.Y) - (x - a.X) * (b.Y - a.Y);
            if (a.Y <= y && b.Y > y && cross > 0) winding++;
            else if (a.Y > y && b.Y <= y && cross < 0) winding--;
        }
        return winding != 0;
    }

    [Fact]
    public void AtHighZoomTheEndOfAStrokeKeepsItsShape()
    {
        var stroke = CurlStroke(writingZoom: 4);
        var outline = StrokeOutline.Get(stroke.Points, stroke.Style, complete: true);
        // Every sample of the curl is inked.
        var curl = stroke.Points.Where(p => p.X >= 10).ToList();
        Assert.NotEmpty(curl);
        Assert.All(curl, p => Assert.True(Inside(outline, p.X, p.Y), $"({p.X:0.00}, {p.Y:0.00}) is not inked"));
    }

    [Fact]
    public void WithPerfectFreehandsFixedSkipTheCurlIsCutOff()
    {
        // What both apps did: the last 3 page units are skipped whatever the zoom, so the outside of
        // the curl is not inked. This pins the reason for WritingZoom.
        var stroke = CurlStroke(writingZoom: 1);
        var outline = StrokeOutline.Get(stroke.Points, stroke.Style, complete: true);
        Assert.Contains(stroke.Points.Where(p => p.X >= 10), p => !Inside(outline, p.X, p.Y));
    }

    [Fact]
    public void WritingZoomedOutOutlinesAsBefore()
    {
        var points = Writing(5, 150);
        var style = Brushes.PenStyle(Brushes.Ballpoint, "#000000", 2, "pen");
        Assert.Equal(StrokeOutline.Get(points, style, true), StrokeOutline.Get(points, style with { WritingZoom = 0.5 }, true));
    }

    [Fact]
    public void NoPointsGiveNoOutline()
    {
        Assert.Empty(StrokeOutline.Get([], Brushes.PenStyle("ballpoint", "#000000", 2, "pen"), true));
    }

    [Fact]
    public void AnOutlineSurroundsItsLine()
    {
        var points = Writing(3, 100);
        var style = Brushes.PenStyle("ballpoint", "#000000", 4, "pen");
        var outline = StrokeOutline.Get(points, style, true);
        double minX = outline.Min(p => p.X), maxX = outline.Max(p => p.X);
        Assert.True(minX <= points.Min(p => p.X) && maxX >= points.Max(p => p.X));
    }
}
