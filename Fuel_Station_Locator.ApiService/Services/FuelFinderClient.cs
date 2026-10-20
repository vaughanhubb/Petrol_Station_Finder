using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Fuel_Station_Locator.ApiService.Models;

namespace Fuel_Station_Locator.ApiService.Services;

/// <summary>
/// Client for the gov.uk Fuel Finder API (https://www.fuel-finder.service.gov.uk/api/v1).
/// Handles OAuth client-credentials auth, pages through every 500-record batch of
/// forecourts (/pfs) and prices (/pfs/fuel-prices), merges them by node_id and caches the result.
/// </summary>
public class FuelFinderClient
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        NumberHandling = JsonNumberHandling.AllowReadingFromString
    };

    // Safety cap: ~8,700 forecourts today = 18 batches. Stops a runaway loop if the API never returns an empty batch.
    private const int MaxBatches = 100;
    private const int BatchSize = 500;

    private readonly HttpClient _httpClient;
    private readonly IConfiguration _configuration;
    private readonly ILogger<FuelFinderClient> _logger;

    private readonly SemaphoreSlim _tokenLock = new(1, 1);
    private string? _accessToken;
    private DateTimeOffset _tokenExpiry;

    // Developer guidelines: live limit is 100 requests/minute and 1 concurrent request per client,
    // so every call goes through _requestLock and calls are spaced at least MinRequestInterval apart.
    private static readonly TimeSpan MinRequestInterval = TimeSpan.FromMilliseconds(650);
    private readonly SemaphoreSlim _requestLock = new(1, 1);
    private DateTimeOffset _lastRequest = DateTimeOffset.MinValue;

    private readonly TimeSpan _stationCacheDuration;
    private readonly TimeSpan _priceCacheDuration;
    private readonly SemaphoreSlim _refreshLock = new(1, 1);
    private List<PfsRecord>? _forecourts;
    private DateTimeOffset _forecourtsExpiry;
    private IReadOnlyList<FuelStationResult>? _cachedStations;
    private DateTimeOffset _pricesExpiry;

    public FuelFinderClient(HttpClient httpClient, IConfiguration configuration, ILogger<FuelFinderClient> logger)
    {
        _httpClient = httpClient;
        _configuration = configuration;
        _logger = logger;
        // Guideline cache durations: station data 1 hour, price data 15 minutes.
        _stationCacheDuration = TimeSpan.FromMinutes(configuration.GetValue("FuelFinderApi:StationCacheMinutes", 60));
        _priceCacheDuration = TimeSpan.FromMinutes(configuration.GetValue("FuelFinderApi:PriceCacheMinutes", 15));
    }

    /// <summary>
    /// Returns every forecourt in the UK with its current prices. Served from cache when fresh.
    /// </summary>
    public async Task<IReadOnlyList<FuelStationResult>> GetAllStationsAsync(CancellationToken cancellationToken = default)
    {
        if (_cachedStations != null && DateTimeOffset.UtcNow < _pricesExpiry)
            return _cachedStations;

        await _refreshLock.WaitAsync(cancellationToken);
        try
        {
            // Another request may have refreshed the cache while we waited.
            if (_cachedStations != null && DateTimeOffset.UtcNow < _pricesExpiry)
                return _cachedStations;

            var started = DateTimeOffset.UtcNow;

            if (_forecourts == null || DateTimeOffset.UtcNow >= _forecourtsExpiry)
            {
                _forecourts = await GetAllBatchesAsync<PfsRecord>("pfs", cancellationToken);
                _forecourtsExpiry = DateTimeOffset.UtcNow + _stationCacheDuration;
            }

            var prices = await GetAllBatchesAsync<PfsPriceRecord>("pfs/fuel-prices", cancellationToken);

            var pricesByNode = new Dictionary<string, List<PfsFuelPrice>>();
            foreach (var p in prices)
            {
                if (!string.IsNullOrEmpty(p.NodeId) && p.FuelPrices != null)
                    pricesByNode[p.NodeId] = p.FuelPrices;
            }

            var stations = _forecourts
                .Where(f => !string.IsNullOrEmpty(f.NodeId))
                .Select(f => MapStation(f, pricesByNode.GetValueOrDefault(f.NodeId!)))
                .ToList();

            _logger.LogInformation(
                "Loaded {Stations} forecourts and {Prices} price records from gov.uk Fuel Finder in {Seconds:F1}s",
                stations.Count, prices.Count, (DateTimeOffset.UtcNow - started).TotalSeconds);

            _cachedStations = stations;
            _pricesExpiry = DateTimeOffset.UtcNow + _priceCacheDuration;
            return stations;
        }
        finally
        {
            _refreshLock.Release();
        }
    }

    /// <summary>
    /// Pages through batch-number=1,2,3... until the API returns a short/empty batch or 404 (end of data).
    /// </summary>
    private async Task<List<T>> GetAllBatchesAsync<T>(string path, CancellationToken cancellationToken)
    {
        var all = new List<T>();

        for (var batch = 1; batch <= MaxBatches; batch++)
        {
            var token = await GetAccessTokenAsync(cancellationToken);
            using var response = await SendRateLimitedAsync(() =>
            {
                var request = new HttpRequestMessage(HttpMethod.Get, $"{path}?batch-number={batch}");
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                return request;
            }, cancellationToken);

            // The API returns 404 for a batch number past the end of the data.
            if (response.StatusCode == HttpStatusCode.NotFound)
                break;

            if (!response.IsSuccessStatusCode)
            {
                var body = await response.Content.ReadAsStringAsync(cancellationToken);
                throw new HttpRequestException(
                    $"Fuel Finder {path} batch {batch} returned {(int)response.StatusCode}: {body}", null, response.StatusCode);
            }

            var items = await response.Content.ReadFromJsonAsync<List<T>>(JsonOptions, cancellationToken) ?? [];
            all.AddRange(items);

            _logger.LogDebug("Fuel Finder {Path} batch {Batch}: {Count} records", path, batch, items.Count);

            // A batch smaller than 500 is the last one; skip the extra request that would only return 404.
            if (items.Count < BatchSize)
                break;
        }

        return all;
    }

    /// <summary>
    /// Sends one request at a time, spaced to stay under the 100 requests/minute limit.
    /// </summary>
    private async Task<HttpResponseMessage> SendRateLimitedAsync(Func<HttpRequestMessage> createRequest, CancellationToken cancellationToken)
    {
        await _requestLock.WaitAsync(cancellationToken);
        try
        {
            var wait = _lastRequest + MinRequestInterval - DateTimeOffset.UtcNow;
            if (wait > TimeSpan.Zero)
                await Task.Delay(wait, cancellationToken);

            using var request = createRequest();
            try
            {
                return await _httpClient.SendAsync(request, cancellationToken);
            }
            finally
            {
                _lastRequest = DateTimeOffset.UtcNow;
            }
        }
        finally
        {
            _requestLock.Release();
        }
    }

    private async Task<string> GetAccessTokenAsync(CancellationToken cancellationToken)
    {
        if (_accessToken != null && DateTimeOffset.UtcNow < _tokenExpiry)
            return _accessToken;

        await _tokenLock.WaitAsync(cancellationToken);
        try
        {
            if (_accessToken != null && DateTimeOffset.UtcNow < _tokenExpiry)
                return _accessToken;

            var clientId = _configuration["FuelFinderApi:ClientId"];
            var clientSecret = _configuration["FuelFinderApi:ClientSecret"];

            if (string.IsNullOrWhiteSpace(clientId) || string.IsNullOrWhiteSpace(clientSecret))
                throw new InvalidOperationException(
                    "Fuel Finder credentials are not configured. Set FuelFinderApi:ClientId and FuelFinderApi:ClientSecret (see README).");

            using var response = await SendRateLimitedAsync(() => new HttpRequestMessage(HttpMethod.Post, "oauth/generate_access_token")
            {
                Content = JsonContent.Create(new { client_id = clientId, client_secret = clientSecret })
            }, cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                var body = await response.Content.ReadAsStringAsync(cancellationToken);
                throw new HttpRequestException(
                    $"Fuel Finder token request returned {(int)response.StatusCode}: {body}", null, response.StatusCode);
            }

            var token = await response.Content.ReadFromJsonAsync<TokenEnvelope>(JsonOptions, cancellationToken);
            if (token?.Data?.AccessToken == null)
                throw new HttpRequestException("Fuel Finder token response did not contain an access_token.");

            _accessToken = token.Data.AccessToken;
            // Renew a minute early so a token never expires mid-way through paging.
            _tokenExpiry = DateTimeOffset.UtcNow.AddSeconds(Math.Max(60, token.Data.ExpiresIn - 60));
            return _accessToken;
        }
        finally
        {
            _tokenLock.Release();
        }
    }

    private static FuelStationResult MapStation(PfsRecord f, List<PfsFuelPrice>? prices)
    {
        var station = new FuelStationResult
        {
            NodeId = f.NodeId,
            Name = f.TradingName,
            BrandName = f.BrandName,
            AddressLine1 = f.Location?.AddressLine1,
            AddressLine2 = string.IsNullOrWhiteSpace(f.Location?.AddressLine2) ? null : f.Location.AddressLine2,
            City = f.Location?.City,
            County = string.IsNullOrWhiteSpace(f.Location?.County) ? null : f.Location.County,
            Postcode = f.Location?.Postcode,
            Latitude = f.Location?.Latitude,
            Longitude = f.Location?.Longitude,
            Phone = f.PublicPhoneNumber,
            Amenities = f.Amenities,
            IsTemporarilyClosed = f.TemporaryClosure ?? false,
            IsPermanentlyClosed = f.PermanentClosure ?? false,
            FuelTypesAvailable = f.FuelTypes,
            IsMotorwayServiceStation = f.IsMotorwayServiceStation ?? false,
            IsSupermarketServiceStation = f.IsSupermarketServiceStation ?? false,
            OpeningTimes = MapOpeningTimes(f.OpeningTimes),
        };

        foreach (var p in prices ?? [])
        {
            if (p.Price is not > 0) continue;

            var price = new FuelPrice
            {
                ValuePencePerUnit = p.Price,
                PriceLastUpdated = p.PriceLastUpdated,
                EffectiveTimestamp = p.PriceChangeEffectiveTimestamp
            };

            switch (p.FuelType?.ToUpperInvariant())
            {
                case "E10": station.Pricing.E10 = price; break;
                case "E5": station.Pricing.E5 = price; break;
                case "B7_STANDARD": station.Pricing.B7_Standard = price; break;
                case "B7_PREMIUM": station.Pricing.B7_Premium = price; break;
                case "B10": station.Pricing.B10 = price; break;
                case "HVO": station.Pricing.HVO = price; break;
            }
        }

        return station;
    }

    private static StationOpeningTimes? MapOpeningTimes(PfsOpeningTimes? o)
    {
        if (o == null) return null;

        Dictionary<string, OpeningHours>? usualDays = null;
        if (o.UsualDays != null)
        {
            // Indexer (not ToDictionary) so a duplicated day can't throw and break the whole data load
            usualDays = new Dictionary<string, OpeningHours>();
            foreach (var (day, hours) in o.UsualDays)
            {
                if (hours != null)
                    usualDays[day.ToLowerInvariant()] = new OpeningHours { Open = hours.Open, Close = hours.Close, Is24Hours = hours.Is24Hours ?? false };
            }
        }

        return new StationOpeningTimes
        {
            UsualDays = usualDays,
            BankHoliday = o.BankHoliday == null ? null : new OpeningHours
            {
                Open = o.BankHoliday.OpenTime,
                Close = o.BankHoliday.CloseTime,
                Is24Hours = o.BankHoliday.Is24Hours ?? false
            },
            BankHolidayType = o.BankHoliday?.Type
        };
    }

    // ---- gov.uk Fuel Finder wire format ----

    private sealed class TokenEnvelope
    {
        [JsonPropertyName("data")] public TokenData? Data { get; set; }
    }

    private sealed class TokenData
    {
        [JsonPropertyName("access_token")] public string? AccessToken { get; set; }
        [JsonPropertyName("expires_in")] public int ExpiresIn { get; set; }
    }

    private sealed class PfsRecord
    {
        [JsonPropertyName("node_id")] public string? NodeId { get; set; }
        [JsonPropertyName("trading_name")] public string? TradingName { get; set; }
        [JsonPropertyName("brand_name")] public string? BrandName { get; set; }
        [JsonPropertyName("public_phone_number")] public string? PublicPhoneNumber { get; set; }
        [JsonPropertyName("temporary_closure")] public bool? TemporaryClosure { get; set; }
        [JsonPropertyName("permanent_closure")] public bool? PermanentClosure { get; set; }
        [JsonPropertyName("location")] public PfsLocation? Location { get; set; }
        [JsonPropertyName("amenities")] public List<string>? Amenities { get; set; }
        [JsonPropertyName("fuel_types")] public List<string>? FuelTypes { get; set; }
        [JsonPropertyName("is_motorway_service_station")] public bool? IsMotorwayServiceStation { get; set; }
        [JsonPropertyName("is_supermarket_service_station")] public bool? IsSupermarketServiceStation { get; set; }
        [JsonPropertyName("opening_times")] public PfsOpeningTimes? OpeningTimes { get; set; }
    }

    private sealed class PfsOpeningTimes
    {
        [JsonPropertyName("usual_days")] public Dictionary<string, PfsDayHours>? UsualDays { get; set; }
        [JsonPropertyName("bank_holiday")] public PfsBankHolidayHours? BankHoliday { get; set; }
    }

    private sealed class PfsDayHours
    {
        [JsonPropertyName("open")] public string? Open { get; set; }
        [JsonPropertyName("close")] public string? Close { get; set; }
        [JsonPropertyName("is_24_hours")] public bool? Is24Hours { get; set; }
    }

    private sealed class PfsBankHolidayHours
    {
        [JsonPropertyName("type")] public string? Type { get; set; }
        [JsonPropertyName("open_time")] public string? OpenTime { get; set; }
        [JsonPropertyName("close_time")] public string? CloseTime { get; set; }
        [JsonPropertyName("is_24_hours")] public bool? Is24Hours { get; set; }
    }

    private sealed class PfsLocation
    {
        [JsonPropertyName("address_line_1")] public string? AddressLine1 { get; set; }
        [JsonPropertyName("address_line_2")] public string? AddressLine2 { get; set; }
        [JsonPropertyName("city")] public string? City { get; set; }
        [JsonPropertyName("county")] public string? County { get; set; }
        [JsonPropertyName("postcode")] public string? Postcode { get; set; }
        [JsonPropertyName("latitude")] public double? Latitude { get; set; }
        [JsonPropertyName("longitude")] public double? Longitude { get; set; }
    }

    private sealed class PfsPriceRecord
    {
        [JsonPropertyName("node_id")] public string? NodeId { get; set; }
        [JsonPropertyName("fuel_prices")] public List<PfsFuelPrice>? FuelPrices { get; set; }
    }

    private sealed class PfsFuelPrice
    {
        [JsonPropertyName("fuel_type")] public string? FuelType { get; set; }
        [JsonPropertyName("price")] public decimal? Price { get; set; }
        [JsonPropertyName("price_last_updated")] public DateTime? PriceLastUpdated { get; set; }
        [JsonPropertyName("price_change_effective_timestamp")] public DateTime? PriceChangeEffectiveTimestamp { get; set; }
    }
}
