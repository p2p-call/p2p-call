// Package call is the call itself: the small server that serves the call
// page and introduces the participants, and the tunnel that gives it a public
// address. The desktop program and the Android app are both thin shells
// around it.
package call

import (
	"bytes"
	"cmp"
	"compress/gzip"
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

//go:embed web
var webFiles embed.FS

type iceServer struct {
	URLs []string `json:"urls"`
}

type Config struct {
	Port     int // preferred port on this device; any free one if taken
	MaxPeers int // how many people fit in the call
	// Tunnel is how the call gets its public address: auto (localhost.run,
	// then serveo.net, then Cloudflare), ssh (the first two only: no
	// program to download), localhostrun, serveo, cloudflare, none (this
	// device only), self (no tunnel, yet a link: for trying it all out on
	// one computer) — or an address of the organizer's own, https://…, for
	// a tunnel they run themselves (ngrok, Tailscale Funnel, a Cloudflare
	// tunnel of their own…) to this program's port: then none is opened.
	Tunnel      string
	Cloudflared string // path to cloudflared; found or downloaded if empty
	// StateDir is where the organizer's key is kept, which makes the link
	// permanent. Empty: the link lasts for this run only.
	StateDir string
	// NewLink throws the kept key away: a new link, and the old one dies.
	NewLink bool
	// OneTime gives this call a link of its own, made up on the spot and
	// kept nowhere: it dies with the call and can't be used again. The
	// permanent link is left as it is, for the calls that want it.
	OneTime bool
	// Direct gives people the tunnel's own address instead of a link to the
	// site: the call page comes from this program, through the tunnel, and
	// nothing else is used — no site, no notice boards. The address changes
	// whenever the tunnel reconnects (the new one is shown to the organizer,
	// and the pages already in the call are told it). The key is made up for
	// this call only, as with OneTime. Relay "none" means the same.
	Direct bool
	// Relay is the notice board the tunnel's address is posted on (see
	// relay.go). Empty: DefaultRelay. "none": no permanent link — people are
	// given the tunnel's own address, which changes.
	Relay string
	// Site is the page the permanent link leads to. Empty: DefaultSite.
	Site string
	// Invite is called with the link to give people: at once with the
	// permanent one, or, without a relay, with the tunnel's address when it
	// is up and each time it changes. May be nil.
	Invite func(url string, changed bool)
	// OnEnd is called when the organizer has ended the call for everyone
	// from the call page; the program is expected to Close the call. May
	// be nil.
	OnEnd func()
	// OnAbandoned is called when the organizer's page has been closed (or
	// was never opened) for a minute and a half: the program, which has no
	// window of its own, is expected to Close the call and quit rather
	// than run on unseen. Nil: the call waits for its organizer for as
	// long as it takes — right for the Android app, which has a window.
	OnAbandoned func()
}

// Call is a running call.
type Call struct {
	// HostURL is the organizer's page, on this device only. Whoever opens
	// it runs the call, so it is not to be shared.
	HostURL string
	// Link is the permanent link for the guests; "" if there isn't one.
	Link string

	srv   *http.Server
	relay *relay
	stop  context.CancelFunc
}

// Start begins serving the call and, unless cfg.Tunnel is "none", opens the
// tunnel in the background. The call lasts until Close or until ctx ends.
func Start(ctx context.Context, cfg Config) (*Call, error) {
	ice := []iceServer{{URLs: stunServers}}
	if cfg.MaxPeers <= 0 {
		cfg.MaxPeers = 10
	}

	ln, err := listen(cfg.Port)
	if err != nil {
		return nil, err
	}
	local := "http://localhost:" + fmt.Sprint(ln.Addr().(*net.TCPAddr).Port)

	direct := cfg.Tunnel != "none" && (cfg.Direct || cfg.Relay == "none")
	keyDir, fresh := cfg.StateDir, cfg.NewLink
	if cfg.OneTime || direct {
		keyDir, fresh = "", true
	}
	id, err := loadIdentity(keyDir, fresh)
	if err != nil {
		log.Printf("Couldn't save the permanent link key (%v): the link will work this time only.", err)
		if id, err = loadIdentity("", true); err != nil {
			ln.Close()
			return nil, err
		}
	}
	var rl *relay
	link := ""
	if cfg.Tunnel != "none" && !direct {
		rl = &relay{base: strings.TrimRight(cmp.Or(cfg.Relay, DefaultRelay), "/"), id: id}
		if cfg.Relay == "" {
			rl.spare = spareBoards // a board of one's own choosing stands alone
		}
		link = cmp.Or(cfg.Site, DefaultSite) + "#" + id.tail()
	}

	room := NewRoom(randomHex(16), cfg.MaxPeers)
	for _, key := range id.bannedKeys() {
		room.banned[key] = true
	}
	room.onBan = id.ban
	room.onEnd = cfg.OnEnd
	if cfg.OnAbandoned != nil {
		room.abandonAfter(90*time.Second, cfg.OnAbandoned)
	}
	room.id = id
	if u, err := url.Parse(cmp.Or(cfg.Site, DefaultSite)); err == nil && u.Host != "" {
		room.siteOrigin = u.Scheme + "://" + u.Host
	}
	room.pass = id.pass()
	site := siteInfo{}
	if rl != nil {
		site = siteInfo{Room: id.room(), Once: cfg.OneTime}
		room.sealedOnly = true
		room.SetInvite(link)
	}
	directTail := ""
	if direct {
		// Sealed all the same: the tunnel passes the talk with the program
		// on but can't read it — as long as the page it passes on is honest,
		// which the guests' pages are told (see the warning in index.html).
		site = siteInfo{Room: id.room(), Direct: true}
		room.sealedOnly = true
		directTail = id.directTail()
	}
	room.config = pageConfig(ice, site)
	if cfg.Tunnel != "none" {
		room.tunnel = &tunnelCtl{hello: mustJSON(map[string]any{"room": site.Room})}
	}
	srv := &http.Server{Handler: routes(room, ice, site), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("Server stopped: %v", err)
		}
	}()

	ctx, stop := context.WithCancel(ctx)
	if rl != nil {
		go rl.keepPosted(ctx)
		if cfg.Invite != nil {
			cfg.Invite(link, false)
		}
	}
	if cfg.Tunnel != "none" {
		go openTunnel(ctx, cfg, local, room, rl, directTail)
	}
	return &Call{HostURL: local + "/?host=" + room.hostToken, Link: link, srv: srv, relay: rl, stop: stop}, nil
}

// Close ends the call: the tunnel goes down and the server stops.
func (c *Call) Close() {
	c.stop()
	if c.relay != nil {
		// Tell the link's page the call is over, so it doesn't send people
		// to a door that is no longer there.
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		c.relay.post(ctx, "", true)
		cancel()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if c.srv.Shutdown(ctx) != nil {
		c.srv.Close() // the participants' open connections don't end on their own
	}
}

// siteInfo is what the pages need to find the call again when the tunnel's
// address changes. Empty when there is no permanent link.
type siteInfo struct {
	Room   string `json:"room,omitempty"`
	Once   bool   `json:"once,omitempty"`   // the link is for this call only
	Direct bool   `json:"direct,omitempty"` // the link is the tunnel's own address
}

func pageConfig(ice []iceServer, site siteInfo) []byte {
	return mustJSON(map[string]any{"iceServers": ice, "room": site.Room, "once": site.Once, "direct": site.Direct})
}

func routes(room *Room, ice []iceServer, site siteInfo) http.Handler {
	web, _ := fs.Sub(webFiles, "web")
	// The organizer's own page, on the device itself, asks for this before
	// joining. A guest's page gets it sealed, in the welcome.
	config := pageConfig(nil, site)
	if !room.sealedOnly {
		config = pageConfig(ice, site)
	}
	hello := mustJSON(map[string]any{"room": site.Room})

	mux := http.NewServeMux()
	mux.Handle("/ws", room)
	mux.HandleFunc("/config.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(config)
	})
	// The permanent link's page asks this before sending a visitor here: is
	// the call it is looking for really behind this address, and alive?
	mux.HandleFunc("/hello.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		// Only that page: any other site open in the organizer's browser
		// could otherwise ask the program on this device for the call's name.
		w.Header().Set("Access-Control-Allow-Origin", room.site())
		w.Write(hello)
	})
	files := http.FileServerFS(web)
	page := wholePage(web)
	var packed bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&packed, gzip.BestCompression)
	zw.Write(page)
	zw.Close()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Each run is a new call at a new address; nothing is worth caching.
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer") // the host's address carries its token
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Vary", "Accept-Encoding")
			body := page
			// Packed: through a tunnel every kilobyte counts (localhost.run
			// passes on a few a second).
			if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
				w.Header().Set("Content-Encoding", "gzip")
				body = packed.Bytes()
			}
			// With its length said: sent in chunks, localhost.run holds the
			// end back for half a minute.
			w.Header().Set("Content-Length", strconv.Itoa(len(body)))
			w.Write(body)
			return
		}
		files.ServeHTTP(w, r)
	})
	// Only under its own names: this device's, and the tunnels'. A page of
	// some other site, open in the organizer's browser, could otherwise make
	// its own address point here and talk to the program as if it were its
	// own server.
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !ownHost(r.Host) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

// wholePage is the call page with its scripts and styles put inside it: one
// request instead of a dozen. Through a tunnel every request takes a second
// or more, and a guest whose page comes straight from here (Config.Direct)
// would otherwise wait half a minute for it.
func wholePage(web fs.FS) []byte {
	html, err := fs.ReadFile(web, "index.html")
	if err != nil {
		panic(err)
	}
	inline := func(re *regexp.Regexp, open, close string) {
		html = re.ReplaceAllFunc(html, func(tag []byte) []byte {
			body, err := fs.ReadFile(web, string(re.FindSubmatch(tag)[1]))
			if err != nil || bytes.Contains(body, []byte("</")) && bytes.Contains(bytes.ToLower(body), []byte("</"+strings.Trim(open, "<>"))) {
				return tag // left as a link: it couldn't be put inside safely
			}
			return append(append([]byte(open+"\n"), body...), close...)
		})
	}
	inline(regexp.MustCompile(`<script src="([a-z]+\.js)"></script>`), "<script>", "</script>")
	inline(regexp.MustCompile(`<link rel="stylesheet" href="([a-z]+\.css)">`), "<style>", "</style>")
	return html
}

func ownHost(hostport string) bool {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	host = strings.ToLower(strings.Trim(host, "[]"))
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return true
	}
	for _, d := range tunnelDomains() {
		if host == d || strings.HasSuffix(host, "."+d) {
			return true
		}
	}
	return false
}

// OwnTunnel says whether the tunnel asked for is an address of the
// organizer's own (https://name[:port]), and gives it without a trailing
// slash. The program then answers under that name too.
func OwnTunnel(which string) (string, bool) {
	u, err := url.Parse(which)
	if err != nil || u.Scheme != "https" || u.Host == "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", false
	}
	ownTunnelMu.Lock()
	ownTunnel = strings.ToLower(u.Hostname())
	ownTunnelMu.Unlock()
	return "https://" + strings.ToLower(u.Host), true
}

// listen takes the preferred port on loopback only — guests come in through
// the tunnel, and a bare LAN address wouldn't get them a microphone anyway
// (browsers only allow it over https or on localhost).
func listen(port int) (net.Listener, error) {
	if port > 0 {
		if ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port)); err == nil {
			return ln, nil
		}
	}
	return net.Listen("tcp", "127.0.0.1:0")
}

// openTunnel gets the call a public address: localhost.run first (nothing to
// download, and it works where Cloudflare's quick tunnels are blocked), then
// serveo.net, then Cloudflare (desktop only: it needs its own program).
func openTunnel(ctx context.Context, cfg Config, local string, room *Room, rl *relay, directTail string) {
	announced := false
	announce := func(url string) {
		if asked, same := room.tunnel.set(url); asked {
			// After the invite below, so that this is the last word on it.
			defer room.tellHosts(mustJSON(map[string]any{"type": "tunnel", "ok": true, "renewed": true, "same": same}))
		}
		if rl != nil {
			// People have the permanent link; only its page needs to know.
			log.Printf("Tunnel: %s", url)
			rl.set(ctx, url)
			return
		}
		if directTail != "" {
			url += "/#" + directTail
		}
		room.SetInvite(url)
		if cfg.Invite != nil {
			cfg.Invite(url, announced)
		}
		announced = true
	}

	which := cfg.Tunnel
	if which == "self" {
		announce(local)
		return
	}
	if own, ok := OwnTunnel(which); ok {
		// The organizer's own tunnel, run by themselves: nothing to open.
		log.Printf("Own tunnel address: %s (the tunnel must point to %s)", own, local)
		announce(own)
		return
	}
	for _, t := range []struct {
		name string
		ssh  sshTunnel
	}{{"localhostrun", localhostRun}, {"serveo", serveo}} {
		if which != "" && which != "auto" && which != "ssh" && which != t.name {
			continue
		}
		log.Printf("Starting tunnel %s…", t.ssh.name)
		// (The nudge to take a new address is this tunnel's from now on.)
		again := make(chan struct{}, 1)
		room.tunnel.mu.Lock()
		room.tunnel.again = again
		room.tunnel.mu.Unlock()
		err := startSSH(ctx, t.ssh, strings.TrimPrefix(local, "http://"), again, announce)
		if err != nil {
			room.tunnel.mu.Lock()
			room.tunnel.again = nil
			room.tunnel.mu.Unlock()
		}
		if err == nil || ctx.Err() != nil {
			return
		}
		log.Printf("%s didn't work: %v", t.ssh.name, err)
	}
	if which != "" && which != "auto" && which != "cloudflare" {
		log.Printf("The tunnel didn't start. The call is only available on this device.")
		return
	}

	log.Printf("Starting Cloudflare tunnel…")
	bin, err := findCloudflared(cfg.Cloudflared)
	if err == nil {
		var url string
		if url, err = startTunnel(ctx, bin, local); err == nil {
			announce(url)
			return
		}
	}
	if ctx.Err() == nil {
		log.Printf("The tunnel didn't start: %v\n  The call is only available on this device.", err)
	}
}
