using Fuel_Station_Locator.Web.Components;

var builder = WebApplication.CreateBuilder(args);

// Add service defaults & Aspire client integrations.
builder.AddServiceDefaults();

// Statically rendered page; all interactivity is in wwwroot/app.js
builder.Services.AddRazorComponents();

// HttpClient for the ApiService, resolved via Aspire service discovery
// (falls back to "services:apiservice" in appsettings.Development.json when run without the AppHost).
// The first search after startup can wait for all ~8,100 forecourts to download in 500-record batches, so allow extra time.
#pragma warning disable EXTEXP0001 // RemoveAllResilienceHandlers: replace the 10s default from ServiceDefaults
builder.Services.AddHttpClient("apiservice", client => client.BaseAddress = new Uri("https+http://apiservice"))
    .RemoveAllResilienceHandlers()
#pragma warning restore EXTEXP0001
    .AddStandardResilienceHandler(options =>
    {
        options.AttemptTimeout.Timeout = TimeSpan.FromMinutes(2);
        options.TotalRequestTimeout.Timeout = TimeSpan.FromMinutes(3);
        options.CircuitBreaker.SamplingDuration = TimeSpan.FromMinutes(5);
    });

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error", createScopeForErrors: true);
    // The default HSTS value is 30 days. You may want to change this for production scenarios, see https://aka.ms/aspnetcore-hsts.
    app.UseHsts();
}

app.UseHttpsRedirection();
app.UseAntiforgery();

app.MapStaticAssets();
app.MapRazorComponents<App>();

// Proxy browser searches (app.js) to the ApiService, which holds the gov.uk Fuel Finder credentials
app.MapGet("/fuel-finder/near", async (HttpContext context, IHttpClientFactory httpClientFactory, CancellationToken cancellationToken) =>
{
    var client = httpClientFactory.CreateClient("apiservice");
    using var response = await client.GetAsync("/fuel-finder/near" + context.Request.QueryString, cancellationToken);

    context.Response.StatusCode = (int)response.StatusCode;
    context.Response.ContentType = response.Content.Headers.ContentType?.ToString() ?? "application/json";
    await response.Content.CopyToAsync(context.Response.Body, cancellationToken);
});

app.MapDefaultEndpoints();

app.Run();
