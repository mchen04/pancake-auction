'use client';
import { useEffect } from 'react';
import { nextAttempt, parseAttempt, parseVersion } from '../lib/update';

const running = process.env.APP_VERSION;
const attemptKey = 'pancake-update';

// Installed iPhone apps resume the page they were showing, so a new deployment is only seen after a reload.
// When the app is opened, shown again or focused, ask the server which build is live and reload once if it
// differs. Never while someone is typing an amount or a request is in flight; offline checks change nothing.
export function AppUpdater() {
  useEffect(() => {
    if (!running) return;
    const root = document.documentElement;
    let live: string | null = null;
    let checking = false;
    let checkedAt = 0;
    const editing = () => {
      const active = document.activeElement;
      return Boolean(document.querySelector('[data-unsaved], [data-busy]'))
        || (active instanceof HTMLElement && (active.isContentEditable || active.matches('input, textarea, select')));
    };
    const apply = () => {
      if (!live || live === running || document.visibilityState !== 'visible') return;
      if (editing()) { root.dataset.update = 'deferred'; return; }
      let attempt;
      try {
        attempt = nextAttempt(live, parseAttempt(sessionStorage.getItem(attemptKey)), Date.now());
        if (attempt) sessionStorage.setItem(attemptKey, JSON.stringify(attempt));
      } catch { attempt = null; }
      if (!attempt) { root.dataset.update = 'held'; return; }
      root.dataset.update = 'reloading';
      location.reload();
    };
    const check = async () => {
      if (checking || document.visibilityState !== 'visible' || Date.now() - checkedAt < 3000) return;
      checking = true;
      checkedAt = Date.now();
      try {
        const response = await fetch(`/version.json?t=${checkedAt}`, { cache: 'no-store' });
        const version = response.ok ? parseVersion(await response.json()) : null;
        if (!version) throw new Error(`Version check returned ${response.status}`);
        live = version;
        root.dataset.update = live === running ? 'current' : 'available';
        apply();
      } catch {
        root.dataset.update = 'unreachable';
      } finally {
        checking = false;
      }
    };
    const shown = () => { if (document.visibilityState === 'visible') void check(); };
    const settled = () => setTimeout(apply, 250);
    const triggers: [EventTarget, string, () => void][] = [[document, 'visibilitychange', shown], [window, 'focus', shown],
      [window, 'pageshow', shown], [window, 'online', shown], [document, 'focusout', settled]];
    for (const [target, type, listener] of triggers) target.addEventListener(type, listener);
    void check();
    return () => { for (const [target, type, listener] of triggers) target.removeEventListener(type, listener); };
  }, []);
  return null;
}
