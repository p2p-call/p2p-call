package call

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type client struct {
	t    *testing.T
	conn *websocket.Conn
	id   string
}

func dial(t *testing.T, srv *httptest.Server, join map[string]any) (*client, map[string]any, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	join["type"] = "join"
	if err := wsjson.Write(ctx, conn, join); err != nil {
		t.Fatal(err)
	}
	c := &client{t: t, conn: conn}
	m, err := c.tryRead()
	if err != nil {
		return nil, nil, err
	}
	c.id, _ = m["id"].(string)
	t.Cleanup(func() { conn.CloseNow() })
	return c, m, nil
}

func (c *client) tryRead() (map[string]any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var m map[string]any
	err := wsjson.Read(ctx, c.conn, &m)
	return m, err
}

func (c *client) read() map[string]any {
	c.t.Helper()
	m, err := c.tryRead()
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	return m
}

func (c *client) expect(typ string) map[string]any {
	c.t.Helper()
	m := c.read()
	if m["type"] != typ {
		c.t.Fatalf("want %q, got %v", typ, m)
	}
	return m
}

func (c *client) send(m map[string]any) {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, c.conn, m); err != nil {
		c.t.Fatal(err)
	}
}

func setup(t *testing.T, max int) *httptest.Server {
	return setupGrace(t, max, defaultGrace)
}

func setupGrace(t *testing.T, max int, grace time.Duration) *httptest.Server {
	room := NewRoom("secret", max)
	room.grace = grace
	srv := httptest.NewServer(routes(room, nil, siteInfo{}))
	t.Cleanup(srv.Close)
	return srv
}

func TestJoinAndSignal(t *testing.T) {
	srv := setup(t, 10)
	host, w, err := dial(t, srv, map[string]any{"name": "Mike", "host": "secret"})
	if err != nil {
		t.Fatal(err)
	}
	if w["type"] != "welcome" || w["host"] != true || len(w["peers"].([]any)) != 0 {
		t.Fatalf("host welcome: %v", w)
	}

	guest, w, err := dial(t, srv, map[string]any{"name": "  Pete\x07  ", "key": "k1", "host": "wrong"})
	if err != nil {
		t.Fatal(err)
	}
	if w["host"] != false || w["name"] != "Pete" {
		t.Fatalf("guest welcome: %v", w)
	}
	peers := w["peers"].([]any)
	if len(peers) != 1 || peers[0].(map[string]any)["id"] != host.id {
		t.Fatalf("guest sees: %v", peers)
	}
	if j := host.expect("peer-joined"); j["peer"].(map[string]any)["id"] != guest.id {
		t.Fatalf("peer-joined: %v", j)
	}

	data := json.RawMessage(`{"sdp":{"type":"offer","sdp":"v=0"}}`)
	guest.send(map[string]any{"type": "signal", "to": host.id, "data": data})
	s := host.expect("signal")
	if s["from"] != guest.id || s["data"].(map[string]any)["sdp"].(map[string]any)["type"] != "offer" {
		t.Fatalf("signal: %v", s)
	}

	guest.send(map[string]any{"type": "status", "muted": true})
	if st := host.expect("status"); st["id"] != guest.id || st["muted"] != true {
		t.Fatalf("status: %v", st)
	}

	guest.send(map[string]any{"type": "status", "music": true})
	if st := host.expect("status"); st["music"] != true || st["muted"] != true {
		t.Fatalf("music status: %v", st)
	}

	// The song's owner tells about it; the host may drive it, the owner's
	// own commands to others go nowhere.
	guest.send(map[string]any{"type": "music-info", "data": map[string]any{"name": "song"}})
	if mi := host.expect("music-info"); mi["id"] != guest.id || mi["data"].(map[string]any)["name"] != "song" {
		t.Fatalf("music-info: %v", mi)
	}
	guest.send(map[string]any{"type": "music-ctl", "id": host.id, "data": map[string]any{"a": "stop"}})
	host.send(map[string]any{"type": "music-ctl", "id": guest.id, "data": map[string]any{"a": "pause"}})
	if mc := guest.expect("music-ctl"); mc["data"].(map[string]any)["a"] != "pause" {
		t.Fatalf("music-ctl: %v", mc)
	}

	guest.send(map[string]any{"type": "status", "video": "camera"})
	if st := host.expect("status"); st["video"] != "camera" || st["music"] != true {
		t.Fatalf("video status: %v", st)
	}
	guest.send(map[string]any{"type": "status", "video": "nonsense"})
	if st := host.expect("status"); st["video"] != "camera" {
		t.Fatalf("a made-up kind of video got through: %v", st)
	}

	guest.send(map[string]any{"type": "leave"})
	if l := host.expect("peer-left"); l["id"] != guest.id {
		t.Fatalf("peer-left: %v", l)
	}
}

func TestGuestCannotUseHostPowers(t *testing.T) {
	srv := setup(t, 10)
	host, _, _ := dial(t, srv, map[string]any{"name": "host", "host": "secret"})
	a, _, _ := dial(t, srv, map[string]any{"name": "a"})
	host.expect("peer-joined")
	b, _, _ := dial(t, srv, map[string]any{"name": "b"})
	host.expect("peer-joined")
	a.expect("peer-joined")

	a.send(map[string]any{"type": "kick", "id": b.id})
	a.send(map[string]any{"type": "lock", "locked": true})
	a.send(map[string]any{"type": "kick", "id": host.id})
	// A marker: if the forbidden commands had done anything, b would have
	// heard about it before this.
	a.send(map[string]any{"type": "status", "muted": true})
	if m := b.expect("status"); m["id"] != a.id {
		t.Fatalf("b got %v", m)
	}
}

func TestHostEndsCallForEveryone(t *testing.T) {
	room := NewRoom("secret", 10)
	ended := make(chan struct{})
	room.onEnd = func() { close(ended) }
	srv := httptest.NewServer(routes(room, nil, siteInfo{}))
	t.Cleanup(srv.Close)

	host, _, _ := dial(t, srv, map[string]any{"name": "host", "host": "secret"})
	a, _, _ := dial(t, srv, map[string]any{"name": "a"})
	host.expect("peer-joined")

	// A guest can't do it.
	a.send(map[string]any{"type": "end"})
	a.send(map[string]any{"type": "status", "muted": true})
	host.expect("status")

	host.send(map[string]any{"type": "end"})
	host.expect("ended")
	a.expect("ended")
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("the program wasn't told that the call is over")
	}
	// Nobody comes in after that.
	if _, _, err := dial(t, srv, map[string]any{"name": "late"}); websocket.CloseStatus(err) != closeRejected {
		t.Fatalf("a latecomer got in: %v", err)
	}
}

// A program with no window gives the call up when the organizer's page is
// gone for long enough — and not while it is there, or back in time.
func TestAbandonedWithoutHost(t *testing.T) {
	room := NewRoom("secret", 10)
	gone := make(chan struct{}, 1)
	room.abandonAfter(300*time.Millisecond, func() { gone <- struct{}{} })
	srv := httptest.NewServer(routes(room, nil, siteInfo{}))
	t.Cleanup(srv.Close)
	wait := func(d time.Duration) bool {
		select {
		case <-gone:
			return true
		case <-time.After(d):
			return false
		}
	}

	host, _, _ := dial(t, srv, map[string]any{"name": "host", "host": "secret"})
	guest, _, _ := dial(t, srv, map[string]any{"name": "guest"})
	host.expect("peer-joined")
	if wait(700 * time.Millisecond) {
		t.Fatal("given up with the organizer in the call")
	}
	// The page is reloaded: gone for a moment, then back.
	host.conn.Close(closeLeft, "left")
	guest.expect("peer-left")
	host2, _, _ := dial(t, srv, map[string]any{"name": "host", "host": "secret"})
	guest.expect("peer-joined")
	if wait(700 * time.Millisecond) {
		t.Fatal("given up though the organizer came back")
	}
	// Closed for good; a guest still being there changes nothing.
	host2.conn.Close(closeLeft, "left")
	if !wait(3 * time.Second) {
		t.Fatal("still running with the organizer's page long closed")
	}
}

func TestOnlyOwnHostNames(t *testing.T) {
	srv := setup(t, 10)
	get := func(host string) int {
		req, _ := http.NewRequest("GET", srv.URL+"/hello.json", nil)
		req.Host = host
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	for host, want := range map[string]int{
		"localhost:8765": 200, "127.0.0.1:8765": 200, "abc123.lhr.life": 200, "x-y.trycloudflare.com": 200,
		"evil.example:8765": 403, "lhr.life.evil.example": 403, "notlhr.life": 403,
	} {
		if got := get(host); got != want {
			t.Errorf("%s: %d, want %d", host, got, want)
		}
	}
}

func TestLockAndFull(t *testing.T) {
	srv := setup(t, 2)
	host, _, _ := dial(t, srv, map[string]any{"name": "host", "host": "secret"})
	dial(t, srv, map[string]any{"name": "a"})
	host.expect("peer-joined")

	if _, _, err := dial(t, srv, map[string]any{"name": "b"}); websocket.CloseStatus(err) != closeRejected {
		t.Fatalf("full room should reject, got %v", err)
	}

	host.send(map[string]any{"type": "lock", "locked": true})
	host.expect("locked")
	// The host gets in even when locked or full (another tab of theirs).
	if _, w, err := dial(t, srv, map[string]any{"name": "host2", "host": "secret"}); err != nil || w["type"] != "welcome" {
		t.Fatalf("host should always get in: %v %v", w, err)
	}
}

func TestLockedRejectsGuests(t *testing.T) {
	srv := setup(t, 10)
	host, _, _ := dial(t, srv, map[string]any{"name": "host", "host": "secret"})
	host.send(map[string]any{"type": "lock", "locked": true})
	host.expect("locked")
	_, _, err := dial(t, srv, map[string]any{"name": "late"})
	var ce websocket.CloseError
	if websocket.CloseStatus(err) != closeRejected || !asClose(err, &ce) || ce.Reason != "locked" {
		t.Fatalf("want locked rejection, got %v", err)
	}
	host.send(map[string]any{"type": "lock", "locked": false})
	host.expect("locked")
	if _, _, err := dial(t, srv, map[string]any{"name": "late"}); err != nil {
		t.Fatalf("unlocked should admit: %v", err)
	}
}

func TestKickBansKey(t *testing.T) {
	srv := setup(t, 10)
	host, _, _ := dial(t, srv, map[string]any{"name": "host", "host": "secret"})
	bad, _, _ := dial(t, srv, map[string]any{"name": "bad", "key": "badkey"})
	host.expect("peer-joined")
	other, _, _ := dial(t, srv, map[string]any{"name": "other", "key": "ok"})
	host.expect("peer-joined")
	bad.expect("peer-joined")

	host.send(map[string]any{"type": "mute", "id": bad.id})
	bad.expect("muted-by-host")

	host.send(map[string]any{"type": "kick", "id": bad.id})
	bad.expect("kicked")
	if _, err := bad.tryRead(); websocket.CloseStatus(err) != closeKicked {
		t.Fatalf("kicked close: %v", err)
	}
	if l := other.expect("peer-left"); l["id"] != bad.id {
		t.Fatalf("other: %v", l)
	}

	var ce websocket.CloseError
	if _, _, err := dial(t, srv, map[string]any{"name": "bad again", "key": "badkey"}); !asClose(err, &ce) || ce.Reason != "banned" {
		t.Fatalf("banned key should be rejected: %v", err)
	}
}

func asClose(err error, ce *websocket.CloseError) bool {
	return errors.As(err, ce)
}

// A participant whose connection to the server drops keeps their place: the
// others aren't told, messages wait, and the same browser gets the same id back.
func TestDroppedConnectionResumes(t *testing.T) {
	srv := setup(t, 10)
	host, _, err := dial(t, srv, map[string]any{"name": "Mike", "host": "secret"})
	if err != nil {
		t.Fatal(err)
	}
	guest, _, err := dial(t, srv, map[string]any{"name": "Pete", "key": "k1"})
	if err != nil {
		t.Fatal(err)
	}
	host.expect("peer-joined")

	guest.conn.CloseNow()
	time.Sleep(100 * time.Millisecond) // let the server notice
	host.send(map[string]any{"type": "signal", "to": guest.id, "data": json.RawMessage(`{"candidate":1}`)})

	// Somebody else's browser can't take the place.
	thief, w, err := dial(t, srv, map[string]any{"name": "Thief", "key": "k2", "resume": guest.id})
	if err != nil || w["type"] != "welcome" || thief.id == guest.id {
		t.Fatalf("thief: %v %v", w, err)
	}
	host.expect("peer-joined")

	back, w, err := dial(t, srv, map[string]any{"name": "Pete", "key": "k1", "resume": guest.id})
	if err != nil {
		t.Fatal(err)
	}
	// What was sent meanwhile comes first, in order, then the confirmation.
	if w["type"] != "signal" || w["from"] != host.id {
		t.Fatalf("want the waiting signal, got %v", w)
	}
	if j := back.expect("peer-joined"); j["peer"].(map[string]any)["id"] != thief.id {
		t.Fatalf("peer-joined: %v", j)
	}
	back.expect("resumed")

	// Same id as before, and the host was never told Pete had left.
	back.send(map[string]any{"type": "status", "muted": true})
	if st := host.expect("status"); st["id"] != guest.id {
		t.Fatalf("status after resume: %v", st)
	}
}

// Without coming back in time, the place is given up.
func TestDroppedConnectionExpires(t *testing.T) {
	srv := setupGrace(t, 10, 200*time.Millisecond)
	host, _, err := dial(t, srv, map[string]any{"name": "Mike", "host": "secret"})
	if err != nil {
		t.Fatal(err)
	}
	guest, _, err := dial(t, srv, map[string]any{"name": "Pete", "key": "k1"})
	if err != nil {
		t.Fatal(err)
	}
	host.expect("peer-joined")

	guest.conn.CloseNow()
	if l := host.expect("peer-left"); l["id"] != guest.id {
		t.Fatalf("peer-left: %v", l)
	}

	// Too late to resume: let in as a new participant.
	again, w, err := dial(t, srv, map[string]any{"name": "Pete", "key": "k1", "resume": guest.id})
	if err != nil || w["type"] != "welcome" || again.id == guest.id {
		t.Fatalf("late resume: %v %v", w, err)
	}
}

func TestPing(t *testing.T) {
	srv := setup(t, 10)
	c, _, err := dial(t, srv, map[string]any{"name": "Mike"})
	if err != nil {
		t.Fatal(err)
	}
	c.send(map[string]any{"type": "ping"})
	c.expect("pong")
}
