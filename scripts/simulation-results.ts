import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

type Metrics = {
    acceptedBids: number;
    maxBidHits: number;
    averageUnspentBudget: number;
    activeSize: number;
    timers: { expirySales: number; nominationTimeouts: number };
};

export function assertFloors(metrics: Metrics) {
    assert(metrics.acceptedBids >= 400, `At least 400 accepted bids required; received ${metrics.acceptedBids}`);
    assert(metrics.timers.expirySales >= 25, `At least 25 expiry sales required; received ${metrics.timers.expirySales}`);
    assert(metrics.timers.nominationTimeouts >= 3, 'At least three nomination timeouts required');
    assert(metrics.maxBidHits >= 5, `At least five maximum bids required; received ${metrics.maxBidHits}`);
    assert(metrics.averageUnspentBudget < 150, 'Average unspent budget must be below $150');
    assert.equal(metrics.activeSize, 200, 'Every active roster must fill');
}

export async function recordSpread(paths: string[], requireVariation = false) {
    const runs = await Promise.all(paths.map(async path => JSON.parse(await readFile(path, 'utf8'))));
    const seeds = runs.map(run => run.seed as number);
    const values = runs.map(run => ({
        seed: run.seed as number,
        bids: run.result.acceptedBids as number,
        expirySales: run.result.timers.expirySales as number,
        nominationTimeouts: run.result.timers.nominationTimeouts as number,
        maxBidHits: run.result.maxBidHits as number,
        averageUnspentBudget: run.result.averageUnspentBudget as number,
        taxiIrOnlyWins: run.result.taxiIrOnlyManagers.taxiSales + run.result.taxiIrOnlyManagers.irSales
    }));
    const metrics = ['bids', 'expirySales', 'nominationTimeouts', 'maxBidHits', 'averageUnspentBudget'] as const;
    const ranges = Object.fromEntries(metrics.map(metric => {
        const counts = values.map(value => value[metric]);
        const min = Math.min(...counts);
        const max = Math.max(...counts);
        return [metric, { min, max, spread: max - min }];
    }));
    if (requireVariation) {
        assert(new Set(seeds).size > 1, 'Spread requires distinct seeds');
        assert(new Set(values.map(value => value.bids)).size > 1, 'Accepted bid counts must vary across seeds');
        assert(new Set(values.map(value => value.expirySales)).size > 1, 'Expiry counts must vary across seeds');
    }
    const seedSpread = { seeds, values, ranges };
    await Promise.all(runs.map((run, index) => writeFile(paths[index], JSON.stringify({ ...run, seedSpread }, null, 2))));
    return seedSpread;
}
