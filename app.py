"""
GrowthGPT — app.py
===================
STRUCTURE:
  1. Imports & Config
  2. Database Setup
  3. Auth Helpers
  4. AI Helpers
  5. Auth Routes       (/login  /signup  /logout)
  6. Chat Routes       (/new_chat  /get_chats  /get_chat  /rename_chat  /delete_chat  /clear)
  7. Message Routes    (/chat  /upload)
  8. Error Handlers
"""

import os, json, uuid, hashlib, PyPDF2
from datetime import datetime, timedelta
from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from openai import OpenAI
from werkzeug.utils import secure_filename

# ══════════════════════════════════════════
#  1. CONFIG
# ══════════════════════════════════════════
app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "growthgpt-secret-key-change-in-production")
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024   # 5 MB upload limit

BASE_DIR         = os.path.dirname(os.path.abspath(__file__))
DB_PATH = "/tmp/growthgpt.db"
ALLOWED_EXTENSIONS = {"txt", "pdf"}

client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY", "OPENAI_API_KEY"))

SYSTEM_PROMPT = (
    "You are GrowthGPT, an expert AI assistant specializing in marketing, "
    "startup growth, SEO, ad copy, and business strategy. "
    "Give clear, practical, beginner-friendly advice."
)


# ══════════════════════════════════════════
#  2. DATABASE SETUP
#  Uses SQLite — a simple file-based database.
#  No installation needed, built into Python.
# ══════════════════════════════════════════

def get_db():
    """Open a database connection. row_factory lets us use column names."""
    import sqlite3
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """
    Create tables on first run.
    
    users table  → stores accounts
    chats table  → stores conversations (linked to users by user_id)
    """
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            username   TEXT    NOT NULL UNIQUE,
            password   TEXT    NOT NULL,
            created_at TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chats (
            id         TEXT    PRIMARY KEY,
            user_id    INTEGER NOT NULL,
            title      TEXT    NOT NULL DEFAULT 'New Chat',
            messages   TEXT    NOT NULL DEFAULT '[]',
            created_at TEXT    NOT NULL,
            updated_at TEXT    NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
    """)
    conn.commit()
    conn.close()


# ── User DB helpers ─────────────────────

def create_user(username, password):
    """Insert new user. Returns user dict or None if username taken."""
    conn = get_db()
    try:
        now = datetime.utcnow().isoformat()
        conn.execute(
            "INSERT INTO users (username, password, created_at) VALUES (?,?,?)",
            (username.strip(), hash_pw(password), now)
        )
        conn.commit()
        row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        return dict(row)
    except Exception:
        return None          # username already exists
    finally:
        conn.close()


def find_user(username):
    """Find user by username. Returns dict or None."""
    conn = get_db()
    row  = conn.execute("SELECT * FROM users WHERE username=?", (username.strip(),)).fetchone()
    conn.close()
    return dict(row) if row else None


# ── Chat DB helpers ──────────────────────

def db_new_chat(user_id):
    """Create empty chat, return chat_id."""
    cid  = str(uuid.uuid4())[:8]
    now  = datetime.utcnow().isoformat()
    conn = get_db()
    conn.execute(
        "INSERT INTO chats (id,user_id,title,messages,created_at,updated_at) VALUES (?,?,?,?,?,?)",
        (cid, user_id, "New Chat", "[]", now, now)
    )
    conn.commit(); conn.close()
    return cid


def db_get_chats(user_id):
    """Return all chats for user, newest first. Only id/title/updated_at (fast)."""
    conn = get_db()
    rows = conn.execute(
        "SELECT id,title,updated_at FROM chats WHERE user_id=? ORDER BY updated_at DESC",
        (user_id,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def db_get_chat(chat_id, user_id):
    """Load one full chat including messages. Returns None if not found or wrong user."""
    conn = get_db()
    row  = conn.execute(
        "SELECT * FROM chats WHERE id=? AND user_id=?", (chat_id, user_id)
    ).fetchone()
    conn.close()
    if not row:
        return None
    chat = dict(row)
    chat["messages"] = json.loads(chat["messages"])
    return chat


def db_save(chat_id, user_id, messages, title=None):
    """Save updated messages (and optionally title) back to DB."""
    now  = datetime.utcnow().isoformat()
    conn = get_db()
    if title:
        conn.execute(
            "UPDATE chats SET messages=?,title=?,updated_at=? WHERE id=? AND user_id=?",
            (json.dumps(messages, ensure_ascii=False), title, now, chat_id, user_id)
        )
    else:
        conn.execute(
            "UPDATE chats SET messages=?,updated_at=? WHERE id=? AND user_id=?",
            (json.dumps(messages, ensure_ascii=False), now, chat_id, user_id)
        )
    conn.commit(); conn.close()


def db_rename(chat_id, user_id, new_title):
    conn = get_db()
    conn.execute(
        "UPDATE chats SET title=? WHERE id=? AND user_id=?",
        (new_title.strip()[:80], chat_id, user_id)
    )
    conn.commit(); conn.close()


def db_delete(chat_id, user_id):
    conn = get_db()
    conn.execute("DELETE FROM chats WHERE id=? AND user_id=?", (chat_id, user_id))
    conn.commit(); conn.close()


# ══════════════════════════════════════════
#  3. AUTH HELPERS
# ══════════════════════════════════════════

def hash_pw(password):
    """Hash password with SHA-256. Never store plain text passwords."""
    return hashlib.sha256(password.encode()).hexdigest()


def uid():
    """Return logged-in user's ID from session, or None."""
    return session.get("user_id")


def login_required(f):
    """Decorator: redirect to /login if user is not logged in."""
    from functools import wraps
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not uid():
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return wrapper


# ══════════════════════════════════════════
#  4. AI HELPERS
# ══════════════════════════════════════════

def ask_ai(messages):
    """Send message history to OpenAI, return reply text."""
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "system", "content": SYSTEM_PROMPT}] + messages,
        temperature=0.7,
        max_tokens=1024,
    )
    return resp.choices[0].message.content


def smart_title(first_msg):
    """
    Generate a short (≤5 word) title from the user's first message.
    Example: "How do I grow my startup?" → "Startup Growth Strategy"
    Falls back to truncated message if AI fails.
    """
    try:
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content":
                f"Make a short chat title, max 5 words, title case, no quotes, for: '{first_msg[:200]}'"
            }],
            max_tokens=15, temperature=0.4,
        )
        return resp.choices[0].message.content.strip().strip('"')[:60]
    except Exception:
        clean = first_msg.strip()[:40]
        return clean + ("…" if len(first_msg) > 40 else "")


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def extract_text(file):
    """Pull text out of a .txt or .pdf file object."""
    ext = secure_filename(file.filename).rsplit(".", 1)[1].lower()
    if ext == "txt":
        return file.read().decode("utf-8", errors="ignore")
    if ext == "pdf":
        reader = PyPDF2.PdfReader(file)
        text   = "\n".join(p.extract_text() or "" for p in reader.pages).strip()
        if not text:
            raise ValueError("PDF appears scanned — no text found.")
        return text
    raise ValueError(f"Unsupported: .{ext}")


# ══════════════════════════════════════════
#  5. AUTH ROUTES
# ══════════════════════════════════════════

@app.route("/signup", methods=["GET", "POST"])
def signup():
    if uid(): return redirect(url_for("index"))
    error = None
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "").strip()
        if len(username) < 3:
            error = "Username must be at least 3 characters."
        elif len(password) < 6:
            error = "Password must be at least 6 characters."
        else:
            user = create_user(username, password)
            if not user:
                error = "Username already taken."
            else:
                session["user_id"]  = user["id"]
                session["username"] = user["username"]
                return redirect(url_for("index"))
    return render_template("auth.html", mode="signup", error=error)


@app.route("/login", methods=["GET", "POST"])
def login():
    if uid(): return redirect(url_for("index"))
    error = None
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "").strip()
        user     = find_user(username)
        if not user or user["password"] != hash_pw(password):
            error = "Invalid username or password."
        else:
            session["user_id"]  = user["id"]
            session["username"] = user["username"]
            return redirect(url_for("index"))
    return render_template("auth.html", mode="login", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


# ══════════════════════════════════════════
#  6. CHAT ROUTES
# ══════════════════════════════════════════

@app.route("/")
@login_required
def index():
    return render_template("index.html", username=session.get("username", "User"))


@app.route("/new_chat", methods=["POST"])
@login_required
def new_chat():
    cid = db_new_chat(uid())
    return jsonify({"chat_id": cid})


@app.route("/get_chats")
@login_required
def get_chats():
    chats = db_get_chats(uid())
    # Add "section" label: Today / Yesterday / Previous
    today     = datetime.utcnow().date()
    yesterday = today - timedelta(days=1)
    for c in chats:
        try:
            d = datetime.fromisoformat(c["updated_at"]).date()
            if d == today:
                c["section"] = "Today"
            elif d == yesterday:
                c["section"] = "Yesterday"
            else:
                c["section"] = "Previous"
        except Exception:
            c["section"] = "Previous"
    return jsonify(chats)


@app.route("/get_chat/<chat_id>")
@login_required
def get_chat_route(chat_id):
    chat = db_get_chat(chat_id, uid())
    if not chat:
        return jsonify({"error": "Not found"}), 404
    return jsonify(chat)


@app.route("/rename_chat/<chat_id>", methods=["POST"])
@login_required
def rename_chat(chat_id):
    title = request.get_json().get("title", "").strip()
    if not title:
        return jsonify({"error": "Title empty"}), 400
    db_rename(chat_id, uid(), title)
    return jsonify({"status": "ok", "title": title[:80]})


@app.route("/delete_chat/<chat_id>", methods=["DELETE"])
@login_required
def delete_chat(chat_id):
    db_delete(chat_id, uid())
    return jsonify({"status": "deleted"})


@app.route("/clear", methods=["POST"])
@login_required
def clear():
    """Clear current chat history (keeps the chat, just wipes messages)."""
    data    = request.get_json() or {}
    chat_id = data.get("chat_id", "")
    chat    = db_get_chat(chat_id, uid())
    if chat:
        db_save(chat_id, uid(), [], title="New Chat")
    return jsonify({"status": "cleared"})


# ══════════════════════════════════════════
#  7. MESSAGE ROUTES
# ══════════════════════════════════════════

@app.route("/chat", methods=["POST"])
@login_required
def chat():
    """
    Handle user text message.
    1. Load chat from DB
    2. Add user message
    3. Call OpenAI
    4. Save reply
    5. Generate smart title on first message
    6. Return reply + updated title
    """
    try:
        data     = request.get_json()
        chat_id  = data.get("chat_id", "").strip()
        user_msg = data.get("message", "").strip()

        if not user_msg:
            return jsonify({"response": "⚠️ Please type a message."}), 400

        chat = db_get_chat(chat_id, uid())
        if not chat:
            return jsonify({"response": "⚠️ Chat not found."}), 404

        msgs     = chat["messages"]
        is_first = (len(msgs) == 0)

        msgs.append({"role": "user", "content": user_msg})
        reply = ask_ai(msgs)
        msgs.append({"role": "assistant", "content": reply})

        new_title = smart_title(user_msg) if is_first else None
        db_save(chat_id, uid(), msgs, title=new_title)

        return jsonify({"response": reply, "title": new_title or chat["title"]})

    except Exception as e:
        return jsonify({"response": f"⚠️ Error: {str(e)}"}), 500


@app.route("/upload", methods=["POST"])
@login_required
def upload():
    """Handle file upload + AI analysis."""
    try:
        if "file" not in request.files:
            return jsonify({"response": "⚠️ No file attached."}), 400

        file    = request.files["file"]
        chat_id = request.form.get("chat_id", "").strip()

        if not file.filename:
            return jsonify({"response": "⚠️ No file selected."}), 400
        if not allowed_file(file.filename):
            return jsonify({"response": "⚠️ Only .txt and .pdf files allowed."}), 415

        text     = extract_text(file)
        MAX_CHARS = 12_000
        truncated = text[:MAX_CHARS]
        was_cut   = len(text) > MAX_CHARS

        prompt = (
            f"Analyze this file and give a clear summary and key insights.\n\n"
            f"--- FILE ---\n{truncated}\n--- END ---"
            + ("\n\n[File was truncated]" if was_cut else "")
        )

        chat = db_get_chat(chat_id, uid())
        if not chat:
            return jsonify({"response": "⚠️ Chat not found."}), 404

        msgs     = chat["messages"]
        is_first = (len(msgs) == 0)
        fname    = secure_filename(file.filename)

        msgs.append({"role": "user", "content": prompt})
        reply = ask_ai(msgs)
        msgs.append({"role": "assistant", "content": reply})

        new_title = f"📄 {fname}" if is_first else None
        db_save(chat_id, uid(), msgs, title=new_title)

        return jsonify({
            "response":  reply,
            "title":     new_title or chat["title"],
            "filename":  fname,
            "truncated": was_cut,
        })

    except ValueError as ve:
        return jsonify({"response": f"⚠️ {ve}"}), 422
    except Exception as e:
        return jsonify({"response": f"⚠️ Upload error: {e}"}), 500


# ══════════════════════════════════════════
#  8. ERROR HANDLERS
# ══════════════════════════════════════════

@app.errorhandler(413)
def too_large(_):
    return jsonify({"response": "⚠️ File too large — max 5 MB."}), 413


# ══════════════════════════════════════════
#  ENTRY POINT
# ══════════════════════════════════════════
init_db() 
if __name__ == "__main__":
    init_db()
    app.run(debug=True)
    
    
    

 

