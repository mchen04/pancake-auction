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
        let generation = 0;
        let synchronized = false;
        let retryDelay = 1000;
        let timer: ReturnType<typeof setTimeout>;
        const controllers = new Set<AbortController>();
        const current = (epoch: number) => !cancelled && epoch === generation;
        async function sample(epoch: number) {
            if (!current(epoch)) return;
            const request = samples.begin();
            const controller = new AbortController();
            controllers.add(controller);
            const timeout = setTimeout(() => controller.abort(), 2500);
            const http = new ConvexHttpClient(convex.url, { fetch: (input, init) =>
                fetch(input, { ...init, signal: controller.signal }) });
            try {
                const result = await http.mutation(api.auction.syncTime, {}, { skipQueue: true });
                if (!current(epoch)) return;
                const accepted = samples.accept(request, result.serverNow);
                if (accepted !== null) {
                    synchronized = true;
                    retryDelay = 1000;
                    setClock({ sample: accepted, status: samples.provisional ? 'provisional' : 'synced' });
                }
            } catch {
                if (current(epoch) && !synchronized) setClock(previous => ({ ...previous, status: 'retrying' }));
            } finally {
                clearTimeout(timeout);
                controllers.delete(controller);
            }
        }
        function schedule(epoch: number) {
            if (!current(epoch)) return;
            if (!synchronized) setClock(previous => ({ ...previous, status: 'retrying' }));
            const delay = synchronized ? 15000 : retryDelay;
            retryDelay = Math.min(15000, retryDelay * 2);
            timer = setTimeout(() => { void repeat(epoch); }, delay);
        }
        async function repeat(epoch: number) {
            await sample(epoch);
            schedule(epoch);
        }
        async function initialize(epoch: number) {
            for (let index = 0; index < 3 && current(epoch); index++) await sample(epoch);
            schedule(epoch);
        }
        function refresh(clearAnchor = true) {
            if (cancelled) return;
            const epoch = ++generation;
            clearTimeout(timer);
            for (const controller of controllers) controller.abort();
            samples.reset();
            synchronized = false;
            retryDelay = 1000;
            setClock(previous => ({ sample: clearAnchor ? null : previous.sample, status: 'syncing' }));
            void initialize(epoch);
        }
        const wake = () => refresh();
        const visible = () => { if (document.visibilityState === 'visible') wake(); };
        let previousWall = Date.now(), previousMonotonic = performance.now();
        const heartbeat = setInterval(() => {
            const wall = Date.now(), monotonic = performance.now();
            if (Math.abs(wall - previousWall - monotonic + previousMonotonic) > 1000) refresh(false);
            previousWall = wall;
            previousMonotonic = monotonic;
        }, 1000);
        refresh();
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
