export async function apiGet(endpoint, params) {
  const base = import.meta.env.BASE_URL || '/'
  const url = new URL(base.replace(/\/$/, '') + endpoint, window.location.origin)
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v)
  }
  const res = await fetch(url)
  const ctype = res.headers.get('content-type') || ''
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  if (!ctype.includes('json')) throw new Error(`non-JSON reply (${res.status} ${ctype.slice(0, 30)})`)
  return res.json()
}

export async function searchLocalities(q) {
  const { localities, note } = await apiGet('/api/search', { q })
  return { localities: (localities || []).map((l) => ({ ...l, type: 'locality' })), note }
}

export async function searchAll(q, limit = 50) {
  const { results = [] } = await apiGet('/api/search-all', { q, limit })
  return results
}

export function localityStops(slug) {
  return apiGet('/api/locality', { slug })
}

export function localityDirections(slug) {
  return apiGet('/api/locality-directions', { slug })
}

export function nearby(lat, lon) {
  return apiGet('/api/nearby', { lat, lon })
}

export function stopDepartures(atco, when) {
  const params = { atco }
  if (when) params.when = when.toISOString()
  return apiGet('/api/departures', params)
}

export function stopServices(atco) {
  return apiGet('/api/stop-services', { atco })
}

export function serviceStops(slug) {
  return apiGet('/api/service-stops', { slug })
}
