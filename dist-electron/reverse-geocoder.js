/**
 * Offline Reverse Geocoder for PDR
 *
 * Uses GeoNames cities5000 dataset (~68K cities, 2.6MB) with a k-d tree
 * for fast nearest-neighbor lookup. Converts GPS lat/lon coordinates
 * into human-readable country + city names.
 *
 * Data: GeoNames (https://www.geonames.org/)
 * License: Creative Commons Attribution 4.0
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function buildKDTree(points, depth = 0) {
    if (points.length === 0)
        return null;
    const dim = depth % 2; // alternate between lat (0) and lon (1)
    // Sort by current dimension
    points.sort((a, b) => {
        const av = dim === 0 ? a.lat : a.lon;
        const bv = dim === 0 ? b.lat : b.lon;
        return av - bv;
    });
    const mid = Math.floor(points.length / 2);
    return {
        point: points[mid],
        left: buildKDTree(points.slice(0, mid), depth + 1),
        right: buildKDTree(points.slice(mid + 1), depth + 1),
        splitDim: dim,
    };
}
// Haversine distance in km
function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function nearestNeighbor(root, targetLat, targetLon, best) {
    if (!root)
        return;
    const d = haversineKm(targetLat, targetLon, root.point.lat, root.point.lon);
    if (d < best.dist) {
        best.dist = d;
        best.node = root;
    }
    const dim = root.splitDim;
    const targetVal = dim === 0 ? targetLat : targetLon;
    const nodeVal = dim === 0 ? root.point.lat : root.point.lon;
    const diff = targetVal - nodeVal;
    // Search the side of the split that contains the target first
    const first = diff < 0 ? root.left : root.right;
    const second = diff < 0 ? root.right : root.left;
    nearestNeighbor(first, targetLat, targetLon, best);
    // Check if we need to search the other side
    // Convert coordinate difference to approximate km for pruning
    const dimDiffKm = Math.abs(diff) * (dim === 0 ? 111.32 : 111.32 * Math.cos(targetLat * Math.PI / 180));
    if (dimDiffKm < best.dist) {
        nearestNeighbor(second, targetLat, targetLon, best);
    }
}
// ─── Geocoder ───────────────────────────────────────────────────────────────
let kdTree = null;
let countries = {};
let loaded = false;
/**
 * Load the geodata and build the k-d tree. Call once at startup or first use.
 * Subsequent calls are no-ops.
 */
export function initGeocoder() {
    if (loaded)
        return;
    // Try multiple paths — works both in dev and packaged app
    const possiblePaths = [
        path.join(__dirname, 'geodata', 'cities.json'),
        path.join(__dirname, '..', 'electron', 'geodata', 'cities.json'),
        path.join(process.resourcesPath || '', 'geodata', 'cities.json'),
    ];
    let dataPath = null;
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            dataPath = p;
            break;
        }
    }
    if (!dataPath) {
        console.warn('[Geocoder] cities.json not found — reverse geocoding disabled');
        console.warn('[Geocoder] Searched:', possiblePaths.join(', '));
        loaded = true; // Don't try again
        return;
    }
    console.log(`[Geocoder] Loading geodata from ${dataPath}...`);
    const startTime = Date.now();
    const raw = fs.readFileSync(dataPath, 'utf-8');
    const data = JSON.parse(raw);
    countries = data.countries || {};
    // Convert compact arrays to CityRecord objects
    const cities = data.cities.map((c) => ({
        lat: c[0],
        lon: c[1],
        name: c[2],
        countryCode: c[3],
        admin1: c[4] || '',
    }));
    // Build k-d tree
    kdTree = buildKDTree(cities);
    const elapsed = Date.now() - startTime;
    console.log(`[Geocoder] Loaded ${cities.length} cities in ${elapsed}ms`);
    loaded = true;
}
/**
 * Reverse geocode a GPS coordinate to the nearest city.
 * Returns null if geodata is not loaded or coordinates are invalid.
 *
 * @param lat Latitude (-90 to 90)
 * @param lon Longitude (-180 to 180)
 * @param maxDistanceKm Maximum distance to nearest city (default 200km)
 */
export function reverseGeocode(lat, lon, maxDistanceKm = 200) {
    if (!kdTree || !loaded)
        return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180)
        return null;
    if (isNaN(lat) || isNaN(lon))
        return null;
    const best = { node: null, dist: Infinity };
    nearestNeighbor(kdTree, lat, lon, best);
    if (!best.node || best.dist > maxDistanceKm)
        return null;
    const city = best.node.point;
    return {
        country: countries[city.countryCode] || city.countryCode,
        countryCode: city.countryCode,
        city: city.name,
        admin1: city.admin1,
        distance: Math.round(best.dist * 10) / 10,
    };
}
/**
 * Check if the geocoder is ready (geodata loaded).
 */
export function isGeocoderReady() {
    return loaded && kdTree !== null;
}
