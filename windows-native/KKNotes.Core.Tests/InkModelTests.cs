using KKNotes.Core.Ink;

namespace KKNotes.Core.Tests;

public class StrokeBuilderTests
{
    private static StrokeBuilder Builder() =>
        new(StrokeTools.Pen, Brushes.PenStyle("ballpoint", "#000000", 2, "pen"), "pen", 0);

    [Fact]
    public void SamplesTooCloseTogetherAreHeldBack()
    {
        var b = Builder();
        b.Add(new InkPoint(0, 0, 0.5));
        b.Add(new InkPoint(0.1, 0, 0.5));
        b.Add(new InkPoint(0.2, 0, 0.5));
        Assert.Equal(1, b.Count);
    }

    [Fact]
    public void TheStrokeStillEndsWhereThePenDid()
    {
        var b = Builder();
        b.Add(new InkPoint(0, 0, 0.5));
        b.Add(new InkPoint(5, 0, 0.5));
        b.Add(new InkPoint(5.2, 0, 0.5));
        var stroke = b.Build();
        Assert.Equal(3, stroke.Points.Count);
        Assert.Equal(5.2, stroke.Points[^1].X);
    }

    [Fact]
    public void ExactDuplicatesAreDropped()
    {
        var b = Builder();
        b.Add(new InkPoint(1, 1, 0.5));
        b.Add(new InkPoint(1, 1, 0.5));
        Assert.Single(b.Build().Points);
    }

    [Fact]
    public void TheBoxIsPaddedByTheWidth()
    {
        var b = Builder();
        b.Add(new InkPoint(10, 20, 0.5));
        b.Add(new InkPoint(30, 40, 0.5));
        var stroke = b.Build();
        double pad = StrokeBuilder.Padding(stroke.Style);
        Assert.Equal(new BBox(10 - pad, 20 - pad, 30 + pad, 40 + pad), stroke.BBox);
    }
}

public class HitTestTests
{
    private static Stroke Line(double x1, double y1, double x2, double y2, double size = 2)
    {
        var b = new StrokeBuilder(StrokeTools.Pen, Brushes.PenStyle("ballpoint", "#000000", size, "pen"), "pen", 0);
        b.Add(new InkPoint(x1, y1, 0.5));
        b.Add(new InkPoint(x2, y2, 0.5));
        return b.Build();
    }

    [Fact]
    public void ASweepAcrossAStrokeHitsIt()
    {
        var stroke = Line(0, 50, 100, 50);
        // The eraser jumps from above the line to below it between two samples.
        Assert.True(HitTest.StrokeHitBySegment(stroke, new Vec2(50, 0), new Vec2(50, 100), HitTest.StrokeEraserRadius));
    }

    [Fact]
    public void ASweepBesideAStrokeMissesIt()
    {
        var stroke = Line(0, 50, 100, 50);
        Assert.False(HitTest.StrokeHitBySegment(stroke, new Vec2(0, 60), new Vec2(100, 60), HitTest.StrokeEraserRadius));
    }

    [Fact]
    public void TheRadiusIncludesHalfTheStrokeWidth()
    {
        var stroke = Line(0, 50, 100, 50, size: 10);
        // 3 (eraser) + 5 (half the width) = 8 units reach.
        Assert.True(HitTest.StrokeHitBySegment(stroke, new Vec2(40, 57.9), new Vec2(60, 57.9), HitTest.StrokeEraserRadius));
        Assert.False(HitTest.StrokeHitBySegment(stroke, new Vec2(40, 58.1), new Vec2(60, 58.1), HitTest.StrokeEraserRadius));
    }

    [Fact]
    public void ADotIsHit()
    {
        var b = new StrokeBuilder(StrokeTools.Pen, Brushes.PenStyle("ballpoint", "#000000", 2, "pen"), "pen", 0);
        b.Add(new InkPoint(10, 10, 0.5));
        var dot = b.Build();
        Assert.True(HitTest.StrokeHitBySegment(dot, new Vec2(0, 12), new Vec2(20, 12), HitTest.StrokeEraserRadius));
    }
}

public class InkPageTests
{
    private static Stroke S(double x)
    {
        var b = new StrokeBuilder(StrokeTools.Pen, Brushes.PenStyle("ballpoint", "#000000", 2, "pen"), "pen", 0);
        b.Add(new InkPoint(x, 0, 0.5));
        return b.Build();
    }

    [Fact]
    public void UndoAndRedoAnAdd()
    {
        var page = new InkPage();
        var a = S(1);
        page.Add(a);
        Assert.True(page.Undo());
        Assert.Empty(page.Strokes);
        Assert.True(page.Redo());
        Assert.Same(a, page.Strokes[0]);
    }

    [Fact]
    public void RemovingPutsStrokesBackInTheirPlaces()
    {
        var page = new InkPage();
        var (a, b, c, d) = (S(1), S(2), S(3), S(4));
        foreach (var s in new[] { a, b, c, d }) page.Add(s);
        page.Remove([b, d]);
        Assert.Equal([a, c], page.Strokes);
        page.Undo();
        Assert.Equal([a, b, c, d], page.Strokes);
        page.Redo();
        Assert.Equal([a, c], page.Strokes);
    }

    [Fact]
    public void ClearIsOneStep()
    {
        var page = new InkPage();
        page.Add(S(1));
        page.Add(S(2));
        page.Clear();
        Assert.Empty(page.Strokes);
        page.Undo();
        Assert.Equal(2, page.Strokes.Count);
    }

    [Fact]
    public void ANewChangeDropsTheRedos()
    {
        var page = new InkPage();
        page.Add(S(1));
        page.Undo();
        page.Add(S(2));
        Assert.False(page.CanRedo);
    }

    [Fact]
    public void HistoryIsCapped()
    {
        var page = new InkPage();
        for (int i = 0; i < InkPage.MaxHistoryDepth + 10; i++) page.Add(S(i));
        int undone = 0;
        while (page.Undo()) undone++;
        Assert.Equal(InkPage.MaxHistoryDepth, undone);
        Assert.Equal(10, page.Strokes.Count);
    }

    [Fact]
    public void EveryChangeBumpsTheVersion()
    {
        var page = new InkPage();
        int v0 = page.Version;
        page.Add(S(1));
        page.Undo();
        page.Redo();
        Assert.Equal(v0 + 3, page.Version);
    }

    [Fact]
    public void RemovingNothingIsNotAStep()
    {
        var page = new InkPage();
        page.Add(S(1));
        page.Remove([S(2)]);
        page.Undo();
        Assert.Empty(page.Strokes);
    }
}

public class PressureAndTiltTests
{
    [Theory]
    [InlineData(0, 0.5)]
    [InlineData(-1, 0.5)]
    [InlineData(double.NaN, 0.5)]
    [InlineData(0.3, 0.3)]
    [InlineData(1.4, 1)]
    public void PressureIsNormalized(double raw, double expected) =>
        Assert.Equal(expected, InkDefaults.NormalizePressure(raw));

    [Fact]
    public void TiltIsTheLeanOfBothAxes()
    {
        Assert.Equal(0, InkDefaults.TiltMagnitude(0, 0));
        Assert.Equal(1, InkDefaults.TiltMagnitude(70, 0));
        Assert.Equal(1, InkDefaults.TiltMagnitude(60, 60));
        Assert.Equal(0.5, InkDefaults.TiltMagnitude(21, 28), 6);
    }
}
