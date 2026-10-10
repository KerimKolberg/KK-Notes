namespace KKNotes.Core.Ink;

/// <summary>
/// Whether a finger may start a gesture (pan or pinch), the palm-rejection half of the current
/// app's <c>engine/pointerPolicy.ts</c>. A hand writing rests on the screen: while the pen is in
/// range, and for a moment after it was last seen, new touches are ignored so the palm does not
/// scroll the page under the pen. A pen that never says it left goes stale after a while, so
/// touch is not locked out for good. Times are in milliseconds.
/// </summary>
public sealed class TouchGate
{
    /// <summary>Touch is ignored for this long after the last pen event.</summary>
    public const double PalmGraceMs = 700;

    /// <summary>After this long without a pen event, "in range" is treated as stale.</summary>
    public const double PenProximityTimeoutMs = 3000;

    private double _lastPenAt = double.NegativeInfinity;
    private bool _penInRange;

    public void PenSeen(double now, bool inRange)
    {
        _lastPenAt = now;
        _penInRange = inRange;
    }

    public void PenLeft(double now)
    {
        _lastPenAt = now;
        _penInRange = false;
    }

    public bool AllowsTouch(double now)
    {
        double since = now - _lastPenAt;
        if (_penInRange && since < PenProximityTimeoutMs) return false;
        return since >= PalmGraceMs;
    }
}
