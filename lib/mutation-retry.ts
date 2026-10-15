import { ConvexError } from 'convex/values';

function abortedConflict(error: unknown) {
    if (!(error instanceof Error)) return false;
    let data: unknown = error instanceof ConvexError ? error.data : undefined;
    if (data === undefined) {
        try { data = JSON.parse(error.message); } catch { return false; }
    }
    return typeof data === 'object' && data !== null && 'code' in data
        && data.code === 'OptimisticConcurrencyControlFailure';
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
