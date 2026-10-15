import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireClosedPort } from '../scripts/local-backend';

const transport = vi.hoisted(() => ({ outcomes: [] as string[], calls: 0 }));
vi.mock('node:net', () => ({
    createServer: vi.fn(),
    createConnection: () => {
        transport.calls++;
        const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn() });
        queueMicrotask(() => {
            const outcome = transport.outcomes.shift() ?? 'connect';
            if (outcome === 'connect') socket.emit('connect');
            else socket.emit('error', Object.assign(new Error(outcome), { code: outcome }));
        });
        return socket;
    }
}));
afterEach(() => { vi.useRealTimers(); transport.calls = 0; transport.outcomes = []; });
describe('Port closure proof', () => {
    it('waits through resets and transient errors until a refused connection', async () => {
        vi.useFakeTimers();
        transport.outcomes = ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'connect', 'ECONNREFUSED'];
        const result = requireClosedPort(43001);
        const assertion = expect(result).resolves.toBeUndefined();
        await vi.runAllTimersAsync();
        await assertion;
        expect(transport.calls).toBe(6);
    });
    it('never treats a live listener as closed and stops within the timeout', async () => {
        vi.useFakeTimers();
        const assertion = expect(requireClosedPort(43001)).rejects.toThrow('did not stop');
        await vi.runAllTimersAsync();
        await assertion;
        expect(transport.calls).toBeGreaterThan(1);
    });
});
