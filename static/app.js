/**
 * GrowthGPT — app.js
 * ====================
 * All frontend logic in one file, clearly explained.
 *
 * SECTIONS:
 *   1. State & DOM references
 *   2. Page startup
 *   3. Sidebar: load, render, search, sections
 *   4. Chat management: new, load, delete, rename
 *   5. Messaging: send text, upload file
 *   6. UI helpers: bubbles, typing indicator, toast, scroll
 *   7. Input events
 */


/* ════════════════════════════════════════════════
   1. STATE & DOM REFERENCES
════════════════════════════════════════════════ */

let activeChatId = null;   // which chat is currently open
let pendingFile  = null;   // file chosen but not yet sent
let allChats     = [];     // cached chat list for search filtering

const MAX_CHARS = 2000;
const MAX_BYTES = 5 * 1024 * 1024;  // 5 MB

// DOM shortcuts — we grab these once on load
const msgEl      = document.getElementById('messages');
const inputEl    = document.getElementById('user-input');
const sendBtn    = document.getElementById('send-btn');
const charCnt    = document.getElementById('char-cnt');
const attachBtn  = document.getElementById('attach-btn');
const fileInput  = document.getElementById('file-input');
const pillRow    = document.getElementById('pill-row');
const chatListEl = document.getElementById('chat-list');
const hdrTitle   = document.getElementById('hdr-title');
const searchInp  = document.getElementById('search-input');


/* ════════════════════════════════════════════════
   2. PAGE STARTUP
   On load: create a new chat + load the sidebar
════════════════════════════════════════════════ */

window.addEventListener('DOMContentLoaded', async () => {
  await startNewChat();    // creates a fresh chat
  await refreshSidebar();  // loads saved chats into sidebar

  // Sync header avatar letter with the sidebar user avatar
  const sbAv  = document.querySelector('.user-av');
  const hdrAv = document.getElementById('hdr-av-letter');
  if (sbAv && hdrAv) hdrAv.textContent = sbAv.textContent.trim();
});


/* ════════════════════════════════════════════════
   3. SIDEBAR: LOAD, RENDER, SEARCH, SECTIONS

   The sidebar shows all the user's past chats,
   grouped by Today / Yesterday / Previous.
   There is also a search box to filter by title.
════════════════════════════════════════════════ */

/**
 * refreshSidebar()
 * Fetch chats from server, cache them, render in sidebar.
 * Called after: page load, new message, new chat, delete.
 */
async function refreshSidebar() {
  const res = await fetch('/get_chats');
  allChats  = await res.json();   // [{ id, title, updated_at, section }, ...]
  renderSidebar(allChats);
}

/**
 * renderSidebar(list)
 * Build the sidebar HTML from a list of chat objects.
 * Groups chats under section headers: Today / Yesterday / Previous.
 *
 * @param {Array} list  - array of chat objects to render
 */
function renderSidebar(list) {
  if (list.length === 0) {
    chatListEl.innerHTML = '<div class="empty-chats">No chats yet.<br>Start a new conversation!</div>';
    return;
  }

  // Group chats by their section label
  const groups = { Today: [], Yesterday: [], Previous: [] };
  for (const c of list) {
    const sec = c.section || 'Previous';
    if (!groups[sec]) groups[sec] = [];
    groups[sec].push(c);
  }

  let html = '';

  // Render each section that has chats
  for (const [label, chats] of Object.entries(groups)) {
    if (chats.length === 0) continue;

    // Section label (e.g. "Today", "Yesterday")
    html += `<div class="section-label">${label}</div>`; // CSS handles styling

    // Each chat item in this section
    for (const c of chats) {
      const isActive = c.id === activeChatId ? 'active' : '';
      html += `
        <div class="ci ${isActive}" id="ci-${c.id}">
          <span class="ci-icon">💬</span>
          <div class="ci-body" onclick="loadChat('${c.id}')">
            <div class="ci-title" id="title-${c.id}">${escHtml(c.title)}</div>
            <div class="ci-time">${timeAgo(c.updated_at)}</div>
          </div>
          <div class="ci-actions">
            <button class="ci-btn ren" onclick="beginRename('${c.id}')" title="Rename">✏️</button>
            <button class="ci-btn del" onclick="deleteChat(event,'${c.id}')" title="Delete">✕</button>
          </div>
        </div>`;
    }
  }

  chatListEl.innerHTML = html;
}

/**
 * filterChats(query)
 * Called every time the user types in the search box.
 * Filters the cached allChats list by title (case-insensitive).
 *
 * @param {string} query - what the user typed
 */
function filterChats(query) {
  const q = query.toLowerCase().trim();
  if (!q) {
    // Empty search → show everything
    renderSidebar(allChats);
    return;
  }
  // Keep only chats whose title includes the search query
  const filtered = allChats.filter(c =>
    c.title.toLowerCase().includes(q)
  );
  renderSidebar(filtered);
}

/**
 * setActive(chatId)
 * Highlight the currently open chat in the sidebar.
 */
function setActive(chatId) {
  document.querySelectorAll('.ci').forEach(el => el.classList.remove('active'));
  const el = document.getElementById(`ci-${chatId}`);
  if (el) el.classList.add('active');
}


/* ════════════════════════════════════════════════
   4. CHAT MANAGEMENT
════════════════════════════════════════════════ */

/**
 * startNewChat()
 * Creates a brand-new empty chat on the server.
 * Resets the main area to the welcome screen.
 */
async function startNewChat() {
  const res    = await fetch('/new_chat', { method: 'POST' });
  const data   = await res.json();
  activeChatId = data.chat_id;

  hdrTitle.textContent = 'New Chat';
  clearFile();
  inputEl.value = '';
  inputEl.style.height = 'auto';
  renderWelcome();          // show welcome screen
  await refreshSidebar();
}

/**
 * loadChat(chatId)
 * Loads a previous chat when user clicks it in sidebar.
 * Fetches all messages and re-renders them.
 */
async function loadChat(chatId) {
  activeChatId = chatId;

  const res  = await fetch(`/get_chat/${chatId}`);
  const chat = await res.json();

  hdrTitle.textContent = chat.title;
  msgEl.innerHTML = '';  // clear current view

  // Render each saved message
  for (const m of chat.messages) {
    // The file analysis prompt is very long — show a short label instead
    if (m.role === 'user' && m.content.startsWith('Analyze this file')) {
      addBubble('user', '📎 [File uploaded for analysis]');
    } else {
      addBubble(m.role, m.content);
    }
  }

  setActive(chatId);

  // Close sidebar on mobile after selecting a chat
  if (window.innerWidth <= 680) {
    document.getElementById('sidebar').classList.remove('open');
  }
}

/**
 * deleteChat(event, chatId)
 * Deletes a chat. Uses stopPropagation so clicking ✕
 * doesn't also trigger loadChat() on the parent element.
 */
async function deleteChat(event, chatId) {
  event.stopPropagation();
  await fetch(`/delete_chat/${chatId}`, { method: 'DELETE' });
  // If we deleted the current chat, open a fresh one
  if (chatId === activeChatId) {
    await startNewChat();
  } else {
    await refreshSidebar();
  }
}

/**
 * beginRename(chatId)
 * Replaces the title text with an input field in-place.
 * User types new name, presses Enter or clicks away → finishRename().
 */
function beginRename(chatId) {
  const titleEl  = document.getElementById(`title-${chatId}`);
  const current  = titleEl.textContent;
  titleEl.innerHTML = `
    <input class="rename-inp" id="ri-${chatId}"
      value="${escHtml(current)}" maxlength="80"
      onclick="event.stopPropagation()"
      onkeydown="if(event.key==='Enter') finishRename('${chatId}')"
      onblur="finishRename('${chatId}')">`;
  const inp = document.getElementById(`ri-${chatId}`);
  inp.focus(); inp.select();
}

/**
 * finishRename(chatId)
 * Saves the new name to the server after inline editing.
 */
async function finishRename(chatId) {
  const inp = document.getElementById(`ri-${chatId}`);
  if (!inp) return;
  const newTitle = inp.value.trim() || 'Untitled';
  await fetch(`/rename_chat/${chatId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: newTitle })
  });
  if (chatId === activeChatId) hdrTitle.textContent = newTitle;
  await refreshSidebar();
  setActive(activeChatId);
}


/* ════════════════════════════════════════════════
   5. MESSAGING
════════════════════════════════════════════════ */

/**
 * handleSend()
 * Decides whether to send a file or a text message.
 */
function handleSend() {
  if (pendingFile) {
    uploadFile();
  } else {
    sendMessage();
  }
}

/**
 * sendMessage()
 * Sends a text message to /chat and shows the AI reply.
 *
 * FLOW:
 *   1. Show user bubble immediately (feels fast)
 *   2. Show "Thinking..." bubble with animated dots
 *   3. POST to /chat with { chat_id, message }
 *   4. Replace "Thinking..." with actual reply
 *   5. Update sidebar title if this was the first message
 */
async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || text.length > MAX_CHARS) return;

  // Reset input
  inputEl.value = '';
  inputEl.style.height = 'auto';
  charCnt.textContent = `0 / ${MAX_CHARS}`;
  sendBtn.disabled = true;

  addBubble('user', text);       // show user message
  const thinkBub = showThinking(); // show "Thinking..." bubble

  try {
    const res  = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: activeChatId, message: text })
    });
    const data = await res.json();

    // Replace the "Thinking..." bubble with the real reply
    replaceThinking(thinkBub, data.response);

    // If first message, AI generated a title — update sidebar
    if (data.title && data.title !== 'New Chat') {
      hdrTitle.textContent = data.title;
      await refreshSidebar();
      setActive(activeChatId);
    }
  } catch {
    replaceThinking(thinkBub, '⚠️ Connection error. Please try again.');
  }

  sendBtn.disabled = false;
  inputEl.focus();
}

/**
 * uploadFile()
 * Sends the selected file to /upload and shows AI analysis.
 * Same flow as sendMessage() but uses FormData.
 */
async function uploadFile() {
  if (!pendingFile) return;
  sendBtn.disabled = true;

  addBubble('user', `📎 Uploaded: ${pendingFile.name}`);
  const thinkBub = showThinking(); // file analysis

  const form = new FormData();
  form.append('file', pendingFile);
  form.append('chat_id', activeChatId);
  clearFile();  // clear the pill immediately

  try {
    const res  = await fetch('/upload', { method: 'POST', body: form });
    const data = await res.json();

    if (data.truncated) showToast('ℹ️ Large file — only first 12,000 chars analyzed.');

    replaceThinking(thinkBub, data.response, data.filename);

    if (data.title && data.title !== 'New Chat') {
      hdrTitle.textContent = data.title;
      await refreshSidebar();
      setActive(activeChatId);
    }
  } catch {
    replaceThinking(thinkBub, '⚠️ Upload failed. Please try again.');
  }

  sendBtn.disabled = false;
  inputEl.focus();
}


/* ════════════════════════════════════════════════
   6. UI HELPERS
════════════════════════════════════════════════ */

/**
 * renderWelcome()
 * Show the welcome / empty state screen in the messages area.
 */
function renderWelcome() {
  msgEl.innerHTML = `
    <div class="welcome" id="welcome">
      <div class="wlc-icon">🚀</div>
      <h2>Hi, I'm GrowthGPT</h2>
      <p>Your AI-powered growth partner. Ask anything or upload a file for insights.</p>
      <div class="prompt-grid">
        <div class="pc" onclick="usePrompt('How do I build a growth strategy for my startup?')">
          <span>📈</span><strong>Growth Strategy</strong><small>Build a roadmap that scales</small>
        </div>
        <div class="pc" onclick="usePrompt('What are the best marketing channels for early-stage startups?')">
          <span>📣</span><strong>Marketing Channels</strong><small>Find your audience</small>
        </div>
        <div class="pc" onclick="usePrompt('How do I improve user retention?')">
          <span>🎯</span><strong>Retention Tips</strong><small>Keep users coming back</small>
        </div>
        <div class="pc" onclick="usePrompt('Give me fundraising advice for my startup.')">
          <span>💰</span><strong>Fundraising</strong><small>Pitch and close investors</small>
        </div>
      </div>
    </div>`;
}

/**
 * hideWelcome()
 * Fade out and remove the welcome screen when first message is sent.
 */
function hideWelcome() {
  const w = document.getElementById('welcome');
  if (w) {
    w.style.opacity = '0';
    w.style.transition = 'opacity .2s ease';
    setTimeout(() => w.remove(), 200);
  }
}

/**
 * addBubble(role, text, fileBadge)
 * Creates a message bubble (user or bot) in the chat area.
 *
 * @param {string} role       - 'user' or 'bot'
 * @param {string} text       - message content
 * @param {string} fileBadge  - optional filename to show as badge
 */
function addBubble(role, text, fileBadge = null) {
  hideWelcome();
  const isUser = role === 'user';

  const row = document.createElement('div');
  row.className = `msg-row ${isUser ? 'user' : 'bot'}`;

  // Avatar
  const av = document.createElement('div');
  av.className = 'av';
  // User avatar = first letter of username (from the DOM)
  av.textContent = isUser
    ? (document.querySelector('.user-av')?.textContent || '👤')
    : '🌱';

  // Column (bubble + timestamp)
  const col = document.createElement('div');
  col.className = 'msg-col';

  const bub = document.createElement('div');
  bub.className = 'bubble';

  // Optional file badge (on bot reply after file upload)
  if (fileBadge) {
    const badge = document.createElement('div');
    badge.className = 'fbadge';
    badge.innerHTML = `${fileBadge.endsWith('.pdf') ? '📄' : '📝'} ${fileBadge}`;
    bub.appendChild(badge);
  }

  // Message text — convert newlines to <br> for multi-line responses
  const sp = document.createElement('span');
  sp.innerHTML = text.replace(/\n/g, '<br>');
  bub.appendChild(sp);

  // Timestamp
  const ts = document.createElement('div');
  ts.className = 'ts';
  ts.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  col.appendChild(bub);
  col.appendChild(ts);
  row.appendChild(av);
  row.appendChild(col);
  msgEl.appendChild(row);

  scrollToBottom();
  return bub;  // returned so we can replace it (for thinking bubble)
}

/**
 * showThinking(label)
 * Shows a "Thinking..." bubble with animated dots.
 * Returns a reference to the bubble element so we can replace it later.
 *
 * This is the KEY typing indicator feature:
 *   - Appears instantly when user hits Send
 *   - Gets replaced with real reply when AI responds
 *
 * @param {string} label - text shown above the dots
 * @returns {HTMLElement}  the bubble element
 */
function showThinking() {
  // Shows a clean ChatGPT-style typing bubble — just 3 animated dots, no text label
  hideWelcome();

  const row = document.createElement('div');
  row.className = 'msg-row bot';
  row.id = 'thinking-row';

  const av = document.createElement('div');
  av.className = 'av';
  av.textContent = '🌱';

  const col = document.createElement('div');
  col.className = 'msg-col';

  const bub = document.createElement('div');
  bub.className = 'bubble';
  bub.id = 'thinking-bub';
  // Pure dot animation — no "Thinking..." text, just like ChatGPT
  bub.innerHTML = `<div class="dots"><span></span><span></span><span></span></div>`;

  col.appendChild(bub);
  row.appendChild(av);
  row.appendChild(col);
  msgEl.appendChild(row);

  scrollToBottom();
  return bub;
}

/**
 * replaceThinking(bubEl, text, fileBadge)
 * Swaps the "Thinking..." bubble content with the real AI reply.
 * This creates a smooth, in-place replacement effect.
 *
 * @param {HTMLElement} bubEl    - the bubble element to replace
 * @param {string}      text     - the AI reply text
 * @param {string}      fileBadge - optional filename badge
 */
function replaceThinking(bubEl, text, fileBadge = null) {
  if (!bubEl) return;

  // Clear the dots and label
  bubEl.innerHTML = '';

  // Add file badge if present
  if (fileBadge) {
    const badge = document.createElement('div');
    badge.className = 'fbadge';
    badge.innerHTML = `${fileBadge.endsWith('.pdf') ? '📄' : '📝'} ${fileBadge}`;
    bubEl.appendChild(badge);
  }

  // Add the reply text
  const sp = document.createElement('span');
  sp.innerHTML = text.replace(/\n/g, '<br>');
  bubEl.appendChild(sp);

  // Add timestamp below the bubble (in the column)
  const col = bubEl.parentElement;
  if (col && !col.querySelector('.ts')) {
    const ts = document.createElement('div');
    ts.className = 'ts';
    ts.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    col.appendChild(ts);
  }

  scrollToBottom();
}

/**
 * scrollToBottom()
 * Smoothly scrolls the message area to the bottom.
 */
function scrollToBottom() {
  msgEl.scrollTo({ top: msgEl.scrollHeight, behavior: 'smooth' });
}

/**
 * showToast(msg)
 * Shows a small notification at the bottom of the screen for 3 seconds.
 */
function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

/**
 * usePrompt(text)
 * When a suggestion card is clicked, fill the input and send.
 */
function usePrompt(text) {
  inputEl.value = text;
  inputEl.dispatchEvent(new Event('input'));  // triggers auto-resize
  sendMessage();
}

/* ── File upload helpers ────────────────────────── */

function onFileChosen(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > MAX_BYTES) {
    showToast('⚠️ File too large — max 5 MB');
    fileInput.value = '';
    return;
  }
  setPendingFile(file);
}

function setPendingFile(file) {
  pendingFile = file;
  attachBtn.classList.add('has-file');
  // Show a pill above the input box
  pillRow.innerHTML = `
    <div class="file-pill">
      <span>${file.name.endsWith('.pdf') ? '📄' : '📝'}</span>
      <span class="pill-name">${file.name}</span>
      <span class="pill-size">${fmtBytes(file.size)}</span>
      <button class="pill-rm" onclick="clearFile()">✕</button>
    </div>`;
}

function clearFile() {
  pendingFile      = null;
  fileInput.value  = '';
  pillRow.innerHTML = '';
  attachBtn.classList.remove('has-file');
}

function fmtBytes(b) {
  return b < 1048576
    ? (b / 1024).toFixed(1) + ' KB'
    : (b / 1048576).toFixed(2) + ' MB';
}

/* ── Utility helpers ────────────────────────────── */

/**
 * timeAgo(isoString)
 * Converts a UTC ISO timestamp to a human-readable "X ago" string.
 * e.g. "2h ago", "just now", "3d ago"
 */
function timeAgo(iso) {
  const diff = Math.floor((Date.now() - new Date(iso + 'Z')) / 1000);
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return Math.floor(diff / 60)   + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600)  + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

/**
 * escHtml(str)
 * Escapes HTML special characters to prevent XSS attacks.
 * Always use this when inserting user-provided text as innerHTML.
 */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


/* ════════════════════════════════════════════════
   7. INPUT EVENTS
════════════════════════════════════════════════ */

// Auto-resize textarea as user types
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  const n = inputEl.value.length;
  charCnt.textContent  = `${n} / ${MAX_CHARS}`;
  charCnt.style.color  = n > MAX_CHARS * 0.9
    ? 'rgba(219,39,119,.9)'
    : 'var(--text-dim)';
});

// Enter sends, Shift+Enter adds a new line
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

// Drag & drop a file anywhere on the page
let dragCount = 0;
document.addEventListener('dragenter', e => {
  e.preventDefault();
  dragCount++;
});
document.addEventListener('dragleave', () => {
  dragCount--;
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  dragCount = 0;
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['txt', 'pdf'].includes(ext)) {
    showToast('⚠️ Only .txt and .pdf files are supported');
    return;
  }
  if (file.size > MAX_BYTES) {
    showToast('⚠️ File too large — max 5 MB');
    return;
  }
  setPendingFile(file);
});


