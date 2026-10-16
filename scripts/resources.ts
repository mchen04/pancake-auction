import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile, type ChildProcess } from 'node:child_process';
import type { Server, Socket } from 'node:net';
import { promisify } from 'node:util';
import { appendEvidenceFile, captureEvidence } from './evidence';

const execute = promisify(execFile);
const active = new AsyncLocalStorage<Resources>();
export function onceAsync(run: () => Promise<void>) {
    let result: Promise<void> | undefined;
    return () => result ??= run();
}
class Resources {
    cleanups: (() => Promise<void>)[] = [];
    servers: { server: Server; port: number | null }[] = [];
    processes: ChildProcess[] = [];
    browsers = new Map<string, { closed: boolean; started: boolean }>();
    async close() {
        const errors: unknown[] = [];
        for (const close of this.cleanups.reverse()) {
            try { await close(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, 'Owned resource cleanup failed');
    }
}
export function ownCleanup(close: () => Promise<void>) {
    const dispose = onceAsync(close);
    active.getStore()?.cleanups.push(dispose);
    return dispose;
}
export async function withResources<T>(run: () => Promise<T>) {
    const resources = new Resources();
    return active.run(resources, async () => {
        try { return await run(); }
        finally {
            try { await resources.close(); }
            finally {
                if (process.env.EVIDENCE_DIR) await appendEvidenceFile(`${process.env.EVIDENCE_DIR}/resources.jsonl`,
                    JSON.stringify({ servers:resources.servers.map(({server,port})=>({port,closed:!server.listening})),
                        processes:resources.processes.map(child=>({pid:child.pid,exitCode:child.exitCode,
                            signalCode:child.signalCode,closed:child.exitCode!==null||child.signalCode!==null})),
                        browsers:[...resources.browsers].map(([session,state])=>({session,...state})) })+'\n');
            }
        }
    });
}
export function ownServer<T extends Server>(server: T) {
    const record = { server, port: null as number | null };
    active.getStore()?.servers.push(record);
    server.once('listening',()=>{
        const address=server.address();if(address&&typeof address!=='string')record.port=address.port;
    });
    const sockets = new Set<Socket>();
    server.on('connection', socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    ownCleanup(async () => {
        for (const socket of sockets) socket.destroy();
        if (server.listening) await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    });
    return server;
}
export async function listen(server: Server, port = 0, host = '127.0.0.1') {
    await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        server.once('error', failed);
        server.listen(port, host, () => { server.removeListener('error', failed); resolve(); });
    });
}
export function ownClient<T extends { close: () => Promise<void> }>(client: T) {
    const close = client.close.bind(client);
    client.close = ownCleanup(close);
    return client;
}
export function ownProcess<T extends ChildProcess>(child: T, signal: NodeJS.Signals = 'SIGTERM', group = false) {
    active.getStore()?.processes.push(child);
    ownCleanup(async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()));
        if (group) process.kill(-child.pid!, signal);
        else child.kill(signal);
        await stopped;
    });
    return child;
}
export async function runBrowser(session: string, args: string[], timeout = 20000) {
    const scope = active.getStore();
    if (!scope) throw new Error('Run browser tests inside withResources');
    let browser = scope.browsers.get(session);
    if (!browser) {
        browser = { closed: true, started: false };
        scope.browsers.set(session, browser);
        const state = browser;
        ownCleanup(async () => {
            if (!state.started) return;
            if (!state.closed) await execute('agent-browser', ['--session',session,'close'], { timeout });
            state.closed = true;
            for (let attempt = 0; attempt < 100; attempt++) {
                const sessions = await execute('agent-browser', ['session','list'], { timeout });
                if (!sessions.stdout.includes(session)) return;
                await new Promise(resolve => setTimeout(resolve,50));
            }
            throw new Error('Owned browser session did not stop');
        });
    }
    const state = browser;
    const command = async (values: string[]) => {
        if (values[0] !== 'close') { state.closed = false; state.started = true; }
        const result = await execute('agent-browser', ['--session',session,...values], { timeout });
        if (values[0] === 'close') state.closed = true;
        return result.stdout.trim();
    };
    if (args[0] === 'screenshot' && args[1] && !args[1].startsWith('-')) {
        return captureEvidence(args[1], temporary => command(['screenshot',temporary,...args.slice(2)]));
    }
    return command(args);
}
