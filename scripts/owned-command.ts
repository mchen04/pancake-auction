import { ChildProcess, spawn, type SpawnOptions } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { captureGroup, type OwnedGroup } from './process-group';

const groups = new WeakMap<ChildProcess, OwnedGroup>();
const commandPids = new WeakMap<ChildProcess, number>();
export function ownedProcessGroup(child: ChildProcess) { return groups.get(child); }
export function ownedCommandPid(child: ChildProcess) { return commandPids.get(child); }
export function createOwnedCommand(command: string, args: string[], options: SpawnOptions = {}) {
    const requested = typeof options.stdio === 'string' ? [options.stdio, options.stdio, options.stdio]
        : options.stdio ?? ['pipe', 'pipe', 'pipe'];
    const stdio = requested.map(value => value ?? 'pipe');
    const outer = stdio.slice(0, 3).map(value => value === 'pipe' || value === 'ignore' ? 'ignore' : value);
    const anchor = spawn(process.execPath, [fileURLToPath(new URL('./command-anchor.mjs', import.meta.url)),
        command, ...args], { ...options, detached: true, stdio: [...outer, 'ipc'] });
    const child = new ChildProcess();
    Object.defineProperty(child, 'pid', { value: anchor.pid });
    Object.assign(child, { spawnfile: command, spawnargs: [command, ...args], exitCode: null, signalCode: null });
    child.stdout = stdio[1] === 'pipe' ? new PassThrough() : null;
    child.stderr = stdio[2] === 'pipe' ? new PassThrough() : null;
    const pending: unknown[] = [];
    let ready = false;
    let exited = false;
    let closed = false;
    let completed = false;
    let releaseRequested = false;
    Object.defineProperty(child, 'connected', { get: () => stdio.includes('ipc') && anchor.connected && !exited });
    const send = (value: unknown) => {
        if (!anchor.connected) return false;
        if (!ready) { pending.push(value); return true; }
        return anchor.send(value as Parameters<ChildProcess['send']>[0]);
    };
    child.stdin = stdio[0] === 'pipe' ? new Writable({
        write(data, encoding, done) { send({ type: 'input', value: Buffer.from(data).toString('base64') }); done(); },
        final(done) { send({ type: 'input-end' }); done(); }
    }) : null;
    Object.assign(child, { stdio: [child.stdin, child.stdout, child.stderr] });
    child.send = ((value: unknown) => send({ type: 'send', value })) as ChildProcess['send'];
    child.kill = (signal: NodeJS.Signals | number = 'SIGTERM') => {
        if (exited) return false;
        Object.assign(child, { killed: true });
        return send({ type: 'kill', signal });
    };
    const exit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (exited) return;
        completed = true; exited = true; Object.assign(child, { exitCode: code, signalCode: signal });
        child.emit('exit', code, signal);
    };
    const close = (code: number | null, signal: NodeJS.Signals | null) => {
        if (closed) return;
        closed = true;
        (child.stdout as PassThrough | null)?.end(); (child.stderr as PassThrough | null)?.end();
        child.emit('close', code, signal);
    };
    const identity = captureGroup(anchor.pid!);
    identity.anchored = true;
    identity.releaseAnchor = async () => {
        if (!completed || releaseRequested || !anchor.connected) return;
        releaseRequested = true;
        await new Promise<void>((resolve, reject) => anchor.send({ type: 'release' }, error => {
            if (error) reject(error); else resolve();
        }));
    };
    groups.set(child, identity);
    anchor.on('message', (message: { type: string; fd?: number; value?: string; pid?: number;
        code: number | null; signal: NodeJS.Signals | null; message?: string }) => {
        if (message.type === 'ready') {
            ready = true;
            const commandOptions = { ...options, env: undefined, stdio: undefined, detached: false };
            anchor.send({ type: 'start', options: commandOptions,
                stdio: stdio.map((value, index) => index < 3 && value !== 'pipe' && value !== 'ignore' ? 'inherit' : value) });
            for (const value of pending.splice(0)) send(value);
        } else if (message.type === 'spawn') {
            commandPids.set(child, message.pid!); child.emit('spawn');
        } else if (message.type === 'data') {
            const output = message.fd === 1 ? child.stdout : child.stderr;
            (output as PassThrough | null)?.write(Buffer.from(message.value!, 'base64'));
        } else if (message.type === 'end') {
            ((message.fd === 1 ? child.stdout : child.stderr) as PassThrough | null)?.end();
        } else if (message.type === 'message') child.emit('message', message.value);
        else if (message.type === 'error') {
            completed = true;
            child.emit('error', Object.assign(new Error(message.message), { code: message.code }));
        }
        else if (message.type === 'exit') exit(message.code, message.signal);
        else if (message.type === 'close') close(message.code, message.signal);
    });
    anchor.on('error', error => child.emit('error', error));
    anchor.on('exit', (code, signal) => {
        if (!exited) exit(code, signal);
        close(child.exitCode, child.signalCode);
    });
    return child;
}
