// Reload guard for app updates: at most `limit` reloads toward one version per window, so a stale
// shell or a half-finished deployment can never cause a reload loop.
export interface UpdateAttempt { version: string; at: number; count: number }
export const updateWindowMs = 10 * 60000;

export function parseVersion(body: unknown) {
    const version = typeof body === 'object' && body !== null ? (body as { version?: unknown }).version : undefined;
    return typeof version === 'string' && /^[\w.-]{1,64}$/.test(version) ? version : null;
}
export function parseAttempt(raw: string | null): UpdateAttempt | null {
    try {
        const value = raw ? JSON.parse(raw) : null;
        return typeof value?.version === 'string' && Number.isFinite(value.at) && Number.isInteger(value.count) ? value : null;
    } catch { return null; }
}
export function nextAttempt(version: string, previous: UpdateAttempt | null, now: number, limit = 2): UpdateAttempt | null {
    const recent = previous && previous.version === version && now - previous.at < updateWindowMs ? previous : null;
    if (recent && recent.count >= limit) return null;
    return { version, at: recent?.at ?? now, count: (recent?.count ?? 0) + 1 };
}
