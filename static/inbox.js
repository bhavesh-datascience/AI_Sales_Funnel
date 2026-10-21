// Inbox: live Gmail (read + reply) and a Reply Tracker that checks which people on a list have replied.
document.addEventListener('DOMContentLoaded', () => {
    const $ = id => document.getElementById(id);
    const SPINNER = '<div class="spinner" style="width: 14px; height: 14px; border-width: 2px;"></div>';
    const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

    let loaded = false;
    let loading = false;
    let oldestUid = 0;
    let currentMessage = null;

    async function errorFrom(response, fallback) {
        try {
            return (await response.json()).detail || fallback;
        } catch {
            return fallback;
        }
    }

    function showError(el, message) {
        el.textContent = message || '';
        el.classList.toggle('hidden', !message);
    }

    function formatDate(iso, long = false) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d)) return '';
        if (long) return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
        const today = new Date();
        if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const sameYear = d.getFullYear() === today.getFullYear();
        return d.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function withSpinner(btn, label) {
        const originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = `${SPINNER} ${label}`;
        return () => {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
            lucide.createIcons();
        };
    }

    // ---------- tabs ----------
    function showTab(tab) {
        document.querySelectorAll('[data-inbox-tab]').forEach(b => b.classList.toggle('active', b.dataset.inboxTab === tab));
        $('inboxMailTab').classList.toggle('hidden', tab !== 'mail');
        $('inboxTrackerTab').classList.toggle('hidden', tab !== 'tracker');
    }
    document.querySelectorAll('[data-inbox-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.inboxTab)));

    // Load mail the first time the Inbox page is opened
    document.querySelectorAll('.nav-item[data-view="inbox"]').forEach(nav => nav.addEventListener('click', () => {
        if (!loaded) loadInbox(true);
    }));

    // ---------- inbox list ----------
    async function loadInbox(reset) {
        if (loading) return;
        loading = true;
        const list = $('inboxList');
        const status = $('inboxListStatus');
        if (reset) {
            list.innerHTML = '';
            oldestUid = 0;
        }
        showError($('inboxError'), '');
        status.innerHTML = `${SPINNER} Loading mail...`;
        $('inboxLoadMore').classList.add('hidden');

        try {
            const params = new URLSearchParams({ limit: 25, q: $('inboxSearch').value.trim() });
            if (oldestUid) params.set('before_uid', oldestUid);
            const response = await fetch(`/api/inbox?${params}`);
            if (!response.ok) throw new Error(await errorFrom(response, 'Could not load your inbox.'));
            const data = await response.json();

            data.messages.forEach(m => list.appendChild(renderListItem(m, data.mailbox)));
            if (data.messages.length) oldestUid = data.messages[data.messages.length - 1].uid;
            status.textContent = list.children.length ? '' : ($('inboxSearch').value.trim() ? 'No emails match your search.' : 'Your inbox is empty.');
            $('inboxLoadMore').classList.toggle('hidden', !data.has_more);
            loaded = true;
        } catch (error) {
            status.textContent = '';
            showError($('inboxError'), error.message);
        } finally {
            loading = false;
        }
    }

    function renderListItem(m, mailbox) {
        const item = document.createElement('div');
        item.className = 'inbox-item' + (m.unread ? ' unread' : '');
        item.dataset.uid = m.uid;

        const header = document.createElement('div');
        header.className = 'inbox-item-header';
        const name = document.createElement('span');
        name.className = 'sender-name';
        name.textContent = m.from_name || m.from_email;
        name.title = m.from_email;
        const time = document.createElement('span');
        time.className = 'time';
        time.textContent = formatDate(m.date);
        header.append(name, time);

        const subject = document.createElement('div');
        subject.className = 'subject';
        subject.textContent = m.subject;

        item.append(header, subject);
        item.addEventListener('click', () => openMessage(m.uid, mailbox, item));
        return item;
    }

    $('inboxRefreshBtn').addEventListener('click', () => loadInbox(true));
    $('inboxLoadMore').addEventListener('click', () => loadInbox(false));
    $('inboxSearch').addEventListener('keydown', e => {
        if (e.key === 'Enter') loadInbox(true);
    });

    // ---------- reading a message ----------
    async function openMessage(uid, mailbox, item) {
        document.querySelectorAll('#inboxList .inbox-item').forEach(i => i.classList.toggle('active', i === item));
        $('inboxEmpty').classList.add('hidden');
        $('inboxMessage').classList.remove('hidden');
        $('msgSubject').textContent = 'Loading...';
        $('msgFromName').textContent = '';
        $('msgFromEmail').textContent = '';
        $('msgDate').textContent = '';
        $('msgAvatar').textContent = '';
        $('msgBody').textContent = '';
        $('msgAttachments').classList.add('hidden');
        $('replyBody').value = '';
        currentMessage = null;

        try {
            const response = await fetch(`/api/inbox/message?${new URLSearchParams({ uid, mailbox })}`);
            if (!response.ok) throw new Error(await errorFrom(response, 'Could not open this email.'));
            const m = await response.json();
            currentMessage = m;
            if (item) item.classList.remove('unread');

            $('msgSubject').textContent = m.subject;
            $('msgFromName').textContent = m.from_name;
            $('msgFromEmail').textContent = m.from_email;
            $('msgDate').textContent = formatDate(m.date, true);
            $('msgAvatar').textContent = (m.from_name || m.from_email || '?').trim().charAt(0).toUpperCase();
            $('msgBody').textContent = m.body || '(This email has no text content.)';

            const attachments = $('msgAttachments');
            attachments.innerHTML = '';
            m.attachments.forEach(name => {
                const chip = document.createElement('span');
                chip.className = 'attachment-chip';
                chip.innerHTML = '<i data-lucide="paperclip"></i>';
                chip.append(name);
                attachments.appendChild(chip);
            });
            attachments.classList.toggle('hidden', m.attachments.length === 0);
            lucide.createIcons();
        } catch (error) {
            $('msgSubject').textContent = 'Could not open this email';
            $('msgBody').textContent = error.message;
        }
    }

    // ---------- replying ----------
    $('aiReplyBtn').addEventListener('click', async () => {
        if (!currentMessage) return;
        if ($('replyBody').value.trim() && !confirm('Replace your current reply with an AI draft?')) return;
        const done = withSpinner($('aiReplyBtn'), 'Drafting...');
        try {
            const response = await fetch('/api/inbox/ai-reply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uid: currentMessage.uid, mailbox: currentMessage.mailbox })
            });
            if (!response.ok) throw new Error(await errorFrom(response, 'Could not draft a reply.'));
            $('replyBody').value = (await response.json()).body;
        } catch (error) {
            alert('Error: ' + error.message);
        } finally {
            done();
        }
    });

    $('sendReplyBtn').addEventListener('click', async () => {
        if (!currentMessage) return;
        const body = $('replyBody').value.trim();
        if (!body) {
            alert('Write a reply first.');
            return;
        }
        const done = withSpinner($('sendReplyBtn'), 'Sending...');
        try {
            const response = await fetch('/api/inbox/reply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uid: currentMessage.uid, mailbox: currentMessage.mailbox, body })
            });
            if (!response.ok) throw new Error(await errorFrom(response, 'Could not send the reply.'));
            $('replyBody').value = '';
            alert(`Reply sent to ${currentMessage.from_email}.`);
        } catch (error) {
            alert('Error: ' + error.message);
        } finally {
            done();
        }
    });

    // ---------- reply tracker ----------
    let trackerColumns = [];
    let trackerRows = [];
    let trackerResults = [];
    let trackerFilter = 'all';

    const cell = (row, column) => (column && row[column] != null ? String(row[column]).trim() : '');

    $('trackerUploadBtn').addEventListener('click', () => $('trackerFileInput').click());

    $('trackerFileInput').addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        const done = withSpinner($('trackerUploadBtn'), 'Reading file...');
        showError($('trackerError'), '');
        try {
            const formData = new FormData();
            formData.append('file', file);
            const response = await fetch('/api/parse-list', { method: 'POST', body: formData });
            if (!response.ok) throw new Error(await errorFrom(response, 'Could not read the file.'));
            const data = await response.json();
            trackerColumns = data.columns;
            trackerRows = data.rows;

            const select = $('trackerEmailColumn');
            select.innerHTML = '';
            const guess = trackerColumns.find(c => /e-?mail/i.test(c)) || trackerColumns[0];
            trackerColumns.forEach(c => select.add(new Option(c, c, false, c === guess)));

            $('trackerFileName').textContent = `${file.name} · ${trackerRows.length} rows`;
            $('trackerOptions').classList.remove('hidden');
            $('trackerCheckBtn').disabled = trackerRows.length === 0;
            $('trackerResults').classList.add('hidden');
        } catch (error) {
            showError($('trackerError'), error.message);
        } finally {
            done();
            e.target.value = '';
        }
    });

    $('trackerCheckBtn').addEventListener('click', async () => {
        const emailColumn = $('trackerEmailColumn').value;
        const nameColumn = trackerColumns.find(c => /name|contact|person/i.test(c) && !/mail|company/i.test(c))
            || trackerColumns.find(c => /company|organi[sz]ation/i.test(c));

        // One entry per unique address, keeping the first row it appears on
        const entries = new Map();
        trackerRows.forEach(row => {
            const email = cell(row, emailColumn).toLowerCase();
            const key = email || `__row${entries.size}`;
            if (!entries.has(key)) entries.set(key, { email, name: cell(row, nameColumn), row });
        });
        const valid = [...entries.values()].filter(e => EMAIL_PATTERN.test(e.email));
        if (!valid.length) {
            showError($('trackerError'), `No valid email addresses found in the "${emailColumn}" column.`);
            return;
        }

        showError($('trackerError'), '');
        const done = withSpinner($('trackerCheckBtn'), `Checking ${valid.length} addresses...`);
        try {
            const response = await fetch('/api/check-replies', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ emails: valid.map(v => v.email), since: $('trackerSince').value })
            });
            if (!response.ok) throw new Error(await errorFrom(response, 'Could not check replies.'));
            const data = await response.json();
            const byEmail = new Map(data.results.map(r => [r.email, r]));

            trackerResults = [...entries.values()].map(entry => {
                const r = byEmail.get(entry.email);
                if (!r) return { ...entry, status: 'Invalid email', replyCount: 0, lastDate: '', lastSubject: '', lastText: '', uid: null, mailbox: data.mailbox };
                return {
                    ...entry,
                    status: r.replied ? 'Replied' : 'No reply',
                    replyCount: r.reply_count,
                    lastDate: r.last_reply_date,
                    lastSubject: r.last_reply_subject,
                    lastText: r.last_reply_text,
                    uid: r.last_reply_uid,
                    mailbox: data.mailbox
                };
            });
            renderTracker();
        } catch (error) {
            showError($('trackerError'), error.message);
        } finally {
            done();
        }
    });

    document.querySelectorAll('#trackerFilter .segment').forEach(seg => seg.addEventListener('click', () => {
        document.querySelectorAll('#trackerFilter .segment').forEach(s => s.classList.toggle('active', s === seg));
        trackerFilter = seg.dataset.filter;
        renderTracker();
    }));

    function renderTracker() {
        const checked = trackerResults.filter(r => r.status !== 'Invalid email');
        const replied = checked.filter(r => r.status === 'Replied').length;
        $('trackerStatTotal').textContent = checked.length;
        $('trackerStatReplied').textContent = replied;
        $('trackerStatNoReply').textContent = checked.length - replied;
        $('trackerStatRate').textContent = checked.length ? `${Math.round((replied / checked.length) * 100)}%` : '0%';

        const visible = trackerResults.filter(r =>
            trackerFilter === 'all' || (trackerFilter === 'replied' ? r.status === 'Replied' : r.status !== 'Replied'));
        const body = $('trackerBody');
        body.innerHTML = '';
        const pill = { 'Replied': 'sent', 'No reply': 'not-sent', 'Invalid email': 'failed' };
        visible.forEach(r => {
            const tr = body.insertRow();
            tr.insertCell().textContent = r.email || '(empty)';
            tr.insertCell().textContent = r.name;
            const status = document.createElement('span');
            status.className = `status-pill ${pill[r.status]}`;
            status.textContent = r.status;
            tr.insertCell().appendChild(status);
            tr.insertCell().textContent = r.replyCount || '';
            tr.insertCell().textContent = formatDate(r.lastDate, true);
            tr.insertCell().textContent = r.lastSubject;
            const actions = tr.insertCell();
            if (r.uid) {
                const view = document.createElement('button');
                view.className = 'btn btn-outline btn-sm view-reply-btn';
                view.textContent = 'View reply';
                view.addEventListener('click', () => {
                    showTab('mail');
                    openMessage(r.uid, r.mailbox, null);
                });
                view.addEventListener('click', e => e.stopPropagation(), true);
                actions.appendChild(view);
            }

            // Click a replied row to read the reply right here
            if (r.lastText) {
                tr.classList.add('expandable-row');
                tr.title = 'Click to read the reply';
                const detail = body.insertRow();
                detail.className = 'mail-detail-row' + (r.expanded ? '' : ' hidden');
                tr.classList.toggle('open', !!r.expanded);
                const td = detail.insertCell();
                td.colSpan = 7;
                const mail = document.createElement('div');
                mail.className = 'mail-detail';
                mail.textContent = `Subject: ${r.lastSubject}\n\n${r.lastText}`;
                td.appendChild(mail);
                tr.addEventListener('click', () => {
                    r.expanded = !r.expanded;
                    detail.classList.toggle('hidden', !r.expanded);
                    tr.classList.toggle('open', r.expanded);
                });
            }
        });
        $('trackerResults').classList.remove('hidden');
    }

    function trackerExportRows() {
        const emailColumn = $('trackerEmailColumn').value;
        return trackerResults.map(r => ({
            'Email': r.email,
            'Name': r.name,
            'Status': r.status,
            'Replied': r.status === 'Replied' ? 'Yes' : 'No',
            'Reply Count': r.replyCount,
            'Last Reply At': formatDate(r.lastDate, true),
            'Last Reply Subject': r.lastSubject,
            'Last Reply Message': r.lastText,
            ...Object.fromEntries(trackerColumns.filter(c => c !== emailColumn).map(c => [c, cell(r.row, c)]))
        }));
    }

    $('trackerExportCsvBtn').addEventListener('click', () => {
        const rows = trackerExportRows();
        if (!rows.length) return;
        const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const headers = Object.keys(rows[0]);
        const lines = [headers.map(escape).join(','), ...rows.map(r => headers.map(h => escape(r[h])).join(','))];
        downloadBlob(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `reply-report-${new Date().toISOString().slice(0, 10)}.csv`);
    });

    $('trackerExportExcelBtn').addEventListener('click', async () => {
        const done = withSpinner($('trackerExportExcelBtn'), 'Exporting...');
        try {
            const response = await fetch('/api/export-report', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rows: trackerExportRows() })
            });
            if (!response.ok) throw new Error(await errorFrom(response, 'Could not export the report.'));
            downloadBlob(await response.blob(), `reply-report-${new Date().toISOString().slice(0, 10)}.xlsx`);
        } catch (error) {
            alert('Error: ' + error.message);
        } finally {
            done();
        }
    });
});
