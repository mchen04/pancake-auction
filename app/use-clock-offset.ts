'use client';
import { useEffect, useRef, useState } from 'react';
import { useConvex } from 'convex/react';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/_generated/api';
import { ClockSamples, type ClockSample } from '../lib/clock-samples';

type ClockStatus = 'syncing' | 'retrying' | 'synced' | 'provisional';
type ClockState = { sample: ClockSample | null; status: ClockStatus };
export function useClockOffset(connected: boolean, connectionCount: number, enabled = true) {
    const convex = useConvex();
    const [samples] = useState(() => new ClockSamples());
    const continuity = useRef<{ wall: number; monotonic: number } | null>(null);
    const [clock, setClock] = useState<ClockState>({ sample: null, status: 'syncing' });
    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        let synchronized = samples.hasSample;
        let pendingSamples = 0;
        let sampling = false;
        let retryDelay = 250;
        let timer: ReturnType<typeof setTimeout>;
        const controllers = new Set<AbortController>();
        const baseline = continuity.current ?? { wall: Date.now(), monotonic: performance.now() };
        continuity.current = baseline;
        async function sample() {
            if (cancelled || !connected) return;
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
                    retryDelay = 250;
                    baseline.wall = Date.now();
                    baseline.monotonic = performance.now();
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
            retryDelay = Math.min(2000, retryDelay * 2);
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
            if (cancelled || !connected) return;
            clearTimeout(timer);
            pendingSamples = Math.max(pendingSamples, count);
            if (!sampling) void drain();
        }
        function checkContinuity() {
            const wall = Date.now(), monotonic = performance.now();
            const divergence = wall - baseline.wall - monotonic + baseline.monotonic;
            if (divergence > 1000) {
                baseline.wall = wall;
                baseline.monotonic = monotonic;
                samples.reset();
                synchronized = false;
                retryDelay = 250;
                setClock({ sample: null, status: 'retrying' });
                for (const controller of controllers) controller.abort();
                return 2;
            }
            if (divergence < -1000) {
                baseline.wall = wall;
                baseline.monotonic = monotonic;
            }
            return 0;
        }
        const wake = () => refresh(checkContinuity() || 1);
        const visible = () => { if (document.visibilityState === 'visible') wake(); };
        const heartbeat = setInterval(() => {
            const count = checkContinuity();
            if (count) refresh(count);
        }, 1000);
        if (connected) samples.reset(true);
        checkContinuity();
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
    }, [connected, connectionCount, convex, samples, enabled]);
    return clock;
}
