using KKNotes.Core.Ink;
using KKNotes.Core.View;

namespace KKNotes.Core.Tests;

/// <summary>The same decisions the current app pins in <c>barrelButton.test.ts</c>.</summary>
public class BarrelButtonTests
{
    [Fact]
    public void AQuickPressIsAClick()
    {
        var (s, _) = BarrelButton.Down(BarrelState.Idle, 1000);
        var (s2, action) = BarrelButton.Up(s, 1100);
        Assert.Equal(BarrelActionKind.Click, action.Kind);
        Assert.Equal(BarrelPhase.Idle, s2.Phase);
    }

    [Fact]
    public void ALongPressIsNeverAClickEvenWithoutATick()
    {
        var (s, _) = BarrelButton.Down(BarrelState.Idle, 1000);
        var (_, action) = BarrelButton.Up(s, 1400);
        Assert.Equal(BarrelActionKind.None, action.Kind);
    }

    [Fact]
    public void AHoldBorrowsAtTheTickAndGivesBackOnRelease()
    {
        var (s, _) = BarrelButton.Down(BarrelState.Idle, 1000);
        var (early, none) = BarrelButton.Tick(s, 1200, Tool.StrokeEraser, Tool.Pen);
        Assert.Equal(BarrelActionKind.None, none.Kind);
        var (held, start) = BarrelButton.Tick(early, 1300, Tool.StrokeEraser, Tool.Pen);
        Assert.Equal(new BarrelAction(BarrelActionKind.HoldStart, Tool.StrokeEraser), start);
        var (_, end) = BarrelButton.Up(held, 2000);
        Assert.Equal(new BarrelAction(BarrelActionKind.HoldEnd, Tool.Pen), end);
    }

    [Fact]
    public void HoldingWhileAlreadyOnTheHoldToolSwitchesNothing()
    {
        var (s, _) = BarrelButton.Down(BarrelState.Idle, 0);
        var (held, start) = BarrelButton.Tick(s, 400, Tool.StrokeEraser, Tool.StrokeEraser);
        Assert.Equal(BarrelActionKind.None, start.Kind);
        Assert.Equal(BarrelActionKind.None, BarrelButton.Up(held, 900).Action.Kind);
    }

    [Fact]
    public void AStrokeMadeWithTheButtonDownIsNotAClick()
    {
        var (s, _) = BarrelButton.Down(BarrelState.Idle, 0);
        s = BarrelButton.Consume(s);
        Assert.Equal(BarrelActionKind.None, BarrelButton.Up(s, 150).Action.Kind);
    }

    [Fact]
    public void ConsumingAHoldLeavesItAHold()
    {
        var (s, _) = BarrelButton.Down(BarrelState.Idle, 0);
        (s, _) = BarrelButton.Tick(s, 300, Tool.StrokeEraser, Tool.Pen);
        s = BarrelButton.Consume(s);
        Assert.Equal(BarrelActionKind.HoldEnd, BarrelButton.Up(s, 900).Action.Kind);
    }

    [Fact]
    public void CancelGivesBackButNeverClicks()
    {
        var (s, _) = BarrelButton.Down(BarrelState.Idle, 0);
        Assert.Equal(BarrelActionKind.None, BarrelButton.Cancel(s).Action.Kind);
        (s, _) = BarrelButton.Tick(s, 300, Tool.StrokeEraser, Tool.Highlighter);
        Assert.Equal(new BarrelAction(BarrelActionKind.HoldEnd, Tool.Highlighter), BarrelButton.Cancel(s).Action);
    }

    [Theory]
    [InlineData(Tool.Pen, Tool.StrokeEraser)]
    [InlineData(Tool.StrokeEraser, Tool.Pen)]
    [InlineData(Tool.Highlighter, Tool.StrokeEraser)]
    public void ClickToggles(Tool from, Tool to) => Assert.Equal(to, BarrelButton.Toggle(from, Tool.Pen, Tool.StrokeEraser));
}

public class PageCameraTests
{
    [Fact]
    public void ZoomingKeepsThePointUnderTheFingers()
    {
        var cam = new PageCamera(1.2, 30, -40);
        var (px, py) = cam.ToPage(500, 300);
        var zoomed = cam.ZoomAt(1.7, 500, 300);
        var (vx, vy) = zoomed.ToView(px, py);
        Assert.Equal(500, vx, 9);
        Assert.Equal(300, vy, 9);
    }

    [Fact]
    public void ZoomIsBounded()
    {
        Assert.Equal(PageCamera.MaxZoom, new PageCamera(5, 0, 0).ZoomAt(10, 0, 0).Zoom);
        Assert.Equal(PageCamera.MinZoom, new PageCamera(0.3, 0, 0).ZoomAt(0.1, 0, 0).Zoom);
    }

    [Fact]
    public void APageNarrowerThanTheViewIsCentred()
    {
        var cam = new PageCamera(1, -500, 0).Clamped(1200, 800, 794, 1123);
        Assert.Equal((1200 - 794) / 2.0, cam.OffsetX);
    }

    [Fact]
    public void ATallPageScrollsNoFurtherThanItsMargin()
    {
        var top = new PageCamera(1, 0, 500).Clamped(1200, 800, 794, 1123);
        Assert.Equal(PageCamera.Margin, top.OffsetY);
        var bottom = new PageCamera(1, 0, -5000).Clamped(1200, 800, 794, 1123);
        Assert.Equal(800 - 1123 - PageCamera.Margin, bottom.OffsetY);
    }

    [Fact]
    public void FitWidthFillsTheWidthBetweenMargins()
    {
        var cam = PageCamera.FitWidth(1700, 1000, 794, 1123);
        Assert.Equal((1700 - 2 * PageCamera.Margin) / 794, cam.Zoom, 9);
        Assert.Equal(PageCamera.Margin, cam.OffsetY);
    }
}

public class TouchGateTests
{
    [Fact]
    public void TouchIsFreeWhenNoPenWasSeen() => Assert.True(new TouchGate().AllowsTouch(0));

    [Fact]
    public void APenInRangeBlocksTouch()
    {
        var gate = new TouchGate();
        gate.PenSeen(1000, inRange: true);
        Assert.False(gate.AllowsTouch(2500));
    }

    [Fact]
    public void TouchWaitsOutTheGraceAfterThePenLeaves()
    {
        var gate = new TouchGate();
        gate.PenLeft(1000);
        Assert.False(gate.AllowsTouch(1500));
        Assert.True(gate.AllowsTouch(1000 + TouchGate.PalmGraceMs));
    }

    [Fact]
    public void AStalePenStopsBlocking()
    {
        var gate = new TouchGate();
        gate.PenSeen(1000, inRange: true);
        Assert.True(gate.AllowsTouch(1000 + TouchGate.PenProximityTimeoutMs));
    }
}
