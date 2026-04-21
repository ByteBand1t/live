// ← FIX: API gibt "journeys" zurück, nicht "vehicles"
const vehicles = result.journeys || [];

vehicles.forEach((journey) => {
  const key = journey.journeyID;
  if (key) allVehicles.set(key, normalizeJourney(journey));
});
