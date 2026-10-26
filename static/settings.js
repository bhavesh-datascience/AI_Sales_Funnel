// Settings: email signature (sign-off + Instagram / Website / LinkedIn / YouTube with icons)
document.addEventListener('DOMContentLoaded', () => {
    const $ = id => document.getElementById(id);
    const FIELDS = [
        { key: 'instagram', label: 'Instagram', input: 'sigInstagram' },
        { key: 'website', label: 'Website', input: 'sigWebsite' },
        { key: 'linkedin', label: 'LinkedIn', input: 'sigLinkedin' },
        { key: 'youtube', label: 'YouTube', input: 'sigYoutube' },
    ];
    let loaded = false;
    let savedSnapshot = '';

    // Same rules as the server, so the preview matches what recipients see (the server re-checks on save)
    function normalize(key, value) {
        value = value.trim();
        if (!value) return null;
        if (key === 'instagram' && !/^https?:\/\//i.test(value)) {
            const handle = value.replace(/^@/, '').replace(/\/+$/, '');
            return { url: `https://instagram.com/${handle}`, text: `@${handle}` };
        }
        if (key === 'youtube' && value.startsWith('@')) return { url: `https://www.youtube.com/${value}`, text: value };
        if (key === 'linkedin' && /^(in|company)\//.test(value)) value = `https://www.linkedin.com/${value}`;
        const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
        let parsed;
        try { parsed = new URL(url); } catch { return null; }
        const first = parsed.pathname.replace(/^\/+/, '').split('/')[0];
        if (key === 'instagram') return { url, text: first ? `@${first}` : 'Instagram' };
        if (key === 'website') return { url, text: (parsed.host + parsed.pathname).replace(/^www\./, '').replace(/\/+$/, '') };
        if (key === 'youtube') return { url, text: first.startsWith('@') ? first : 'YouTube' };
        return { url, text: 'LinkedIn' };
    }

    const current = () => ({
        enabled: $('sigEnabled').checked,
        sign_off: $('sigSignOff').value,
        ...Object.fromEntries(FIELDS.map(f => [f.key, $(f.input).value])),
    });

    function renderPreview() {
        const data = current();
        const preview = $('sigPreview');
        preview.replaceChildren();
        preview.classList.toggle('disabled', !data.enabled);
        if (!data.enabled) {
            preview.appendChild(Object.assign(document.createElement('p'), { className: 'muted-text', textContent: 'Signature is turned off. Emails end with your message.' }));
            return;
        }
        if (data.sign_off.trim()) {
            preview.appendChild(Object.assign(document.createElement('div'), { className: 'sig-signoff', textContent: data.sign_off.trim() }));
        }
        const links = document.createElement('div');
        links.className = 'sig-links';
        FIELDS.forEach(f => {
            const link = normalize(f.key, data[f.key]);
            if (!link) return;
            const a = document.createElement('a');
            a.href = link.url;
            a.target = '_blank';
            a.rel = 'noopener';
            const icon = Object.assign(document.createElement('img'), { src: `/static/email-icons/${f.key}.png`, alt: f.label, width: 18, height: 18 });
            a.append(icon, document.createTextNode(link.text));
            links.appendChild(a);
        });
        if (links.children.length) preview.appendChild(links);
        if (!preview.children.length) {
            preview.appendChild(Object.assign(document.createElement('p'), { className: 'muted-text', textContent: 'Add a sign-off or a link to see it here.' }));
        }
        updateStatus();
    }

    function updateStatus() {
        if (!loaded) return;
        $('sigStatus').textContent = JSON.stringify(current()) === savedSnapshot ? 'All changes saved' : 'Unsaved changes';
    }

    function fill(data) {
        $('sigEnabled').checked = data.enabled !== false;
        $('sigSignOff').value = data.sign_off || '';
        FIELDS.forEach(f => { $(f.input).value = data[f.key] || ''; });
        savedSnapshot = JSON.stringify(current());
        renderPreview();
    }

    async function load() {
        try {
            const response = await fetch('/api/settings/signature');
            if (!response.ok) throw new Error('Could not load your signature.');
            fill(await response.json());
            loaded = true;
            updateStatus();
        } catch (error) {
            $('sigError').textContent = error.message;
            $('sigError').classList.remove('hidden');
        }
    }

    $('sigSaveBtn').addEventListener('click', async () => {
        const btn = $('sigSaveBtn');
        const originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<div class="spinner" style="width: 14px; height: 14px; border-width: 2px;"></div> Saving...';
        $('sigError').classList.add('hidden');
        try {
            const response = await fetch('/api/settings/signature', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(current())
            });
            if (!response.ok) {
                let detail = 'Could not save the signature.';
                try { detail = (await response.json()).detail || detail; } catch { /* not JSON */ }
                throw new Error(detail);
            }
            fill(await response.json());
            $('sigStatus').textContent = 'Saved. New emails will use this signature.';
        } catch (error) {
            $('sigError').textContent = error.message;
            $('sigError').classList.remove('hidden');
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
            lucide.createIcons();
        }
    });

    ['sigEnabled', 'sigSignOff', ...FIELDS.map(f => f.input)].forEach(id => $(id).addEventListener('input', renderPreview));

    // Load when the Settings page is first opened
    document.querySelectorAll('.nav-item[data-view="settings"]').forEach(nav => nav.addEventListener('click', () => {
        if (!loaded) load();
    }));

    // Warn before leaving the page with unsaved signature changes
    window.addEventListener('beforeunload', e => {
        if (loaded && JSON.stringify(current()) !== savedSnapshot) e.preventDefault();
    });

    renderPreview();
});
