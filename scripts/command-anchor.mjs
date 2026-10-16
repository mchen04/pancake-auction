import { spawn, execFileSync } from 'node:child_process';

if (!process.send || Number(execFileSync('ps', ['-p', String(process.pid), '-o', 'pgid='])) !== process.pid) {
    process.exit(1);
}
let command;
let started = false;
let finished = false;
let released = false;
const keepAlive = setInterval(() => {}, 1000);
const startup = setTimeout(() => process.exit(1), 10000);
const send = value => { if (process.connected) process.send(value, () => {}); };
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
process.on('disconnect', () => {
    if (released) return;
    process.kill(-process.pid, 'SIGTERM');
    setTimeout(() => process.kill(-process.pid, 'SIGKILL'), 2000);
});
process.on('message', message => {
    if (message.type === 'start' && !started) {
        started = true;
        clearTimeout(startup);
        command = spawn(process.argv[2], process.argv.slice(3), { ...message.options, stdio: message.stdio });
        command.on('spawn', () => send({ type: 'spawn', pid: command.pid }));
        for (const [fd, stream] of [[1, command.stdout], [2, command.stderr]]) {
            stream?.on('data', data => send({ type: 'data', fd, value: data.toString('base64') }));
            stream?.on('end', () => send({ type: 'end', fd }));
        }
        command.on('message', value => send({ type: 'message', value }));
        command.on('error', error => {
            finished = true;
            send({ type: 'error', message: error.message, code: error.code });
        });
        command.on('exit', (code, signal) => {
            finished = true;
            send({ type: 'exit', code, signal });
        });
        command.on('close', (code, signal) => send({ type: 'close', code, signal }));
    } else if (message.type === 'send') command?.send?.(message.value);
    else if (message.type === 'kill') command?.kill(message.signal);
    else if (message.type === 'input') command?.stdin?.write(Buffer.from(message.value, 'base64'));
    else if (message.type === 'input-end') command?.stdin?.end();
    else if (message.type === 'release' && finished) {
        released = true;
        clearInterval(keepAlive);
        process.send({ type: 'released' }, () => process.exit(0));
    }
});
send({ type: 'ready' });
