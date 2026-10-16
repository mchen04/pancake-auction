import fixture from '../tests/fixtures/sleeper-pool.json';
import { sourceUrls } from '../lib/import-data';
import type { Player } from '../lib/types';

export function recordedPool() {
    return { players: fixture.players as Player[], source: `recorded Sleeper pool (${fixture.fetchedAt})`,
        importMetadata: { fetchedAt: fixture.fetchedAt, sources: [...sourceUrls], counts: fixture.counts,
            coverage: fixture.coverage } };
}
