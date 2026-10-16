import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConvexError } from 'convex/values';
import { retryAbortedMutation } from '../lib/mutation-retry';

afterEach(() => vi.useRealTimers());
describe('HTTP aborted mutation retries', () => {
    it('retries only explicit aborted transaction conflicts and returns the committed result', async () => {
        vi.useFakeTimers();
        const conflict = new Error(JSON.stringify({ code: 'OptimisticConcurrencyControlFailure', message: 'aborted' }));
        const operation = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValue('committed');
        const result = retryAbortedMutation(operation);
        const assertion = expect(result).resolves.toBe('committed');
        await vi.runAllTimersAsync();
        await assertion;
        expect(operation).toHaveBeenCalledTimes(2);
    });
    it('does not retry rule rejections, unknown failures, or a similar error message', async () => {
        for (const failure of [new Error('Network failed'), new Error('OptimisticConcurrencyControlFailure'),
            new Error('{"code":"DifferentError"}'), new ConvexError({ code: 'Unauthorized' })]) {
            const operation = vi.fn().mockRejectedValue(failure);
            await expect(retryAbortedMutation(operation)).rejects.toBe(failure);
            expect(operation).toHaveBeenCalledTimes(1);
        }
        const operation = vi.fn().mockResolvedValue({ ok: false, status: 409 });
        await expect(retryAbortedMutation(operation)).resolves.toEqual({ ok: false, status: 409 });
        expect(operation).toHaveBeenCalledTimes(1);
    });
    it('does not turn a WebSocket-shaped message into an HTTP retry', async () => {
        vi.useFakeTimers();
        const payload = JSON.stringify({ code: 'OptimisticConcurrencyControlFailure', message: 'aborted' });
        const conflict = new Error(`[CONVEX M(auction:actOnDraft)] ${payload}\n  Called by client`);
        const operation = vi.fn().mockRejectedValue(conflict);
        const result = retryAbortedMutation(operation).catch(error => error);
        await vi.runAllTimersAsync();
        expect(await result).toBe(conflict);
        expect(operation).toHaveBeenCalledTimes(1);
    });
    it('exposes the original conflict after four attempts', async () => {
        vi.useFakeTimers();
        const conflict = new ConvexError({ code: 'OptimisticConcurrencyControlFailure' });
        const operation = vi.fn().mockRejectedValue(conflict);
        const assertion = expect(retryAbortedMutation(operation)).rejects.toBe(conflict);
        await vi.runAllTimersAsync();
        await assertion;
        expect(operation).toHaveBeenCalledTimes(4);
    });
});
