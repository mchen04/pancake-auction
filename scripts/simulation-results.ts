import { writeEvidenceFile as writeFile, evidenceFile } from './evidence';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

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

export function draftFingerprint(events: { type: string; data: Record<string, unknown> }[]) {
    const sales = events.filter(event => event.type === 'sale').map(({ data }) => {
        assert(typeof data.playerId === 'string' && Number.isInteger(data.managerId)
            && typeof data.price === 'number' && Number.isInteger(data.price) && data.price >= 1,
            'Draft fingerprint requires a player, winner and price for every sale');
        return [data.playerId, data.managerId, data.price];
    });
    assert(sales.length > 0, 'Draft fingerprint requires sales');
    return createHash('sha256').update(JSON.stringify(sales)).digest('hex');
}

export function assertSeedVariation(values: { seed: number; bids: number; draftFingerprint: string }[]) {
    assert(new Set(values.map(value => value.seed)).size > 1, 'Spread requires distinct seeds');
    assert(new Set(values.map(value => value.bids)).size > 1, 'Accepted bid counts must vary across seeds');
    const seedsByFingerprint = new Map<string, number>();
    for (const value of values) {
        const previousSeed = seedsByFingerprint.get(value.draftFingerprint);
        assert(previousSeed === undefined || previousSeed === value.seed,
            'Different seeds must produce distinct sale sequences');
        seedsByFingerprint.set(value.draftFingerprint, value.seed);
    }
}

export async function recordSpread(paths: string[], requireVariation = false) {
    paths = paths.map(evidenceFile);
    const runs = await Promise.all(paths.map(async path => JSON.parse(await readFile(path, 'utf8'))));
    const seeds = runs.map(run => run.seed as number);
    const values = await Promise.all(runs.map(async (run, index) => ({
        seed: run.seed as number,
        draftFingerprint: draftFingerprint(JSON.parse(await readFile(evidenceFile(join(dirname(paths[index]),
            basename(paths[index]).replace(/^run-/, 'events-'))), 'utf8'))),
        bids: run.result.acceptedBids as number,
        expirySales: run.result.timers.expirySales as number,
        nominationTimeouts: run.result.timers.nominationTimeouts as number,
        extensions: run.result.timers.extensions as number,
        caps: run.result.timers.caps as number,
        maxBidHits: run.result.maxBidHits as number,
        averageUnspentBudget: run.result.averageUnspentBudget as number,
        taxiIrOnlyWins: run.result.taxiIrOnlyManagers.taxiSales + run.result.taxiIrOnlyManagers.irSales
    })));
    const metrics = ['bids', 'expirySales', 'nominationTimeouts', 'extensions', 'caps',
        'maxBidHits', 'averageUnspentBudget'] as const;
    const ranges = Object.fromEntries(metrics.map(metric => {
        const counts = values.map(value => value[metric]);
        const min = Math.min(...counts);
        const max = Math.max(...counts);
        return [metric, { min, max, spread: max - min }];
    }));
    if (requireVariation) assertSeedVariation(values);
    const seedSpread = { seeds, values, ranges };
    await Promise.all(runs.map((run, index) => writeFile(paths[index], JSON.stringify({
        ...run, draftFingerprint: values[index].draftFingerprint, seedSpread
    }, null, 2))));
    return seedSpread;
}
