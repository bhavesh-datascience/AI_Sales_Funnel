import os
import io
import requests
from bs4 import BeautifulSoup
import pandas as pd
from typing import Literal
from fastapi import FastAPI, File, UploadFile, HTTPException, Form, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, StreamingResponse, RedirectResponse, JSONResponse
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import PydanticOutputParser
from langchain_groq import ChatGroq
import math
import re
import ssl
import html
import json
import time
import asyncio
import smtplib
import sqlite3
import threading
from collections import Counter
from datetime import timedelta
import hmac
import hashlib
import secrets
import imaplib
import email
from email import policy
from email.utils import parseaddr, parsedate_to_datetime
from langchain_core.output_parsers import StrOutputParser
from datetime import date, datetime
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid

load_dotenv()

app = FastAPI(title="Email Automation Agent")

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# ---------- Login ----------
# Credentials live in .env. The session is a signed cookie: "username|expiry|signature".

SESSION_COOKIE = "zeal_session"
SESSION_SECRET = os.environ.get("SESSION_SECRET") or secrets.token_hex(32)  # random fallback: sessions reset on restart
PUBLIC_PATHS = {"/login", "/api/login", "/favicon.ico"}

def sign_session(username: str, max_age: int) -> str:
    payload = f"{username}|{int(time.time()) + max_age}"
    signature = hmac.new(SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}|{signature}"

def session_user(request: Request) -> str | None:
    """The logged-in username, or None if the cookie is missing, tampered with or expired."""
    token = request.cookies.get(SESSION_COOKIE, "")
    try:
        username, expiry, signature = token.rsplit("|", 2)
    except ValueError:
        return None
    expected = hmac.new(SESSION_SECRET.encode(), f"{username}|{expiry}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected) or int(expiry) < time.time():
        return None
    return username

@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    if path in PUBLIC_PATHS or path.startswith("/static/") or session_user(request):
        return await call_next(request)
    if path.startswith("/api/"):
        return JSONResponse({"detail": "Your session has expired. Please log in again."}, status_code=401)
    return RedirectResponse("/login", status_code=303)

@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    if session_user(request):
        return RedirectResponse("/", status_code=303)
    with open("static/login.html", "r", encoding="utf-8") as f:
        page = f.read()
    version = int(os.path.getmtime("static/styles.css"))
    return page.replace('/static/styles.css"', f'/static/styles.css?v={version}"')

class LoginRequest(BaseModel):
    username: str
    password: str
    remember: bool = False

@app.post("/api/login")
async def login(req: LoginRequest):
    expected_user = os.environ.get("APP_USERNAME", "zeal")
    expected_password = os.environ.get("APP_PASSWORD", "zeal")
    # compare_digest on both fields so the check takes the same time whatever was typed
    user_ok = hmac.compare_digest(req.username.strip().encode(), expected_user.encode())
    password_ok = hmac.compare_digest(req.password.encode(), expected_password.encode())
    if not (user_ok and password_ok):
        await asyncio.sleep(1)  # slows down password guessing
        raise HTTPException(status_code=401, detail="Incorrect username or password.")

    max_age = 30 * 24 * 3600 if req.remember else 12 * 3600
    response = JSONResponse({"status": "success"})
    response.set_cookie(
        SESSION_COOKIE, sign_session(expected_user, max_age),
        max_age=max_age if req.remember else None,  # not remembered: cookie ends when the browser closes
        httponly=True, samesite="lax",
    )
    return response

# ---------- Activity log (feeds the Dashboard and Analytics) ----------
# Every draft, approval, decline, send, failure and skip is recorded in a small SQLite file.

DB_FILE = "activity.db"
db_lock = threading.Lock()

def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_FILE, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with db_lock, db_connect() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                type TEXT NOT NULL,          -- drafted, regenerated, approved, declined, sent, failed, skipped
                channel TEXT DEFAULT '',     -- single (AI drafts), bulk, reply
                campaign_id TEXT DEFAULT '',
                campaign_name TEXT DEFAULT '',
                email TEXT DEFAULT '',
                company TEXT DEFAULT '',
                subject TEXT DEFAULT '',
                detail TEXT DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
            CREATE TABLE IF NOT EXISTS replies (
                email TEXT PRIMARY KEY,
                reply_count INTEGER,
                first_reply_at TEXT,
                last_reply_at TEXT,
                last_subject TEXT,
                checked_at TEXT
            );
        """)

init_db()

def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")

def to_local_iso(value: str) -> str:
    """Gmail dates carry a timezone; store them as local time like everything else."""
    if not value:
        return ""
    try:
        d = datetime.fromisoformat(value)
        return (d.astimezone().replace(tzinfo=None) if d.tzinfo else d).isoformat(timespec="seconds")
    except ValueError:
        return ""

def log_events(events: list[dict]):
    """Record activity. Never lets a logging problem break the action being logged."""
    columns = ("type", "channel", "campaign_id", "campaign_name", "email", "company", "subject", "detail")
    try:
        with db_lock, db_connect() as conn:
            conn.executemany(
                f"INSERT INTO events (ts, {', '.join(columns)}) VALUES (?, {', '.join('?' * len(columns))})",
                [(now_iso(), *(str(e.get(c) or "")[:2000] for c in columns)) for e in events],
            )
    except Exception as e:
        print(f"Could not record activity: {e}")

def log_event(type: str, **fields):
    log_events([{"type": type, **fields}])

def company_from(row: dict) -> str:
    for key, value in (row or {}).items():
        if re.search(r"company|organi[sz]ation|business|firm", str(key), re.I) and value:
            return str(value).strip()
    return ""

def store_replies(results: list[dict]):
    with db_lock, db_connect() as conn:
        conn.executemany(
            """INSERT INTO replies (email, reply_count, first_reply_at, last_reply_at, last_subject, checked_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(email) DO UPDATE SET reply_count=excluded.reply_count, first_reply_at=excluded.first_reply_at,
                   last_reply_at=excluded.last_reply_at, last_subject=excluded.last_subject, checked_at=excluded.checked_at""",
            [(r["email"], r["reply_count"], to_local_iso(r.get("first_reply_date", "")), to_local_iso(r["last_reply_date"]),
              r["last_reply_subject"], now_iso()) for r in results],
        )

class ActivityEvent(BaseModel):
    type: Literal["approved", "declined", "skipped"]
    channel: str = ""
    campaign_id: str = ""
    campaign_name: str = ""
    email: str = ""
    company: str = ""
    subject: str = ""
    detail: str = ""

class ActivityRequest(BaseModel):
    events: list[ActivityEvent]

@app.post("/api/activity")
def record_activity(req: ActivityRequest):
    """Actions that happen only in the browser (approve, decline, client-side skips)."""
    log_events([e.model_dump() for e in req.events[:5000]])
    return {"status": "success"}

@app.post("/api/logout")
async def logout():
    response = JSONResponse({"status": "success"})
    response.delete_cookie(SESSION_COOKIE)
    return response

class DraftResponse(BaseModel):
    subject: str = Field(description="A short, specific, professional subject line (under 60 characters, no ALL CAPS, no exclamation marks, no emojis)")
    draft_body: str = Field(description="The body of the professional email draft")

# Using a standard fast model from Groq
model = ChatGroq(
    model="openai/gpt-oss-20b", 
    api_key=os.environ.get("GROQ_API_KEY"),
)

parser = PydanticOutputParser(pydantic_object=DraftResponse)

# Create a Prompt Template to control the AI's behavior
prompt = ChatPromptTemplate.from_messages([
    ("system", "You are an expert sales and email automation AI for 'Zeal Interactive Service', an event-based service company. You will be provided with information about a company or a contact. Your task is to write a short, highly professional, and engaging outreach email based on the provided context, positioning Zeal Interactive Service's event-based offerings as a solution or value-add. Keep it concise, natural, and persuasive. Do not use generic placeholders like [Your Name] if possible, just write the draft. Write it as a genuine one-to-one email in plain text so it does not land in spam: no ALL CAPS words, no exclamation marks, no emojis, no links or URLs, no prices or discounts, and avoid spam-trigger phrases such as 'free', 'guarantee', 'act now', 'limited time', 'risk-free', 'click here', '100%' or 'no obligation'.\n\n{format_instructions}"),
    ("human", "Here is the information to base the email on:\n{context}")
])

chain = prompt | model | parser

# Prompt for bulk-email templates: one email for a whole audience category, with {{variable}} placeholders
template_prompt = ChatPromptTemplate.from_messages([
    ("system", "You are an expert sales copywriter for 'Zeal Interactive Service', an event-based service company. Write ONE outreach email template that will be sent to many recipients who all belong to the same audience category. Position Zeal Interactive Service's event-based offerings as relevant to that kind of organisation. Keep it short (under 150 words), natural and persuasive, written like a genuine one-to-one email in plain text so it does not land in spam: no ALL CAPS words, no exclamation marks, no emojis, no links or URLs, no prices or discounts, and avoid spam-trigger phrases such as 'free', 'guarantee', 'act now', 'limited time', 'risk-free', 'click here', '100%' or 'no obligation'. Do not use placeholders like [Your Name].\n\nPersonalisation: {variable_rules}\n\n{format_instructions}"),
    ("human", "Audience category: {category}\nAdditional instructions from the user: {instructions}")
])

template_chain = template_prompt | model | parser

@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    with open("static/index.html", "r", encoding="utf-8") as f:
        page = f.read()
    # Show the logged-in user in the header
    page = page.replace("{{CURRENT_USER}}", html.escape(session_user(request) or ""))
    # Cache-busting: tag CSS/JS links with the file's modified time so browsers never use a stale copy
    for asset in ("styles.css", "app.js", "bulk.js", "inbox.js", "dashboard.js"):
        version = int(os.path.getmtime(f"static/{asset}"))
        page = page.replace(f"/static/{asset}\"", f"/static/{asset}?v={version}\"")
    return page

@app.post("/api/upload-preview")
async def upload_preview(file: UploadFile = File(...)):
    if not file.filename.endswith(('.xlsx', '.xls', '.csv')):
        raise HTTPException(status_code=400, detail="Invalid file type. Please upload an Excel or CSV file.")
    
    try:
        contents = await file.read()
        if file.filename.endswith('.csv'):
            df = pd.read_csv(io.BytesIO(contents))
        else:
            df = pd.read_excel(io.BytesIO(contents))
            
        columns = df.columns.tolist()
        total_rows = len(df)
        
        return {"status": "success", "columns": columns, "total_rows": total_rows}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def scrape_company_info(domain: str) -> str:
    """Attempt to scrape basic info from the company's domain."""
    if not domain:
        return ""
    
    url = f"http://www.{domain}" if not domain.startswith("www.") else f"http://{domain}"
    
    try:
        # Using a short timeout so we don't hang the drafting process
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        response = requests.get(url, headers=headers, timeout=5)
        
        if response.status_code == 200:
            soup = BeautifulSoup(response.text, 'html.parser')
            
            title = soup.title.string if soup.title else ""
            meta_desc = ""
            desc_tag = soup.find('meta', attrs={'name': 'description'})
            if desc_tag and desc_tag.get('content'):
                meta_desc = desc_tag['content']
                
            # Grab some readable text from paragraphs to get an idea of what they do
            paragraphs = soup.find_all('p')
            text_content = " ".join([p.get_text(strip=True) for p in paragraphs[:5]])
            
            scraped_info = f"Website Title: {title.strip()}\n"
            if meta_desc:
                scraped_info += f"Description: {meta_desc.strip()}\n"
            if text_content:
                scraped_info += f"Context from Website: {text_content[:500]}...\n"
                
            return scraped_info
    except Exception as e:
        print(f"Failed to scrape {domain}: {str(e)}")
        
    return ""

def build_context(row_dict: dict, email_val: str) -> str:
    """Turn a spreadsheet row (plus scraped website info for its email domain) into AI context."""
    domain = email_val.split("@")[-1].strip() if "@" in email_val else ""

    context_parts = [f"{k}: {v}" for k, v in row_dict.items() if v]
    if domain:
        context_parts.append(f"Target Company Domain: {domain}")
        # Real-time web search for context
        scraped_data = scrape_company_info(domain)
        if scraped_data:
            context_parts.append(f"\n--- Real-Time Website Data for {domain} ---\n{scraped_data}")

    return "\n".join(context_parts)

class RegenerateRequest(BaseModel):
    email: str = ""
    data: dict
    previous_subject: str = ""
    previous_body: str = ""
    instructions: str = ""

@app.post("/api/regenerate-draft")
def regenerate_draft(req: RegenerateRequest):
    if not req.instructions.strip():
        raise HTTPException(status_code=400, detail="Tell the AI what to change in the draft.")
    context_str = build_context(req.data, req.email)
    if not context_str.strip():
        raise HTTPException(status_code=400, detail="No data available to draft this email.")

    if req.previous_body:
        context_str += (
            "\n\n--- Current draft ---\n"
            f"Subject: {req.previous_subject}\n{req.previous_body}"
        )
    context_str += (
        "\n\n--- Changes requested by the user ---\n"
        f"{req.instructions.strip()}\n\n"
        "Rewrite the current draft applying exactly these changes. Keep everything the user did not ask "
        "to change, and keep the subject unless the changes call for a new one."
    )

    try:
        draft = chain.invoke({
            "context": context_str,
            "format_instructions": parser.get_format_instructions()
        })
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    log_event("regenerated", channel="single", email=req.email, company=company_from(req.data),
              subject=draft.subject, detail=req.instructions.strip())
    return {"status": "success", "subject": draft.subject, "draft_body": draft.draft_body}

@app.post("/api/draft-emails")
async def draft_emails(
    file: UploadFile = File(...),
    email_column: str = Form(...),
    num_drafts: int = Form(...)
):
    if not file.filename.endswith(('.xlsx', '.xls', '.csv')):
        raise HTTPException(status_code=400, detail="Invalid file type. Please upload an Excel or CSV file.")
    
    try:
        contents = await file.read()
        if file.filename.endswith('.csv'):
            df = pd.read_csv(io.BytesIO(contents))
        else:
            df = pd.read_excel(io.BytesIO(contents))
            
        # Limit rows
        df = df.head(num_drafts)
            
        results = []
        batch_id = f"drafts-{datetime.now():%Y%m%d-%H%M%S}"
        batch_name = f"AI drafts · {file.filename}"
        for index, row in df.iterrows():
            row_dict = {k: (v if not (isinstance(v, float) and math.isnan(v)) else "") for k, v in row.to_dict().items()}
            
            email_val = str(row_dict.get(email_column, ""))
            context_str = build_context(row_dict, email_val)

            if not context_str.strip():
                continue
                
            draft = chain.invoke({
                "context": context_str,
                "format_instructions": parser.get_format_instructions()
            })            
            results.append({
                "row_index": index,
                "email": email_val.strip(),
                "data": row_dict,
                "subject": draft.subject,
                "draft_body": draft.draft_body
            })
            log_event("drafted", channel="single", campaign_id=batch_id, campaign_name=batch_name,
                      email=email_val.strip(), company=company_from(row_dict), subject=draft.subject)
            
        return {"status": "success", "data": results, "campaign_id": batch_id, "campaign_name": batch_name}
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class SendEmailRequest(BaseModel):
    to_email: str
    to_name: str = ""
    subject: str
    body: str
    in_reply_to: str = ""
    references: str = ""
    # For the activity log
    channel: str = "single"
    campaign_id: str = ""
    campaign_name: str = ""
    company: str = ""

SEND_LOG_FILE = "sent_log.json"
send_lock = asyncio.Lock()
last_sent_at = 0.0

def load_send_log() -> dict:
    today = date.today().isoformat()
    try:
        with open(SEND_LOG_FILE, "r", encoding="utf-8") as f:
            log = json.load(f)
        if log.get("date") == today:
            return log
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return {"date": today, "recipients": []}

def save_send_log(log: dict):
    with open(SEND_LOG_FILE, "w", encoding="utf-8") as f:
        json.dump(log, f)

def build_message(req: SendEmailRequest, gmail_address: str) -> EmailMessage:
    from_name = os.environ.get("EMAIL_FROM_NAME", "Zeal Interactive Service")
    reply_to = os.environ.get("EMAIL_REPLY_TO") or gmail_address
    footer = os.environ.get("EMAIL_FOOTER", "If you'd prefer not to receive emails from us, just reply with \"unsubscribe\".")

    is_reply = bool(req.in_reply_to)
    text_body = req.body.strip()
    # Replies are part of a conversation, so they don't get the opt-out footer
    if footer and not is_reply:
        text_body += f"\n\n--\n{footer}"

    msg = EmailMessage()
    msg["From"] = formataddr((from_name, gmail_address))
    msg["To"] = formataddr((req.to_name, req.to_email)) if req.to_name else req.to_email
    msg["Reply-To"] = reply_to
    msg["Subject"] = req.subject.strip()
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=gmail_address.split("@")[-1])
    if is_reply:
        # Threading headers so the reply lands in the same conversation
        msg["In-Reply-To"] = req.in_reply_to
        msg["References"] = f"{req.references} {req.in_reply_to}".strip()
    else:
        # Lets mail clients show an "Unsubscribe" link, which spam filters reward
        msg["List-Unsubscribe"] = f"<mailto:{reply_to}?subject=unsubscribe>"

    # Send both plain text and HTML; HTML-only or text-only bulk mail scores worse with spam filters
    msg.set_content(text_body)
    paragraphs = "".join(
        f"<p>{html.escape(p).replace(chr(10), '<br>')}</p>" for p in text_body.split("\n\n") if p.strip()
    )
    msg.add_alternative(
        f'<html><body style="font-family: Arial, sans-serif; font-size: 14px; color: #222;">{paragraphs}</body></html>',
        subtype="html",
    )
    return msg

def smtp_send(msg: EmailMessage, gmail_address: str, app_password: str):
    # 465 = TLS from the first byte, 587 = STARTTLS; Gmail accepts App Passwords on both
    port = int(os.environ.get("SMTP_PORT", "465"))
    context = ssl.create_default_context()
    if port == 465:
        server = smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30, context=context)
    else:
        server = smtplib.SMTP("smtp.gmail.com", port, timeout=30)
        server.starttls(context=context)
    # EHLO must come before AUTH: if send_message() has to send it afterwards, Gmail starts a new
    # session, forgets the login, and rejects the sender with 530 Authentication Required
    server.ehlo()
    with server:
        # Log in with AUTH PLAIN only: server.login() falls back to AUTH LOGIN after a failure,
        # Gmail hangs up on that retry, and the real error (e.g. 534 WebLoginRequired) gets lost
        server.user, server.password = gmail_address, app_password
        server.auth("PLAIN", server.auth_plain)
        server.send_message(msg)

@app.get("/api/send-settings")
def send_settings():
    return {
        "interval_seconds": float(os.environ.get("SEND_INTERVAL_SECONDS", "20")),
        "jitter_seconds": float(os.environ.get("SEND_JITTER_SECONDS", "10")),
        "daily_limit": int(os.environ.get("DAILY_SEND_LIMIT", "400")),
        "sent_today": len(load_send_log()["recipients"]),
    }

class ExportReportRequest(BaseModel):
    rows: list[dict]

@app.post("/api/export-report")
def export_report(req: ExportReportRequest):
    if not req.rows:
        raise HTTPException(status_code=400, detail="The report is empty.")
    
    details = pd.DataFrame(req.rows)
    status_counts = details["Status"].value_counts() if "Status" in details else pd.Series(dtype=int)
    summary = pd.DataFrame(
        [("Generated At", datetime.now().strftime("%Y-%m-%d %H:%M:%S")), ("Total", len(details))]
        + [(str(status), int(count)) for status, count in status_counts.items()],
        columns=["Metric", "Value"],
    )
    
    buffer = io.BytesIO()
    with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
        summary.to_excel(writer, sheet_name="Summary", index=False)
        details.to_excel(writer, sheet_name="Details", index=False)
        for sheet in writer.sheets.values():
            sheet.freeze_panes = "A2"
            for column in sheet.columns:
                longest = max(len(str(cell.value or "")) for cell in column)
                sheet.column_dimensions[column[0].column_letter].width = min(max(longest + 2, 12), 60)
    buffer.seek(0)
    
    return StreamingResponse(
        buffer,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=email-report.xlsx"},
    )

@app.post("/api/send-email")
async def send_email(req: SendEmailRequest):
    return await deliver(req)

async def deliver(req: SendEmailRequest, allow_repeat: bool = False):
    """Send one email and record the outcome in the activity log."""
    fields = dict(channel=req.channel, campaign_id=req.campaign_id, campaign_name=req.campaign_name,
                  email=req.to_email.strip(), company=req.company, subject=req.subject)
    try:
        result = await send_with_safeguards(req, allow_repeat)
    except HTTPException as e:
        # 409 (already emailed today) and 429 (daily limit) are safeguards holding an email back, not delivery failures
        log_event("skipped" if e.status_code in (409, 429) else "failed", detail=str(e.detail), **fields)
        raise
    log_event("sent", **fields)
    return result

async def send_with_safeguards(req: SendEmailRequest, allow_repeat: bool = False):
    """Send one email through Gmail with all the anti-spam safeguards (gap, daily cap, no repeats)."""
    global last_sent_at

    gmail_address = os.environ.get("GMAIL_ADDRESS")
    app_password = os.environ.get("GMAIL_APP_PASSWORD", "").replace(" ", "")
    if not gmail_address or not app_password:
        raise HTTPException(status_code=500, detail="Gmail is not configured. Set GMAIL_ADDRESS and GMAIL_APP_PASSWORD in .env.")

    to_email = req.to_email.strip()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", to_email):
        raise HTTPException(status_code=400, detail=f"Invalid recipient email: '{req.to_email}'")
    req.to_email = to_email

    interval = float(os.environ.get("SEND_INTERVAL_SECONDS", "20"))
    daily_limit = int(os.environ.get("DAILY_SEND_LIMIT", "400"))

    # One send at a time, spaced out, capped per day, and never the same person twice a day:
    # bursts and repeats are what get a Gmail account flagged as a spammer
    async with send_lock:
        log = load_send_log()
        if to_email.lower() in log["recipients"] and not allow_repeat:
            raise HTTPException(status_code=409, detail=f"An email was already sent to {to_email} today.")
        if len(log["recipients"]) >= daily_limit:
            raise HTTPException(status_code=429, detail=f"Daily send limit of {daily_limit} reached. Try again tomorrow.")

        # Safety net: the UI adds the random extra gap itself (so Stop works instantly),
        # but the server never lets two emails go out closer than the minimum interval
        wait = interval - (time.monotonic() - last_sent_at)
        if wait > 0:
            await asyncio.sleep(wait)

        try:
            await asyncio.to_thread(smtp_send, build_message(req, gmail_address), gmail_address, app_password)
        except smtplib.SMTPAuthenticationError as e:
            gmail_reply = e.smtp_error.decode(errors="replace") if isinstance(e.smtp_error, bytes) else str(e.smtp_error)
            print(f"Gmail login failed ({e.smtp_code}): {gmail_reply}")
            if e.smtp_code == 534:
                raise HTTPException(status_code=502, detail="Google blocked the sign-in for security (534 WebLoginRequired). Sign in to this Gmail account in a browser on this computer, approve any 'Was this you?' security alert, then try again.")
            raise HTTPException(status_code=502, detail=f"Gmail rejected the login ({e.smtp_code}). Check GMAIL_ADDRESS and GMAIL_APP_PASSWORD (must be an App Password, not your normal password).")
        except smtplib.SMTPRecipientsRefused:
            raise HTTPException(status_code=400, detail=f"Gmail refused the recipient {to_email}.")
        except Exception as e:
            print(f"Gmail send failed: {type(e).__name__}: {e}")
            raise HTTPException(status_code=502, detail=f"Failed to send via Gmail: {str(e)}")

        last_sent_at = time.monotonic()
        log["recipients"].append(to_email.lower())
        save_send_log(log)

    return {"status": "success", "sent_today": len(log["recipients"]), "daily_limit": daily_limit}

# ---------- Bulk email: one template sent to a whole list ----------

VARIABLE_PATTERN = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")

def render_template(template: str, row: dict) -> tuple[str, list[str]]:
    """Fill {{Column Name}} placeholders from a row (case-insensitive). Returns (text, missing variable names)."""
    lookup = {str(k).strip().lower(): ("" if v is None else str(v).strip()) for k, v in row.items()}
    missing = []

    def fill(match):
        name = match.group(1)
        value = lookup.get(name.strip().lower(), "")
        if not value:
            missing.append(name)
        return value

    return VARIABLE_PATTERN.sub(fill, template), missing

@app.post("/api/parse-list")
async def parse_list(file: UploadFile = File(...)):
    if not file.filename.endswith(('.xlsx', '.xls', '.csv')):
        raise HTTPException(status_code=400, detail="Invalid file type. Please upload an Excel or CSV file.")

    try:
        contents = await file.read()
        # Read everything as text so phone numbers, zip codes etc. keep their exact formatting
        if file.filename.endswith('.csv'):
            df = pd.read_csv(io.BytesIO(contents), dtype=str, keep_default_na=False)
        else:
            df = pd.read_excel(io.BytesIO(contents), dtype=str).fillna("")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read the file: {str(e)}")

    df.columns = [str(c).strip() for c in df.columns]
    df = df.apply(lambda col: col.str.strip())
    return {"status": "success", "columns": df.columns.tolist(), "rows": df.to_dict(orient="records")}

class GenerateTemplateRequest(BaseModel):
    category: str
    instructions: str = ""
    variables: list[str] = []

@app.post("/api/generate-template")
def generate_template(req: GenerateTemplateRequest):
    if not req.category.strip():
        raise HTTPException(status_code=400, detail="Choose or enter an audience category.")

    if req.variables:
        placeholders = ", ".join("{{" + v + "}}" for v in req.variables)
        variable_rules = (
            f"Use these placeholders where they read naturally, spelled exactly like this including the double curly braces: {placeholders}. "
            "They are replaced with each recipient's real data. Do not invent any other placeholders."
        )
    else:
        variable_rules = "Do not use any placeholders or variables at all; write a greeting that works for any recipient, such as 'Hi there,'."

    try:
        draft = template_chain.invoke({
            "category": req.category.strip(),
            "instructions": req.instructions.strip() or "None",
            "variable_rules": variable_rules,
            "format_instructions": parser.get_format_instructions(),
        })
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {"status": "success", "subject": draft.subject, "body": draft.draft_body}

class BulkEmailRequest(BaseModel):
    to_email: str
    to_name: str = ""
    subject: str
    body: str
    variables: dict = {}
    campaign_id: str = ""
    campaign_name: str = ""

@app.post("/api/send-bulk-email")
async def send_bulk_email(req: BulkEmailRequest):
    subject, missing_subject = render_template(req.subject, req.variables)
    body, missing_body = render_template(req.body, req.variables)

    # Every variable used in the template is required: never send an email with a blank where a value should be
    missing = list(dict.fromkeys(missing_subject + missing_body))
    if missing:
        detail = f"Not sent: missing value for {', '.join(missing)}"
        log_event("skipped", channel="bulk", campaign_id=req.campaign_id, campaign_name=req.campaign_name,
                  email=req.to_email, company=company_from(req.variables), detail=detail)
        raise HTTPException(status_code=422, detail=detail)
    if not subject.strip() or not body.strip():
        raise HTTPException(status_code=400, detail="Subject and body are required.")

    return await deliver(SendEmailRequest(
        to_email=req.to_email, to_name=req.to_name, subject=subject, body=body, channel="bulk",
        campaign_id=req.campaign_id, campaign_name=req.campaign_name, company=company_from(req.variables),
    ))

# ---------- Inbox (Gmail over IMAP) ----------

IMAP_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

def imap_connect() -> imaplib.IMAP4_SSL:
    gmail_address = os.environ.get("GMAIL_ADDRESS")
    app_password = os.environ.get("GMAIL_APP_PASSWORD", "").replace(" ", "")
    if not gmail_address or not app_password:
        raise HTTPException(status_code=500, detail="Gmail is not configured. Set GMAIL_ADDRESS and GMAIL_APP_PASSWORD in .env.")
    try:
        conn = imaplib.IMAP4_SSL("imap.gmail.com", 993, timeout=30)
    except OSError as e:
        raise HTTPException(status_code=502, detail=f"Could not reach Gmail: {e}")
    try:
        conn.login(gmail_address, app_password)
    except imaplib.IMAP4.error as e:
        reason = e.args[0].decode(errors="replace") if e.args and isinstance(e.args[0], bytes) else str(e)
        print(f"Gmail IMAP login failed: {reason}")
        raise HTTPException(status_code=502, detail=f"Gmail rejected the inbox login ({reason}). Sign in to this Gmail account in a browser and approve any security alert, and check GMAIL_APP_PASSWORD is a current App Password.")
    return conn

def imap_close(conn):
    try:
        conn.logout()
    except Exception:
        pass

def find_all_mail(conn) -> str:
    """Gmail's 'All Mail' folder (name depends on account language); it includes archived replies."""
    typ, boxes = conn.list()
    for line in boxes or []:
        text = line.decode(errors="replace") if isinstance(line, bytes) else str(line)
        if "\\All" in text:
            return text.rsplit(' "/" ', 1)[-1].strip()
    return "INBOX"

def iso_date(value: str) -> str:
    try:
        return parsedate_to_datetime(value).isoformat()
    except Exception:
        return ""

def fetch_summaries(conn, uids: list[int]) -> list[dict]:
    """Headers + read state for a set of UIDs (selected mailbox), newest first."""
    if not uids:
        return []
    typ, data = conn.uid("FETCH", ",".join(map(str, uids)), "(UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)])")
    summaries = []
    for part in data or []:
        if not isinstance(part, tuple):
            continue
        meta = part[0].decode(errors="replace")
        uid_match = re.search(r"UID (\d+)", meta)
        if not uid_match:
            continue
        flags_match = re.search(r"FLAGS \(([^)]*)\)", meta)
        headers = email.message_from_bytes(part[1], policy=policy.default)
        from_name, from_email = parseaddr(str(headers.get("From", "")))
        summaries.append({
            "uid": int(uid_match.group(1)),
            "from_name": from_name or from_email,
            "from_email": from_email.lower(),
            "subject": str(headers.get("Subject", "")) or "(no subject)",
            "date": iso_date(str(headers.get("Date", ""))),
            "unread": "\\Seen" not in (flags_match.group(1) if flags_match else ""),
        })
    return sorted(summaries, key=lambda m: m["uid"], reverse=True)

def html_to_text(markup: str) -> str:
    """Readable plain text from an HTML email: line breaks at block elements, inline tags kept on one line."""
    soup = BeautifulSoup(markup, "html.parser")
    for tag in soup(["script", "style", "head"]):
        tag.decompose()
    for br in soup.find_all("br"):
        br.replace_with("\n")
    for block in soup.find_all(["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"]):
        block.append("\n")
    lines = (re.sub(r"[ \t\xa0]+", " ", line).strip() for line in soup.get_text().splitlines())
    return "\n".join(lines)

def fetch_message(conn, mailbox: str, uid: int) -> dict:
    conn.select(mailbox, readonly=True)
    typ, data = conn.uid("FETCH", str(uid), "(BODY.PEEK[])")
    raw = next((part[1] for part in data or [] if isinstance(part, tuple)), None)
    if raw is None:
        raise HTTPException(status_code=404, detail="Email not found. It may have been deleted or moved.")

    msg = email.message_from_bytes(raw, policy=policy.default)
    body = ""
    part = msg.get_body(preferencelist=("plain", "html"))
    if part is not None:
        content = part.get_content()
        body = html_to_text(content) if part.get_content_type() == "text/html" else content
    body = re.sub(r"\n{3,}", "\n\n", body.replace("\r\n", "\n")).strip()

    from_name, from_email = parseaddr(str(msg.get("From", "")))
    return {
        "uid": uid,
        "mailbox": mailbox,
        "from_name": from_name or from_email,
        "from_email": from_email.lower(),
        "to": str(msg.get("To", "")),
        "subject": str(msg.get("Subject", "")) or "(no subject)",
        "date": iso_date(str(msg.get("Date", ""))),
        "message_id": str(msg.get("Message-ID", "")),
        "references": str(msg.get("References", "")),
        "body": body,
        "attachments": [a.get_filename() or "attachment" for a in msg.iter_attachments()],
    }

@app.get("/api/inbox")
def list_inbox(limit: int = 25, before_uid: int = 0, q: str = ""):
    limit = max(1, min(limit, 100))
    conn = imap_connect()
    try:
        conn.select("INBOX", readonly=True)
        if q.strip():
            # Gmail search syntax, same as the Gmail search box (e.g. "from:acme.com", "is:unread")
            typ, data = conn.uid("SEARCH", "X-GM-RAW", '"' + q.replace('"', "").strip() + '"')
        else:
            typ, data = conn.uid("SEARCH", None, "ALL")
        uids = sorted(int(u) for u in (data[0] or b"").split())
        if before_uid:
            uids = [u for u in uids if u < before_uid]
        page = uids[-limit:]
        return {"mailbox": "INBOX", "messages": fetch_summaries(conn, page), "has_more": len(uids) > len(page)}
    finally:
        imap_close(conn)

@app.get("/api/inbox/message")
def get_message(uid: int, mailbox: str = "INBOX"):
    conn = imap_connect()
    try:
        return fetch_message(conn, mailbox, uid)
    finally:
        imap_close(conn)

class InboxReplyRequest(BaseModel):
    uid: int
    mailbox: str = "INBOX"
    body: str

@app.post("/api/inbox/reply")
async def reply_to_message(req: InboxReplyRequest):
    if not req.body.strip():
        raise HTTPException(status_code=400, detail="Write a reply first.")
    conn = await asyncio.to_thread(imap_connect)
    try:
        original = await asyncio.to_thread(fetch_message, conn, req.mailbox, req.uid)
    finally:
        imap_close(conn)

    subject = original["subject"]
    if not subject.lower().startswith("re:"):
        subject = f"Re: {subject}"
    # A reply continues a conversation, so the once-per-day rule doesn't apply (the time gap still does)
    return await deliver(SendEmailRequest(
        to_email=original["from_email"], to_name=original["from_name"], subject=subject, body=req.body,
        in_reply_to=original["message_id"], references=original["references"], channel="reply",
    ), allow_repeat=True)

reply_prompt = ChatPromptTemplate.from_messages([
    ("system", "You write email replies on behalf of 'Zeal Interactive Service', an event-based service company. Write a short, warm, professional reply to the email below. Answer what they asked; if they are interested, propose a next step such as a short call. Plain text only: no subject line, no placeholders like [Your Name], no exclamation marks, no emojis. Sign off as 'Zeal Interactive Service'."),
    ("human", "From: {sender}\nSubject: {subject}\n\n{body}")
])
reply_chain = reply_prompt | model | StrOutputParser()

class AiReplyRequest(BaseModel):
    uid: int
    mailbox: str = "INBOX"

@app.post("/api/inbox/ai-reply")
def ai_reply(req: AiReplyRequest):
    conn = imap_connect()
    try:
        original = fetch_message(conn, req.mailbox, req.uid)
    finally:
        imap_close(conn)
    try:
        draft = reply_chain.invoke({
            "sender": f"{original['from_name']} <{original['from_email']}>",
            "subject": original["subject"],
            "body": original["body"][:6000],
        })
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"status": "success", "body": draft.strip()}

# ---------- Reply tracker: who on a list has replied ----------

class CheckRepliesRequest(BaseModel):
    emails: list[str]
    since: str = ""  # YYYY-MM-DD: only count replies on or after this date

def imap_or_from(addresses: list[str]) -> list[str]:
    """IMAP search criteria matching mail FROM any of the addresses: OR FROM a OR FROM b FROM c"""
    criteria = []
    for address in addresses[:-1]:
        criteria += ["OR", "FROM", f'"{address}"']
    return criteria + ["FROM", f'"{addresses[-1]}"']

@app.post("/api/check-replies")
def check_replies(req: CheckRepliesRequest):
    emails = list(dict.fromkeys(e.strip().lower() for e in req.emails if re.fullmatch(r"[^@\s\"]+@[^@\s\"]+\.[^@\s\"]+", e.strip())))
    if not emails:
        raise HTTPException(status_code=400, detail="No valid email addresses to check.")
    if len(emails) > 5000:
        raise HTTPException(status_code=400, detail="Please check at most 5000 addresses at a time.")
    result = find_replies(emails, req.since)
    store_replies(result["results"])
    return result

def find_replies(emails: list[str], since: str = "") -> dict:
    """Search Gmail (All Mail) for messages from each address."""
    req = CheckRepliesRequest(emails=emails, since=since)

    since_criteria = []
    if req.since:
        try:
            d = datetime.strptime(req.since, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=400, detail="Date must be in YYYY-MM-DD format.")
        since_criteria = ["SINCE", f"{d.day:02d}-{IMAP_MONTHS[d.month - 1]}-{d.year}"]

    replies = {address: [] for address in emails}
    conn = imap_connect()
    try:
        mailbox = find_all_mail(conn)
        conn.select(mailbox, readonly=True)
        # Search in batches (one OR-query per batch) instead of one round trip per address
        for i in range(0, len(emails), 25):
            batch = emails[i:i + 25]
            typ, data = conn.uid("SEARCH", None, *since_criteria, *imap_or_from(batch))
            uids = [int(u) for u in (data[0] or b"").split()]
            # IMAP FROM is a substring match, so confirm the exact sender address
            for message in fetch_summaries(conn, uids):
                if message["from_email"] in replies:
                    replies[message["from_email"]].append(message)

        # Text of each person's latest reply, for the report
        latest_text = {}
        for address, found in replies.items():
            if not found:
                continue
            latest = max(found, key=lambda m: m["date"] or "")
            try:
                latest_text[address] = fetch_message(conn, mailbox, latest["uid"])["body"][:3000]
            except Exception as e:
                print(f"Could not read reply from {address}: {e}")
    finally:
        imap_close(conn)

    results = []
    for address in emails:
        found = sorted(replies[address], key=lambda m: m["date"] or "", reverse=True)
        latest = found[0] if found else None
        results.append({
            "email": address,
            "replied": bool(found),
            "reply_count": len(found),
            "last_reply_date": latest["date"] if latest else "",
            "first_reply_date": found[-1]["date"] if found else "",
            "last_reply_subject": latest["subject"] if latest else "",
            "last_reply_uid": latest["uid"] if latest else None,
            "last_reply_text": latest_text.get(address, ""),
        })
    return {"mailbox": mailbox, "results": results}

# ---------- Dashboard & Analytics ----------

@app.post("/api/stats/check-replies")
def refresh_replies():
    """Check Gmail for replies from everyone we've emailed, so reply rates are current."""
    with db_lock, db_connect() as conn:
        emails = [r["email"] for r in conn.execute(
            "SELECT DISTINCT lower(email) AS email FROM events WHERE type = 'sent' AND channel != 'reply' AND email != ''")]
    if not emails:
        return {"status": "success", "checked": 0, "replied": 0}
    results = []
    for i in range(0, len(emails), 5000):
        results += find_replies(emails[i:i + 5000])["results"]
    store_replies(results)
    return {"status": "success", "checked": len(results), "replied": sum(r["replied"] for r in results)}

@app.get("/api/stats")
def stats(days: int = 30):
    """Everything the Dashboard and Analytics pages show, for the last `days` days (0 = all time)."""
    today = date.today()
    since = (datetime.combine(today, datetime.min.time()) - timedelta(days=days - 1)).isoformat() if days > 0 else ""

    with db_lock, db_connect() as conn:
        events = [dict(r) for r in conn.execute("SELECT * FROM events WHERE ts >= ? ORDER BY id", (since,))]
        reply_rows = {r["email"]: dict(r) for r in conn.execute("SELECT * FROM replies")}
        last_check = conn.execute("SELECT max(checked_at) FROM replies").fetchone()[0]

    counts = Counter(e["type"] for e in events)
    outreach = [e for e in events if e["channel"] != "reply"]
    sent = [e for e in outreach if e["type"] == "sent"]

    # First time each person was emailed in this period; they "replied" if Gmail has mail from them after that
    first_sent = {}
    for e in sent:
        first_sent.setdefault(e["email"].lower(), e["ts"])
    replied = {}
    for address, sent_at in first_sent.items():
        r = reply_rows.get(address)
        if r and r["reply_count"] and (r["last_reply_at"] or "") >= sent_at:
            replied[address] = max(r["first_reply_at"] or "", sent_at)  # first reply we can attribute to this period

    # Daily series
    start = datetime.fromisoformat(since).date() if since else (
        datetime.fromisoformat(events[0]["ts"]).date() if events else today)
    start = max(start, today - timedelta(days=364))
    day_keys = [(start + timedelta(days=i)).isoformat() for i in range((today - start).days + 1)]
    daily = {k: {"date": k, "sent": 0, "failed": 0, "replies": 0} for k in day_keys}
    for e in outreach:
        k = e["ts"][:10]
        if k in daily and e["type"] in ("sent", "failed"):
            daily[k][e["type"]] += 1
    for reply_at in replied.values():
        if reply_at[:10] in daily:
            daily[reply_at[:10]]["replies"] += 1

    # Personalised (AI drafts) funnel
    single = [e for e in events if e["channel"] == "single"]
    single_sent = {e["email"].lower() for e in single if e["type"] == "sent"}
    funnel = [
        {"stage": "Drafted", "value": sum(e["type"] == "drafted" for e in single)},
        {"stage": "Approved", "value": sum(e["type"] == "approved" for e in single)},
        {"stage": "Sent", "value": sum(e["type"] == "sent" for e in single)},
        {"stage": "Replied", "value": len(single_sent & replied.keys())},
    ]

    # Campaigns: each drafting run or bulk send
    campaigns = {}
    for e in events:
        if not e["campaign_id"]:
            continue
        c = campaigns.setdefault(e["campaign_id"], {
            "id": e["campaign_id"], "name": e["campaign_name"] or e["campaign_id"], "channel": e["channel"],
            "started": e["ts"], "last_activity": e["ts"], "counts": Counter(), "recipients": set()})
        c["last_activity"] = e["ts"]
        c["counts"][e["type"]] += 1
        if e["type"] == "sent":
            c["recipients"].add(e["email"].lower())
    campaign_list = []
    for c in sorted(campaigns.values(), key=lambda c: c["started"], reverse=True):
        replied_count = len(c["recipients"] & replied.keys())
        campaign_list.append({
            "id": c["id"], "name": c["name"], "channel": c["channel"], "started": c["started"],
            "last_activity": c["last_activity"], "drafted": c["counts"]["drafted"], "sent": c["counts"]["sent"],
            "failed": c["counts"]["failed"], "skipped": c["counts"]["skipped"], "declined": c["counts"]["declined"],
            "replied": replied_count,
            "reply_rate": round(100 * replied_count / len(c["recipients"]), 1) if c["recipients"] else 0,
        })

    # Why emails didn't go out
    reasons = Counter()
    for e in events:
        if e["type"] in ("failed", "skipped") and e["detail"]:
            reasons[re.sub(r"\S+@\S+", "<email>", e["detail"])[:90]] += 1

    # Recipient domains
    domain_sent, domain_replied = Counter(), Counter()
    for address in first_sent:
        domain = address.split("@")[-1]
        domain_sent[domain] += 1
        domain_replied[domain] += address in replied

    channel_names = {"single": "AI drafts", "bulk": "Bulk email", "reply": "Inbox replies"}
    channels = Counter(e["channel"] for e in events if e["type"] == "sent")
    send_log = load_send_log()

    return {
        "range_days": days,
        "generated_at": now_iso(),
        "last_reply_check": last_check,
        "totals": {
            "sent": len(sent),
            "unique_recipients": len(first_sent),
            "replied": len(replied),
            "reply_rate": round(100 * len(replied) / len(first_sent), 1) if first_sent else 0,
            "failed": sum(e["type"] == "failed" for e in outreach),
            "skipped": counts["skipped"],
            "drafted": counts["drafted"],
            "regenerated": counts["regenerated"],
            "approved": counts["approved"],
            "declined": counts["declined"],
            "replies_sent": sum(e["type"] == "sent" for e in events if e["channel"] == "reply"),
        },
        "today": {"sent": len(send_log["recipients"]), "daily_limit": int(os.environ.get("DAILY_SEND_LIMIT", "400"))},
        "daily": list(daily.values()),
        "funnel": funnel,
        "channels": [{"channel": channel_names.get(k, k or "Other"), "value": channels[k]}
                     for k in ("single", "bulk", "reply") if channels[k]],
        "campaigns": campaign_list,
        "reasons": [{"reason": r, "count": n} for r, n in reasons.most_common(8)],
        "domains": [{"domain": d, "sent": n, "replied": domain_replied[d],
                     "reply_rate": round(100 * domain_replied[d] / n, 1)} for d, n in domain_sent.most_common(10)],
        "recent": [
            {"ts": e["ts"], "type": e["type"], "channel": channel_names.get(e["channel"], e["channel"]),
             "email": e["email"], "company": e["company"], "subject": e["subject"], "detail": e["detail"]}
            for e in reversed(events) if e["type"] in ("sent", "failed", "skipped", "declined", "approved")
        ][:12],
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)