package call

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

// The tunnel's address is random and changes whenever the tunnel reconnects,
// which on a phone is often. So the link people are given is a permanent one,
// to a small static page (docs/index.html, on GitHub Pages), and the address
// of the moment is posted on a public notice board — ntfy.sh, free and with
// no account. The page reads
// the board and sends the visitor on; the pages of people already in the call
// read it when they lose the server, and find it again.
//
// Each notice is signed (identity.go), and the pages ignore any that isn't:
// the board is open for anyone to write on. It is sealed too, and put up
// under a name the board can't trace to the link — both from the link's
// secret — so the board itself learns nothing it could use to come in.
//
// Nothing about the call itself goes there, only where its door is.

// ntfy.sh keeps a notice for 12 hours, and counts each one against the day's
// allowance; it is posted anew well within that, but not often. How long the
// spare boards remember is their own business, and they don't count — so
// they are reminded more often.
const (
	relayRepeat = 15 * time.Minute
	spareRepeat = 3 * time.Minute
)

type relay struct {
	base  string
	spare []string // more boards, see spare.go
	id    *identity

	mu  sync.Mutex
	url string // the tunnel's current address; "" — none
	// behind: the first board hasn't got the latest notice (it was out of
	// reach, or refused), so it is offered again sooner than usual.
	behind bool
	deaf   map[string]bool // the spare boards that didn't take the last one
}

func (r *relay) topicURL() string { return r.base + "/" + r.id.topic() }

// set posts the new address now and keeps it posted.
func (r *relay) set(ctx context.Context, url string) {
	r.mu.Lock()
	r.url = url
	r.mu.Unlock()
	if err := r.post(ctx, url, true); err != nil && ctx.Err() == nil {
		log.Printf("Couldn't update the permanent link: %v. Will try again.", err)
		go r.retry(ctx, url)
	}
}

// retry keeps trying a post that failed, until it works or the address is no
// longer the current one.
func (r *relay) retry(ctx context.Context, url string) {
	for wait := 5 * time.Second; ; wait = min(wait*2, time.Minute) {
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return
		}
		r.mu.Lock()
		current := r.url
		r.mu.Unlock()
		if current != url || r.post(ctx, url, true) == nil {
			return
		}
	}
}

func (r *relay) keepPosted(ctx context.Context) {
	t := time.NewTicker(spareRepeat)
	defer t.Stop()
	for n := 1; ; n++ {
		select {
		case <-t.C:
			r.mu.Lock()
			url, behind := r.url, r.behind
			r.mu.Unlock()
			if url != "" {
				r.post(ctx, url, behind || n%int(relayRepeat/spareRepeat) == 0)
			}
		case <-ctx.Done():
			return
		}
	}
}

// post puts one signed notice on the boards: on the spare ones always, on
// the first one if first is set. An empty url says "the call is over". It
// is posted if any one board has taken it.
func (r *relay) post(ctx context.Context, url string, first bool) error {
	t := time.Now().Unix()
	// v: which call page on the site speaks to this program (wire.go). It is
	// signed with the rest, so nobody can talk the page into an older, plain
	// way of connecting.
	sig, err := r.id.sign([]byte(fmt.Sprintf("p2p-call|%s|%d|%d", url, t, ProtocolVersion)))
	if err != nil {
		return err
	}
	// Signed, and then sealed with a key from the link's secret: the board
	// sees neither the address nor whose call it is.
	sealed, err := r.id.seal(mustJSON(map[string]any{
		"u": url,
		"t": t,
		"v": ProtocolVersion,
		"k": base64.StdEncoding.EncodeToString(r.id.public()),
		"s": base64.StdEncoding.EncodeToString(sig),
	}))
	if err != nil {
		return err
	}
	body := []byte(sealed)
	type answer struct {
		board string
		err   error
	}
	spared := make(chan answer, len(r.spare))
	for _, board := range r.spare {
		go func() { spared <- answer{board, spareLeave(ctx, board, r.id.topic(), body)} }()
	}
	if first {
		err = r.sendFirst(ctx, body)
		r.mu.Lock()
		r.behind = err != nil
		r.mu.Unlock()
	} else if len(r.spare) > 0 {
		err = errors.New("the first board wasn't asked")
	}
	for range r.spare {
		a := <-spared
		if a.err == nil {
			err = nil
		}
		// Said once per trouble, not every few minutes.
		r.mu.Lock()
		was := r.deaf[a.board]
		if r.deaf == nil {
			r.deaf = map[string]bool{}
		}
		r.deaf[a.board] = a.err != nil
		r.mu.Unlock()
		if a.err != nil && !was && ctx.Err() == nil {
			log.Printf("Backup board %s didn't accept the announcement: %v", a.board, a.err)
		}
	}
	return err
}

func (r *relay) sendFirst(ctx context.Context, body []byte) error {
	err := r.send(ctx, http.DefaultClient, body)
	// Some phones don't show this program their list of trusted certificates.
	// The notice is sealed and signed, so nothing is lost by sending it
	// without checking who is on the other end: the worst an impostor can do
	// is throw it away.
	var unknown x509.UnknownAuthorityError
	var verify *tls.CertificateVerificationError
	if errors.As(err, &unknown) || errors.As(err, &verify) {
		err = r.send(ctx, unchecked, body)
	}
	return err
}

var unchecked = &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}

func (r *relay) send(ctx context.Context, client *http.Client, body []byte) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.topicURL(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s replied %s", r.base, resp.Status)
	}
	var ack struct{ ID string }
	return json.NewDecoder(resp.Body).Decode(&ack)
}
