namespace KKNotes.Core.View;

/// <summary>
/// Where the page is on screen: <c>view = page × Zoom + Offset</c>, in device-independent pixels
/// of the drawing area. At zoom 1 a page unit is one DIP, as a CSS pixel is in the current app.
/// Immutable, so the input thread can publish a new one and the render thread read it whole.
/// </summary>
public sealed record PageCamera(double Zoom, double OffsetX, double OffsetY)
{
    public const double MinZoom = 0.25;
    public const double MaxZoom = 6;

    /// <summary>Space kept around the page, in DIPs.</summary>
    public const double Margin = 24;

    public static readonly PageCamera Identity = new(1, 0, 0);

    public (double X, double Y) ToPage(double viewX, double viewY) => ((viewX - OffsetX) / Zoom, (viewY - OffsetY) / Zoom);

    public (double X, double Y) ToView(double pageX, double pageY) => (pageX * Zoom + OffsetX, pageY * Zoom + OffsetY);

    /// <summary>The page as wide as the view allows, its top in view.</summary>
    public static PageCamera FitWidth(double viewWidth, double viewHeight, double pageWidth, double pageHeight)
    {
        double zoom = Math.Clamp((viewWidth - 2 * Margin) / pageWidth, MinZoom, MaxZoom);
        return new PageCamera(zoom, 0, Margin).Clamped(viewWidth, viewHeight, pageWidth, pageHeight);
    }

    public PageCamera PanBy(double dx, double dy) => this with { OffsetX = OffsetX + dx, OffsetY = OffsetY + dy };

    /// <summary>Zoom by <paramref name="factor"/> keeping the page point under (vx, vy) where it is.</summary>
    public PageCamera ZoomAt(double factor, double vx, double vy)
    {
        double zoom = Math.Clamp(Zoom * factor, MinZoom, MaxZoom);
        double k = zoom / Zoom;
        return new PageCamera(zoom, vx - (vx - OffsetX) * k, vy - (vy - OffsetY) * k);
    }

    /// <summary>
    /// Keeps the page in reach: centred along an axis where it fits in the view, otherwise no
    /// further than <see cref="Margin"/> past either edge.
    /// </summary>
    public PageCamera Clamped(double viewWidth, double viewHeight, double pageWidth, double pageHeight)
    {
        return this with
        {
            OffsetX = ClampAxis(OffsetX, viewWidth, pageWidth * Zoom),
            OffsetY = ClampAxis(OffsetY, viewHeight, pageHeight * Zoom),
        };
    }

    private static double ClampAxis(double offset, double view, double extent)
    {
        if (view <= 0) return offset;
        if (extent + 2 * Margin <= view) return (view - extent) / 2;
        return Math.Clamp(offset, view - extent - Margin, Margin);
    }
}
