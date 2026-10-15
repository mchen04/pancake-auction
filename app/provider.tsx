'use client';
import { ConvexProvider, ConvexReactClient } from 'convex/react';
import { useState, type ReactNode } from 'react';

export function AuctionProvider({ url, children }: { url?: string; children: ReactNode }) {
    const [client] = useState(() => url ? new ConvexReactClient(url) : null);
    if (!client) return <main className="gate"><h1 className="wordmark">Pancake Auction</h1>
        <p>The draft room is not configured.</p></main>;
    return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
