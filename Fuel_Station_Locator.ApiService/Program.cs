using Fuel_Station_Locator.ApiService.Services;

var builder = WebApplication.CreateBuilder(args);

// Add service defaults & Aspire client integrations.
builder.AddServiceDefaults();

builder.Services.AddProblemDetails();
builder.Services.AddControllers();

// HttpClient for the gov.uk Fuel Finder API
#pragma warning disable EXTEXP0001 // RemoveAllResilienceHandlers: replace the 10s default from ServiceDefaults
builder.Services.AddHttpClient("GovUkFuelFinder", client =>
{
    // Trailing slash is required so relative paths append to /api/v1.
    var baseAddress = builder.Configuration.GetValue<string>("FuelFinderApi:BaseUrl")
        ?? "https://www.fuel-finder.service.gov.uk/api/v1";
    client.BaseAddress = new Uri(baseAddress.TrimEnd('/') + "/");

    client.DefaultRequestHeaders.Add("Accept", "application/json");

    // The Fuel Finder CloudFront WAF returns 403 "Request blocked" for requests without a User-Agent
    client.DefaultRequestHeaders.UserAgent.ParseAdd("FuelStationLocator/1.0");
})
.RemoveAllResilienceHandlers()
.AddStandardResilienceHandler(options =>
{
    // 500-record batches regularly take 5-10s; the default 10s attempt timeout caused needless retries.
    // Retries (incl. 429 with Retry-After) use exponential backoff, per the developer guidelines.
    options.AttemptTimeout.Timeout = TimeSpan.FromSeconds(30);
    options.TotalRequestTimeout.Timeout = TimeSpan.FromMinutes(2);
    options.CircuitBreaker.SamplingDuration = TimeSpan.FromMinutes(1);
});
#pragma warning restore EXTEXP0001

// Singleton so the OAuth token and the cached ~8,100 forecourts are shared across requests
builder.Services.AddSingleton(sp => new FuelFinderClient(
    sp.GetRequiredService<IHttpClientFactory>().CreateClient("GovUkFuelFinder"),
    sp.GetRequiredService<IConfiguration>(),
    sp.GetRequiredService<ILogger<FuelFinderClient>>()));

var app = builder.Build();

// Warm the forecourt cache in the background so the first search doesn't wait for all batches to download
app.Lifetime.ApplicationStarted.Register(() => _ = Task.Run(async () =>
{
    try
    {
        await app.Services.GetRequiredService<FuelFinderClient>().GetAllStationsAsync(app.Lifetime.ApplicationStopping);
    }
    catch (Exception ex)
    {
        app.Logger.LogWarning(ex, "Initial gov.uk Fuel Finder cache warm-up failed; will retry on first search");
    }
}));

// Unhandled exceptions become RFC 7807 problem responses
app.UseExceptionHandler();

app.MapDefaultEndpoints();
app.MapControllers();

app.Run();
