'use client';
import { useEffect, useState } from 'react';
import { useConvex } from 'convex/react';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/_generated/api';
import { ClockSamples } from '../lib/clock-samples';

export function useClockOffset(connected: boolean, connectionCount: number) {
    const convex = useConvex();
    const [samples] = useState(() => new ClockSamples());
    const [offset, setOffset] = useState(0);
    useEffect(() => {
        if (!connected) return;
        let cancelled = false;
        samples.reset();
        const http = new ConvexHttpClient(convex.url, { fetch: (input, init) =>
            fetch(input, { ...init, signal: AbortSignal.timeout(500) }) });
        async function sample() {
            const request = samples.begin();
            try {
                const result = await http.mutation(api.auction.syncTime, {}, { skipQueue: true });
                if (cancelled) return;
                const accepted = samples.accept(request, result.serverNow);
                if (accepted !== null) setOffset(accepted);
            } catch { return; }
        }
        async function initialize() { for (let index = 0; index < 3 && !cancelled; index++) await sample(); }
        void initialize();
        const interval = setInterval(() => { void sample(); }, 15000);
        const focus = () => { void sample(); };
        window.addEventListener('focus', focus);
        return () => {
            cancelled = true;
            clearInterval(interval);
            window.removeEventListener('focus', focus);
        };
    }, [connected, connectionCount, convex, samples]);
    return offset;
}
