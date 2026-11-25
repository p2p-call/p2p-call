package call

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// identity is what makes the organizer's link permanent: a key kept on this
// device. The link carries a fingerprint of the key; the tunnel's current
// address is published signed with it (see relay.go), so the pages can tell
// the organizer's word from anybody else's. A new key is a new link, and the
// old one stops working — that is "change my link".
//
// The people the organizer has removed are remembered with it: otherwise a
// permanent link would let them back in at the next call.
//
// And with it a secret, the second half of the link (name.secret). The name
// alone opens nothing: where on the board the address is posted, the seal on
// that notice and the word a guest's page says at the door all come from the
// secret, which never leaves the link — not to the board, not to the tunnel.
// So neither of them can make up the link and walk in.
type identity struct {
	key    *ecdsa.PrivateKey
	secret []byte
	path   string // "" — nothing is kept; the link lasts for this run only

	mu     sync.Mutex
	banned []string
}

type identityFile struct {
	Key    string   `json:"key"`
	Secret string   `json:"secret,omitempty"`
	Banned []string `json:"banned,omitempty"`
}

// loadIdentity reads the identity kept in dir, or makes a new one if there is
// none, it can't be read, or fresh is set.
func loadIdentity(dir string, fresh bool) (*identity, error) {
	id := &identity{}
	if dir != "" {
		id.path = filepath.Join(dir, "room.json")
	}
	if id.path != "" && !fresh {
		var f identityFile
		if b, err := os.ReadFile(id.path); err == nil && json.Unmarshal(b, &f) == nil {
			if der, err := base64.StdEncoding.DecodeString(f.Key); err == nil {
				if key, err := x509.ParseECPrivateKey(der); err == nil && key.Curve == elliptic.P256() {
					id.key, id.banned = key, f.Banned
					if id.secret, err = base64.RawURLEncoding.DecodeString(f.Secret); err == nil && len(id.secret) == secretLen {
						return id, nil
					}
					// A key kept by a version from before the secret: the
					// link gets its second half now.
					id.secret = newSecret()
					return id, id.save()
				}
			}
		}
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	id.key, id.banned, id.secret = key, nil, newSecret()
	return id, id.save()
}

const secretLen = 16

func newSecret() []byte {
	b := make([]byte, secretLen)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

// save is called with id.mu held, or before the identity is shared.
func (id *identity) save() error {
	if id.path == "" {
		return nil
	}
	der, err := x509.MarshalECPrivateKey(id.key)
	if err != nil {
		return err
	}
	b, _ := json.Marshal(identityFile{
		Key:    base64.StdEncoding.EncodeToString(der),
		Secret: base64.RawURLEncoding.EncodeToString(id.secret),
		Banned: id.banned,
	})
	if err := os.MkdirAll(filepath.Dir(id.path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(id.path, b, 0o600)
}

// public is the key as browsers take it: an uncompressed P-256 point.
func (id *identity) public() []byte {
	k, err := id.key.PublicKey.ECDH()
	if err != nil {
		panic(err) // a P-256 key always converts
	}
	return k.Bytes()
}

// room is the fingerprint in the link: enough of the key's hash that nobody
// can make another key with the same one.
func (id *identity) room() string {
	h := sha256.Sum256(id.public())
	return base64.RawURLEncoding.EncodeToString(h[:16])
}

// tail is what follows the # in the link: the call's name and its secret.
func (id *identity) tail() string {
	return id.room() + "." + base64.RawURLEncoding.EncodeToString(id.secret)
}

// directTail is the same for a link straight to the tunnel's address: what
// the call page served there reads (r= the name, k= the secret). Like any
// part of a link after the #, it never reaches the tunnel.
func (id *identity) directTail() string {
	return "r=" + id.room() + "&k=" + base64.RawURLEncoding.EncodeToString(id.secret)
}

// from derives one thing from the link's secret. The pages do the same
// (doorKeys in link.js and in the link's page).
func (id *identity) from(purpose string, n int) []byte {
	b, err := hkdf.Key(sha256.New, id.secret, nil, "p2p-call door "+purpose+"|"+id.room(), n)
	if err != nil {
		panic(err) // only for a length no hash can give
	}
	return b
}

// topic is the board's name for the call.
func (id *identity) topic() string {
	return "p2pcall_" + base64.RawURLEncoding.EncodeToString(id.from("topic", 16))
}

// pass is the word a guest's page says at the door, over the sealed
// connection: it shows that the guest was given the whole link.
func (id *identity) pass() string {
	return base64.RawURLEncoding.EncodeToString(id.from("pass", 16))
}

// seal closes a notice for the board, so that the board can't read it.
func (id *identity) seal(msg []byte) (string, error) {
	block, err := aes.NewCipher(id.from("key", 32))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	iv := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(gcm.Seal(iv, iv, msg, nil)), nil
}

// sign returns the signature in the form browsers verify: r and s, 32 bytes each.
func (id *identity) sign(msg []byte) ([]byte, error) {
	h := sha256.Sum256(msg)
	r, s, err := ecdsa.Sign(rand.Reader, id.key, h[:])
	if err != nil {
		return nil, err
	}
	out := make([]byte, 64)
	r.FillBytes(out[:32])
	s.FillBytes(out[32:])
	return out, nil
}

func (id *identity) bannedKeys() []string {
	id.mu.Lock()
	defer id.mu.Unlock()
	return append([]string(nil), id.banned...)
}

func (id *identity) ban(key string) {
	id.mu.Lock()
	defer id.mu.Unlock()
	id.banned = append(id.banned, key)
	id.save()
}
