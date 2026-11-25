package call

import (
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// sealedDial does what a guest's page does: the handshake of wire.go, with
// the organizer's signature checked, and then the join, sealed.
func sealedDial(t *testing.T, srv *httptest.Server, id *identity, join map[string]any) (*wire, map[string]any, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.CloseNow() })
	mine, _ := ecdh.P256().GenerateKey(rand.Reader)
	pub := base64.StdEncoding.EncodeToString(mine.PublicKey().Bytes())
	if err := wsjson.Write(ctx, ws, map[string]any{"type": "hello", "pub": pub}); err != nil {
		t.Fatal(err)
	}
	var hello struct{ Type, Pub, Key, Sig string }
	if err := wsjson.Read(ctx, ws, &hello); err != nil {
		return nil, nil, err
	}
	key, _ := base64.StdEncoding.DecodeString(hello.Key)
	h := sha256.Sum256(key)
	if base64.RawURLEncoding.EncodeToString(h[:16]) != id.room() {
		t.Fatal("the key in the hello isn't the one the link names")
	}
	sig, _ := base64.StdEncoding.DecodeString(hello.Sig)
	digest := sha256.Sum256([]byte("p2p-call-wire|" + hello.Pub + "|" + pub))
	if len(sig) != 64 || !ecdsa.Verify(&id.key.PublicKey, digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		t.Fatal("the hello isn't signed by the organizer")
	}
	raw, _ := base64.StdEncoding.DecodeString(hello.Pub)
	theirs, err := ecdh.P256().NewPublicKey(raw)
	if err != nil {
		t.Fatal(err)
	}
	secret, _ := mine.ECDH(theirs)
	w := &wire{Conn: ws}
	// The page's side of the keys: it sends where the host receives.
	w.out, _ = wireKey(secret, "p2p-call page to host")
	w.in, _ = wireKey(secret, "p2p-call host to page")

	join["type"] = "join"
	if err := w.send(ctx, mustJSON(join)); err != nil {
		t.Fatal(err)
	}
	var welcome map[string]any
	if err := w.recv(ctx, &welcome); err != nil {
		return nil, nil, err
	}
	return w, welcome, nil
}

func TestSealedConnection(t *testing.T) {
	id, err := loadIdentity("", true)
	if err != nil {
		t.Fatal(err)
	}
	room := NewRoom("secret", 10)
	room.id = id
	room.sealedOnly = true
	room.pass = id.pass()
	room.config = json.RawMessage(`{"iceServers":[{"urls":["stun:stun.example"]}]}`)
	srv := httptest.NewServer(routes(room, nil, siteInfo{}))
	t.Cleanup(srv.Close)

	// The organizer, on the device itself, speaks plainly.
	host, _, err := dial(t, srv, map[string]any{"name": "host", "host": "secret"})
	if err != nil {
		t.Fatal(err)
	}
	// A guest who doesn't seal the connection isn't let in.
	if _, _, err := dial(t, srv, map[string]any{"name": "plain"}); websocket.CloseStatus(err) != closeRejected {
		t.Fatalf("an unsealed guest got in: %v", err)
	}

	// Nor one who seals it but wasn't given the link's secret — the board
	// and the tunnel can learn the call's name, and no more than that.
	for _, pass := range []string{"", id.room(), id.pass()[1:]} {
		if _, _, err := sealedDial(t, srv, id, map[string]any{"name": "nosy", "pass": pass}); websocket.CloseStatus(err) != closeRejected {
			t.Fatalf("a guest with the word %q got in: %v", pass, err)
		}
	}

	guest, welcome, err := sealedDial(t, srv, id, map[string]any{"name": "guest", "pass": id.pass()})
	if err != nil {
		t.Fatal(err)
	}
	if welcome["type"] != "welcome" || welcome["name"] != "guest" {
		t.Fatalf("welcome: %v", welcome)
	}
	// What the page has to know comes sealed, in the welcome.
	if cfg, _ := json.Marshal(welcome["config"]); !strings.Contains(string(cfg), "stun.example") {
		t.Fatalf("no config in the welcome: %s", cfg)
	}
	host.expect("peer-joined")

	// Both ways, several messages: the numbering holds.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for i := 0; i < 3; i++ {
		if err := guest.send(ctx, mustJSON(map[string]any{"type": "status", "muted": i%2 == 0})); err != nil {
			t.Fatal(err)
		}
		if st := host.expect("status"); st["muted"] != (i%2 == 0) {
			t.Fatalf("status %d: %v", i, st)
		}
		host.send(map[string]any{"type": "lock", "locked": i%2 == 0})
		host.expect("locked") // the organizer hears it too
		var m map[string]any
		if err := guest.recv(ctx, &m); err != nil || m["type"] != "locked" || m["locked"] != (i%2 == 0) {
			t.Fatalf("locked %d: %v %v", i, m, err)
		}
	}

	// The page being closed says so with the close itself: the place isn't kept.
	guest.Close(closeLeft, "left")
	if l := host.expect("peer-left"); l["id"] != welcome["id"] {
		t.Fatalf("peer-left: %v", l)
	}
}

// Somebody in the middle can't pass for the organizer, nor meddle with what is said.
func TestSealedConnectionTampering(t *testing.T) {
	id, _ := loadIdentity("", true)
	room := NewRoom("secret", 10)
	room.id = id
	srv := httptest.NewServer(routes(room, nil, siteInfo{}))
	t.Cleanup(srv.Close)

	guest, _, err := sealedDial(t, srv, id, map[string]any{"name": "guest"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// A message sealed out of turn (as a repeated or reordered one would be) ends the connection.
	guest.outN += 5
	guest.send(ctx, mustJSON(map[string]any{"type": "ping"}))
	var m map[string]any
	if err := guest.recv(ctx, &m); err == nil {
		t.Fatalf("a message out of turn was answered: %v", m)
	}
}

// The guests' call page on the site must be the same page the program serves.
func TestSitePageIsCurrent(t *testing.T) {
	dir := fmt.Sprintf("../docs/c%d", ProtocolVersion)
	ours, err := webFiles.ReadDir("web")
	if err != nil {
		t.Fatal(err)
	}
	theirs, _ := os.ReadDir(dir)
	if len(theirs) != len(ours) {
		t.Fatalf("%s has %d files, call/web has %d: run scripts/sync-page.sh", dir, len(theirs), len(ours))
	}
	for _, f := range ours {
		mine, err := webFiles.ReadFile("web/" + f.Name())
		if err != nil {
			t.Fatal(err)
		}
		site, err := os.ReadFile(dir + "/" + f.Name())
		if err != nil || string(site) != string(mine) {
			t.Fatalf("%s/%s differs from call/web/%s: run scripts/sync-page.sh", dir, f.Name(), f.Name())
		}
	}
}

// The link's page and the call page read the board with the same code, kept
// in both files by hand.
func TestBoardCodeIsTheSame(t *testing.T) {
	cut := func(path string) string {
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		s := string(b)
		from, to := strings.Index(s, "// What the link's secret gives"), strings.Index(s, "// end of the shared code")
		if from < 0 || to < from {
			t.Fatalf("%s: the shared code isn't marked", path)
		}
		// Its own "door" helper sits in between, in the call page only.
		return strings.Join(strings.Fields(strings.Replace(s[from:to], "let doorOnce = null;\nconst door = () => doorOnce || (doorOnce = doorKeys(far.room, far.pass));\n", "", 1)), " ")
	}
	if cut("web/link.js") != cut("../docs/index.html") {
		t.Fatal("doorKeys, lookup and genuine differ between call/web/link.js and docs/index.html")
	}
}
