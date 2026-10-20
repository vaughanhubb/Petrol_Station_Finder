var builder = DistributedApplication.CreateBuilder(args);

// gov.uk Fuel Finder API credentials. Stored in this project's user-secrets as
// Parameters:fuelfinder-client-id / Parameters:fuelfinder-client-secret; the dashboard prompts if missing.
var fuelFinderClientId = builder.AddParameter("fuelfinder-client-id", secret: true);
var fuelFinderClientSecret = builder.AddParameter("fuelfinder-client-secret", secret: true);

var apiService = builder.AddProject<Projects.Fuel_Station_Locator_ApiService>("apiservice")
    .WithEnvironment("FuelFinderApi__ClientId", fuelFinderClientId)
    .WithEnvironment("FuelFinderApi__ClientSecret", fuelFinderClientSecret)
    .WithHttpHealthCheck("/health");

builder.AddProject<Projects.Fuel_Station_Locator_Web>("webfrontend")
    .WithExternalHttpEndpoints()
    .WithReference(apiService)
    .WaitFor(apiService);

builder.Build().Run();
