namespace KKNotes.Native;

/// <summary>
/// A plain-text log in the temp folder (<c>%TEMP%\KKNotes.Native.log</c>), started afresh at each
/// launch: what the app set up (input thread, frame latency, prediction, swap chain) and anything
/// that went wrong. It is what Claude reads when the owner reports a problem.
/// </summary>
internal static class Log
{
    private static readonly object Lock = new();

    public static string FilePath { get; } = Path.Combine(Path.GetTempPath(), "KKNotes.Native.log");

    public static void Start()
    {
        lock (Lock) File.WriteAllText(FilePath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} KK-Notes native prototype started{Environment.NewLine}");
    }

    public static void Write(string message)
    {
        try
        {
            lock (Lock) File.AppendAllText(FilePath, $"{DateTime.Now:HH:mm:ss.fff} [{Environment.CurrentManagedThreadId}] {message}{Environment.NewLine}");
        }
        catch (IOException)
        {
            // Logging must never take the app down.
        }
    }
}
