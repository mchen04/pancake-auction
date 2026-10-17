import { evidenceDirectory } from './evidence';
import managers from '../league/managers.json';
import { runAdmin } from './admin-client';
export async function checkLeague(inspect = () => runAdmin('admin:inspect')) {
    evidenceDirectory(process.env.EVIDENCE_DIR);
    const data = await inspect();
    const draft = data.draft?.value;
    const expected = managers.map(manager => manager.name).sort();
    const actual = data.managers.map((manager: { name: string }) => manager.name).sort();
    const checks = {
        schema: Boolean(data.draft),
        managers: JSON.stringify(expected) === JSON.stringify(actual),
        commissioner: data.managers.filter((manager: { commissioner: boolean }) => manager.commissioner).length === 1
            && data.managers.some((manager: { name: string; commissioner: boolean }) =>
                manager.name === 'Michael' && manager.commissioner),
        import: data.imports.some((run: { revision: string; finishedAt: number; counts: { pool: number } }) =>
            run.finishedAt && run.counts.pool > 0 && run.counts.pool === data.pool?.count
                && run.revision === data.pool?.revision),
        setup: draft?.status === 'setup' && data.lots.length === 0,
        timing: draft?.mode === 'sealed-v1' && draft?.nominationMs === 86400000 && draft?.biddingMs === 86400000
    };
    return { ready: Object.values(checks).every(Boolean), checks, imports: data.imports };
}
