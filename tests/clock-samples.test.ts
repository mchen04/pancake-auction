import { describe, expect, it } from 'vitest';
import { ClockSamples, maximumClockRttMs, preferredClockRttMs } from '../lib/clock-samples';

function warmedSamples() {
    const samples = new ClockSamples();
    samples.begin(0, 0);
    return samples;
}

describe('C20 bounded independent clock samples', () => {
    it('discards the first request on a connection, including a cold slow sample', () => {
        const samples = new ClockSamples();
        expect(samples.accept(samples.begin(0, 0), 600, 1200, 1200)).toBeNull();
        expect(samples.accept(samples.begin(1200, 1200), 1400, 1600, 1600)).toBe(0);
        expect(samples.provisional).toBe(true);
    });
    it('accepts provisional RTTs up to the hard cap and replaces them with better samples', () => {
        const samples = warmedSamples();
        expect(samples.accept(samples.begin(0, 0), 1000, 2000, 2000)).toBe(0);
        expect(samples.provisional).toBe(true);
        expect(samples.accept(samples.begin(2100, 2100), 2300, 2500, 2500)).toBe(0);
        expect(samples.accept(samples.begin(2600, 2600), 2900, 3200, 3200)).toBeNull();
        expect(samples.accept(samples.begin(3300, 3300), 3400, 3500, 3500)).toBe(0);
        expect(samples.provisional).toBe(false);
        expect(preferredClockRttMs).toBe(300);
    });
    it('uses the request midpoint and accepts local wall-clock skew', () => {
        const samples = warmedSamples();
        const request = samples.begin(121000, 0);
        expect(samples.accept(request, 1050, 121100, 100)).toBe(-120000);
    });
    it('rejects excessive round trips and a wall-clock jump during a request', () => {
        const samples = warmedSamples();
        expect(samples.accept(samples.begin(0, 0), 100, maximumClockRttMs + 1, maximumClockRttMs + 1)).toBeNull();
        expect(samples.accept(samples.begin(1000, 1000), 1000, 122000, 1100)).toBeNull();
    });
    it('never lets an older completion overwrite a newer good sample', () => {
        const samples = warmedSamples();
        const older = samples.begin(1000, 0);
        const newer = samples.begin(1010, 10);
        expect(samples.accept(newer, 1020, 1020, 20)).toBe(5);
        expect(samples.accept(older, 1010, 1030, 30)).toBeNull();
    });
    it('prefers a lower RTT until the best sample ages out', () => {
        const samples = warmedSamples();
        expect(samples.accept(samples.begin(1000, 0), 1005, 1010, 10)).toBe(0);
        expect(samples.accept(samples.begin(1100, 100), 1200, 1150, 150)).toBeNull();
        expect(samples.accept(samples.begin(32000, 31000), 32025, 32050, 31050)).toBe(0);
    });
    it('accepts a fresh sample after the local wall clock changes between requests', () => {
        const samples = warmedSamples();
        expect(samples.accept(samples.begin(1000, 0), 1005, 1010, 10)).toBe(0);
        expect(samples.accept(samples.begin(122000, 1000), 2010, 122020, 1020)).toBe(-120000);
    });
    it('invalidates earlier requests on reconnect and accepts a fresh sample', () => {
        const samples = warmedSamples();
        const pending = samples.begin(1000, 0);
        samples.reset();
        expect(samples.accept(pending, 1010, 1020, 20)).toBeNull();
        expect(samples.accept(samples.begin(1030, 30), 1035, 1040, 40)).toBeNull();
        expect(samples.accept(samples.begin(1050, 50), 1055, 1060, 60)).toBe(0);
    });
});
