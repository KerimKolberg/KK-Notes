namespace KKNotes.Core.Ink;

/// <summary>The tools of the prototype.</summary>
public enum Tool
{
    Pen,
    Highlighter,
    StrokeEraser,
}

public enum BarrelPhase
{
    /// <summary>Not pressed.</summary>
    Idle,
    /// <summary>Pressed, not yet long enough to be a hold.</summary>
    Pending,
    /// <summary>Held past the threshold; a tool is on loan.</summary>
    Held,
    /// <summary>
    /// Pressed and already spent: the pen touched the page while it was down, so it was a stroke
    /// with the button held, not a gesture of its own.
    /// </summary>
    Used,
}

public enum BarrelActionKind
{
    None,
    /// <summary>A click: toggle between the configured pair.</summary>
    Click,
    /// <summary>A hold began: switch to <see cref="BarrelAction.Tool"/>.</summary>
    HoldStart,
    /// <summary>A hold ended: put <see cref="BarrelAction.Tool"/> back.</summary>
    HoldEnd,
}

public readonly record struct BarrelAction(BarrelActionKind Kind, Tool Tool = default)
{
    public static readonly BarrelAction None = new(BarrelActionKind.None);
}

/// <summary>State of the barrel gesture. <see cref="PressedAt"/> is in milliseconds.</summary>
public readonly record struct BarrelState(BarrelPhase Phase, double PressedAt, Tool? BorrowedFrom)
{
    public static readonly BarrelState Idle = new(BarrelPhase.Idle, 0, null);
}

/// <summary>
/// The pen's barrel button as a click-or-hold gesture, a port of the current app's pure state
/// machine (<c>engine/barrelButton.ts</c>, README "Stylus buttons"). A quick press toggles
/// between two tools; holding it borrows a third only for as long as it is held.
/// </summary>
public static class BarrelButton
{
    /// <summary>Below this a press is a click, at or past it a hold.</summary>
    public const double ClickMs = 300;

    public static (BarrelState State, BarrelAction Action) Down(BarrelState state, double now)
    {
        // A second down without an up restarts the press rather than stacking.
        if (state.Phase == BarrelPhase.Held) return (state, BarrelAction.None);
        return (new BarrelState(BarrelPhase.Pending, now, null), BarrelAction.None);
    }

    /// <summary>
    /// Released before the threshold it was a click; after, a hold, whether or not a tick had
    /// promoted it. A long press is never read as a click.
    /// </summary>
    public static (BarrelState State, BarrelAction Action) Up(BarrelState state, double now, double threshold = ClickMs)
    {
        switch (state.Phase)
        {
            case BarrelPhase.Idle:
                return (state, BarrelAction.None);
            case BarrelPhase.Used:
                return (BarrelState.Idle, BarrelAction.None);
            case BarrelPhase.Held:
                return (BarrelState.Idle, state.BorrowedFrom is Tool restore
                    ? new BarrelAction(BarrelActionKind.HoldEnd, restore)
                    : BarrelAction.None);
            default:
                return (BarrelState.Idle, now - state.PressedAt < threshold
                    ? new BarrelAction(BarrelActionKind.Click)
                    : BarrelAction.None);
        }
    }

    /// <summary>
    /// Time passed with the button still down (a held button sends no events, so a timer calls
    /// this). Promotes a pending press to a hold once it crosses the threshold.
    /// </summary>
    public static (BarrelState State, BarrelAction Action) Tick(
        BarrelState state, double now, Tool holdTool, Tool currentTool, double threshold = ClickMs)
    {
        if (state.Phase != BarrelPhase.Pending || now - state.PressedAt < threshold) return (state, BarrelAction.None);
        if (holdTool == currentTool) return (state with { Phase = BarrelPhase.Held, BorrowedFrom = null }, BarrelAction.None);
        return (new BarrelState(BarrelPhase.Held, state.PressedAt, currentTool),
            new BarrelAction(BarrelActionKind.HoldStart, holdTool));
    }

    /// <summary>The pen touched the page with the button down: the press is a stroke, not a click.</summary>
    public static BarrelState Consume(BarrelState state) =>
        state.Phase == BarrelPhase.Pending ? state with { Phase = BarrelPhase.Used, BorrowedFrom = null } : state;

    /// <summary>The gesture was abandoned (the pen left range). Anything borrowed goes back.</summary>
    public static (BarrelState State, BarrelAction Action) Cancel(BarrelState state)
    {
        if (state.Phase == BarrelPhase.Held && state.BorrowedFrom is Tool restore)
            return (BarrelState.Idle, new BarrelAction(BarrelActionKind.HoldEnd, restore));
        return (BarrelState.Idle, BarrelAction.None);
    }

    /// <summary>Where a click goes: a fixed pair, toggled; from a third tool it goes to the second.</summary>
    public static Tool Toggle(Tool current, Tool a, Tool b) => current == a ? b : current == b ? a : b;
}
