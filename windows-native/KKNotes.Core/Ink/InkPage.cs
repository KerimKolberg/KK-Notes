namespace KKNotes.Core.Ink;

/// <summary>
/// The strokes of one page and their undo history (<c>engine/history.ts</c>): a command stack
/// where adding stores the stroke, removing stores the strokes with their original indices and
/// clearing stores the list. Undo inverts, redo re-applies, the depth is capped.
/// Not thread-safe: the caller holds one lock around it.
/// </summary>
public sealed class InkPage
{
    public const int MaxHistoryDepth = 200;

    /// <summary>A4 at 96 dpi, the current app's default page.</summary>
    public const double A4Width = 794, A4Height = 1123;

    private abstract record Command;
    private sealed record AddCommand(Stroke Stroke) : Command;
    private sealed record RemoveCommand(IReadOnlyList<(int Index, Stroke Stroke)> Removed) : Command;
    private sealed record ClearCommand(IReadOnlyList<Stroke> Strokes) : Command;

    private readonly List<Stroke> _strokes = [];
    private readonly LinkedList<Command> _undo = new();
    private readonly Stack<Command> _redo = new();

    public double Width { get; init; } = A4Width;
    public double Height { get; init; } = A4Height;

    public IReadOnlyList<Stroke> Strokes => _strokes;

    /// <summary>Goes up with every change, so a renderer can tell its cache is stale.</summary>
    public int Version { get; private set; }

    public bool CanUndo => _undo.Count > 0;
    public bool CanRedo => _redo.Count > 0;

    public void Add(Stroke stroke) => Do(new AddCommand(stroke));

    /// <summary>Removes the given strokes as one undoable step; strokes not on the page are ignored.</summary>
    public void Remove(IEnumerable<Stroke> strokes)
    {
        var set = strokes.ToHashSet();
        var removed = new List<(int, Stroke)>();
        for (int i = 0; i < _strokes.Count; i++)
        {
            if (set.Contains(_strokes[i])) removed.Add((i, _strokes[i]));
        }
        if (removed.Count > 0) Do(new RemoveCommand(removed));
    }

    public void Clear()
    {
        if (_strokes.Count > 0) Do(new ClearCommand(_strokes.ToArray()));
    }

    public bool Undo()
    {
        if (_undo.Last is not { } node) return false;
        _undo.RemoveLast();
        Revert(node.Value);
        _redo.Push(node.Value);
        Version++;
        return true;
    }

    public bool Redo()
    {
        if (!_redo.TryPop(out var command)) return false;
        Apply(command);
        _undo.AddLast(command);
        Version++;
        return true;
    }

    private void Do(Command command)
    {
        Apply(command);
        _undo.AddLast(command);
        if (_undo.Count > MaxHistoryDepth) _undo.RemoveFirst();
        _redo.Clear();
        Version++;
    }

    private void Apply(Command command)
    {
        switch (command)
        {
            case AddCommand add:
                _strokes.Add(add.Stroke);
                break;
            case RemoveCommand remove:
                // Highest index first, so the earlier indices stay valid.
                for (int i = remove.Removed.Count - 1; i >= 0; i--) _strokes.RemoveAt(remove.Removed[i].Index);
                break;
            case ClearCommand:
                _strokes.Clear();
                break;
        }
    }

    private void Revert(Command command)
    {
        switch (command)
        {
            case AddCommand add:
                _strokes.Remove(add.Stroke);
                break;
            case RemoveCommand remove:
                foreach (var (index, stroke) in remove.Removed) _strokes.Insert(index, stroke);
                break;
            case ClearCommand clear:
                _strokes.AddRange(clear.Strokes);
                break;
        }
    }
}
