export const preferredClockRttMs = 300;
export const maximumClockRttMs = 2000;
const bestSampleWindowMs = 30000;
export interface ClockAnchor { serverNow: number; monotonic: number }
export interface ClockSample extends ClockAnchor { sequence: number; rtt: number }
export interface ClockRequest { sequence: number; monotonic: number; wall: number; warmup: boolean }
export function estimatedServerTime(anchor: ClockAnchor, monotonic = performance.now()) {
    return anchor.serverNow + monotonic - anchor.monotonic;
}
export class ClockSamples {
    private sequence = 0;
    private acceptedSequence = 0;
    private bestRtt = Infinity;
    private bestAt = -Infinity;
    private accepted: ClockSample | null = null;
    private needsWarmup = true;
    get hasSample() { return this.accepted !== null; }
    get provisional() { return this.bestRtt > preferredClockRttMs; }
    reset(keepAccepted = false) {
        this.acceptedSequence = ++this.sequence;
        if (!keepAccepted) {
            this.bestRtt = Infinity;
            this.bestAt = -Infinity;
            this.accepted = null;
        }
        this.needsWarmup = true;
    }
    begin(monotonic = performance.now(), wall = Date.now()): ClockRequest {
        const warmup = this.needsWarmup;
        this.needsWarmup = false;
        return { sequence: ++this.sequence, monotonic, wall, warmup };
    }
    accept(request: ClockRequest, serverNow: number, monotonic = performance.now(), wall = Date.now()) {
        const rtt = monotonic - request.monotonic;
        if (request.warmup || !Number.isFinite(serverNow) || rtt < 0 || rtt > maximumClockRttMs
            || Math.abs(wall - request.wall - rtt) > 100 || request.sequence <= this.acceptedSequence) return null;
        const midpoint = (request.monotonic + monotonic) / 2;
        const drift = this.accepted === null ? 0 : Math.abs(serverNow - estimatedServerTime(this.accepted, midpoint));
        const driftLimit = Math.max(100, (rtt + this.bestRtt) / 2);
        if (drift <= driftLimit && monotonic - this.bestAt < bestSampleWindowMs && rtt > this.bestRtt) return null;
        this.acceptedSequence = request.sequence;
        this.bestRtt = rtt;
        this.bestAt = monotonic;
        this.accepted = { serverNow, monotonic: midpoint, sequence: request.sequence, rtt };
        return this.accepted;
    }
}
