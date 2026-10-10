using KKNotes.Core.Ink;

namespace KKNotes.Native.Ink;

/// <summary>What the toolbar has chosen. Immutable, swapped whole, so any thread reads one consistent set.</summary>
internal sealed record InkSettings(
    Tool Tool,
    string Brush,
    string PenColor,
    double PenWidth,
    string HighlighterColor,
    double HighlighterWidth)
{
    /// <summary>The current app's defaults: a 1 px dark-grey ballpoint, a 16 px yellow highlighter.</summary>
    public static readonly InkSettings Default = new(Tool.Pen, Brushes.Ballpoint, "#1f1f24", 1, "#facc15", Brushes.DefaultHighlighterWidth);

    /// <summary>The barrel button's click toggles these two; its hold borrows the eraser (README "Stylus buttons").</summary>
    public const Tool ClickToggleA = Tool.Pen;
    public const Tool ClickToggleB = Tool.StrokeEraser;
    public const Tool HoldTool = Tool.StrokeEraser;
}
