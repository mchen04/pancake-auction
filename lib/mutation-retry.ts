import { ConvexError } from 'convex/values';

function abortedConflict(error: unknown) {
    if (!(error instanceof Error)) return false;
    let data: unknown = error instanceof ConvexError ? error.data : undefined;
    if (data === undefined) {
        const wrapped = /^\[CONVEX M\([^\r\n)]+\)\] ([\s\S]*)\n  Called by client$/.exec(error.message);
        try { data = JSON.parse(wrapped ? wrapped[1] : error.message); } catch { return false; }
    }
    return typeof data === 'object' && data !== null && 'code' in data
        && data.code === 'OptimisticConcurrencyControlFailure';
}
export function mutationErrorMessage(error: unknown) {
    if (abortedConflict(error)) return "Your bid didn't go through. Try again.";
    return error instanceof Error ? error.message : 'Request failed';
}
export async function retryAbortedMutation<T>(operation: () => Promise<T>, onRetry?: () => void): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try { return await operation(); }
        catch (error) {
            if (attempt === 3 || !abortedConflict(error)) throw error;
            onRetry?.();
            const delay = 50 * 2 ** attempt + Math.random() * 50;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}
