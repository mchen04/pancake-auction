'use client';
import { useEffect, useState } from 'react';
import { useConvex } from 'convex/react';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/_generated/api';
import { ClockSamples, type ClockSample } from '../lib/clock-samples';

type ClockStatus = 'syncing' | 'retrying' | 'synced' | 'provisional';
type ClockState = { sample: ClockSample | null; status: ClockStatus };
export function useClockOffset(connected: boolean, connectionCount: number) {
    const convex = useConvex();
    const [samples] = useState(() => new ClockSamples());
    const [clock, setClock] = useState<ClockState>({ sample: null, status: 'syncing' });
    useEffect(() => {
        if (!connected) return;
        let cancelled = false;
        let synchronized = samples.hasSample;
        let pendingSamples = 0;
        let sampling = false;
        let retryDelay = 1000;
        let timer: ReturnType<typeof setTimeout>;
        const controllers = new Set<AbortController>();
        async function sample() {
            if (cancelled) return;
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
                    setClock({ sample: accepted, status: samples.provisional ? 'provisional' : 'synced' });
                }
            } catch {
                if (!cancelled && !synchronized) setClock(previous => ({ ...previous, status: 'retrying' }));
            } finally {
                clearTimeout(timeout);
                controllers.delete(controller);
            }
        }
        function schedule() {
            if (cancelled) return;
            if (!synchronized) setClock(previous => ({ ...previous, status: 'retrying' }));
            const delay = synchronized ? 15000 : retryDelay;
            retryDelay = Math.min(15000, retryDelay * 2);
            timer = setTimeout(() => refresh(), delay);
        }
        async function drain() {
            sampling = true;
            try {
                while (pendingSamples > 0 && !cancelled) {
                    pendingSamples--;
                    await sample();
                }
            } finally {
                sampling = false;
                schedule();
            }
        }
        function refresh(count = 1) {
            if (cancelled) return;
            clearTimeout(timer);
            pendingSamples = Math.max(pendingSamples, count);
            if (!sampling) void drain();
        }
        const wake = () => refresh();
        const visible = () => { if (document.visibilityState === 'visible') wake(); };
        let previousWall = Date.now(), previousMonotonic = performance.now();
        const heartbeat = setInterval(() => {
            const wall = Date.now(), monotonic = performance.now();
            if (Math.abs(wall - previousWall - monotonic + previousMonotonic) > 1000) refresh();
            previousWall = wall;
            previousMonotonic = monotonic;
        }, 1000);
        samples.reset(true);
        refresh(3);
        window.addEventListener('focus', wake);
        window.addEventListener('pageshow', wake);
        document.addEventListener('visibilitychange', visible);
        document.addEventListener('resume', wake);
        return () => {
            cancelled = true;
            clearInterval(heartbeat);
            clearTimeout(timer);
            for (const controller of controllers) controller.abort();
            window.removeEventListener('focus', wake);
            window.removeEventListener('pageshow', wake);
            document.removeEventListener('visibilitychange', visible);
            document.removeEventListener('resume', wake);
        };
    }, [connected, connectionCount, convex, samples]);
    return clock;
}
