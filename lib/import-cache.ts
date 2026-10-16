import { readFile } from 'node:fs/promises';
import { evidenceFile, writeEvidenceFile } from '../scripts/evidence';

export interface Snapshot {
    fetchedAt: string;
    data: unknown;
}

export async function readSnapshot(path: string, now = Date.now()): Promise<Snapshot | null> {
    path = evidenceFile(path);
    try {
        const snapshot = JSON.parse(await readFile(path, 'utf8')) as Snapshot;
        const age = now - Date.parse(snapshot.fetchedAt);
        return age >= 0 && age < 86400000 && snapshot.data !== undefined ? snapshot : null;
    } catch {
        return null;
    }
}

export async function writeSnapshot(path: string, snapshot: Snapshot) {
    await writeEvidenceFile(path, JSON.stringify(snapshot));
}
