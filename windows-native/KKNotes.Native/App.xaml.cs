using Microsoft.UI.Xaml;

namespace KKNotes.Native;

public partial class App : Application
{
    private Window? _window;

    public App()
    {
        Log.Start();
        UnhandledException += (_, e) => Log.Write($"Unhandled: {e.Exception}");
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log.Write($"Unhandled (domain): {e.ExceptionObject}");
        InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        // `--snapshot <file.png>` draws a demo page, saves it and quits: a check of the drawing
        // code that needs no one at the screen.
        string[] argv = Environment.GetCommandLineArgs();
        int i = Array.IndexOf(argv, "--snapshot");
        string? snapshot = i >= 0 && i + 1 < argv.Length ? Path.GetFullPath(argv[i + 1]) : null;

        _window = new MainWindow(snapshot);
        _window.Activate();
    }
}
