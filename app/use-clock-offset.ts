'use client';
import { useEffect, useState } from 'react';
import { useConvex } from 'convex/react';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/_generated/api';
import { ClockSamples } from '../lib/clock-samples';

type ClockStatus = 'syncing' | 'retrying' | 'synced' | 'provisional';
export function useClockOffset(connected: boolean, connectionCount: number) {
    const convex = useConvex();
    const [samples] = useState(() => new ClockSamples());
    const [offset, setOffset] = useState<number | null>(null);
    const [status, setStatus] = useState<ClockStatus>('syncing');
    useEffect(() => {
        if (!connected) return;
        let cancelled = false;
        let sampling = false;
        let synchronized = false;
        let retryDelay = 1000;
        let timer: ReturnType<typeof setTimeout>;
        const controllers = new Set<AbortController>();
        samples.reset();
        setStatus('syncing');
        async function sample() {
            if (sampling || cancelled) return;
            sampling = true;
            const request = samples.begin();
            const controller = new AbortController();
            controllers.add(controller);
            const timeout = setTimeout(() => controller.abort(), 2500);
            const http = new ConvexHttpClient(convex.url, { fetch: (input, init) =>
                fetch(input, { ...init, signal: controller.signal }) });
            try {
                const result = await http.mutation(api.auction.syncTime, {}, { skipQueue: true });
                if (cancelled) return;
                const accepted = samples.accept(request, result.serverNow);
                if (accepted !== null) {
                    synchronized = true;
                    retryDelay = 1000;
                    setOffset(accepted);
                    setStatus(samples.provisional ? 'provisional' : 'synced');
                }
            } catch {
                if (!cancelled && !synchronized) setStatus('retrying');
            } finally {
                clearTimeout(timeout);
                controllers.delete(controller);
                sampling = false;
            }
        }
        async function repeat() {
            await sample();
            if (cancelled) return;
            if (!synchronized) setStatus('retrying');
            const delay = synchronized ? 15000 : retryDelay;
            retryDelay = Math.min(15000, retryDelay * 2);
            timer = setTimeout(() => { void repeat(); }, delay);
        }
        async function initialize() {
            for (let index = 0; index < 3 && !cancelled; index++) await sample();
            if (cancelled) return;
            if (!synchronized) setStatus('retrying');
            timer = setTimeout(() => { void repeat(); }, synchronized ? 15000 : retryDelay);
        }
        void initialize();
        const focus = () => { void sample(); };
        window.addEventListener('focus', focus);
        return () => {
            cancelled = true;
            clearTimeout(timer);
            for (const controller of controllers) controller.abort();
            window.removeEventListener('focus', focus);
        };
    }, [connected, connectionCount, convex, samples]);
    return { offset, status };
}
