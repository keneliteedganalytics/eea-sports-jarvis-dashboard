// OpenWeather adapter — current conditions at a ballpark (lat/lon → wind,
// temp, humidity). Returns null when OPENWEATHER_API_KEY is unset so the
// model proceeds with a neutral (zero) weather adjustment.

import { getJson } from "./http";
import type { WeatherRefined } from "../sports/mlb/weather";

const BASE = "https://api.openweathermap.org/data/2.5/weather";

export function hasWeatherKey(): boolean {
  return Boolean(process.env.OPENWEATHER_API_KEY);
}

interface RawWeather {
  main?: { temp?: number; humidity?: number };
  wind?: { speed?: number };
}

// Fetch current conditions for a ballpark. `lat`/`lon` are the stadium coords.
export async function fetchWeather(lat: number, lon: number): Promise<WeatherRefined | null> {
  if (!hasWeatherKey()) return null;

  const res = await getJson<RawWeather>(BASE, {
    lat,
    lon,
    units: "imperial",
    appid: process.env.OPENWEATHER_API_KEY,
  });
  if (!res.ok || !res.data) return null;

  return {
    tempF: res.data.main?.temp ?? null,
    humidity: res.data.main?.humidity ?? null,
    windMph: res.data.wind?.speed ?? null,
  };
}
