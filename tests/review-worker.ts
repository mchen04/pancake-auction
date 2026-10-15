import { act, claimSeat, getState } from '../lib/engine';
import { closeDatabase, schemaName } from '../lib/db';
import { loadEnvironment, safeError } from '../scripts/env';

async function main() {
    loadEnvironment();
    if (!schemaName().startsWith('test_')) throw new Error('Cross-process test requires a test schema');
    if (process.argv[2] === 'start') await act({ type: 'start' }, await claimSeat(1));
    const state = await getState();
    console.log(JSON.stringify({
        phase: state.draft.phase, count: state.players.length, playerId: state.lot?.playerId
    }));
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; }).finally(closeDatabase);
