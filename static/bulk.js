// Bulk Email: one template sent to a whole list, personalised with {{Column Name}} variables.
// Every variable used in the template is required: recipients without a value for it are skipped
// (the server enforces this too, so an email with a blank where a value should be is never sent).
document.addEventListener('DOMContentLoaded', () => {
    const $ = id => document.getElementById(id);
    const VARIABLE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
    const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    const SPINNER = '<div class="spinner" style="width: 14px; height: 14px; border-width: 2px;"></div>';
    const FATAL_ERRORS = /not configured|rejected the login|Google blocked|Daily send limit/;

    let columns = [];
    let rows = [];
    let ready = [];          // [{ row, email, name }]
    let skipped = [];        // [{ row, email, name, reason }]
    let blocked = true;      // template problem that prevents sending at all
    let previewIndex = 0;
    let lastFocused = $('bulkBody');
    let sending = false;
    let stopRequested = false;
    let results = [];

    const subjectInput = $('bulkSubject');
    const bodyInput = $('bulkBody');

    // ---------- helpers ----------
    const findColumn = name => columns.find(c => c.toLowerCase() === name.trim().toLowerCase());
    const cell = (row, column) => (column && row[column] != null ? String(row[column]).trim() : '');

    function usedVariables() {
        const names = [...`${subjectInput.value}\n${bodyInput.value}`.matchAll(VARIABLE_PATTERN)].map(m => m[1].trim());
        return [...new Map(names.map(n => [n.toLowerCase(), n])).values()];
    }

    function render(template, row) {
        return template.replace(VARIABLE_PATTERN, (_, name) => cell(row, findColumn(name)));
    }

    function timestamp() {
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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

    async function errorFrom(response, fallback) {
        try {
            return (await response.json()).detail || fallback;
        } catch {
            return fallback;
        }
    }

    // ---------- step 1: recipients ----------
    $('bulkUploadBtn').addEventListener('click', () => $('bulkFileInput').click());

    $('bulkFileInput').addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        const btn = $('bulkUploadBtn');
        const originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = `${SPINNER} Reading file...`;

        try {
            const formData = new FormData();
            formData.append('file', file);
            const response = await fetch('/api/parse-list', { method: 'POST', body: formData });
            if (!response.ok) throw new Error(await errorFrom(response, 'Could not read the file.'));
            const data = await response.json();

            columns = data.columns;
            rows = data.rows;
            $('bulkFileName').textContent = `${file.name} · ${rows.length} rows`;
            populateColumnSelects();
            renderVariableChips();
            renderAiVariableOptions();
            $('bulkColumnRow').classList.remove('hidden');
            $('bulkResults').classList.add('hidden');
            previewIndex = 0;
            validate();
        } catch (error) {
            alert('Error: ' + error.message);
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
            e.target.value = '';
            lucide.createIcons();
        }
    });

    function populateColumnSelects() {
        const emailSelect = $('bulkEmailColumn');
        const nameSelect = $('bulkNameColumn');
        emailSelect.innerHTML = '';
        nameSelect.innerHTML = '<option value="">(none)</option>';
        const emailGuess = columns.find(c => /e-?mail/i.test(c)) || columns[0];
        const nameGuess = columns.find(c => /name|contact|person/i.test(c) && !/mail|company/i.test(c))
            || columns.find(c => /company|organi[sz]ation/i.test(c));
        columns.forEach(c => {
            emailSelect.add(new Option(c, c, false, c === emailGuess));
            nameSelect.add(new Option(c, c, false, c === nameGuess));
        });
    }

    $('bulkEmailColumn').addEventListener('change', () => { renderVariableChips(); renderAiVariableOptions(); validate(); });
    $('bulkNameColumn').addEventListener('change', validate);

    // ---------- step 2: compose ----------
    document.querySelectorAll('#view-bulk-email .segment').forEach(seg => {
        seg.addEventListener('click', () => {
            document.querySelectorAll('#view-bulk-email .segment').forEach(s => s.classList.remove('active'));
            seg.classList.add('active');
            $('bulkAiPanel').classList.toggle('hidden', seg.dataset.mode !== 'ai');
        });
    });

    $('bulkCategory').addEventListener('change', () => {
        $('bulkCustomCategoryField').classList.toggle('hidden', $('bulkCategory').value !== '__custom');
    });

    [subjectInput, bodyInput].forEach(input => {
        input.addEventListener('focus', () => { lastFocused = input; });
        input.addEventListener('input', validate);
    });

    function renderVariableChips() {
        const box = $('bulkVariableChips');
        box.innerHTML = '';
        const emailColumn = $('bulkEmailColumn').value;
        const recipients = rows.filter(r => EMAIL_PATTERN.test(cell(r, emailColumn)));
        columns.forEach(column => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'variable-chip';
            chip.dataset.column = column;
            chip.textContent = `{{${column}}}`;
            const missing = recipients.filter(r => !cell(r, column)).length;
            if (missing) {
                const badge = document.createElement('span');
                badge.className = 'chip-missing';
                badge.textContent = `${missing} empty`;
                badge.title = `${missing} recipient(s) have no value for this column and would be skipped if you use it`;
                chip.appendChild(badge);
            }
            chip.addEventListener('click', () => insertVariable(column));
            box.appendChild(chip);
        });
        $('bulkVariablesBox').classList.toggle('hidden', columns.length === 0);
    }

    function insertVariable(column) {
        const input = lastFocused;
        const token = `{{${column}}}`;
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        input.value = input.value.slice(0, start) + token + input.value.slice(end);
        input.focus();
        input.setSelectionRange(start + token.length, start + token.length);
        validate();
    }

    function renderAiVariableOptions() {
        const box = $('bulkAiVariables');
        box.innerHTML = '';
        const emailColumn = $('bulkEmailColumn').value;
        columns.filter(c => c !== emailColumn).forEach(column => {
            const label = document.createElement('label');
            label.className = 'ai-var-option';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = column;
            checkbox.checked = /name|company|organi[sz]ation/i.test(column);
            label.append(checkbox, ` ${column}`);
            box.appendChild(label);
        });
        $('bulkAiVariablesField').classList.toggle('hidden', box.children.length === 0);
    }

    $('bulkGenerateBtn').addEventListener('click', async () => {
        const category = $('bulkCategory').value === '__custom' ? $('bulkCustomCategory').value.trim() : $('bulkCategory').value;
        if (!category) {
            alert('Please type a custom category.');
            return;
        }
        if ((subjectInput.value.trim() || bodyInput.value.trim()) && !confirm('Replace the current subject and body with a new AI draft?')) return;

        const btn = $('bulkGenerateBtn');
        const originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = `${SPINNER} Generating...`;
        try {
            const response = await fetch('/api/generate-template', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    category,
                    instructions: $('bulkInstructions').value,
                    variables: [...document.querySelectorAll('#bulkAiVariables input:checked')].map(c => c.value)
                })
            });
            if (!response.ok) throw new Error(await errorFrom(response, 'Could not generate the email.'));
            const data = await response.json();
            subjectInput.value = data.subject;
            bodyInput.value = data.body;
            validate();
        } catch (error) {
            alert('Error: ' + error.message);
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
            lucide.createIcons();
        }
    });

    // ---------- step 3: validate, preview, send ----------
    function showAlert(message) {
        $('bulkAlert').textContent = message;
        $('bulkAlert').classList.toggle('hidden', !message);
    }

    function validate() {
        const emailColumn = $('bulkEmailColumn').value;
        const nameColumn = $('bulkNameColumn').value;
        const used = usedVariables();
        const unknown = used.filter(v => !findColumn(v));

        // Highlight the chips that are in use (and therefore required)
        document.querySelectorAll('#bulkVariableChips .variable-chip').forEach(chip => {
            chip.classList.toggle('used', used.some(v => v.toLowerCase() === chip.dataset.column.toLowerCase()));
        });

        ready = [];
        skipped = [];
        const seen = new Set();
        rows.forEach(row => {
            const email = cell(row, emailColumn);
            const name = cell(row, nameColumn);
            let reason = '';
            if (!EMAIL_PATTERN.test(email)) reason = email ? 'Invalid email address' : 'No email address';
            else if (seen.has(email.toLowerCase())) reason = 'Duplicate email in list';
            else {
                const missing = used.filter(v => findColumn(v) && !cell(row, findColumn(v)));
                if (missing.length) reason = `Missing required variable: ${missing.join(', ')}`;
            }
            if (EMAIL_PATTERN.test(email)) seen.add(email.toLowerCase());
            (reason ? skipped : ready).push({ row, email, name, reason });
        });

        if (!rows.length) showAlert('');
        else if (unknown.length) showAlert(`Unknown variable ${unknown.map(v => `{{${v}}}`).join(', ')}: it doesn't match any column in your file. Fix or remove it to send.`);
        else if (!subjectInput.value.trim() || !bodyInput.value.trim()) showAlert('Add a subject and an email body to send.');
        else showAlert('');
        blocked = !rows.length || unknown.length > 0 || !subjectInput.value.trim() || !bodyInput.value.trim();

        $('bulkStatTotal').textContent = rows.length;
        $('bulkStatReady').textContent = ready.length;
        $('bulkStatSkipped').textContent = skipped.length;
        $('bulkSendCount').textContent = ready.length;
        $('bulkSendBtn').disabled = blocked || ready.length === 0 || sending;

        const skippedBody = $('bulkSkippedBody');
        skippedBody.innerHTML = '';
        skipped.forEach(s => {
            const tr = skippedBody.insertRow();
            tr.insertCell().textContent = s.email || '(empty)';
            tr.insertCell().textContent = s.reason;
        });
        $('bulkSkippedDetails').classList.toggle('hidden', skipped.length === 0);

        renderPreview();
    }

    function renderPreview() {
        const show = ready.length > 0 && (subjectInput.value.trim() || bodyInput.value.trim());
        $('bulkPreview').classList.toggle('hidden', !show);
        if (!show) return;
        previewIndex = Math.min(previewIndex, ready.length - 1);
        const r = ready[previewIndex];
        $('bulkPreviewIndex').textContent = `${previewIndex + 1} / ${ready.length}`;
        $('bulkPreviewTo').textContent = r.name ? `${r.name} <${r.email}>` : r.email;
        $('bulkPreviewSubject').textContent = render(subjectInput.value, r.row);
        $('bulkPreviewBody').textContent = render(bodyInput.value, r.row);
    }

    $('bulkPrevBtn').addEventListener('click', () => {
        if (!ready.length) return;
        previewIndex = (previewIndex - 1 + ready.length) % ready.length;
        renderPreview();
    });
    $('bulkNextBtn').addEventListener('click', () => {
        if (!ready.length) return;
        previewIndex = (previewIndex + 1) % ready.length;
        renderPreview();
    });

    function setComposeLocked(locked) {
        document.querySelectorAll('#view-bulk-email .bulk-card:not(#bulkResults) :is(input, textarea, select, button)')
            .forEach(el => { if (el.id !== 'bulkStopBtn') el.disabled = locked; });
    }

    function renderResults() {
        const body = $('bulkResultsBody');
        body.innerHTML = '';
        const pillClass = { 'Sent': 'sent', 'Skipped': 'skipped', 'Failed': 'failed', 'Not sent': 'not-sent' };
        results.forEach(r => {
            const tr = body.insertRow();
            tr.insertCell().textContent = r.email || '(empty)';
            tr.insertCell().textContent = r.name;
            const pill = document.createElement('span');
            pill.className = `status-pill ${pillClass[r.status]}`;
            pill.textContent = r.status;
            tr.insertCell().appendChild(pill);
            tr.insertCell().textContent = r.subject;
            tr.insertCell().textContent = r.details;
            tr.insertCell().textContent = r.time;

            // Click a row to read the exact email that went (or would go) to this recipient
            if (r.body) {
                tr.classList.add('expandable-row');
                tr.title = 'Click to view the email';
                const detail = body.insertRow();
                detail.className = 'mail-detail-row' + (r.expanded ? '' : ' hidden');
                const td = detail.insertCell();
                td.colSpan = 6;
                const mail = document.createElement('div');
                mail.className = 'mail-detail';
                mail.textContent = `Subject: ${r.subject}\n\n${r.body}`;
                td.appendChild(mail);
                tr.classList.toggle('open', !!r.expanded);
                tr.addEventListener('click', () => {
                    r.expanded = !r.expanded;
                    detail.classList.toggle('hidden', !r.expanded);
                    tr.classList.toggle('open', r.expanded);
                });
            }
        });
        const count = status => results.filter(r => r.status === status).length;
        $('bulkResSent').textContent = count('Sent');
        $('bulkResSkipped').textContent = count('Skipped');
        $('bulkResFailed').textContent = count('Failed');
        $('bulkResNotSent').textContent = count('Not sent');
        $('bulkResults').classList.remove('hidden');
    }

    $('bulkSendBtn').addEventListener('click', async () => {
        validate();
        if (blocked || !ready.length || sending) return;

        let settings = { interval_seconds: 20, jitter_seconds: 10, daily_limit: 400, sent_today: 0 };
        try {
            settings = await (await fetch('/api/send-settings')).json();
        } catch { /* fall back to defaults */ }
        const minGap = settings.interval_seconds;
        const maxGap = settings.interval_seconds + settings.jitter_seconds;
        const remaining = settings.daily_limit - settings.sent_today;
        const minutes = Math.ceil((ready.length - 1) * (minGap + settings.jitter_seconds / 2) / 60);

        let message = `Send this email to ${ready.length} recipient(s)?\n\nThey go out one at a time, ${minGap}-${maxGap} seconds apart, which takes about ${minutes} minute(s). Keep this tab open.`;
        if (skipped.length) message += `\n\n${skipped.length} recipient(s) will be skipped (see the skipped list).`;
        if (ready.length > remaining) message += `\n\nWarning: only ${Math.max(remaining, 0)} more email(s) can be sent today (daily limit ${settings.daily_limit}). Sending will stop when the limit is reached.`;
        if (!confirm(message)) return;

        const subjectTemplate = subjectInput.value;
        const bodyTemplate = bodyInput.value;
        const queue = [...ready];
        const campaignId = `bulk-${Date.now()}`;
        const campaignName = subjectTemplate.length > 60 ? subjectTemplate.slice(0, 57) + '...' : subjectTemplate;

        // Recipients skipped before sending (bad/duplicate address, missing values) still count in Analytics
        if (skipped.length) {
            fetch('/api/activity', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ events: skipped.map(sk => ({
                    type: 'skipped', channel: 'bulk', campaign_id: campaignId, campaign_name: campaignName,
                    email: sk.email, detail: sk.reason
                })) })
            }).catch(() => { /* analytics only */ });
        }

        results = [
            ...queue.map(r => ({ ...r, status: 'Not sent', details: '', time: '', subject: render(subjectTemplate, r.row), body: render(bodyTemplate, r.row) })),
            ...skipped.map(s => ({ ...s, status: 'Skipped', details: s.reason, time: '', subject: '', body: '' }))
        ];
        renderResults();

        sending = true;
        stopRequested = false;
        setComposeLocked(true);
        $('bulkStopBtn').disabled = false;
        $('bulkSendStatus').classList.remove('hidden');

        let sent = 0;
        for (let i = 0; i < queue.length; i++) {
            const result = results[i];
            if (i > 0) {
                // Random gap between emails so the pattern doesn't look automated; checked often so Stop is instant
                const waitUntil = Date.now() + (minGap + Math.random() * settings.jitter_seconds) * 1000;
                while (!stopRequested && Date.now() < waitUntil) {
                    $('bulkSendStatusText').textContent = `${sent} of ${queue.length} sent. Next email to ${result.email} in ${Math.ceil((waitUntil - Date.now()) / 1000)}s`;
                    await new Promise(r => setTimeout(r, 250));
                }
            }
            if (stopRequested) break;

            $('bulkSendStatusText').textContent = `Sending ${i + 1} of ${queue.length} to ${result.email}...`;
            try {
                const response = await fetch('/api/send-bulk-email', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        to_email: result.email,
                        to_name: result.name,
                        subject: subjectTemplate,
                        body: bodyTemplate,
                        variables: result.row,
                        campaign_id: campaignId,
                        campaign_name: campaignName
                    })
                });
                if (!response.ok) {
                    const detail = await errorFrom(response, 'Sending failed.');
                    // 422 = the server found a required variable without a value
                    Object.assign(result, { status: response.status === 422 ? 'Skipped' : 'Failed', details: detail, time: timestamp() });
                    renderResults();
                    if (FATAL_ERRORS.test(detail)) break;
                    continue;
                }
                sent++;
                Object.assign(result, { status: 'Sent', details: '', time: timestamp() });
            } catch (error) {
                Object.assign(result, { status: 'Failed', details: error.message, time: timestamp() });
            }
            renderResults();
        }

        results.filter(r => r.status === 'Not sent').forEach(r => { r.details = stopRequested ? 'Stopped before sending' : 'Not sent'; });
        renderResults();
        sending = false;
        setComposeLocked(false);
        $('bulkSendStatus').classList.add('hidden');
        validate();

        const failed = results.filter(r => r.status === 'Failed');
        let summary = `${sent} of ${queue.length} email(s) sent.`;
        if (stopRequested) summary += ' Stopped early.';
        if (failed.length) summary += `\n\n${failed.length} failed. First error: ${failed[0].details}`;
        alert(summary);
    });

    $('bulkStopBtn').addEventListener('click', () => {
        stopRequested = true;
        $('bulkStopBtn').disabled = true;
        $('bulkSendStatusText').textContent = 'Stopping...';
    });

    // ---------- export ----------
    function exportRows() {
        return results.map(r => ({
            'Email': r.email,
            'Name': r.name,
            'Status': r.status,
            'Details': r.details,
            'Sent At': r.time,
            'Subject': r.subject,
            'Email Body': r.body,
            ...Object.fromEntries(columns.filter(c => c !== $('bulkEmailColumn').value).map(c => [c, cell(r.row, c)]))
        }));
    }

    $('bulkExportCsvBtn').addEventListener('click', () => {
        const rowsOut = exportRows();
        if (!rowsOut.length) return;
        const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const headers = Object.keys(rowsOut[0]);
        const lines = [headers.map(escape).join(','), ...rowsOut.map(r => headers.map(h => escape(r[h])).join(','))];
        downloadBlob(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `bulk-email-report-${timestamp().slice(0, 10)}.csv`);
    });

    $('bulkExportExcelBtn').addEventListener('click', async () => {
        const btn = $('bulkExportExcelBtn');
        btn.disabled = true;
        try {
            const response = await fetch('/api/export-report', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rows: exportRows() })
            });
            if (!response.ok) throw new Error(await errorFrom(response, 'Could not export the report.'));
            downloadBlob(await response.blob(), `bulk-email-report-${timestamp().slice(0, 10)}.xlsx`);
        } catch (error) {
            alert('Error: ' + error.message);
        } finally {
            btn.disabled = false;
        }
    });

    validate();
});
