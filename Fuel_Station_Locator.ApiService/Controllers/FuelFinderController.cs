using Microsoft.AspNetCore.Mvc;
using Fuel_Station_Locator.ApiService.Models;
using Fuel_Station_Locator.ApiService.Services;

namespace Fuel_Station_Locator.ApiService.Controllers;

/// <summary>
/// Finds fuel stations near a location using live gov.uk Fuel Finder data.
/// The gov.uk API has no location search: it returns every UK forecourt, so FuelFinderClient
/// caches them all and this controller filters by distance (Haversine formula).
/// </summary>
public class FuelFinderController : ControllerBase
{
    private readonly FuelFinderClient _fuelFinder;
    private readonly ILogger<FuelFinderController> _logger;

    public FuelFinderController(FuelFinderClient fuelFinder, ILogger<FuelFinderController> logger)
    {
        _fuelFinder = fuelFinder ?? throw new ArgumentNullException(nameof(fuelFinder));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>
    /// Returns open stations within maxDistanceMiles of the given point, nearest first.
    /// </summary>
    [HttpGet("/fuel-finder/near")]
    public async Task<ActionResult<List<FuelStationResult>>> FindFuelStationsNear(
        [FromQuery] double latitude,
        [FromQuery] double longitude,
        [FromQuery] int maxDistanceMiles = 20,
        CancellationToken cancellationToken = default)
    {
        IReadOnlyList<FuelStationResult> allStations;
        try
        {
            allStations = await _fuelFinder.GetAllStationsAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException or TaskCanceledException)
        {
            _logger.LogError(ex, "Error fetching from gov.uk Fuel Finder API");
            return Problem(title: "gov.uk Fuel Finder API unavailable", detail: ex.Message, statusCode: StatusCodes.Status502BadGateway);
        }

        var stations = new List<FuelStationResult>();
        foreach (var s in allStations)
        {
            if (s.IsPermanentlyClosed || s.Latitude is null || s.Longitude is null)
                continue;

            var distance = CalculateDistance(latitude, longitude, s.Latitude.Value, s.Longitude.Value);
            if (distance > maxDistanceMiles)
                continue;

            // Copy so the per-request distance doesn't leak into the shared cache.
            stations.Add(CopyWithDistance(s, (decimal)Math.Round(distance, 2)));
        }

        stations.Sort((a, b) => Nullable.Compare(a.DistanceMiles, b.DistanceMiles));

        _logger.LogInformation("Found {Count} of {Total} fuel stations within {Distance} miles of {Lat},{Lon}",
            stations.Count, allStations.Count, maxDistanceMiles, latitude, longitude);

        return Ok(stations);
    }

    private static FuelStationResult CopyWithDistance(FuelStationResult s, decimal distanceMiles) => new()
    {
        NodeId = s.NodeId,
        Name = s.Name,
        BrandName = s.BrandName,
        AddressLine1 = s.AddressLine1,
        AddressLine2 = s.AddressLine2,
        City = s.City,
        County = s.County,
        Postcode = s.Postcode,
        Latitude = s.Latitude,
        Longitude = s.Longitude,
        Phone = s.Phone,
        Amenities = s.Amenities,
        IsTemporarilyClosed = s.IsTemporarilyClosed,
        IsPermanentlyClosed = s.IsPermanentlyClosed,
        IsMotorwayServiceStation = s.IsMotorwayServiceStation,
        IsSupermarketServiceStation = s.IsSupermarketServiceStation,
        FuelTypesAvailable = s.FuelTypesAvailable,
        Pricing = s.Pricing,
        OpeningTimes = s.OpeningTimes,
        DistanceMiles = distanceMiles
    };

    /// <summary>
    /// Calculates distance in miles between two points using the Haversine formula.
    /// </summary>
    private static double CalculateDistance(double lat1, double lon1, double lat2, double lon2)
    {
        const double earthRadiusKm = 6371.0;

        double dLat = DegreesToRadians(lat2 - lat1);
        double dLon = DegreesToRadians(lon2 - lon1);

        double a = Math.Sin(dLat / 2) * Math.Sin(dLat / 2) +
                   Math.Cos(DegreesToRadians(lat1)) * Math.Cos(DegreesToRadians(lat2)) *
                   Math.Sin(dLon / 2) * Math.Sin(dLon / 2);
        double c = 2 * Math.Atan2(Math.Sqrt(a), Math.Sqrt(1 - a));

        // Convert to miles (1 mile ≈ 1.60934 km)
        return earthRadiusKm * c / 1.60934;
    }

    private static double DegreesToRadians(double degrees) => degrees * Math.PI / 180.0;
}
