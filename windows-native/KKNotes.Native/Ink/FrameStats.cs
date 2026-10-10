namespace KKNotes.Native.Ink;

/// <summary>
/// Counters the render and input threads add to and the toolbar reads twice a second. "Input
/// age" is how old the newest pen sample was when the frame showing it was handed to the
/// compositor: what the app adds to the lag, not the whole of it (the compositor and the screen
/// add their part after).
/// </summary>
internal sealed class FrameStats
{
    private readonly object _lock = new();
    private int _frames;
    private int _samples;
    private double _drawMsTotal;
    private double _drawMsMax;
    private double _ageMsTotal;
    private double _ageMsMax;
    private int _ages;

    public void AddFrame(double drawMs, double? inputAgeMs)
    {
        lock (_lock)
        {
            _frames++;
            _drawMsTotal += drawMs;
            _drawMsMax = Math.Max(_drawMsMax, drawMs);
            if (inputAgeMs is double age)
            {
                _ages++;
                _ageMsTotal += age;
                _ageMsMax = Math.Max(_ageMsMax, age);
            }
        }
    }

    public void AddSamples(int count)
    {
        lock (_lock) _samples += count;
    }

    public readonly record struct Snapshot(
        double FramesPerSecond, double SamplesPerSecond, double DrawMsAvg, double DrawMsMax, double? AgeMsAvg, double AgeMsMax);

    /// <summary>The rates since the last call, which starts a new period.</summary>
    public Snapshot Take(double seconds)
    {
        lock (_lock)
        {
            var s = new Snapshot(
                _frames / seconds,
                _samples / seconds,
                _frames > 0 ? _drawMsTotal / _frames : 0,
                _drawMsMax,
                _ages > 0 ? _ageMsTotal / _ages : null,
                _ageMsMax);
            _frames = _samples = _ages = 0;
            _drawMsTotal = _drawMsMax = _ageMsTotal = _ageMsMax = 0;
            return s;
        }
    }
}
