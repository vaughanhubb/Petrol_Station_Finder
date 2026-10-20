namespace Fuel_Station_Locator.ApiService.Models;

/// <summary>
/// A fuel station returned by GET /fuel-finder/near: gov.uk Fuel Finder forecourt data
/// (/pfs) merged with its prices (/pfs/fuel-prices), plus the distance from the search point.
/// </summary>
public class FuelStationResult
{
    /// <summary>
    /// Unique identifier for the forecourt (node_id).
    /// </summary>
    public string? NodeId { get; set; }

    /// <summary>
    /// Trading name of the forecourt (trading_name).
    /// </summary>
    public string? Name { get; set; }

    /// <summary>
    /// Brand name of the forecourt (brand_name).
    /// </summary>
    public string? BrandName { get; set; }

    public string? AddressLine1 { get; set; }
    public string? AddressLine2 { get; set; }
    public string? City { get; set; }
    public string? County { get; set; }
    public string? Postcode { get; set; }
    public double? Latitude { get; set; }
    public double? Longitude { get; set; }

    /// <summary>
    /// Public phone number for the forecourt (public_phone_number), e.g. "+442038371417".
    /// </summary>
    public string? Phone { get; set; }

    /// <summary>
    /// Amenities at the forecourt, e.g. "customer_toilets", "twenty_four_hour_fuel", "car_wash".
    /// </summary>
    public List<string>? Amenities { get; set; }

    public bool IsTemporarilyClosed { get; set; }
    public bool IsPermanentlyClosed { get; set; }
    public bool IsMotorwayServiceStation { get; set; }
    public bool IsSupermarketServiceStation { get; set; }

    /// <summary>
    /// Distance in miles from the search location (calculated per request).
    /// </summary>
    public decimal? DistanceMiles { get; set; }

    /// <summary>
    /// Fuel types sold (fuel_types): E10, E5, B7_STANDARD, B7_PREMIUM, B10, HVO.
    /// </summary>
    public List<string>? FuelTypesAvailable { get; set; }

    /// <summary>
    /// Current price for each fuel type.
    /// </summary>
    public FuelPricing Pricing { get; set; } = new();

    /// <summary>
    /// Opening hours for each day of the week and bank holidays (opening_times).
    /// </summary>
    public StationOpeningTimes? OpeningTimes { get; set; }
}

/// <summary>
/// Current price per fuel type; null when the forecourt reports no price for it.
/// </summary>
public class FuelPricing
{
    /// <summary>E10 petrol (standard unleaded).</summary>
    public FuelPrice? E10 { get; set; }

    /// <summary>E5 petrol (super unleaded).</summary>
    public FuelPrice? E5 { get; set; }

    /// <summary>B7 standard diesel.</summary>
    public FuelPrice? B7_Standard { get; set; }

    /// <summary>B7 premium diesel.</summary>
    public FuelPrice? B7_Premium { get; set; }

    /// <summary>B10 diesel.</summary>
    public FuelPrice? B10 { get; set; }

    /// <summary>HVO (hydrotreated vegetable oil) diesel.</summary>
    public FuelPrice? HVO { get; set; }
}

/// <summary>
/// A single fuel price.
/// </summary>
public class FuelPrice
{
    /// <summary>
    /// Price in pence per litre (e.g. 145.9 = £1.459/l).
    /// </summary>
    public decimal? ValuePencePerUnit { get; set; }

    /// <summary>
    /// When the price was last updated (price_last_updated, UTC).
    /// </summary>
    public DateTime? PriceLastUpdated { get; set; }

    /// <summary>
    /// When the price change took effect (price_change_effective_timestamp, UTC).
    /// </summary>
    public DateTime? EffectiveTimestamp { get; set; }
}

/// <summary>
/// Opening hours for a forecourt (opening_times).
/// </summary>
public class StationOpeningTimes
{
    /// <summary>
    /// Hours keyed by lower-case day name ("monday" ... "sunday").
    /// </summary>
    public Dictionary<string, OpeningHours>? UsualDays { get; set; }

    /// <summary>
    /// Bank holiday hours.
    /// </summary>
    public OpeningHours? BankHoliday { get; set; }

    /// <summary>
    /// Bank holiday hours type from the API ("standard" or "bank holiday").
    /// </summary>
    public string? BankHolidayType { get; set; }
}

/// <summary>
/// Opening and closing time for one day ("HH:mm:ss", local time).
/// </summary>
public class OpeningHours
{
    public string? Open { get; set; }
    public string? Close { get; set; }
    public bool Is24Hours { get; set; }
}
