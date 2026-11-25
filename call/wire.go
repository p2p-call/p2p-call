package call

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"

	"github.com/coder/websocket"
)

// Guests reach the organizer's device through somebody else's tunnel, and
// the tunnel's owner sees everything that passes — unless it is sealed. So
// a guest's page (which itself comes from the permanent link's site, not
// through the tunnel) and this program first agree on a key that the tunnel
// can't learn or tamper with, and then speak in sealed messages only:
//
//   - the page sends a fresh public key of its own (ECDH, P-256);
//   - the program answers with a fresh one too, signed with the organizer's
//     key — the one whose fingerprint is in the link, so the page can tell
//     that it is the organizer answering and not the tunnel in between;
//   - both derive the same secret from the pair, and from it one key per
//     direction (AES-256-GCM); the messages are numbered, so none can be
//     dropped, repeated or reordered unnoticed.
//
// What the tunnel still sees: who connects and when, and how much is said.
// The organizer's own page talks to the program on the device itself and
// needs none of this.

// ProtocolVersion is which call page (docs/c<N>/ on the site) speaks to this
// program. It is posted with the tunnel's address, so the permanent link's
// page knows where to send the visitor.
const ProtocolVersion = 1

// wire is one participant's connection: plain, or sealed once shake is done.
type wire struct {
	*websocket.Conn
	in, out   cipher.AEAD
	inN, outN uint64
}

func (w *wire) sealed() bool { return w.out != nil }

func nonce(n uint64) []byte {
	b := make([]byte, 12)
	binary.BigEndian.PutUint64(b[4:], n)
	return b
}

// recv reads the next message into v.
func (w *wire) recv(ctx context.Context, v any) error {
	typ, b, err := w.Read(ctx)
	if err != nil {
		return err
	}
	if w.in != nil {
		if typ != websocket.MessageBinary {
			return errors.New("an unsealed message on a sealed connection")
		}
		if b, err = w.in.Open(nil, nonce(w.inN), b, nil); err != nil {
			return err
		}
		w.inN++
	}
	return json.Unmarshal(b, v)
}

// send writes one ready JSON message. Only one goroutine sends at a time
// (the participant's writer), so the numbering needs no lock.
func (w *wire) send(ctx context.Context, msg []byte) error {
	if w.out == nil {
		return w.Write(ctx, websocket.MessageText, msg)
	}
	sealed := w.out.Seal(nil, nonce(w.outN), msg, nil)
	w.outN++
	return w.Write(ctx, websocket.MessageBinary, sealed)
}

// shake answers the page's "hello" and seals the connection from then on.
func (w *wire) shake(ctx context.Context, id *identity, theirs string) error {
	raw, err := base64.StdEncoding.DecodeString(theirs)
	if err != nil {
		return err
	}
	peer, err := ecdh.P256().NewPublicKey(raw)
	if err != nil {
		return err
	}
	mine, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	secret, err := mine.ECDH(peer)
	if err != nil {
		return err
	}
	pub := base64.StdEncoding.EncodeToString(mine.PublicKey().Bytes())
	// The signature covers both fresh keys: it vouches for this very
	// conversation and is of no use in any other.
	sig, err := id.sign([]byte("p2p-call-wire|" + pub + "|" + theirs))
	if err != nil {
		return err
	}
	if w.in, err = wireKey(secret, "p2p-call page to host"); err != nil {
		return err
	}
	out, err := wireKey(secret, "p2p-call host to page")
	if err != nil {
		return err
	}
	hello := mustJSON(map[string]any{
		"type": "hello",
		"pub":  pub,
		"key":  base64.StdEncoding.EncodeToString(id.public()),
		"sig":  base64.StdEncoding.EncodeToString(sig),
	})
	if err := w.Write(ctx, websocket.MessageText, hello); err != nil {
		return err
	}
	w.out = out
	return nil
}

func wireKey(secret []byte, purpose string) (cipher.AEAD, error) {
	key, err := hkdf.Key(sha256.New, secret, nil, purpose, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
