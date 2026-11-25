package call

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coder/websocket"
)

// The link survives a restart, a notice carries a signature that checks out
// against the key in it, and that key is the one the link names.
func TestIdentityAndNotice(t *testing.T) {
	dir := t.TempDir()
	id, err := loadIdentity(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	id.ban("k1")
	again, err := loadIdentity(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if again.room() != id.room() || len(again.bannedKeys()) != 1 {
		t.Fatalf("identity not kept: %s vs %s, banned %v", again.room(), id.room(), again.bannedKeys())
	}
	if fresh, _ := loadIdentity(dir, true); fresh.room() == id.room() {
		t.Fatal("a new link is the same as the old one")
	}

	// The secret is kept with the key, and the link carries both.
	if again.tail() != id.tail() || !strings.HasPrefix(id.tail(), id.room()+".") || len(id.tail()) != 22+1+22 {
		t.Fatalf("the link's tail: %s, then %s", id.tail(), again.tail())
	}

	var path string
	var body []byte
	board := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		body, _ = io.ReadAll(r.Body)
		w.Write([]byte(`{"id":"x"}`))
	}))
	defer board.Close()

	rl := &relay{base: board.URL, id: id}
	if err := rl.post(context.Background(), "https://abc.lhr.life", true); err != nil {
		t.Fatal(err)
	}
	// The board is shown nothing it could find the link by: not the call's
	// name, not the address, not the organizer's key.
	if path != "/"+id.topic() || strings.Contains(path, id.room()) {
		t.Fatalf("posted to %s", path)
	}
	for _, clear := range []string{"lhr.life", id.room(), base64.StdEncoding.EncodeToString(id.public())} {
		if strings.Contains(string(body), clear) {
			t.Fatalf("the notice shows %q: %s", clear, body)
		}
	}
	// Opened the way the pages do it: the key from the link's secret.
	sealed, err := base64.StdEncoding.DecodeString(string(body))
	if err != nil {
		t.Fatal(err)
	}
	block, _ := aes.NewCipher(id.from("key", 32))
	gcm, _ := cipher.NewGCM(block)
	plain, err := gcm.Open(nil, sealed[:12], sealed[12:], nil)
	if err != nil {
		t.Fatal(err)
	}
	var notice struct {
		U, K, S string
		T       int64
		V       int
	}
	if err := json.Unmarshal(plain, &notice); err != nil || notice.U != "https://abc.lhr.life" || notice.V != ProtocolVersion {
		t.Fatalf("notice %s: %v", plain, err)
	}
	pub, _ := base64.StdEncoding.DecodeString(notice.K)
	h := sha256.Sum256(pub)
	if base64.RawURLEncoding.EncodeToString(h[:16]) != id.room() {
		t.Fatal("the key in the notice isn't the one the link names")
	}
	sig, _ := base64.StdEncoding.DecodeString(notice.S)
	if len(sig) != 64 {
		t.Fatalf("signature is %d bytes", len(sig))
	}
	digest := sha256.Sum256([]byte(fmt.Sprintf("p2p-call|%s|%d|%d", notice.U, notice.T, ProtocolVersion)))
	r, s := new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])
	if !ecdsa.Verify(&id.key.PublicKey, digest[:], r, s) {
		t.Fatal("signature doesn't verify")
	}
}

// A one-time call gets a link of its own and leaves the permanent one alone.
func TestOneTimeLink(t *testing.T) {
	dir := t.TempDir()
	// Over before it began: no tunnel is really opened, nothing is posted.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := func(oneTime bool) string {
		c, err := Start(ctx, Config{Tunnel: "localhostrun", Relay: "http://127.0.0.1:1", StateDir: dir, OneTime: oneTime})
		if err != nil {
			t.Fatal(err)
		}
		defer c.stop()
		defer c.srv.Close()
		return c.Link
	}
	permanent := start(false)
	once1, once2 := start(true), start(true)
	if permanent == "" || once1 == permanent || once2 == permanent || once1 == once2 {
		t.Fatalf("links: %q %q %q", permanent, once1, once2)
	}
	if again := start(false); again != permanent {
		t.Fatalf("the permanent link changed: %q, was %q", again, permanent)
	}
}

// A notice is left on a spare board the way MQTT wants it: to be remembered,
// under the call's name on the boards, and acknowledged.
func TestSpareBoard(t *testing.T) {
	type said struct {
		head    byte
		topic   string
		payload []byte
	}
	got := make(chan said, 1)
	board := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"mqtt"}})
		if err != nil {
			return
		}
		defer ws.CloseNow()
		ctx := r.Context()
		_, hello, err := ws.Read(ctx)
		if err != nil || hello[0] != 0x10 || !strings.Contains(string(hello), "MQTT") {
			return
		}
		// Let in — sent in two pieces, as a server is free to do.
		ws.Write(ctx, websocket.MessageBinary, []byte{0x20, 2})
		ws.Write(ctx, websocket.MessageBinary, []byte{0, 0})
		_, p, err := ws.Read(ctx)
		if err != nil {
			return
		}
		// One byte of length is enough for less than 128 bytes, two for the rest.
		at := 2
		if p[1]&128 != 0 {
			at = 3
		}
		n := int(p[at])<<8 | int(p[at+1])
		got <- said{p[0], string(p[at+2 : at+2+n]), p[at+2+n+2:]}
		ws.Write(ctx, websocket.MessageBinary, []byte{0x40, 2, p[at+2+n], p[at+2+n+1]})
		ws.Read(ctx)
	}))
	defer board.Close()

	id, _ := loadIdentity("", true)
	rl := &relay{base: "http://127.0.0.1:1", spare: []string{"ws" + strings.TrimPrefix(board.URL, "http")}, id: id}
	// The first board is out of reach; the spare one taking it is enough.
	if err := rl.post(context.Background(), "https://abc.lhr.life", true); err != nil {
		t.Fatal(err)
	}
	m := <-got
	if m.head != 0x33 || m.topic != id.topic() {
		t.Fatalf("said %#x under %q", m.head, m.topic)
	}
	if sealed, err := base64.StdEncoding.DecodeString(string(m.payload)); err != nil || len(sealed) < 100 {
		t.Fatalf("the notice: %q", m.payload)
	}
	if !rl.behind {
		t.Fatal("the first board missed the notice, and that wasn't noted")
	}
}
