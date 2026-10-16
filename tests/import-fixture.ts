import recorded from './fixtures/sleeper.json';

export function importFixture(): [Record<string, Record<string, unknown>>, Record<string, unknown>[], ...unknown[]] {
    const players = Object.values(recorded[0] as Record<string, Record<string, unknown>>);
    const projections = recorded[1] as Record<string, unknown>[];
    const ids = Array.from({ length: 550 }, (_, i) => String(1000 + i));
    const roster = Object.fromEntries(ids.map((id, i) => [id, {
        ...players[i % players.length], player_id: id, full_name: `Fixture Player ${i}`,
        fantasy_positions: [['PG', 'SG', 'SF', 'PF', 'C'][i % 5]], active: true, team: 'TEST', years_exp: 1
    }]));
    const forecast = ids.map((id, i) => ({ ...projections[i % projections.length], player_id: id }));
    const seasons = Array.from({ length: 13 }, () => Object.fromEntries(ids.map(id => [id, { gp: 1 }])));
    return [roster, forecast, ...seasons];
}
