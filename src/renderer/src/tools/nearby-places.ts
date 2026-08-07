import axios from 'axios'
import { getLiveLocation } from './live-location'

// Haversine distance in km
const haversine = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const R = 6371
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export const findNearbyPlaces = async (query: string) => {
  try {
    if (!query || !query.trim()) return '❌ Please tell me what kind of place to look for.'

    const loc = await getLiveLocation()
    if (!loc || loc.lat == null || loc.lon == null) {
      return '❌ I could not determine your current location to search nearby.'
    }

    const { lat, lon } = loc
    const d = 0.06 // ~6km half-box
    // Nominatim viewbox order: left(minLon), top(maxLat), right(maxLon), bottom(minLat)
    const viewbox = `${lon - d},${lat + d},${lon + d},${lat - d}`
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
      query
    )}&limit=12&viewbox=${viewbox}&bounded=1&addressdetails=1`

    const res = await axios.get(url, { headers: { 'Accept-Language': 'en' } })
    const raw: any[] = res.data || []

    if (raw.length === 0) {
      return `No "${query}" found near your location (${loc.city || 'current area'}). Try a broader term.`
    }

    const places = raw
      .map((r) => ({
        name: r.display_name.split(',')[0],
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
        dist: haversine(lat, lon, parseFloat(r.lat), parseFloat(r.lon))
      }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 8)

    // Center the map on the user's location for visual context
    window.dispatchEvent(
      new CustomEvent('map-update', { detail: { lat, lng: lon, name: `${query} near you` } })
    )

    return (
      `Nearby "${query}" (closest first):\n` +
      places.map((p, i) => `${i + 1}. ${p.name} — ${p.dist.toFixed(1)} km away`).join('\n')
    )
  } catch (err) {
    return `❌ Nearby search failed: ${String(err)}`
  }
}
