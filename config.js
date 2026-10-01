// Site-wide settings. Project data (units, towers, site plan) lives in data.js.
window.SITE_CONFIG = {
  projectName: "Thomson Reserve",
  tagline: "1,268 homes in six towers on a 5-hectare site at Upper Thomson — explore every unit in 3D, " +
    "with real sun and shadows and the actual view from your window.",

  // Local time zone of the site, used by the sun & shadow study.
  utcOffsetHours: 8,
  // Ground height (metres above the WGS84 ellipsoid) used in real-city view.
  // Leave null to detect it automatically from the Google 3D tiles.
  groundHeight: null,

  // Google Maps Platform key for the real-city view. It is visible in the page source, so it is
  // restricted in Google Cloud Console to https://xujianhang8-ctrl.github.io/* and the Map Tiles API.
  googleMapsApiKey: "AIzaSyBi8JHrOrRj-w99kKNcVQCTfNocVNJpyhc",

  // WhatsApp number in international format, digits only (e.g. "6591234567").
  whatsappNumber: "",
  // Where "Register interest" enquiries are emailed if no WhatsApp number is set.
  contactEmail: "",
};
