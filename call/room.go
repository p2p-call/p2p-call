package call

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/coder/websocket"
)

// Room is the one call this program hosts. The server only introduces the
// participants to each other and passes their WebRTC handshakes along; the
// audio itself goes directly between the browsers.
//
// The host is whoever presents hostToken — the page the program opens on the
// organizer's own device. Everybody else is a guest. Through the tunnel every
// request comes from 127.0.0.1, so addresses can't tell them apart.
type Room struct {
	hostToken string
	maxPeers  int
	grace     time.Duration // how long a dropped participant's place is kept

	mu     sync.Mutex
	peers  map[string]*peer
	locked bool
	banned map[string]bool // client keys of kicked guests
	invite string          // the link to give people, once there is one
	// id is the organizer's key; with it guests' connections can be sealed
	// (wire.go). sealedOnly: guests are let in over a sealed connection
	// only — the case whenever there is a permanent link to come by.
	// pass is the word such a guest has to say: it comes from the secret in
	// the link, so it shows they were given the link and didn't put it
	// together from what the board or the tunnel can see.
	id         *identity
	sealedOnly bool
	pass       string
	// siteOrigin is where a guest's page comes from when the call has a
	// link: the site of the links. Empty: the usual one.
	siteOrigin string
	// config is what a page needs to know before it meets the others (the
	// servers that help two browsers find each other, where to look for the
	// call if it moves); it rides in the welcome, sealed with the rest.
	config json.RawMessage
	onBan  func(key string) // remembers a removed guest beyond this run; may be nil
	onEnd  func()           // the host has ended the call for everyone; may be nil
	// The organizer's page may ask whether the tunnel's address still leads
	// here, and have the tunnel take a new one (see tunnelCtl in tunnel.go).
	// Nil where there is no tunnel to ask about.
	tunnel *tunnelCtl
	// onAbandoned is called when the call has been without its organizer
	// for hostWait: their page was closed, or never opened. The program has
	// no window of its own, so otherwise it would go on running unseen. May
	// be nil — then the call waits for as long as it takes.
	onAbandoned func()
	hostWait    time.Duration
	hostTimer   *time.Timer
}

type peer struct {
	id    string
	name  string
	host  bool
	key   string
	muted bool
	music bool   // is playing a song to everyone
	video string // what they are showing: "", "camera", "screen" or "both"

	// conn is nil while the participant's connection to the server is down.
	// Their place is kept for Room.grace: the voice goes directly between the
	// browsers and usually survives, so the others shouldn't lose them over a
	// blip. Messages for them wait in send until they are back.
	conn *wire
	stop chan struct{} // ends the writer of the current conn
	gen  int           // counts connections, so an old grace timer can tell it is stale
	// send carries ready-to-write messages; a nil message means "close now".
	send chan []byte
	// lost is set once a message didn't fit into send: the page has missed
	// something and must join afresh instead of resuming.
	lost bool
}

type peerInfo struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Host  bool   `json:"host"`
	Muted bool   `json:"muted"`
	Music bool   `json:"music"`
	Video string `json:"video"`
}

// inMsg is everything a client may send. Which fields matter depends on Type.
type inMsg struct {
	Type   string          `json:"type"`
	Pub    string          `json:"pub"` // on hello: the page's fresh key, see wire.go
	Name   string          `json:"name"`
	Key    string          `json:"key"`
	Host   string          `json:"host"`
	Resume string          `json:"resume"` // on join: the id held before the connection dropped
	Pass   string          `json:"pass"`   // on join: the word from the link's secret
	Text   string          `json:"text"`
	To     string          `json:"to"`
	ID     string          `json:"id"`
	Data   json.RawMessage `json:"data"`
	Locked *bool           `json:"locked"`
	Muted  *bool           `json:"muted"`
	Music  *bool           `json:"music"`
	Video  *string         `json:"video"`
}

const (
	sendBuffer   = 256
	readLimit    = 64 << 10
	joinTimeout  = 20 * time.Second
	writeTimeout = 10 * time.Second
	// The page pings every 10 seconds; a connection silent for this long is
	// dead even if nobody has told us so.
	readTimeout  = 45 * time.Second
	defaultGrace = 2 * time.Minute
	maxNameRunes = 32

	// Close codes the page reads to tell the person what happened.
	closeRejected = websocket.StatusCode(4000)
	closeKicked   = websocket.StatusCode(4001)
	// And one the page sends: it is being closed, don't keep the place.
	closeLeft = websocket.StatusCode(4002)
)

func NewRoom(hostToken string, maxPeers int) *Room {
	return &Room{
		hostToken: hostToken,
		maxPeers:  maxPeers,
		grace:     defaultGrace,
		peers:     map[string]*peer{},
		banned:    map[string]bool{},
	}
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func cleanName(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > maxNameRunes {
		s = strings.TrimSpace(string(r[:maxNameRunes]))
	}
	if s == "" {
		s = "Guest"
	}
	return s
}

// watchHost starts counting when no organizer's page is connected, and stops
// when one is. Callers hold r.mu.
func (r *Room) watchHost() {
	if r.onAbandoned == nil {
		return
	}
	for _, p := range r.peers {
		if p.host && p.conn != nil {
			if r.hostTimer != nil {
				r.hostTimer.Stop()
				r.hostTimer = nil
			}
			return
		}
	}
	if r.hostTimer != nil {
		return
	}
	var t *time.Timer
	t = time.AfterFunc(r.hostWait, func() {
		r.mu.Lock()
		gone := r.hostTimer == t
		r.mu.Unlock()
		if gone {
			r.onAbandoned()
		}
	})
	r.hostTimer = t
}

// AbandonAfter makes the call give itself up (fn is called) once it has
// been without its organizer's page for wait. It counts from now.
func (r *Room) abandonAfter(wait time.Duration, fn func()) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.onAbandoned, r.hostWait = fn, wait
	r.watchHost()
}

func (r *Room) site() string {
	if r.siteOrigin != "" {
		return r.siteOrigin
	}
	return "https://" + siteHost
}

func (r *Room) isHostToken(t string) bool {
	return t != "" && subtle.ConstantTimeCompare([]byte(t), []byte(r.hostToken)) == 1
}

func (p *peer) info() peerInfo {
	return peerInfo{ID: p.id, Name: p.name, Host: p.host, Muted: p.muted, Music: p.music, Video: p.video}
}

// enqueue hands a message to the peer's writer. A peer that can't keep up is
// dropped rather than allowed to hold everybody else up. Callers hold r.mu.
func (p *peer) enqueue(msg []byte) {
	select {
	case p.send <- msg:
	default:
		p.lost = true
		if p.conn != nil {
			go p.conn.CloseNow()
		}
	}
}

// attach gives the peer a live connection and a writer for it. Callers hold r.mu.
func (p *peer) attach(conn *wire) {
	p.gen++
	p.conn = conn
	p.stop = make(chan struct{})
	go p.writeLoop(conn, p.stop)
}

// unplug stops the writer and forgets the connection. Callers hold r.mu.
func (p *peer) unplug() {
	if p.conn != nil {
		close(p.stop)
		p.conn = nil
	}
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

// broadcast sends to everyone except skip. Callers hold r.mu.
func (r *Room) broadcast(msg []byte, skip *peer) {
	for _, p := range r.peers {
		if p != skip {
			p.enqueue(msg)
		}
	}
}

// join admits a peer or says why not. resumed tells that it is a participant
// coming back on a new connection rather than a new one.
func (r *Room) join(m inMsg, conn *wire) (p *peer, resumed bool, reason string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	host := r.isHostToken(m.Host)
	key := strings.TrimSpace(m.Key)
	if len(key) > 64 {
		key = key[:64]
	}

	// Coming back after a dropped connection: same id, same place, and the
	// others never notice. The browser key (which only its owner and the
	// server know) proves it is the same person.
	// (Across the tunnel only over a sealed connection, like any guest's.)
	if old := r.peers[m.Resume]; old != nil && key != "" && old.key == key && (old.host || !r.sealedOnly || conn.sealed()) {
		if stale := old.conn; stale != nil {
			go stale.CloseNow()
		}
		old.unplug()
		if !old.lost {
			old.enqueue(mustJSON(map[string]any{"type": "resumed"}))
			old.attach(conn)
			r.watchHost()
			return old, true, ""
		}
		r.remove(old) // missed too much; let them in as new below
	}
	if !host {
		switch {
		case r.sealedOnly && !conn.sealed():
			return nil, false, "unsealed"
		case r.sealedOnly && subtle.ConstantTimeCompare([]byte(m.Pass), []byte(r.pass)) != 1:
			return nil, false, "nolink"
		case key != "" && r.banned[key]:
			return nil, false, "banned"
		case r.locked:
			return nil, false, "locked"
		case len(r.peers) >= r.maxPeers:
			return nil, false, "full"
		}
	}

	p = &peer{
		id:   randomHex(6),
		name: cleanName(m.Name),
		host: host,
		key:  key,
		send: make(chan []byte, sendBuffer),
	}
	others := make([]peerInfo, 0, len(r.peers))
	for _, o := range r.peers {
		others = append(others, o.info())
	}
	welcome := map[string]any{
		"type":   "welcome",
		"id":     p.id,
		"host":   p.host,
		"name":   p.name,
		"peers":  others,
		"locked": r.locked,
	}
	if host && r.invite != "" {
		welcome["invite"] = r.invite
	}
	if len(r.config) > 0 {
		welcome["config"] = r.config
	}
	// The welcome goes first, and peer-joined reaches the others before any
	// offer the newcomer sends them: both ride the same ordered queues.
	p.enqueue(mustJSON(welcome))
	r.broadcast(mustJSON(map[string]any{"type": "peer-joined", "peer": p.info()}), nil)
	r.peers[p.id] = p
	p.attach(conn)
	r.watchHost()
	return p, false, ""
}

// remove takes p out of the room if it is still there. Callers hold r.mu.
func (r *Room) remove(p *peer) bool {
	if r.peers[p.id] != p {
		return false
	}
	delete(r.peers, p.id)
	r.broadcast(mustJSON(map[string]any{"type": "peer-left", "id": p.id}), nil)
	return true
}

// dropped is called when conn has ended. Unless the participant has left on
// purpose, been removed, or is already back on a newer connection, their
// place is kept for r.grace.
func (r *Room) dropped(p *peer, conn *wire, left bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p.conn != conn {
		return
	}
	p.unplug()
	if left {
		r.remove(p) // the page was closed: nothing to wait for
	}
	r.watchHost()
	if r.peers[p.id] != p {
		log.Printf("- %s (%s)", p.name, p.id)
		return
	}
	log.Printf("… %s (%s): lost connection to the server, waiting %v", p.name, p.id, r.grace)
	gen := p.gen
	time.AfterFunc(r.grace, func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		if p.conn == nil && p.gen == gen && r.remove(p) {
			log.Printf("- %s (%s): didn't come back", p.name, p.id)
		}
	})
}

func (r *Room) handle(p *peer, m inMsg) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.peers[p.id] != p {
		return // already kicked; its last messages are ignored
	}

	switch m.Type {
	case "ping":
		p.enqueue(pong)

	case "leave":
		r.remove(p)

	case "diag":
		// The page reports how its direct connections are doing, so that
		// "the sound dropped" can be looked up in the organizer's window.
		log.Printf("  %s: %s", p.name, cleanDiag(m.Text))

	case "signal":
		// An SDP or ICE candidate for one other participant, passed on as is.
		if to := r.peers[m.To]; to != nil && to != p && len(m.Data) > 0 {
			to.enqueue(mustJSON(map[string]any{"type": "signal", "from": p.id, "data": m.Data}))
		}

	case "status":
		if m.Muted != nil {
			p.muted = *m.Muted
		}
		if m.Music != nil {
			p.music = *m.Music
		}
		// The picture itself goes directly between the browsers, like the
		// voice; this only tells the others that there is one to show.
		if m.Video != nil && (*m.Video == "" || *m.Video == "camera" || *m.Video == "screen" || *m.Video == "both") {
			p.video = *m.Video
		}
		r.broadcast(mustJSON(map[string]any{"type": "status", "id": p.id, "muted": p.muted, "music": p.music, "video": p.video}), p)

	case "music-info":
		// Whoever plays a song tells the others what it is and where it has
		// got to — so that the organizer can drive it too.
		if p.music && len(m.Data) > 0 && len(m.Data) <= 1024 {
			r.broadcast(mustJSON(map[string]any{"type": "music-info", "id": p.id, "data": m.Data}), p)
		}

	case "music-ctl":
		// The organizer pauses, winds or stops somebody's song; their page
		// does it, the song being theirs.
		if t := r.peers[m.ID]; p.host && t != nil && t != p && t.music && len(m.Data) > 0 && len(m.Data) <= 256 {
			t.enqueue(mustJSON(map[string]any{"type": "music-ctl", "data": m.Data}))
		}

	case "tunnel-check":
		// Is the address people were given still alive? Looked up from
		// here, through the tunnel itself, and not while the room waits.
		if !p.host {
			return
		}
		go func() {
			ok := r.tunnel.alive()
			r.mu.Lock()
			defer r.mu.Unlock()
			p.enqueue(mustJSON(map[string]any{"type": "tunnel", "ok": ok}))
		}()

	case "tunnel-renew":
		// The tunnel has hung, or the organizer wants a fresh address: the
		// new one comes as a new invite, like any change of address.
		if !p.host {
			return
		}
		if err := r.tunnel.renew(); err != nil {
			p.enqueue(mustJSON(map[string]any{"type": "tunnel", "ok": false, "error": err.Error()}))
			return
		}
		log.Printf("The host asked to reconnect the tunnel.")
		p.enqueue(mustJSON(map[string]any{"type": "tunnel", "ok": true, "renewing": true}))

	case "lock":
		if p.host && m.Locked != nil {
			r.locked = *m.Locked
			r.broadcast(mustJSON(map[string]any{"type": "locked", "locked": r.locked}), nil)
		}

	case "end":
		// The host ends the call for everyone: every page hangs up, and
		// nobody is let in while the program winds down.
		if !p.host {
			return
		}
		r.locked = true
		r.broadcast(mustJSON(map[string]any{"type": "ended"}), nil)
		log.Printf("The host ended the call for everyone.")
		if r.onEnd != nil {
			// Not at once: the pages have to hear the news first.
			time.AfterFunc(time.Second, r.onEnd)
		}

	case "mute":
		// The host asks someone to mute; their page does it. It can't be
		// forced from here — the microphone is theirs.
		if t := r.peers[m.ID]; p.host && t != nil && t != p {
			t.enqueue(mustJSON(map[string]any{"type": "muted-by-host"}))
		}

	case "kick":
		t := r.peers[m.ID]
		if !p.host || t == nil || t == p || t.host {
			return
		}
		if t.key != "" {
			r.banned[t.key] = true
			if r.onBan != nil {
				go r.onBan(t.key)
			}
		}
		r.remove(t)
		t.enqueue(mustJSON(map[string]any{"type": "kicked"}))
		t.enqueue(nil)
	}
}

// SetInvite records the public link and tells the hosts already on the page.
func (r *Room) SetInvite(url string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.invite = url
	msg := mustJSON(map[string]any{"type": "invite", "url": url})
	for _, p := range r.peers {
		if p.host {
			p.enqueue(msg)
		}
	}
}

// tellHosts sends something to the organizer's page (or pages).
func (r *Room) tellHosts(msg []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, p := range r.peers {
		if p.host {
			p.enqueue(msg)
		}
	}
}

var pong = mustJSON(map[string]any{"type": "pong"})

func cleanDiag(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	if r := []rune(s); len(r) > 200 {
		s = string(r[:200])
	}
	return s
}

func (p *peer) writeLoop(conn *wire, stop chan struct{}) {
	for {
		select {
		case msg := <-p.send:
			if msg == nil {
				conn.Close(closeKicked, "kicked")
				return
			}
			wctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
			err := conn.send(wctx, msg)
			cancel()
			if err != nil {
				conn.CloseNow()
				return
			}
		case <-stop:
			return
		}
	}
}

// ServeHTTP is the /ws endpoint: one connection per participant.
func (r *Room) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	// A page that has lost the tunnel's old address comes back from it to the
	// new one, so its origin is another tunnel address, not ours.
	// So is the page a guest comes from when the call has a permanent link:
	// it lives on the link's site and reaches us across the tunnel.
	patterns := []string{strings.TrimPrefix(strings.TrimPrefix(r.site(), "https://"), "http://")}
	for _, d := range tunnelDomains() {
		patterns = append(patterns, d, "*."+d)
	}
	ws, err := websocket.Accept(w, req, &websocket.AcceptOptions{OriginPatterns: patterns})
	if err != nil {
		return
	}
	defer ws.CloseNow()
	ws.SetReadLimit(readLimit)
	ctx := req.Context()
	conn := &wire{Conn: ws}

	jctx, cancel := context.WithTimeout(ctx, joinTimeout)
	var m inMsg
	err = conn.recv(jctx, &m)
	if err == nil && m.Type == "hello" && r.id != nil {
		// A sealed connection: agree on the keys, and the join comes sealed.
		if err = conn.shake(jctx, r.id, m.Pub); err == nil {
			m = inMsg{}
			err = conn.recv(jctx, &m)
		}
	}
	cancel()
	if err != nil || m.Type != "join" {
		conn.Close(websocket.StatusPolicyViolation, "join first")
		return
	}

	p, resumed, reason := r.join(m, conn)
	if p == nil {
		conn.Close(closeRejected, reason)
		return
	}
	if resumed {
		log.Printf("+ %s (%s): came back", p.name, p.id)
	} else {
		log.Printf("+ %s (%s)%s", p.name, p.id, map[bool]string{true: " [host]"}[p.host])
	}
	left := false
	defer func() { r.dropped(p, conn, left) }()

	for {
		var m inMsg
		rctx, cancel := context.WithTimeout(ctx, readTimeout)
		err := conn.recv(rctx, &m)
		cancel()
		if err != nil {
			// Closed, dropped, silent or sent garbage.
			left = websocket.CloseStatus(err) == closeLeft
			return
		}
		r.handle(p, m)
	}
}
