using Microsoft.Extensions.Logging;

namespace Fuel_Station_Locator.Tests;

[TestClass]
public class WebTests
{
    private static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(60);

    [TestMethod]
    public async Task GetWebResourceRootReturnsSearchPage()
    {
        // Arrange
        var cancellationToken = new CancellationTokenSource(DefaultTimeout).Token;

        var appHost = await DistributedApplicationTestingBuilder.CreateAsync<Projects.Fuel_Station_Locator_AppHost>(cancellationToken);

        // Dummy credentials so the test doesn't need real gov.uk secrets or network access;
        // the page renders even though the ApiService's background data load will fail.
        appHost.Configuration["Parameters:fuelfinder-client-id"] = "test-client-id";
        appHost.Configuration["Parameters:fuelfinder-client-secret"] = "test-client-secret";

        appHost.Services.AddLogging(logging =>
        {
            logging.SetMinimumLevel(LogLevel.Debug);
            // Override the logging filters from the app's configuration
            logging.AddFilter(appHost.Environment.ApplicationName, LogLevel.Debug);
            logging.AddFilter("Aspire.", LogLevel.Debug);
        });
        appHost.Services.ConfigureHttpClientDefaults(clientBuilder =>
        {
            clientBuilder.AddStandardResilienceHandler();
        });

        await using var app = await appHost.BuildAsync(cancellationToken).WaitAsync(DefaultTimeout, cancellationToken);
        await app.StartAsync(cancellationToken).WaitAsync(DefaultTimeout, cancellationToken);

        // Act
        var httpClient = app.CreateHttpClient("webfrontend");
        await app.ResourceNotifications.WaitForResourceHealthyAsync("webfrontend", cancellationToken).WaitAsync(DefaultTimeout, cancellationToken);
        var response = await httpClient.GetAsync("/", cancellationToken);
        var html = await response.Content.ReadAsStringAsync(cancellationToken);

        // Assert
        Assert.AreEqual(HttpStatusCode.OK, response.StatusCode);
        StringAssert.Contains(html, "<title>Fuel Station Locator</title>");
        StringAssert.Contains(html, "id=\"stationsTable\"");
    }
}
