import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';

type Member = { pid: number; pgid: number; start: string };
export type OwnedGroup = { host: string; pid: number; pgid: number; processStart: string;
    members: Member[]; closed: boolean; anchored?: boolean; releaseAnchor?: () => Promise<void> };
function processes(): Member[] {
    return execFileSync('ps', ['-axo', 'pid=,pgid=,lstart='], { encoding: 'utf8' }).trim().split('\n')
        .flatMap(line => {
            const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
            return match ? [{ pid: Number(match[1]), pgid: Number(match[2]), start: match[3] }] : [];
        });
}
function exists(pgid: number) {
    try { process.kill(-pgid, 0); return true; }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw error;
    }
}
export function captureGroup(pid: number): OwnedGroup {
    const leader = processes().find(row => row.pid === pid);
    if (leader && leader.pgid !== pid) throw new Error('Refusing an unowned process group');
    const owner = { host: hostname(), pid, pgid: pid, processStart: leader?.start ?? '',
        members: leader ? [leader] : [], closed: false };
    refreshGroup(owner);
    return owner;
}
export function refreshGroup(owner: OwnedGroup) {
    if (owner.host !== hostname() || owner.pid !== owner.pgid || owner.pgid <= 0) {
        throw new Error('Process group ownership is uncertain');
    }
    if (!exists(owner.pgid)) { owner.closed = true; return; }
    const rows = processes();
    const leader = rows.find(row => row.pid === owner.pid);
    if (leader && (leader.start !== owner.processStart || leader.pgid !== owner.pgid)) {
        throw new Error('Process group identity changed; refusing to signal');
    }
    const members = rows.filter(row => row.pgid === owner.pgid);
    const trusted = members.some(row => owner.members.some(known => known.pid === row.pid && known.start === row.start));
    if (!trusted) throw new Error('Process group ownership is uncertain; refusing to signal');
    owner.members = members;
    owner.closed = false;
}
export async function stopGroup(owner: OwnedGroup, signal: NodeJS.Signals = 'SIGTERM') {
    const started = performance.now();
    let forced = signal === 'SIGKILL', signalled = false;
    for (;;) {
        if (performance.now() - started >= 8000) throw new Error(`Owned process group ${owner.pgid} did not stop`);
        try { refreshGroup(owner); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
            await new Promise(resolve => setTimeout(resolve, 25));
            continue;
        }
        if (owner.closed) return;
        if (owner.releaseAnchor && owner.members.every(member => member.pid === owner.pid)) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([owner.releaseAnchor(), new Promise<void>(resolve => {
                    timer = setTimeout(resolve, 250);
                })]);
            } finally { clearTimeout(timer); }
            if (performance.now() - started < 2000) {
                await new Promise(resolve => setTimeout(resolve, 25));
                continue;
            }
        }
        if (!signalled || !forced && performance.now() - started >= 2000) {
            const next = signalled ? 'SIGKILL' : signal;
            try { process.kill(-owner.pgid, next); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
            forced = next === 'SIGKILL'; signalled = true;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}
