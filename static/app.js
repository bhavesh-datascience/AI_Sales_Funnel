document.addEventListener('DOMContentLoaded', () => {
    // Initialize Lucide icons
    lucide.createIcons();

    // Navigation Logic
    const navItems = document.querySelectorAll('.nav-item[data-view]');
    const viewSections = document.querySelectorAll('.view-section');

    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            
            // Remove active class from all nav items
            navItems.forEach(nav => nav.classList.remove('active'));
            // Add active class to clicked nav item
            item.classList.add('active');

            // Hide all views
            viewSections.forEach(view => view.classList.add('hidden'));
            
            // Show target view
            const targetViewId = 'view-' + item.getAttribute('data-view');
            const targetView = document.getElementById(targetViewId);
            if (targetView) {
                targetView.classList.remove('hidden');
            }
        });
    });

    // Email Sending Upload Logic
    const uploadCard = document.getElementById('uploadCard');
    const fileInput = document.getElementById('fileInput');
    const uploadProgress = document.getElementById('uploadProgress');
    const resultsSection = document.getElementById('resultsSection');
    const resultsGrid = document.getElementById('resultsGrid');
    const resultsCount = document.getElementById('resultsCount');
    const cardTemplate = document.getElementById('cardTemplate');

    if (uploadCard) {
        // Drag and drop event listeners
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            uploadCard.addEventListener(eventName, preventDefaults, false);
        });

        function preventDefaults(e) {
            e.preventDefault();
            e.stopPropagation();
        }

        ['dragenter', 'dragover'].forEach(eventName => {
            uploadCard.addEventListener(eventName, () => uploadCard.classList.add('dragover'), false);
        });

        ['dragleave', 'drop'].forEach(eventName => {
            uploadCard.addEventListener(eventName, () => uploadCard.classList.remove('dragover'), false);
        });

        uploadCard.addEventListener('drop', handleDrop, false);
        fileInput.addEventListener('change', handleFileSelect, false);

        function handleDrop(e) {
            const dt = e.dataTransfer;
            const files = dt.files;
            if (files.length > 0) {
                handleFiles(files[0]);
            }
        }

        function handleFileSelect(e) {
            if (e.target.files.length > 0) {
                handleFiles(e.target.files[0]);
            }
        }

        function handleFiles(file) {
            // Validate file type
            const validExtensions = ['.xlsx', '.xls', '.csv'];
            const isValid = validExtensions.some(ext => file.name.toLowerCase().endsWith(ext));
            
            if (!isValid) {
                alert('Please upload a valid Excel or CSV file.');
                return;
            }

            uploadFile(file);
        }

        let currentFile = null;

        async function uploadFile(file) {
            currentFile = file;
            const formData = new FormData();
            formData.append('file', file);

            // Show progress for preview
            const uploadProgressText = document.getElementById('uploadProgressText');
            uploadProgressText.textContent = "Analyzing file...";
            uploadProgress.classList.remove('hidden');
            resultsSection.classList.add('hidden');
            document.getElementById('configSection').classList.add('hidden');
            resultsGrid.innerHTML = '';

            try {
                const response = await fetch('/api/upload-preview', {
                    method: 'POST',
                    body: formData
                });

                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.detail || 'An error occurred during file analysis.');
                }

                const data = await response.json();
                
                // Populate dropdown
                const select = document.getElementById('emailColumnSelect');
                select.innerHTML = '';
                data.columns.forEach(col => {
                    const option = document.createElement('option');
                    option.value = col;
                    option.textContent = col;
                    // Auto-select if column name contains 'email'
                    if (col.toLowerCase().includes('email')) {
                        option.selected = true;
                    }
                    select.appendChild(option);
                });
                
                // Update max drafts
                document.getElementById('maxDraftsText').textContent = data.total_rows;
                const numDraftsInput = document.getElementById('numDraftsInput');
                numDraftsInput.max = data.total_rows;
                numDraftsInput.value = Math.min(5, data.total_rows); // default to 5 or max
                
                // Show config section
                document.getElementById('configSection').classList.remove('hidden');
                
            } catch (error) {
                alert('Error: ' + error.message);
                fileInput.value = ''; // reset on error
            } finally {
                uploadProgress.classList.add('hidden');
            }
        }
        
        document.getElementById('startDraftingBtn').addEventListener('click', async () => {
            if (!currentFile) return;
            
            const emailCol = document.getElementById('emailColumnSelect').value;
            const numDrafts = document.getElementById('numDraftsInput').value;
            
            const formData = new FormData();
            formData.append('file', currentFile);
            formData.append('email_column', emailCol);
            formData.append('num_drafts', numDrafts);

            const uploadProgressText = document.getElementById('uploadProgressText');
            uploadProgressText.textContent = "Drafting emails with AI...";
            document.getElementById('configSection').classList.add('hidden');
            uploadProgress.classList.remove('hidden');
            resultsGrid.innerHTML = '';

            try {
                const response = await fetch('/api/draft-emails', {
                    method: 'POST',
                    body: formData
                });

                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.detail || 'An error occurred during drafting.');
                }

                const data = await response.json();
                // Remember which drafting run these came from, for Dashboard/Analytics campaigns
                data.data.forEach(item => Object.assign(item, { campaign_id: data.campaign_id, campaign_name: data.campaign_name }));
                displayResults(data.data);
                
            } catch (error) {
                alert('Error: ' + error.message);
            } finally {
                uploadProgress.classList.add('hidden');
                fileInput.value = ''; // Reset after full flow completes
                currentFile = null;
            }
        });

        const approvedGrid = document.getElementById('approvedGrid');
        const approvedSection = document.getElementById('approvedSection');
        const approvedCount = document.getElementById('approvedCount');
        const sendAllBtn = document.getElementById('sendAllBtn');
        const sendAllStatus = document.getElementById('sendAllStatus');
        const sendAllStatusText = document.getElementById('sendAllStatusText');
        const stopSendAllBtn = document.getElementById('stopSendAllBtn');
        const SPINNER = '<div class="spinner" style="width: 14px; height: 14px; border-width: 2px;"></div>';

        let sendingAll = false;
        let stopRequested = false;

        // ---------- Report: one record per draft, kept in localStorage so it survives a page reload ----------
        const REPORT_KEY = 'zealEmailReport';
        const STATUS = { PENDING: 'Pending Review', APPROVED: 'Approved', DECLINED: 'Declined', SENT: 'Sent', FAILED: 'Failed' };
        const REPORT_COLUMNS = [
            ['company', 'Company Name'], ['contact', 'Contact Name'], ['email', 'Email'], ['status', 'Status'],
            ['subject', 'Subject'], ['body', 'Email Body'], ['regenerations', 'Regenerations'],
            ['change_requests', 'Changes Requested'], ['drafted_at', 'Drafted At'], ['approved_at', 'Approved At'],
            ['declined_at', 'Declined At'], ['sent_at', 'Sent At'], ['error', 'Error']
        ];

        let report = [];
        try { report = JSON.parse(localStorage.getItem(REPORT_KEY)) || []; } catch { report = []; }

        function timestamp() {
            const d = new Date();
            const pad = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        }

        function updateRecord(record, changes) {
            Object.assign(record, changes);
            try { localStorage.setItem(REPORT_KEY, JSON.stringify(report)); } catch { /* storage unavailable */ }
            renderReport();
        }

        function renderReport() {
            const count = status => report.filter(r => r.status === status).length;
            document.getElementById('statDrafted').textContent = report.length;
            document.getElementById('statApproved').textContent = count(STATUS.APPROVED);
            document.getElementById('statSent').textContent = count(STATUS.SENT);
            document.getElementById('statDeclined').textContent = count(STATUS.DECLINED);
            document.getElementById('statFailed').textContent = count(STATUS.FAILED);
            document.getElementById('reportBar').classList.toggle('hidden', report.length === 0);
            if (report.length === 0) reportMailsOpen = false;
            renderReportMails();
        }

        // Table of every draft in the report; click a row to read its email
        let reportMailsOpen = false;
        const expandedRecords = new Set();

        function renderReportMails() {
            const panel = document.getElementById('reportMails');
            panel.classList.toggle('hidden', !reportMailsOpen);
            document.getElementById('viewReportBtn').innerHTML = reportMailsOpen
                ? '<i data-lucide="chevron-up"></i> Hide mails'
                : '<i data-lucide="mail"></i> View mails';
            lucide.createIcons();
            if (!reportMailsOpen) return;

            const pillClass = { [STATUS.PENDING]: 'not-sent', [STATUS.APPROVED]: 'skipped', [STATUS.SENT]: 'sent', [STATUS.DECLINED]: 'failed', [STATUS.FAILED]: 'failed' };
            const body = document.getElementById('reportMailsBody');
            body.innerHTML = '';
            [...report].reverse().forEach(r => {
                const tr = body.insertRow();
                tr.className = 'expandable-row';
                tr.insertCell().textContent = r.company;
                tr.insertCell().textContent = r.contact;
                tr.insertCell().textContent = r.email;
                const pill = document.createElement('span');
                pill.className = `status-pill ${pillClass[r.status] || 'not-sent'}`;
                pill.textContent = r.status;
                tr.insertCell().appendChild(pill);
                tr.insertCell().textContent = r.subject;
                tr.insertCell().textContent = r.sent_at || r.declined_at || r.approved_at || r.drafted_at;

                const detail = body.insertRow();
                const open = expandedRecords.has(r.id);
                detail.className = 'mail-detail-row' + (open ? '' : ' hidden');
                tr.classList.toggle('open', open);
                const td = detail.insertCell();
                td.colSpan = 6;
                const mail = document.createElement('div');
                mail.className = 'mail-detail';
                let text = `To: ${r.contact ? `${r.contact} <${r.email}>` : r.email}\nSubject: ${r.subject}\n\n${r.body}`;
                if (r.change_requests) text += `\n\n— Changes requested: ${r.change_requests}`;
                if (r.error) text += `\n\n— Error: ${r.error}`;
                mail.textContent = text;
                td.appendChild(mail);
                tr.addEventListener('click', () => {
                    const nowOpen = !expandedRecords.has(r.id);
                    nowOpen ? expandedRecords.add(r.id) : expandedRecords.delete(r.id);
                    detail.classList.toggle('hidden', !nowOpen);
                    tr.classList.toggle('open', nowOpen);
                });
            });
        }

        document.getElementById('viewReportBtn').addEventListener('click', () => {
            reportMailsOpen = !reportMailsOpen;
            renderReportMails();
        });

        function reportRows() {
            return report.map(r => Object.fromEntries(REPORT_COLUMNS.map(([key, label]) => [label, r[key] ?? ''])));
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

        document.getElementById('exportCsvBtn').addEventListener('click', () => {
            const escape = v => `"${String(v).replace(/"/g, '""')}"`;
            const lines = [REPORT_COLUMNS.map(([, label]) => escape(label)).join(',')];
            reportRows().forEach(row => lines.push(Object.values(row).map(escape).join(',')));
            // BOM so Excel opens the UTF-8 file with the right encoding
            downloadBlob(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `email-report-${timestamp().slice(0, 10)}.csv`);
        });

        document.getElementById('exportExcelBtn').addEventListener('click', async () => {
            const btn = document.getElementById('exportExcelBtn');
            btn.disabled = true;
            try {
                const response = await fetch('/api/export-report', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rows: reportRows() })
                });
                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.detail || 'Could not export the report.');
                }
                downloadBlob(await response.blob(), `email-report-${timestamp().slice(0, 10)}.xlsx`);
            } catch (error) {
                alert('Error: ' + error.message);
            } finally {
                btn.disabled = false;
            }
        });

        document.getElementById('clearReportBtn').addEventListener('click', () => {
            if (!confirm('Clear the report history? Drafts still on screen will stay in the report.')) return;
            const liveIds = new Set(Array.from(document.querySelectorAll('.draft-card')).map(c => c.record && c.record.id));
            report = report.filter(r => liveIds.has(r.id));
            updateRecord({}, {});
        });

        renderReport();

        function updateCounts() {
            const draftsLeft = resultsGrid.querySelectorAll('.draft-card').length;
            const approvedLeft = approvedGrid.querySelectorAll('.draft-card').length;
            resultsCount.textContent = draftsLeft;
            approvedCount.textContent = approvedLeft;
            resultsSection.classList.toggle('hidden', draftsLeft === 0);
            approvedSection.classList.toggle('hidden', approvedLeft === 0 && !sendingAll);
        }

        // Sends one approved card's email. The server enforces the time gap between emails,
        // so this call can take a while when sending back-to-back.
        async function sendCard(card) {
            const sendBtn = card.querySelector('.send-btn');
            const originalHtml = sendBtn.innerHTML;
            sendBtn.disabled = true;
            sendBtn.innerHTML = `${SPINNER} Sending...`;

            try {
                const response = await fetch('/api/send-email', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        to_email: card.item.email,
                        to_name: card.recipientName,
                        channel: 'single',
                        campaign_id: card.item.campaign_id || '',
                        campaign_name: card.item.campaign_name || '',
                        company: card.record.company,
                        subject: card.item.subject,
                        body: card.querySelector('.draft-textarea').value
                    })
                });

                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.detail || 'An error occurred while sending.');
                }

                updateRecord(card.record, {
                    status: STATUS.SENT, sent_at: timestamp(), error: '',
                    subject: card.item.subject, body: card.querySelector('.draft-textarea').value
                });
                card.remove();
                updateCounts();
                return { ok: true };
            } catch (error) {
                updateRecord(card.record, { status: STATUS.FAILED, error: error.message });
                sendBtn.disabled = false;
                sendBtn.innerHTML = originalHtml;
                lucide.createIcons();
                return { ok: false, error: error.message };
            }
        }

        sendAllBtn.addEventListener('click', async () => {
            const cards = Array.from(approvedGrid.querySelectorAll('.draft-card'));
            if (cards.length === 0 || sendingAll) return;

            let gap = { interval_seconds: 20, jitter_seconds: 10 };
            try {
                gap = await (await fetch('/api/send-settings')).json();
            } catch { /* fall back to defaults */ }
            const minGap = gap.interval_seconds;
            const maxGap = gap.interval_seconds + gap.jitter_seconds;
            if (!confirm(`Send ${cards.length} approved email(s)? They go out one at a time, ${minGap}-${maxGap} seconds apart, to avoid spam filters.`)) return;

            sendingAll = true;
            stopRequested = false;
            sendAllBtn.disabled = true;
            approvedGrid.querySelectorAll('.send-btn, .decline-btn').forEach(b => b.disabled = true);
            sendAllStatus.classList.remove('hidden');
            stopSendAllBtn.disabled = false;

            let sent = 0;
            const failures = [];
            for (let i = 0; i < cards.length; i++) {
                if (i > 0) {
                    // Random gap between emails so the pattern doesn't look automated; checked often so Stop is instant
                    const waitUntil = Date.now() + (minGap + Math.random() * gap.jitter_seconds) * 1000;
                    while (!stopRequested && Date.now() < waitUntil) {
                        const secondsLeft = Math.ceil((waitUntil - Date.now()) / 1000);
                        sendAllStatusText.textContent = `${sent} of ${cards.length} sent. Next email to ${cards[i].item.email} in ${secondsLeft}s (spacing out to avoid spam)`;
                        await new Promise(r => setTimeout(r, 250));
                    }
                }
                if (stopRequested) break;
                sendAllStatusText.textContent = `Sending ${i + 1} of ${cards.length} to ${cards[i].item.email}...`;
                const result = await sendCard(cards[i]);
                if (result.ok) {
                    sent++;
                } else {
                    failures.push(`${cards[i].item.email}: ${result.error}`);
                    cards[i].querySelector('.send-btn').disabled = true;
                    // Gmail login/config problems or the daily cap will fail every remaining email too
                    if (/not configured|rejected the login|Daily send limit/.test(result.error)) break;
                }
            }

            sendingAll = false;
            sendAllBtn.disabled = false;
            approvedGrid.querySelectorAll('.send-btn, .decline-btn').forEach(b => b.disabled = false);
            sendAllStatus.classList.add('hidden');
            updateCounts();

            let summary = `${sent} of ${cards.length} email(s) sent.`;
            if (stopRequested) summary += ' Stopped early.';
            if (failures.length) summary += `\n\nFailed:\n${failures.join('\n')}`;
            alert(summary);
        });

        stopSendAllBtn.addEventListener('click', () => {
            stopRequested = true;
            stopSendAllBtn.disabled = true;
            sendAllStatusText.textContent = 'Stopping...';
        });

        // Approve/decline happen only in the browser, so tell the server for the Dashboard
        function logActivity(type, card) {
            fetch('/api/activity', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ events: [{
                    type, channel: 'single', campaign_id: card.item.campaign_id || '', campaign_name: card.item.campaign_name || '',
                    email: card.item.email, company: card.record.company, subject: card.item.subject
                }] })
            }).catch(() => { /* the dashboard just misses this one */ });
        }

        function displayResults(items) {
            if (!items || items.length === 0) {
                alert('No data could be processed from the file.');
                return;
            }

            items.forEach(item => {
                const clone = cardTemplate.content.cloneNode(true);
                const card = clone.querySelector('.draft-card');

                // Find the company and contact-person columns, whatever the sheet calls them
                const dataKeys = Object.keys(item.data);
                const companyKey = dataKeys.find(k => /company|organi[sz]ation|business|firm/i.test(k));
                const contactKey = dataKeys.find(k => k !== companyKey && /name|contact|person/i.test(k) && !/mail/i.test(k));
                const company = companyKey ? String(item.data[companyKey]) : '';
                const contact = contactKey ? String(item.data[contactKey]) : '';
                const companyName = company || contact || `Lead #${item.row_index + 1}`;
                card.item = item;
                card.recipientName = contact || company;
                card.record = {
                    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    company, contact, email: item.email, subject: item.subject, body: item.draft_body,
                    status: STATUS.PENDING, regenerations: 0, drafted_at: timestamp(),
                    approved_at: '', declined_at: '', sent_at: '', error: '', change_requests: ''
                };
                report.push(card.record);
                updateRecord(card.record, {});

                // Context preview (first few key-values)
                const contextPreview = dataKeys
                    .filter(k => k !== companyKey && item.data[k])
                    .slice(0, 3)
                    .map(k => `${k}: ${item.data[k]}`)
                    .join(' • ');

                clone.querySelector('.company-name').textContent = companyName;
                clone.querySelector('.context-preview').textContent = contextPreview || 'No additional context';
                const subjectText = clone.querySelector('.subject-text');
                subjectText.textContent = item.subject;

                const textarea = clone.querySelector('.draft-textarea');
                textarea.value = item.draft_body;

                // Copy button logic
                const copyBtn = clone.querySelector('.copy-btn');
                copyBtn.addEventListener('click', () => {
                    const textToCopy = `Subject: ${item.subject}\n\n${textarea.value}`;
                    navigator.clipboard.writeText(textToCopy).then(() => {
                        copyBtn.querySelector('i, svg').setAttribute('data-lucide', 'check');
                        copyBtn.style.color = 'var(--success)';
                        lucide.createIcons();

                        setTimeout(() => {
                            copyBtn.querySelector('i, svg').setAttribute('data-lucide', 'copy');
                            copyBtn.style.color = '';
                            lucide.createIcons();
                        }, 2000);
                    });
                });

                // Edit logic
                const editBtn = clone.querySelector('.edit-btn');
                editBtn.addEventListener('click', () => {
                    if (textarea.hasAttribute('readonly')) {
                        textarea.removeAttribute('readonly');
                        textarea.focus();
                        editBtn.textContent = 'Save';
                        editBtn.classList.remove('btn-outline');
                        editBtn.classList.add('btn-primary');
                    } else {
                        textarea.setAttribute('readonly', true);
                        editBtn.textContent = 'Edit';
                        updateRecord(card.record, { body: textarea.value });
                        editBtn.classList.remove('btn-primary');
                        editBtn.classList.add('btn-outline');
                    }
                });

                // Decline logic
                const declineBtn = clone.querySelector('.decline-btn');
                declineBtn.addEventListener('click', () => {
                    declineCard();
                });

                function declineCard() {
                    if (!confirm(`Decline the draft for ${companyName}? It will be removed and marked as declined in the report.`)) return;
                    updateRecord(card.record, { status: STATUS.DECLINED, declined_at: timestamp(), body: textarea.value });
                    logActivity('declined', card);
                    card.remove();
                    updateCounts();
                }

                // Regenerate logic
                const regenerateBtn = clone.querySelector('.regenerate-btn');
                const regenPanel = clone.querySelector('.regen-panel');
                const regenInput = clone.querySelector('.regen-input');
                const regenSubmit = clone.querySelector('.regen-submit');

                // Regenerate first asks what to change, in a panel on the card
                regenerateBtn.addEventListener('click', () => {
                    regenPanel.classList.toggle('hidden');
                    if (!regenPanel.classList.contains('hidden')) regenInput.focus();
                });
                clone.querySelector('.regen-cancel').addEventListener('click', () => {
                    regenPanel.classList.add('hidden');
                    regenInput.value = '';
                });
                clone.querySelectorAll('.regen-suggestions .variable-chip').forEach(chip => chip.addEventListener('click', () => {
                    const current = regenInput.value.trim();
                    regenInput.value = current ? `${current}. ${chip.textContent}` : chip.textContent;
                    regenInput.focus();
                }));
                regenInput.addEventListener('keydown', e => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) regenSubmit.click();
                });

                regenSubmit.addEventListener('click', async () => {
                    const instructions = regenInput.value.trim();
                    if (!instructions) {
                        regenInput.focus();
                        regenInput.placeholder = 'Please describe what to change first';
                        return;
                    }
                    const footerButtons = card.querySelectorAll('.card-footer-small button, .regen-panel button');
                    const originalHtml = regenSubmit.innerHTML;
                    footerButtons.forEach(b => b.disabled = true);
                    regenInput.disabled = true;
                    regenSubmit.innerHTML = `${SPINNER} Regenerating...`;

                    try {
                        const response = await fetch('/api/regenerate-draft', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                email: item.email,
                                data: item.data,
                                previous_subject: item.subject,
                                previous_body: textarea.value,
                                instructions
                            })
                        });

                        if (!response.ok) {
                            const errorData = await response.json();
                            throw new Error(errorData.detail || 'An error occurred while regenerating.');
                        }

                        const data = await response.json();
                        item.subject = data.subject;
                        item.draft_body = data.draft_body;
                        subjectText.textContent = data.subject;
                        textarea.value = data.draft_body;
                        updateRecord(card.record, {
                            subject: data.subject, body: data.draft_body,
                            regenerations: (card.record.regenerations || 0) + 1,
                            change_requests: [card.record.change_requests, instructions].filter(Boolean).join(' | ')
                        });
                        regenPanel.classList.add('hidden');
                        regenInput.value = '';
                    } catch (error) {
                        alert('Error: ' + error.message);
                    } finally {
                        footerButtons.forEach(b => b.disabled = false);
                        regenInput.disabled = false;
                        regenSubmit.innerHTML = originalHtml;
                        lucide.createIcons();
                    }
                });

                // Approve logic
                const approveBtn = clone.querySelector('.approve-btn');
                approveBtn.addEventListener('click', () => {
                    textarea.setAttribute('readonly', true);
                    regenPanel.remove();
                    updateRecord(card.record, { status: STATUS.APPROVED, approved_at: timestamp(), subject: item.subject, body: textarea.value });
                    logActivity('approved', card);

                    // Replace buttons with Decline + Send
                    const footer = card.querySelector('.card-footer-small');
                    footer.innerHTML = '';

                    const sendBtn = document.createElement('button');
                    sendBtn.className = 'btn btn-primary btn-success send-btn';
                    sendBtn.innerHTML = '<i data-lucide="send"></i> Send Email';
                    sendBtn.disabled = sendingAll;

                    const approvedDeclineBtn = document.createElement('button');
                    approvedDeclineBtn.className = 'btn btn-decline decline-btn';
                    approvedDeclineBtn.innerHTML = '<i data-lucide="x"></i> Decline';
                    approvedDeclineBtn.disabled = sendingAll;
                    approvedDeclineBtn.addEventListener('click', declineCard);

                    sendBtn.addEventListener('click', async () => {
                        const result = await sendCard(card);
                        alert(result.ok ? `Email sent to ${item.email}!` : 'Error: ' + result.error);
                    });

                    footer.appendChild(approvedDeclineBtn);
                    footer.appendChild(sendBtn);
                    card.style.borderColor = 'var(--success)';

                    // Move from resultsGrid to approvedGrid
                    approvedGrid.appendChild(card);
                    updateCounts();

                    lucide.createIcons();
                });

                resultsGrid.appendChild(clone);
            });

            updateCounts();
            lucide.createIcons();
        }
    }
});
