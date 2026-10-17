import { localBackend, sleep } from '../scripts/local-backend';
import { AuctionClient, RuleError } from '../lib/client';
import type { Action, Player } from '../lib/types';
export { RuleError, sleep };
export function syntheticPool(): Player[] {
    return Array.from({
        length: 300
    }, (_, i) => ({
        id: `test-${i}`,
        name: `Test Player ${i + 1}`,
        position: [
            "PG",
            "SG",
            "SF",
            "PF",
            "C"
        ][i % 5],
        positions: [
            ["PG"],
            ["SG"],
            ["SF"],
            ["PF"],
            ["C"]
        ][i % 5] as Player["positions"],
        team: null,
        status: "ACT",
        yearsExp: i % 3 === 0 ? 0 : 1,
        injuryStatus: i % 5 === 0 ? "Out" : null,
        age: 22,
        careerGames: i % 3 === 0 ? 0 : i % 7 === 0 ? 100 : 40,
        careerGamesComplete: true,
        projection: 300 - i,
        projectedStats: null,
        adp: null
    }));
}

let backend: Awaited<ReturnType<typeof localBackend>> | undefined;
let client: AuctionClient | undefined;
export async function createIsolated(prefix: 'test' | 'sim') {
    if (backend) throw new Error('Close the previous isolated backend first');
    const name = `${prefix}-${crypto.randomUUID()}`;
    backend = await localBackend(name, true);
    client = new AuctionClient(backend.url);
    return name;
}
export async function dropIsolated(name: string) {
    if (!/^(test|sim)-/.test(name)) throw new Error('Invalid test backend name');
    await backend?.close();
    backend = undefined;
    client = undefined;
}
export function currentBackend() {
    if (!backend) throw new Error('Start an isolated local backend first');
    return backend;
}
export function currentClient() {
    if (!client) throw new Error('Start an isolated local backend first');
    return client;
}
export const getState = (token?: string) => currentClient().state(token);
export type TestAction = Action
    | Omit<Extract<Action, { type: 'nominate' }>, 'nominationGeneration'>
    | Omit<Extract<Action, { type: 'done' }>, 'nominationGeneration'>;
export async function act(action: TestAction, token?: string) {
    if ((action.type === 'nominate' || action.type === 'done') && !('nominationGeneration' in action)) {
        const snapshot = await getState();
        return currentClient().act({ ...action, nominationGeneration: snapshot.draft.nominationGeneration }, token);
    }
    return currentClient().act(action as Action, token);
}
export const claimSeat = (id: number) => currentClient().claim(id);
export const restoreSeat = (token: string) => currentClient().restore(token);
export const configure = (args: Record<string, unknown>) => currentBackend().admin('testOnly:configure', args);
export const inspect = () => currentBackend().admin('admin:inspect');
export async function seedManagers() { await currentBackend().admin('admin:managers'); }
export interface SeedMetadata {
    fetchedAt: string;
    sources: string[];
    counts?: unknown;
    coverage?: unknown;
}
export async function seedPlayers(players = syntheticPool(), metadata?: SeedMetadata) {
    await currentBackend().admin('admin:importPlayers', { players,
        fetchedAt: metadata?.fetchedAt ?? new Date().toISOString(), startedAt: Date.now(),
        sources: metadata?.sources ?? ['recorded-test-fixture'],
        counts: metadata?.counts ?? { pool: players.length }, coverage: metadata?.coverage ?? {} });
}
