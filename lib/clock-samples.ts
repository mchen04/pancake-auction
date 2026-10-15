export const preferredClockRttMs = 300;
export const maximumClockRttMs = 2000;
const bestSampleWindowMs = 30000;
export interface ClockRequest { sequence: number; wall: number; monotonic: number; warmup: boolean }
export class ClockSamples {
    private sequence = 0;
    private acceptedSequence = 0;
    private bestRtt = Infinity;
    private bestAt = -Infinity;
    private acceptedWall = NaN;
    private acceptedMonotonic = NaN;
    private needsWarmup = true;
    get provisional() { return this.bestRtt > preferredClockRttMs; }
    reset() {
        this.acceptedSequence = ++this.sequence;
        this.bestRtt = Infinity;
        this.bestAt = -Infinity;
        this.needsWarmup = true;
    }
    begin(wall = Date.now(), monotonic = performance.now()): ClockRequest {
        const warmup = this.needsWarmup;
        this.needsWarmup = false;
        return { sequence: ++this.sequence, wall, monotonic, warmup };
    }
    accept(request: ClockRequest, serverNow: number, wall = Date.now(), monotonic = performance.now()) {
        const rtt = monotonic - request.monotonic;
        if (request.warmup || !Number.isFinite(serverNow) || rtt < 0 || rtt > maximumClockRttMs
            || Math.abs(wall - request.wall - rtt) > 100 || request.sequence <= this.acceptedSequence) return null;
        const wallChanged = Math.abs(wall - this.acceptedWall - monotonic + this.acceptedMonotonic) > 100;
        if (!wallChanged && monotonic - this.bestAt < bestSampleWindowMs && rtt > this.bestRtt) return null;
        this.acceptedSequence = request.sequence;
        this.bestRtt = rtt;
        this.bestAt = monotonic;
        this.acceptedWall = wall;
        this.acceptedMonotonic = monotonic;
        return serverNow - (request.wall + wall) / 2;
    }
}
