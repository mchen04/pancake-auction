export function safeError(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown error';
}
