'use strict';

// The chat: straight between the pages, kept nowhere.
// (One page, cut in parts: see index.html for the order they load in.)

// ------------------------------------------------------------------ chat

// A few words and links beside the talk. They go straight from page to page,
// over the lines between them — never to a server, the organizer's included —
// and are kept nowhere but in the memory of the pages that are in the call
// now. Whoever comes in compares notes with the others and is given what was
// written before; whoever leaves takes nothing along; when the last one has
// left, there is nothing left.

const CHAT_MOST = 300, CHAT_LONG = 2000;
const chatSeen = new Set();
state.chat = [];   // { id, name, t, text, mine }
let chatNew = 0;   // came while the chat was closed

// The chat is out of the way until asked for: a button among the call's
// own, with a count of what has come in meanwhile, opens it over the call.
function chatOpen(on) {
  $('chatPanel').hidden = !on;
  if (!on) return;
  chatNew = 0;
  renderChat();
  const list = $('chatList');
  list.scrollTop = list.scrollHeight;
  // On a phone the keyboard would cover half of it at once; let them read first.
  if (!('ontouchstart' in window)) $('chatText').focus();
}
$('chatBtn').onclick = () => chatOpen(true);
$('chatClose').onclick = () => chatOpen(false);
$('chatPanel').onclick = (e) => { if (e.target === $('chatPanel')) chatOpen(false); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('chatPanel').hidden) chatOpen(false); });

function chatAdd(msg, mine) {
  if (!msg || !/^[0-9a-f]{12}$/.test(msg.id) || chatSeen.has(msg.id)) return false;
  if (typeof msg.text !== 'string' || !msg.text.trim() || typeof msg.t !== 'number') return false;
  // The oldest give way once there are too many — and don't come back.
  if (state.chat.length >= CHAT_MOST && msg.t <= state.chat[0].t) return false;
  chatSeen.add(msg.id);
  state.chat.push({
    // A time from the future would park the message at the end for good and,
    // with enough of them, push everything else out.
    id: msg.id, name: String(msg.name || 'Guest').slice(0, 32), t: Math.min(msg.t, Date.now()), text: msg.text.slice(0, CHAT_LONG), mine: !!mine,
  });
  state.chat.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  while (state.chat.length > CHAT_MOST) chatSeen.delete(state.chat.shift().id);
  renderChat();
  return true;
}

function chatSay() {
  const text = $('chatText').value.trim();
  if (!text || !state.me || state.ended) return;
  $('chatText').value = '';
  const msg = { id: randomHex(6), name: state.me.name, t: Date.now(), text: text.slice(0, CHAT_LONG) };
  chatAdd(msg, true);
  for (const peer of state.peers.values()) toPeer(peer, { type: 'chat', msg });
}
$('chatSend').onclick = chatSay;
$('chatText').onkeydown = (e) => { if (e.key === 'Enter') chatSay(); };

// "This is what I have": the other page answers with what is missing.
function chatCompare(peer) {
  toPeer(peer, { type: 'chat-have', ids: state.chat.map((m) => m.id) });
}
// Now and then as well: not every two pages are always connected, and a
// message that missed somebody reaches them by way of the others.
setInterval(() => {
  if (!state.me || state.ended || !state.chat.length) return;
  for (const peer of state.peers.values()) chatCompare(peer);
}, 45000);

// Says whether the word was about the chat.
function chatWord(peer, m) {
  switch (m.type) {
    case 'chat':
      // Who wrote it is known from the line it came by, not from what it says.
      if (m.msg && chatAdd({ ...m.msg, name: peer.info.name }, false) && $('chatPanel').hidden) {
        chatNew++;
        renderChat();
        toast(`💬 ${peer.info.name}: ${String(m.msg.text).slice(0, 80)}`);
      }
      return true;
    case 'chat-have': {
      const theirs = new Set(Array.isArray(m.ids) ? m.ids : []);
      let batch = [], size = 0;
      const flush = () => {
        if (batch.length) toPeer(peer, { type: 'chat-past', msgs: batch });
        batch = [];
        size = 0;
      };
      for (const x of state.chat) {
        if (theirs.has(x.id)) continue;
        batch.push({ id: x.id, name: x.name, t: x.t, text: x.text });
        size += x.text.length + 80;
        if (size > 3000) flush();   // a line takes messages of a modest size only
      }
      flush();
      return true;
    }
    case 'chat-past':
      for (const x of (Array.isArray(m.msgs) ? m.msgs : []).slice(0, CHAT_MOST)) chatAdd(x, false);
      return true;
  }
  return false;
}

function renderChat() {
  const list = $('chatList');
  const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.textContent = '';
  for (const m of state.chat) {
    const row = document.createElement('div');
    row.className = 'chat-msg' + (m.mine ? ' mine' : '');
    const who = document.createElement('span');
    who.className = 'chat-who';
    const at = new Date(m.t);
    // By name, one's own too: a message that comes back with the history
    // after leaving and returning is then signed the same as it was.
    who.textContent = `${m.name} · ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    const text = document.createElement('div');
    // Links can be tapped; everything else is shown as written.
    for (const piece of m.text.split(/(https?:\/\/[^\s<>"']+)/)) {
      if (/^https?:\/\//.test(piece)) {
        const a = document.createElement('a');
        a.href = piece;
        a.textContent = piece;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        text.appendChild(a);
      } else if (piece) {
        text.appendChild(document.createTextNode(piece));
      }
    }
    row.append(who, text);
    list.appendChild(row);
  }
  list.hidden = !state.chat.length;
  $('chatEmpty').hidden = !!state.chat.length;
  $('chatNew').textContent = chatNew > 99 ? '99+' : chatNew;
  $('chatNew').hidden = !chatNew;
  $('chatCount').textContent = chatNew ? `${chatNew > 99 ? '99+' : chatNew} new` : '';
  if (atEnd || (state.chat.length && state.chat[state.chat.length - 1].mine)) list.scrollTop = list.scrollHeight;
}
