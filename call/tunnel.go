package call

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sync"
	"time"
)

// The tunnel is a Cloudflare Quick Tunnel: cloudflared dials out to
// Cloudflare and gets a random https://….trycloudflare.com address that leads
// back here. Free, no account. Outgoing connections are what a phone or a home
// router lets through, which is why this works where a bare address can't.

const cloudflaredReleases = "https://github.com/cloudflare/cloudflared/releases/latest/download/"

var tunnelURL = regexp.MustCompile(`https://[a-z0-9-]+\.trycloudflare\.com`)

func exeName(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

// findCloudflared looks next to this program, then on PATH, then in the cache
// it downloads into; failing all three, it downloads.
func findCloudflared(explicit string) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	name := exeName("cloudflared")
	if self, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(self), name)
		if isFile(p) {
			return p, nil
		}
	}
	if p, err := exec.LookPath("cloudflared"); err == nil {
		return p, nil
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	p := filepath.Join(cache, "p2p-call", name)
	if isFile(p) {
		return p, nil
	}
	log.Printf("Downloading cloudflared (once, ~40 MB)…")
	if err := downloadCloudflared(p); err != nil {
		return "", fmt.Errorf("couldn't download cloudflared: %w", err)
	}
	return p, nil
}

func isFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func cloudflaredAsset() (string, error) {
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "linux/amd64", "linux/arm64", "linux/arm", "linux/386":
		return "cloudflared-linux-" + runtime.GOARCH, nil
	case "windows/amd64", "windows/386":
		return "cloudflared-windows-" + runtime.GOARCH + ".exe", nil
	case "darwin/amd64", "darwin/arm64":
		return "cloudflared-darwin-" + runtime.GOARCH + ".tgz", nil
	}
	return "", fmt.Errorf("no prebuilt cloudflared for %s/%s", runtime.GOOS, runtime.GOARCH)
}

func downloadCloudflared(dst string) error {
	asset, err := cloudflaredAsset()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Get(cloudflaredReleases + asset)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: %s", asset, resp.Status)
	}

	var body io.Reader = resp.Body
	if filepath.Ext(asset) == ".tgz" {
		body, err = binaryFromTgz(resp.Body, "cloudflared")
		if err != nil {
			return err
		}
	}

	tmp := dst + ".part"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, body); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

func binaryFromTgz(r io.Reader, name string) (io.Reader, error) {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err != nil {
			return nil, fmt.Errorf("%s not found in the archive: %w", name, err)
		}
		if h.Typeflag == tar.TypeReg && filepath.Base(h.Name) == name {
			return tr, nil
		}
	}
}

// startTunnel runs cloudflared until ctx ends and returns the public address
// as soon as cloudflared prints it.
func startTunnel(ctx context.Context, bin, localURL string) (string, error) {
	cmd := exec.CommandContext(ctx, bin, "tunnel", "--no-autoupdate", "--url", localURL)
	watch := &lineWatcher{found: make(chan string, 1)}
	cmd.Stdout = io.Discard
	cmd.Stderr = watch // cloudflared logs to stderr, the address included
	if err := cmd.Start(); err != nil {
		return "", err
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()

	select {
	case u := <-watch.found:
		go func() {
			if err := <-exited; ctx.Err() == nil {
				log.Printf("The tunnel went down (%v). New people can't join; those already in the call can keep talking.", err)
			}
		}()
		return u, nil
	case err := <-exited:
		return "", fmt.Errorf("cloudflared exited (%v):%s", err, watch.lastLines())
	case <-time.After(90 * time.Second):
		return "", errors.New("cloudflared gave no link within 90 seconds. No internet?")
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// lineWatcher reads cloudflared's log line by line, looking for the address
// and keeping the last lines in case it never comes.
type lineWatcher struct {
	mu      sync.Mutex
	partial []byte
	tail    []string
	sent    bool
	found   chan string
}

func (w *lineWatcher) Write(b []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.partial = append(w.partial, b...)
	for {
		i := bytes.IndexByte(w.partial, '\n')
		if i < 0 {
			break
		}
		line := string(w.partial[:i])
		w.partial = w.partial[i+1:]
		if w.sent {
			continue
		}
		// The API's own address shows up in error messages; the tunnel's
		// address is any other one.
		if u := tunnelURL.FindString(line); u != "" && u != "https://api.trycloudflare.com" {
			w.found <- u
			w.sent = true
			continue
		}
		if len(w.tail) == 20 {
			w.tail = w.tail[1:]
		}
		w.tail = append(w.tail, line)
	}
	if len(w.partial) > 64<<10 {
		w.partial = w.partial[:0]
	}
	return len(b), nil
}

func (w *lineWatcher) lastLines() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := ""
	for _, l := range w.tail {
		out += "\n  " + l
	}
	return out
}

// knownTunnels are the domains the tunnels this program opens give their
// addresses under; ownTunnel, the organizer's own address, if one was given
// (see Config.Tunnel). The program answers under these names only.
var (
	knownTunnels = []string{"lhr.life", "trycloudflare.com", "serveousercontent.com", "serveo.net"}
	ownTunnelMu  sync.Mutex
	ownTunnel    string
)

func tunnelDomains() []string {
	ownTunnelMu.Lock()
	defer ownTunnelMu.Unlock()
	if ownTunnel != "" {
		return append(knownTunnels[:len(knownTunnels):len(knownTunnels)], ownTunnel)
	}
	return knownTunnels
}

// The organizer's choice of tunnel, kept beside the key for the calls to
// come: "" (the program chooses: one after another until one works),
// localhostrun, serveo, or — on a computer — cloudflare.

func tunnelPath(dir string) string { return filepath.Join(dir, "tunnel.txt") }

// LoadTunnel gives back the choice saved with SaveTunnel; "" if none.
func LoadTunnel(dir string) string {
	if dir == "" {
		return ""
	}
	b, _ := os.ReadFile(tunnelPath(dir))
	switch name := string(bytes.TrimSpace(b)); name {
	case "localhostrun", "serveo", "cloudflare":
		return name
	}
	return ""
}

// SaveTunnel keeps the choice; "" or "auto" forgets it.
func SaveTunnel(dir, name string) error {
	if dir == "" {
		return errors.New("nowhere to save")
	}
	switch name {
	case "", "auto":
		err := os.Remove(tunnelPath(dir))
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	case "localhostrun", "serveo", "cloudflare":
	default:
		return fmt.Errorf("no such tunnel: %s", name)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(tunnelPath(dir), []byte(name+"\n"), 0o600)
}

// tunnelCtl is what the room knows of the tunnel: the address it has now,
// how to tell whether that address still leads here, and how to make the
// tunnel take a new one.
type tunnelCtl struct {
	mu    sync.Mutex
	url   string        // the tunnel's address of the moment; "" before the first
	hello []byte        // what /hello.json answers here, to know our own door by
	again chan struct{} // a nudge to the tunnel to reconnect; nil if it can't
	asked bool          // the organizer has asked for that, and is waiting to hear how it went
}

// set takes the tunnel's address of the moment. It says whether the
// organizer had asked for the tunnel to reconnect, and whether the address
// came out the same as before (localhost.run's does; serveo's doesn't).
func (t *tunnelCtl) set(url string) (asked, same bool) {
	if t == nil {
		return false, false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	asked, same = t.asked, t.url == url
	t.url, t.asked = url, false
	return asked, same
}

// alive asks for this program's own /hello.json through the tunnel.
func (t *tunnelCtl) alive() bool {
	if t == nil {
		return false
	}
	t.mu.Lock()
	url, hello := t.url, t.hello
	t.mu.Unlock()
	if url == "" {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url+"/hello.json", nil)
	if err != nil {
		return false
	}
	// As a program, not a browser: a tunnel that shows browsers a page of
	// its own first lets this through.
	req.Header.Set("User-Agent", "p2p-call")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	return resp.StatusCode == http.StatusOK && bytes.Equal(bytes.TrimSpace(body), bytes.TrimSpace(hello))
}

func (t *tunnelCtl) renew() error {
	if t == nil || t.again == nil {
		return errors.New("This tunnel can't be reconnected from here.")
	}
	t.mu.Lock()
	t.asked = true
	t.mu.Unlock()
	select {
	case t.again <- struct{}{}:
	default: // asked already
	}
	return nil
}
