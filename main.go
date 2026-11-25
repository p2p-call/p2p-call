// p2p-call: a group voice call hosted on the organizer's own device.
//
// Run it, and it opens its start page in the browser: create a call, or enter
// somebody else's by a link. Creating one serves the call page, opens it as
// the host, opens a free tunnel and gives the link to send to friends.
// Friends open the link in any browser. Voice goes directly between the browsers
// (WebRTC); this program only introduces them to each other.
package main

import (
	"bytes"
	"cmp"
	"context"
	"crypto/rand"
	"crypto/subtle"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"

	"p2p-call/call"
)

func main() {
	port := flag.Int("port", 8765, "port on this device (if taken, any free one)")
	tunnel := flag.String("tunnel", "auto", "auto | localhostrun | serveo | cloudflare | ssh | none | self | https://your-address\n"+
		"auto: localhost.run, then serveo.net, then Cloudflare; ssh: only the first two; none: the call is only on this device;\n"+
		"self: no tunnel, but with a link, for testing on one computer;\n"+
		"https://…: the address of your own tunnel (ngrok, Tailscale Funnel, your own Cloudflare tunnel) that you started yourself, pointing at -port")
	site := flag.String("site", "", "site the links point to (default "+call.DefaultSite+")")
	noBrowser := flag.Bool("no-browser", false, "don't open a browser; the call starts right away")
	now := flag.Bool("now", false, "start a call right away, without the start page")
	once := flag.Bool("once", false, "with -now: a call with a one-time link that stops working after the call")
	direct := flag.Bool("direct", false, "with -now: a link straight to the tunnel, without the site or boards (changes if the tunnel reconnects); same as -relay none")
	maxPeers := flag.Int("max", 10, "how many people can be in the call")
	cloudflared := flag.String("cloudflared", "", "path to cloudflared (by default it is found or downloaded automatically)")
	newLink := flag.Bool("new-link", false, "change the permanent link: the old one stops working")
	relay := flag.String("relay", "", "none: no site link; people get the tunnel address, which changes. Your own board address is for testing only: pages look for the call on the board from site.json ("+call.DefaultRelay+")")
	flag.Parse()
	log.SetFlags(log.Ltime)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg := call.Config{
		Port:        *port,
		MaxPeers:    *maxPeers,
		Tunnel:      *tunnel,
		Cloudflared: *cloudflared,
		StateDir:    stateDir(),
		NewLink:     *newLink,
		Relay:       *relay,
		Site:        *site,
		OnEnd: func() {
			fmt.Println("\n  The call was ended from the call page.")
			stop()
		},
		OnAbandoned: func() {
			fmt.Println("\n  The host page is closed, so the program is no longer needed.")
			stop()
		},
		Invite: func(url string, changed bool) {
			fmt.Println()
			if changed {
				fmt.Println("  The link for your friends has changed:")
			} else {
				fmt.Println("  Link for your friends:")
			}
			fmt.Println("   ", url)
			fmt.Println("  (it's also on the call page, with a \"Copy\" button)")
			fmt.Println()
		},
	}

	if *noBrowser {
		// Run by hand in a terminal, on purpose: it stays until stopped there.
		cfg.OnAbandoned = nil
	}
	// Said in the terminal too: a call created at once shows no start page.
	go func() {
		if u := checkUpdate(ctx); u.Latest != "" {
			fmt.Printf("\n  New version available: %s (you have %s):\n    %s\n\n", u.Latest, u.Version, u.URL)
		}
	}()
	// A tunnel named on the command line stands; otherwise the one chosen
	// on the start page, if any, is used.
	tunnelNamed := false
	flag.Visit(func(f *flag.Flag) { tunnelNamed = tunnelNamed || f.Name == "tunnel" })
	st := &starter{ctx: ctx, cfg: cfg, tunnelNamed: tunnelNamed}
	defer st.close()
	if *now || *noBrowser {
		// Nobody to press the button: the call begins at once.
		url, err := st.create(*once, *direct)
		if err != nil {
			fatal("Couldn't open the port: %v", err)
		}
		if !*noBrowser {
			fmt.Println("  Opening the call page in your browser…")
			openBrowser(url)
		}
	} else {
		url, err := st.serve(stop)
		if err != nil {
			fatal("Couldn't start the program: %v", err)
		}
		fmt.Println()
		fmt.Println("  Opening the program page in your browser: start a call or join one.")
		fmt.Println("  If it didn't open, open it yourself:")
		fmt.Println("   ", url)
		fmt.Println()
		openBrowser(url)
	}
	<-ctx.Done()

	fmt.Println("\n  Shutting down…")
}

// starter is the program before a call: its start page (create a call, or
// enter somebody else's by a link) and the call it begins when asked to.
type starter struct {
	ctx context.Context
	cfg call.Config

	tunnelNamed bool // -tunnel was given: the start page's choice is not asked

	mu    sync.Mutex
	call  *call.Call
	token string
	seen  time.Time // when the start page last showed that it is open
}

//go:embed start.html
var startPage []byte

// create begins the call, or gives back the one already running; the answer
// is the organizer's page. direct: the link leads straight to the tunnel.
func (s *starter) create(oneTime, direct bool) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.call != nil {
		return s.call.HostURL, nil
	}
	cfg := s.cfg
	cfg.OneTime = oneTime
	cfg.Direct = cfg.Direct || direct
	if t := call.LoadTunnel(cfg.StateDir); t != "" && !s.tunnelNamed {
		cfg.Tunnel = t
	}
	c, err := call.Start(s.ctx, cfg)
	if err != nil {
		return "", err
	}
	s.call = c
	if !oneTime {
		s.cfg.NewLink = false // done
	}
	fmt.Println()
	fmt.Println("  The call has started.")
	if cfg.Direct || cfg.Relay == "none" {
		fmt.Println("  The link points straight to the tunnel: if it reconnects, the link will change.")
	} else if c.Link != "" && oneTime {
		fmt.Println("  The link above is one-time: it stops working after the call.")
	} else if c.Link != "" {
		fmt.Println("  The link above is permanent: it will be the same next time.")
	}
	fmt.Println("  Your host page (don't send it to anyone):")
	fmt.Println("   ", c.HostURL)
	fmt.Println()
	fmt.Println("  To end the call, press \"End call for everyone\" on the page,")
	fmt.Println("  close this window or press Ctrl+C. If you close the call page, the program")
	fmt.Println("  quits by itself after a minute and a half.")
	fmt.Println()
	return c.HostURL, nil
}

func (s *starter) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.call != nil {
		s.call.Close()
		s.call = nil
	}
}

// serve puts the start page up on this device only and gives its address.
// The page is the program's only window, so once it is gone and no call has
// been created, the program has nothing left to do and quits.
func (s *starter) serve(quit func()) (string, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	s.token = hex.EncodeToString(b)
	s.seen = time.Now()

	// Other sites open in the same browser must not be able to press the
	// buttons: every request has to carry the token from the page's address.
	guard := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("t")), []byte(s.token)) != 1 {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			s.mu.Lock()
			s.seen = time.Now()
			s.mu.Unlock()
			w.Header().Set("Cache-Control", "no-store")
			h(w, r)
		}
	}
	answer := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(v)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", guard(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		// Where the links lead is written down in one place (call/site.go).
		w.Write(bytes.ReplaceAll(startPage, []byte("{{SITE}}"), []byte(call.DefaultSite)))
	}))
	mux.HandleFunc("POST /alive", guard(func(w http.ResponseWriter, r *http.Request) {
		answer(w, map[string]any{"ok": true})
	}))
	mux.HandleFunc("POST /create", guard(func(w http.ResponseWriter, r *http.Request) {
		url, err := s.create(r.URL.Query().Get("once") != "", r.URL.Query().Get("direct") != "")
		if err != nil {
			answer(w, map[string]any{"error": err.Error()})
			return
		}
		answer(w, map[string]any{"url": url})
	}))
	// How the call was begun the last time (the start page asks, to offer
	// the same again): read with an empty request, saved with a name in it.
	mux.HandleFunc("POST /mode", guard(func(w http.ResponseWriter, r *http.Request) {
		file := filepath.Join(s.cfg.StateDir, "start.txt")
		if name := r.URL.Query().Get("save"); name != "" && s.cfg.StateDir != "" {
			switch name {
			case "permanent", "once", "direct", "bare":
				os.MkdirAll(s.cfg.StateDir, 0o700)
				os.WriteFile(file, []byte(name+"\n"), 0o600)
			}
		}
		mode := "permanent"
		if b, err := os.ReadFile(file); err == nil && s.cfg.StateDir != "" {
			switch name := string(bytes.TrimSpace(b)); name {
			case "once", "direct", "bare":
				mode = name
			}
		}
		answer(w, map[string]any{"mode": mode})
	}))
	// Which tunnel the calls go out by: read with an empty request, saved
	// with a name in it ("auto" — the program chooses).
	mux.HandleFunc("POST /tunnel", guard(func(w http.ResponseWriter, r *http.Request) {
		if name := r.URL.Query().Get("save"); name != "" {
			if err := call.SaveTunnel(s.cfg.StateDir, name); err != nil {
				answer(w, map[string]any{"error": err.Error()})
				return
			}
		}
		answer(w, map[string]any{"tunnel": cmp.Or(call.LoadTunnel(s.cfg.StateDir), "auto"), "fixed": s.tunnelNamed})
	}))
	// Is there a newer release? Asked by the page, so the answer is on it.
	mux.HandleFunc("POST /update", guard(func(w http.ResponseWriter, r *http.Request) {
		answer(w, checkUpdate(r.Context()))
	}))
	// "Close the program" on the start page.
	mux.HandleFunc("POST /quit", guard(func(w http.ResponseWriter, r *http.Request) {
		answer(w, map[string]any{"ok": true})
		fmt.Println("\n  The program was quit from its page.")
		go quit()
	}))
	mux.HandleFunc("POST /new-link", guard(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.call != nil {
			answer(w, map[string]any{"error": "end the call first"})
			return
		}
		s.cfg.NewLink = true
		answer(w, map[string]any{"ok": true})
	}))
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go srv.Serve(ln)
	go func() {
		<-s.ctx.Done()
		srv.Close()
	}()
	go func() {
		// A tab in the background may report as seldom as once a minute.
		for range time.Tick(15 * time.Second) {
			s.mu.Lock()
			idle := s.call == nil && time.Since(s.seen) > 3*time.Minute
			s.mu.Unlock()
			if idle {
				fmt.Println("\n  The program page is closed and no call was started, so the program is no longer needed.")
				quit()
				return
			}
		}
	}()
	return "http://" + ln.Addr().String() + "/?t=" + s.token, nil
}

// stateDir is where the key behind the permanent link lives.
func stateDir() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "p2p-call")
}

func openBrowser(url string) {
	// (For trying the start page out without a window popping up.)
	if os.Getenv("P2P_NO_OPEN") != "" {
		return
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("Couldn't open the browser. Open the link below yourself.")
		return
	}
	go cmd.Wait()
}

func fatal(format string, args ...any) {
	log.Printf(format, args...)
	if runtime.GOOS == "windows" {
		// Started by a double click, the window would vanish with the message.
		fmt.Println("Press Enter to close.")
		fmt.Scanln()
	}
	os.Exit(1)
}
