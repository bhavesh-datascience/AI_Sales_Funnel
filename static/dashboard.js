// Dashboard & Analytics: live numbers from /api/stats (the server's activity log), refreshed automatically.
document.addEventListener('DOMContentLoaded', () => {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const REFRESH_MS = 30000;

    let days = 30;
    let stats = null;
    let loading = false;

    // ---------- formatting ----------
    const fmt = n => {
        const v = Number(n) || 0;
        if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
        if (Math.abs(v) >= 1e4) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
        return v.toLocaleString();
    };
    const pct = (part, whole) => whole ? `${Math.round((part / whole) * 100)}%` : '0%';
    const dayLabel = iso => new Date(`${iso}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
    const when = iso => {
        if (!iso) return '';
        const d = new Date(iso);
        const today = new Date();
        return d.toDateString() === today.toDateString()
            ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
            : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    };
    const ago = iso => {
        if (!iso) return 'never';
        const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
        if (s < 60) return 'just now';
        if (s < 3600) return `${Math.round(s / 60)} min ago`;
        if (s < 86400) return `${Math.round(s / 3600)} h ago`;
        return `${Math.round(s / 86400)} d ago`;
    };
    const cssVar = (el, name) => getComputedStyle(el).getPropertyValue(name).trim();

    function el(tag, attrs = {}, text) {
        const node = tag.startsWith('svg:') ? document.createElementNS(SVG_NS, tag.slice(4)) : document.createElement(tag);
        Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
        if (text != null) node.textContent = text;
        return node;
    }

    function niceMax(max, ticks = 4) {
        if (max <= 0) return { top: ticks, step: 1 };
        const raw = max / ticks;
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= raw);
        const finalStep = Math.max(1, step);
        return { top: Math.ceil(max / finalStep) * finalStep, step: finalStep };
    }

    function emptyState(container, message) {
        container.replaceChildren(el('div', { class: 'viz-empty' }, message));
    }

    // ---------- tooltip (values lead, labels follow; text only via textContent) ----------
    const tooltip = el('div', { class: 'viz-tooltip', role: 'status' });
    document.body.appendChild(tooltip);

    function showTooltip(event, title, rows) {
        tooltip.replaceChildren(el('div', { class: 'tt-title' }, title));
        rows.forEach(r => {
            const row = el('div', { class: 'tt-row' });
            if (r.color) {
                const key = el('i', { class: r.line ? 'key key-line' : 'key key-rect' });
                key.style.background = r.color;
                row.appendChild(key);
            }
            row.append(el('b', {}, r.value), el('span', {}, r.label));
            tooltip.appendChild(row);
        });
        tooltip.style.display = 'block';
        const pad = 14;
        const { width, height } = tooltip.getBoundingClientRect();
        let x = event.clientX + pad;
        let y = event.clientY + pad;
        if (x + width > window.innerWidth - 8) x = event.clientX - width - pad;
        if (y + height > window.innerHeight - 8) y = event.clientY - height - pad;
        tooltip.style.left = `${x}px`;
        tooltip.style.top = `${y}px`;
    }
    const hideTooltip = () => { tooltip.style.display = 'none'; };

    // A plain table of the same data, for the "Table" toggle and accessibility
    function dataTable(headers, rows) {
        const wrap = el('div', { class: 'data-table' });
        const table = el('table', { class: 'bulk-table num-table' });
        const head = table.createTHead().insertRow();
        headers.forEach((h, i) => head.appendChild(el('th', i ? { class: 'num' } : {}, h)));
        const body = table.createTBody();
        rows.forEach(r => {
            const tr = body.insertRow();
            r.forEach((v, i) => {
                const td = tr.insertCell();
                td.textContent = v;
                if (i) td.className = 'num';
            });
        });
        wrap.appendChild(table);
        return wrap;
    }

    // Shared axes for the time charts
    function timeFrame(svg, width, height, margin, top, step, data) {
        const plotH = height - margin.top - margin.bottom;
        for (let v = 0; v <= top; v += step) {
            const y = margin.top + plotH - (v / top) * plotH;
            svg.appendChild(el('svg:line', { x1: margin.left, x2: width - margin.right, y1: y, y2: y, class: v === 0 ? 'baseline' : 'grid-line' }));
            svg.appendChild(el('svg:text', { x: margin.left - 8, y: y + 4, 'text-anchor': 'end' }, fmt(v)));
        }
        // ~6 evenly spaced date labels
        const plotW = width - margin.left - margin.right;
        const band = plotW / data.length;
        const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(plotW / 70))));
        data.forEach((d, i) => {
            if (i % every === 0 || i === data.length - 1) {
                if (i === data.length - 1 && i % every !== 0 && i % every < every / 2) return; // avoid crowding the last label
                svg.appendChild(el('svg:text', { x: margin.left + band * i + band / 2, y: height - 6, 'text-anchor': 'middle' }, dayLabel(d.date)));
            }
        });
        return { plotH, plotW, band };
    }

    // ---------- stacked columns: sent + failed per day ----------
    function columnChart(container, data, series) {
        const total = d => series.reduce((s, x) => s + d[x.key], 0);
        if (!data.length || data.every(d => total(d) === 0)) {
            emptyState(container, 'No emails sent in this period yet.');
            return;
        }
        const width = Math.max(container.clientWidth, 320);
        const height = 240;
        const margin = { top: 12, right: 8, bottom: 26, left: 36 };
        const { top, step } = niceMax(Math.max(...data.map(total)));
        const svg = el('svg:svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': 'Emails per day' });
        const { plotH, band } = timeFrame(svg, width, height, margin, top, step, data);
        const colW = Math.min(24, Math.max(3, band * 0.6));

        data.forEach((d, i) => {
            const x = margin.left + band * i + (band - colW) / 2;
            const group = el('svg:g', { class: 'col-group' });
            let y = margin.top + plotH;
            const visible = series.filter(s => d[s.key] > 0);
            visible.forEach((s, si) => {
                const h = (d[s.key] / top) * plotH;
                const isTop = si === visible.length - 1;
                const gap = si > 0 ? 2 : 0; // 2px surface gap between stacked segments
                const segH = Math.max(1, h - gap);
                const segY = y - h;
                const r = isTop ? Math.min(4, segH, colW / 2) : 0; // rounded data-end, square at the baseline
                const path = `M${x},${segY + segH} V${segY + r} Q${x},${segY} ${x + r},${segY} H${x + colW - r} Q${x + colW},${segY} ${x + colW},${segY + r} V${segY + segH} Z`;
                group.appendChild(el('svg:path', { d: path, fill: `var(${s.color})` }));
                y -= h;
            });
            svg.appendChild(group);

            // The whole day's band is the hover target, bigger than the mark
            const hit = el('svg:rect', { x: margin.left + band * i, y: margin.top, width: band, height: plotH, class: 'hit', tabindex: 0 });
            const show = e => {
                group.classList.add('hover');
                const rect = hit.getBoundingClientRect();
                const pos = e.clientX ? e : { clientX: rect.left + rect.width / 2, clientY: rect.top + 20 };
                showTooltip(pos, dayLabel(d.date), series.map(s => ({ value: fmt(d[s.key]), label: s.label, color: cssVar(container, s.color) })));
            };
            const hide = () => { group.classList.remove('hover'); hideTooltip(); };
            hit.addEventListener('pointermove', show);
            hit.addEventListener('focus', show);
            hit.addEventListener('pointerleave', hide);
            hit.addEventListener('blur', hide);
            svg.insertBefore(hit, group);
        });

        container.replaceChildren(svg, dataTable(['Date', ...series.map(s => s.label)], data.map(d => [dayLabel(d.date), ...series.map(s => fmt(d[s.key]))])));
    }

    // ---------- multi-line with crosshair: sent vs replies ----------
    function lineChart(container, data, series) {
        if (!data.length || data.every(d => series.every(s => d[s.key] === 0))) {
            emptyState(container, 'Nothing sent or received in this period yet.');
            return;
        }
        const width = Math.max(container.clientWidth, 320);
        const height = 260;
        const margin = { top: 14, right: 70, bottom: 26, left: 36 };
        const { top, step } = niceMax(Math.max(...data.flatMap(d => series.map(s => d[s.key]))));
        const svg = el('svg:svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': 'Emails sent and replies received per day' });
        const { plotH, band } = timeFrame(svg, width, height, margin, top, step, data);
        const xAt = i => margin.left + band * i + band / 2;
        const yAt = v => margin.top + plotH - (v / top) * plotH;
        const surface = cssVar(container, '--bg-card');

        const endYs = [];
        series.forEach(s => {
            const points = data.map((d, i) => `${xAt(i)},${yAt(d[s.key])}`).join(' ');
            svg.appendChild(el('svg:polyline', { points, fill: 'none', stroke: `var(${s.color})`, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
            const last = data[data.length - 1];
            // End marker: r4 dot with a 2px surface ring
            svg.appendChild(el('svg:circle', { cx: xAt(data.length - 1), cy: yAt(last[s.key]), r: 4, fill: `var(${s.color})`, stroke: surface, 'stroke-width': 2 }));
            endYs.push({ s, y: yAt(last[s.key]), value: last[s.key] });
        });
        // Direct end labels only when they don't collide (the legend always carries identity)
        const collide = endYs.length > 1 && Math.abs(endYs[0].y - endYs[1].y) < 16;
        if (!collide) {
            endYs.forEach(({ s, y, value }) => svg.appendChild(el('svg:text', { x: xAt(data.length - 1) + 10, y: y + 4, class: 'end-label' }, `${fmt(value)} ${s.label.toLowerCase()}`)));
        }

        // Crosshair snaps to the nearest day; one tooltip lists every series
        const cross = el('svg:line', { y1: margin.top, y2: margin.top + plotH, class: 'crosshair', visibility: 'hidden' });
        const dots = series.map(s => el('svg:circle', { r: 4, fill: `var(${s.color})`, stroke: surface, 'stroke-width': 2, visibility: 'hidden', 'pointer-events': 'none' }));
        svg.append(cross, ...dots);
        const overlay = el('svg:rect', { x: margin.left, y: margin.top, width: width - margin.left - margin.right, height: plotH, class: 'hit' });
        overlay.addEventListener('pointermove', e => {
            const box = svg.getBoundingClientRect();
            const scale = width / box.width;
            const i = Math.min(data.length - 1, Math.max(0, Math.floor(((e.clientX - box.left) * scale - margin.left) / band)));
            const d = data[i];
            cross.setAttribute('x1', xAt(i));
            cross.setAttribute('x2', xAt(i));
            cross.setAttribute('visibility', 'visible');
            series.forEach((s, si) => {
                dots[si].setAttribute('cx', xAt(i));
                dots[si].setAttribute('cy', yAt(d[s.key]));
                dots[si].setAttribute('visibility', 'visible');
            });
            showTooltip(e, dayLabel(d.date), series.map(s => ({ value: fmt(d[s.key]), label: s.label, color: cssVar(container, s.color), line: true })));
        });
        overlay.addEventListener('pointerleave', () => {
            cross.setAttribute('visibility', 'hidden');
            dots.forEach(d => d.setAttribute('visibility', 'hidden'));
            hideTooltip();
        });
        svg.appendChild(overlay);

        container.replaceChildren(svg, dataTable(['Date', ...series.map(s => s.label)], data.map(d => [dayLabel(d.date), ...series.map(s => fmt(d[s.key]))])));
    }

    // ---------- horizontal bars (single series): funnel, reasons ----------
    function hBars(container, items, { emptyMessage, share } = {}) {
        if (!items.length || items.every(i => !i.value)) {
            emptyState(container, emptyMessage || 'No data yet.');
            return;
        }
        const max = Math.max(...items.map(i => i.value));
        const wrap = el('div', { class: 'hbars' });
        items.forEach(item => {
            const row = el('div', { class: 'hbar-row', tabindex: 0 });
            const label = el('span', { class: 'hbar-label', title: item.label }, item.label);
            const track = el('div', { class: 'hbar-track' });
            const bar = el('div', { class: 'hbar' });
            bar.style.width = `calc((100% - 70px) * ${max ? item.value / max : 0})`;
            const value = el('span', { class: 'hbar-value' }, fmt(item.value));
            if (share) value.appendChild(el('small', {}, share(item)));
            track.append(bar, value);
            row.append(label, track);
            const show = e => {
                const rect = row.getBoundingClientRect();
                const pos = e.clientX ? e : { clientX: rect.left + rect.width / 2, clientY: rect.top };
                showTooltip(pos, item.label, [{ value: fmt(item.value), label: share ? share(item) : '' }]);
            };
            row.addEventListener('pointermove', show);
            row.addEventListener('focus', show);
            row.addEventListener('pointerleave', hideTooltip);
            row.addEventListener('blur', hideTooltip);
            wrap.appendChild(row);
        });
        container.replaceChildren(wrap);
    }

    // ---------- part-to-whole: sent by channel ----------
    function stackBar(container, parts) {
        const total = parts.reduce((s, p) => s + p.value, 0);
        if (!total) {
            emptyState(container, 'No emails sent in this period yet.');
            return;
        }
        const colors = ['--viz-1', '--viz-2', '--viz-3'];
        const bar = el('div', { class: 'stack-bar', role: 'img', 'aria-label': 'Emails sent by channel' });
        const legend = el('div', { class: 'stack-legend' });
        parts.forEach((p, i) => {
            const seg = el('div', { class: 'stack-seg', tabindex: 0 });
            seg.style.flex = `${p.value} 0 0`;
            seg.style.background = `var(${colors[i]})`;
            const show = e => {
                const rect = seg.getBoundingClientRect();
                const pos = e.clientX ? e : { clientX: rect.left + rect.width / 2, clientY: rect.top };
                showTooltip(pos, p.channel, [{ value: fmt(p.value), label: pct(p.value, total), color: cssVar(container, colors[i]) }]);
            };
            seg.addEventListener('pointermove', show);
            seg.addEventListener('focus', show);
            seg.addEventListener('pointerleave', hideTooltip);
            seg.addEventListener('blur', hideTooltip);
            bar.appendChild(seg);

            const row = el('div');
            const key = el('i', { class: 'key key-rect' });
            key.style.background = `var(${colors[i]})`;
            row.append(key, el('span', {}, p.channel), el('b', {}, fmt(p.value)), el('small', {}, pct(p.value, total)));
            legend.appendChild(row);
        });
        container.replaceChildren(bar, legend);
    }

    // ---------- rendering ----------
    const setStat = (name, text) => document.querySelectorAll(`[data-stat="${name}"]`).forEach(n => { n.textContent = text; });

    function pill(type) {
        const labels = { sent: 'Sent', failed: 'Failed', skipped: 'Skipped', declined: 'Declined', approved: 'Approved' };
        return el('span', { class: `status-pill ${{ sent: 'sent', failed: 'failed', skipped: 'skipped', declined: 'declined', approved: 'approved' }[type] || 'not-sent'}` }, labels[type] || type);
    }

    function render() {
        if (!stats) return;
        const t = stats.totals;

        // Tiles
        setStat('sent', fmt(t.sent));
        setStat('sent-sub', `to ${fmt(t.unique_recipients)} ${t.unique_recipients === 1 ? 'person' : 'people'}`);
        setStat('reply-rate', `${t.reply_rate}%`);
        setStat('reply-sub', `${fmt(t.replied)} of ${fmt(t.unique_recipients)} replied`);
        setStat('today', `${fmt(stats.today.sent)} / ${fmt(stats.today.daily_limit)}`);
        const used = stats.today.daily_limit ? stats.today.sent / stats.today.daily_limit : 0;
        document.querySelectorAll('[data-stat="today-meter"]').forEach(m => {
            m.style.width = `${Math.min(100, used * 100)}%`;
            m.className = 'meter-fill' + (used >= 0.9 ? ' danger' : used >= 0.7 ? ' warn' : '');
            m.parentElement.setAttribute('aria-valuenow', Math.round(used * 100));
        });
        setStat('today-sub', `${fmt(Math.max(0, stats.today.daily_limit - stats.today.sent))} left today`);
        setStat('failed', fmt(t.failed));
        setStat('failed-sub', t.sent + t.failed ? `${pct(t.failed, t.sent + t.failed)} of send attempts` : 'No send attempts yet');
        setStat('drafted', fmt(t.drafted));
        setStat('drafted-sub', `${fmt(t.regenerated)} regenerated`);
        setStat('recipients', fmt(t.unique_recipients));
        setStat('replied', fmt(t.replied));
        setStat('replied-sub', `${t.reply_rate}% reply rate`);
        setStat('skipped', fmt(t.skipped));
        setStat('declined', fmt(t.declined));
        setStat('replies-sent', fmt(t.replies_sent));

        // Charts
        columnChart(document.getElementById('chartDaily'), stats.daily, [
            { key: 'sent', label: 'Sent', color: '--viz-1' },
            { key: 'failed', label: 'Failed', color: '--viz-critical' },
        ]);
        const drafted = stats.funnel[0].value;
        hBars(document.getElementById('chartFunnel'), stats.funnel.map(f => ({ label: f.stage, value: f.value })), {
            emptyMessage: 'Generate drafts in Email Sending to see the funnel.',
            share: item => item.label === 'Drafted' ? '' : pct(item.value, drafted),
        });
        stackBar(document.getElementById('chartChannels'), stats.channels);
        lineChart(document.getElementById('chartTrend'), stats.daily, [
            { key: 'sent', label: 'Sent', color: '--viz-1' },
            { key: 'replies', label: 'Replies', color: '--viz-2' },
        ]);
        hBars(document.getElementById('chartReasons'), stats.reasons.map(r => ({ label: r.reason, value: r.count })), {
            emptyMessage: 'Every email went out. Nothing failed or was skipped.',
        });

        // Recent activity
        const recent = document.getElementById('recentBody');
        recent.replaceChildren();
        if (!stats.recent.length) {
            const td = recent.insertRow().insertCell();
            td.colSpan = 5;
            td.className = 'muted-text';
            td.textContent = 'No activity in this period yet.';
        }
        stats.recent.forEach(r => {
            const tr = recent.insertRow();
            tr.insertCell().textContent = when(r.ts);
            const who = tr.insertCell();
            who.textContent = r.email || '(no email)';
            if (r.company) who.appendChild(el('div', { class: 'muted-text' }, r.company));
            tr.insertCell().appendChild(pill(r.type));
            tr.insertCell().textContent = r.channel;
            const subject = tr.insertCell();
            subject.className = 'recent-subject';
            subject.textContent = r.type === 'failed' || r.type === 'skipped' ? r.detail : r.subject;
            subject.title = subject.textContent;
        });

        // Campaigns
        const campaigns = document.getElementById('campaignsBody');
        campaigns.replaceChildren();
        if (!stats.campaigns.length) {
            const td = campaigns.insertRow().insertCell();
            td.colSpan = 9;
            td.className = 'muted-text';
            td.textContent = 'No campaigns in this period yet.';
        }
        stats.campaigns.forEach(c => {
            const tr = campaigns.insertRow();
            tr.insertCell().textContent = c.name;
            tr.insertCell().textContent = c.channel === 'bulk' ? 'Bulk email' : 'AI drafts';
            tr.insertCell().textContent = when(c.started);
            [c.sent, c.failed, c.skipped, c.declined, c.replied].forEach(v => {
                const td = tr.insertCell();
                td.className = 'num';
                td.textContent = fmt(v);
            });
            const rate = tr.insertCell();
            rate.className = 'num';
            rate.textContent = c.sent ? `${c.reply_rate}%` : '–';
        });

        // Domains
        const domains = document.getElementById('domainsBody');
        domains.replaceChildren();
        if (!stats.domains.length) {
            const td = domains.insertRow().insertCell();
            td.colSpan = 4;
            td.className = 'muted-text';
            td.textContent = 'No emails sent in this period yet.';
        }
        stats.domains.forEach(d => {
            const tr = domains.insertRow();
            tr.insertCell().textContent = d.domain;
            [fmt(d.sent), fmt(d.replied), `${d.reply_rate}%`].forEach(v => {
                const td = tr.insertCell();
                td.className = 'num';
                td.textContent = v;
            });
        });

        updateFreshness();
    }

    function updateFreshness() {
        if (!stats) return;
        const text = `Updated ${ago(stats.generated_at)} · replies checked ${ago(stats.last_reply_check)}`;
        document.querySelectorAll('.stats-updated').forEach(n => { n.textContent = text; });
    }

    // ---------- data ----------
    async function load() {
        if (loading) return;
        loading = true;
        // Refetch keeps the frame: dim the current render instead of clearing it
        document.querySelectorAll('.stats-body').forEach(b => b.classList.add('loading'));
        try {
            const response = await fetch(`/api/stats?days=${days}`);
            if (!response.ok) {
                let detail = 'Could not load statistics.';
                try { detail = (await response.json()).detail || detail; } catch { /* not JSON */ }
                throw new Error(detail);
            }
            stats = await response.json();
            document.querySelectorAll('.stats-error').forEach(e => e.classList.add('hidden'));
            render();
        } catch (error) {
            document.querySelectorAll('.stats-error').forEach(e => {
                e.textContent = error.message;
                e.classList.remove('hidden');
            });
        } finally {
            loading = false;
            document.querySelectorAll('.stats-body').forEach(b => b.classList.remove('loading'));
        }
    }

    const statsVisible = () => ['view-dashboard', 'view-analytics'].some(id => !document.getElementById(id).classList.contains('hidden'));

    // Date range: both pages share it so the numbers always agree
    document.querySelectorAll('.range-filter .segment').forEach(btn => btn.addEventListener('click', () => {
        days = Number(btn.dataset.days);
        document.querySelectorAll('.range-filter .segment').forEach(b => b.classList.toggle('active', Number(b.dataset.days) === days));
        load();
    }));

    document.querySelectorAll('.stats-refresh-btn').forEach(btn => btn.addEventListener('click', load));

    document.querySelectorAll('.table-toggle').forEach(btn => btn.addEventListener('click', () => {
        const card = btn.closest('.viz-card');
        const showing = card.classList.toggle('show-table');
        btn.textContent = showing ? 'Chart' : 'Table';
    }));

    document.querySelectorAll('.check-replies-btn').forEach(btn => btn.addEventListener('click', async () => {
        const buttons = document.querySelectorAll('.check-replies-btn');
        const originals = [...buttons].map(b => b.innerHTML);
        buttons.forEach(b => {
            b.disabled = true;
            b.innerHTML = '<div class="spinner" style="width: 14px; height: 14px; border-width: 2px;"></div> Checking Gmail...';
        });
        try {
            const response = await fetch('/api/stats/check-replies', { method: 'POST' });
            if (!response.ok) {
                let detail = 'Could not check replies.';
                try { detail = (await response.json()).detail || detail; } catch { /* not JSON */ }
                throw new Error(detail);
            }
            await load();
        } catch (error) {
            alert('Error: ' + error.message);
        } finally {
            buttons.forEach((b, i) => {
                b.disabled = false;
                b.innerHTML = originals[i];
            });
            lucide.createIcons();
        }
    }));

    document.getElementById('analyticsExportBtn').addEventListener('click', async () => {
        if (!stats || !stats.campaigns.length) {
            alert('There are no campaigns to export for this period.');
            return;
        }
        const rows = stats.campaigns.map(c => ({
            'Campaign': c.name, 'Type': c.channel === 'bulk' ? 'Bulk email' : 'AI drafts', 'Status': c.channel === 'bulk' ? 'Bulk email' : 'AI drafts',
            'Started': c.started.replace('T', ' '), 'Last Activity': c.last_activity.replace('T', ' '),
            'Drafted': c.drafted, 'Sent': c.sent, 'Failed': c.failed, 'Skipped': c.skipped, 'Declined': c.declined,
            'Replied': c.replied, 'Reply Rate %': c.reply_rate,
        }));
        try {
            const response = await fetch('/api/export-report', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rows })
            });
            if (!response.ok) throw new Error('Could not export.');
            const url = URL.createObjectURL(await response.blob());
            const a = el('a', { href: url, download: `campaign-analytics-${new Date().toISOString().slice(0, 10)}.xlsx` });
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) {
            alert('Error: ' + error.message);
        }
    });

    // Refresh whenever one of these pages is opened, then every 30s while it's on screen
    document.querySelectorAll('.nav-item[data-view="dashboard"], .nav-item[data-view="analytics"]').forEach(nav =>
        nav.addEventListener('click', () => setTimeout(load, 0)));
    setInterval(() => {
        if (statsVisible() && document.visibilityState === 'visible') load();
        else updateFreshness();
    }, REFRESH_MS);

    // Charts are sized to their card: redraw on resize and when the theme changes
    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(render, 150);
    });
    new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    load();
});
