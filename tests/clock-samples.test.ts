import { describe, expect, it, vi } from 'vitest';
import { ClockSamples, estimatedServerTime, maximumClockRttMs, preferredClockRttMs } from '../lib/clock-samples';

function warmedSamples() {
    const samples = new ClockSamples();
    samples.begin(0, 0);
    return samples;
}

describe('C20 bounded independent clock samples', () => {
    it('discards the first request on a connection, including a cold slow sample', () => {
        const samples = new ClockSamples();
        expect(samples.accept(samples.begin(0, 0),600,1200, 1200)).toBeNull();
        expect(samples.accept(samples.begin(1200, 1200),1400,1600, 1600)).toMatchObject({serverNow:1400,monotonic:1400,rtt:400});
        expect(samples.provisional).toBe(true);
    });
    it('accepts provisional RTTs up to the hard cap and replaces them with better samples', () => {
        const samples = warmedSamples();
        expect(samples.accept(samples.begin(0, 0),1000,2000, 2000)).toMatchObject({serverNow:1000,monotonic:1000});
        expect(samples.provisional).toBe(true);
        expect(samples.accept(samples.begin(2100, 2100),2300,2500, 2500)).not.toBeNull();
        expect(samples.accept(samples.begin(2600, 2600),2900,3200, 3200)).toBeNull();
        expect(samples.accept(samples.begin(3300, 3300),3400,3500, 3500)).not.toBeNull();
        expect(samples.provisional).toBe(false);
        expect(preferredClockRttMs).toBe(300);
    });
    it('uses the request monotonic midpoint and accepts local wall-clock skew', () => {
        const samples = warmedSamples();
        const sample=samples.accept(samples.begin(0, 0),1050,100, 100)!;
        expect(sample).toMatchObject({serverNow:1050,monotonic:50});
        expect(estimatedServerTime(sample,100)).toBe(1100);
    });
    it('rejects excessive and negative monotonic round trips', () => {
        const samples = warmedSamples();
        expect(samples.accept(samples.begin(0, 0),100,maximumClockRttMs+1, maximumClockRttMs+1)).toBeNull();
        expect(samples.accept(samples.begin(1000, 1000),1000,900, 900)).toBeNull();
    });
    it('never lets an older completion overwrite a newer good sample', () => {
        const samples = warmedSamples();
        const older = samples.begin(0, 0), newer = samples.begin(10, 10);
        expect(samples.accept(newer,1020,20, 20)).toMatchObject({serverNow:1020,monotonic:15});
        expect(samples.accept(older,1010,30, 30)).toBeNull();
    });
    it('prefers a lower RTT until the best sample ages out', () => {
        const samples = warmedSamples();
        expect(samples.accept(samples.begin(0, 0),1005,10, 10)).not.toBeNull();
        expect(samples.accept(samples.begin(100, 100),1200,150, 150)).toBeNull();
        expect(samples.accept(samples.begin(31000, 31000),32025,31050, 31050)).not.toBeNull();
    });
    it('wall-clock changes between requests do not replace a better monotonic anchor', () => {
        const samples = warmedSamples();
        expect(samples.accept(samples.begin(0, 0),1005,10, 10)).not.toBeNull();
        expect(samples.accept(samples.begin(1000, 31000),2010,1020, 31020)).toBeNull();
    });
    it('invalidates earlier requests on reconnect and accepts a fresh sample', () => {
        const samples = warmedSamples();
        const pending = samples.begin(0, 0);
        samples.reset();
        expect(samples.accept(pending,1010,20, 20)).toBeNull();
        expect(samples.accept(samples.begin(30, 30),1035,40, 40)).toBeNull();
        expect(samples.accept(samples.begin(50, 50),1055,60, 60)).not.toBeNull();
    });
    it('keeps the accepted anchor and rank when reconnect invalidates pending requests', () => {
        const samples = warmedSamples();
        const anchor = samples.accept(samples.begin(0, 0), 1005, 10, 10)!;
        const pending = samples.begin(20, 20);
        samples.reset(true);
        expect(samples.hasSample).toBe(true);
        expect(estimatedServerTime(anchor, 30)).toBe(1030);
        expect(samples.accept(pending, 1030, 40, 40)).toBeNull();
        expect(samples.accept(samples.begin(50, 50), 1055, 60, 60)).toBeNull();
        expect(samples.accept(samples.begin(70, 70), 1075, 80, 80)).not.toBeNull();
    });
    it('C24 forward and backward wall jumps cannot change an accepted estimate', () => {
        const samples=warmedSamples();
        const sample=samples.accept(samples.begin(0, 0),1050,100, 100)!;
        const wall=vi.spyOn(Date,'now');
        try {
            for(const value of [31000,-29000,1000]) {
                wall.mockReturnValue(value);
                expect(estimatedServerTime(sample,200)).toBe(1200);
            }
        } finally { wall.mockRestore(); }
    });
    it('C24 detects server drift after a suspended monotonic clock and accepts a fresh anchor', () => {
        const samples=warmedSamples();
        expect(samples.accept(samples.begin(0, 0),1005,10, 10)).not.toBeNull();
        const fresh=samples.accept(samples.begin(1000, 1000),4010,1020, 1020)!;
        expect(fresh).toMatchObject({serverNow:4010,monotonic:1010});
        expect(estimatedServerTime(fresh,1030)).toBe(4030);
    });
    it('C24 rejects requests that span wall-clock corrections or a paused monotonic clock', () => {
        const samples=warmedSamples();
        expect(samples.accept(samples.begin(0,0),1050,100,30100)).toBeNull();
        expect(samples.accept(samples.begin(200,200),2050,300,1300)).toBeNull();
    });

});
