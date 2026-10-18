import assert from 'node:assert/strict';

export const sizes: ['phone' | 'desktop', number, number][] = [['phone', 390, 844], ['phone', 375, 667], ['phone', 360, 640],
    ['phone', 320, 568], ['phone', 390, 500], ['phone', 844, 390], ['desktop', 1440, 900], ['desktop', 1280, 720],
    ['desktop', 1220, 760], ['desktop', 1024, 700], ['desktop', 900, 600]];
export const geometry = (required: string[]) => `(() => {
    const vw = innerWidth, vh = innerHeight, de = document.documentElement;
    const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const reach = e => { const r = e.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(r.height / 2, 10));
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
            inView: r.width > 0 && r.height > 0 && r.x >= -1 && r.y >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1,
            hit: !!hit && (e === hit || e.contains(hit) || hit.contains(e)) }; };
    const box = e => { if (!e) return null; const r = e.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; };
    const required = ${JSON.stringify(required)}.map(selector => { const e = document.querySelector(selector);
        return e && visible(e) ? { selector, ...reach(e) } : { selector, missing: true }; });
    const targets = [...document.querySelectorAll('.room button:not(.name-button), .room input, .room select, .room summary, .pool-row')]
        .filter(visible).map(e => ({ text: (e.getAttribute('aria-label') || e.textContent).trim().slice(0, 40),
            h: Math.round(e.getBoundingClientRect().height) })).filter(t => t.h > 0);
    const panel = [...document.querySelectorAll('.pool, .queue, .teams, .roster, .results')].filter(visible)
        .map(e => ({ panel: e.className.replace('panel ', ''), height: Math.round(e.getBoundingClientRect().height),
            scroll: e.querySelector('.scroll') ? Math.round(e.querySelector('.scroll').clientHeight) : null }));
    // Player table: text (or action button) extents of every cell on screen; cells sharing a line must not crowd.
    const pool = document.querySelector('.pool');
    const extent = cell => { const control = cell.querySelector('.queue-quick, .nominate');
        if (control) return control.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(cell);
        const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
        return rects.length ? { left: Math.min(...rects.map(r => r.left)), right: Math.max(...rects.map(r => r.right)),
            top: Math.min(...rects.map(r => r.top)), bottom: Math.max(...rects.map(r => r.bottom)) } : null; };
    const line = row => { const cells = [...row.children].filter(c => visible(c) && !c.classList.contains('sr-only'))
        .map(c => ({ text: c.textContent.trim().slice(0, 24), ink: extent(c) })).filter(c => c.ink);
        let gap = Infinity, pair = null;
        for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
            const a = cells[i].ink, b = cells[j].ink;
            if (Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) <= 0) continue;
            const d = Math.max(b.left - a.right, a.left - b.right);
            if (d < gap) { gap = d; pair = [cells[i].text, cells[j].text]; }
        }
        return { gap: Math.round(gap * 10) / 10, pair, labels: cells.map(c => c.text) }; };
    let table = null;
    if (pool && visible(pool)) {
        const scroll = pool.querySelector('.scroll'), s = scroll.getBoundingClientRect();
        const rows = [...pool.querySelectorAll('.pool-row')].filter(r => { const b = r.getBoundingClientRect();
            return visible(r) && b.top >= s.top - 1 && b.bottom <= s.bottom + 1; }).map(line);
        // Space between the bottom of the header labels (POS, AGE, ...) and the first player row.
        const head = pool.querySelector('.table-head'), first = pool.querySelector('.pool-row');
        const labels = [...head.children].filter(c => visible(c) && !c.classList.contains('sr-only')).map(extent).filter(Boolean);
        const posGap = first && labels.length ? Math.round(first.getBoundingClientRect().top - Math.max(...labels.map(r => r.bottom))) : null;
        table = { head: line(head), posGap, rows: rows.length,
            rowGap: Math.min(...rows.map(r => r.gap)), crowded: rows.filter(r => r.gap < 8),
            overflowX: scroll.scrollWidth - scroll.clientWidth };
    }
    return { viewport: [vw, vh], document: [de.scrollWidth, de.scrollHeight], body: [document.body.scrollWidth, document.body.scrollHeight],
        bodyOverflow: getComputedStyle(document.body).overflow, tab: document.querySelector('.room').dataset.tab,
        tabsShown: getComputedStyle(document.querySelector('.tabbar')).display !== 'none', required, targets, panel, table,
        thumb: { tabbar: box(document.querySelector('.tabbar')), block: box(document.querySelector('.block')),
            panel: box([...document.querySelectorAll('.pool, .queue, .roster, .results, .teams')].find(visible)),
            controls: [...document.querySelectorAll('.block .sealed-form > *, .block .opening input, .block .opening button, .block .bid-buttons > *, .block .bid-footer > button')].filter(visible)
                .map(e => ({ text: (e.getAttribute('aria-label') || e.textContent).trim(), ...box(e) })) } };
})()`;
export function assertOnePage(proof: { viewport: number[]; document: number[]; body: number[]; bodyOverflow: string;
    required: { selector: string; missing?: boolean; inView?: boolean; hit?: boolean }[];
    panel: { panel: string; scroll: number | null }[]; targets: { text: string; h: number }[] }, label: string, touch: boolean) {
    const [width, height] = proof.viewport;
    assert(proof.document[0] <= width && proof.document[1] <= height && proof.body[0] <= width && proof.body[1] <= height,
        `${label}: page overflows ${proof.document} in ${proof.viewport}`);
    assert.equal(proof.bodyOverflow, 'hidden', `${label}: body must not scroll`);
    for (const item of proof.required) assert(!item.missing && item.inView && item.hit, `${label}: ${item.selector} not reachable ${JSON.stringify(item)}`);
    for (const panel of proof.panel) assert(panel.scroll === null || panel.scroll >= 56, `${label}: ${panel.panel} scroll area ${panel.scroll}px`);
    if (touch) for (const target of proof.targets) assert(target.h >= 44, `${label}: touch target ${target.text} is ${target.h}px`);
}
