import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConvexError } from 'convex/values';
import { mutationErrorMessage, retryAbortedMutation } from '../lib/mutation-retry';

afterEach(() => vi.useRealTimers());
describe('Aborted mutation retries', () => {
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
    it('retries the WebSocket mutation wrapper only when its complete payload is an OCC error', async () => {
        vi.useFakeTimers();
        const payload = JSON.stringify({ code: 'OptimisticConcurrencyControlFailure', message: 'aborted' });
        const conflict = new Error(`[CONVEX M(auction:actOnDraft)] ${payload}\n  Called by client`);
        const operation = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValue('committed');
        const assertion = expect(retryAbortedMutation(operation)).resolves.toBe('committed');
        await vi.runAllTimersAsync();
        await assertion;
        expect(operation).toHaveBeenCalledTimes(2);
    });
    it('preserves unrelated WebSocket errors and rejects partial or different function wrappers', async () => {
        const payload = '{"code":"OptimisticConcurrencyControlFailure"}';
        for (const message of [
            '[CONVEX M(auction:actOnDraft)] Draft is paused\n  Called by client',
            `[CONVEX Q(auction:state)] ${payload}\n  Called by client`,
            `[CONVEX M(auction:actOnDraft)] Server Error: ${payload}\n  Called by client`,
            `[CONVEX M(auction:actOnDraft)] ${payload} trailing\n  Called by client`,
            `[CONVEX M(auction:actOnDraft)] ${payload}`
        ]) {
            const failure = new Error(message);
            const operation = vi.fn().mockRejectedValue(failure);
            await expect(retryAbortedMutation(operation)).rejects.toBe(failure);
            expect(operation).toHaveBeenCalledTimes(1);
        }
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
    it('shows a plain exhausted-conflict message and preserves rule and unknown errors', async () => {
        vi.useFakeTimers();
        const conflict = new Error('[CONVEX M(auction:actOnDraft)] '
            + '{"code":"OptimisticConcurrencyControlFailure"}\n  Called by client');
        const operation = vi.fn().mockRejectedValue(conflict);
        const result = retryAbortedMutation(operation).catch(mutationErrorMessage);
        await vi.runAllTimersAsync();
        expect(await result).toBe("Your bid didn't go through. Try again.");
        expect(operation).toHaveBeenCalledTimes(4);
        expect(mutationErrorMessage(new Error('Draft is paused'))).toBe('Draft is paused');
        expect(mutationErrorMessage(new Error('Unknown failure'))).toBe('Unknown failure');
    });
});
