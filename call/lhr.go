package call

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"regexp"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/ssh"
)

// SSH tunnels: free, no account, and nothing extra to install — the SSH
// client is this program, so they work on Android too. Their free addresses
// change now and then; when that happens the new one is announced the same
// way as the first.
//
// localhost.run comes first. serveo.net is the spare: it shows a browser that
// opens its address a warning page of its own first (one tap to go on), but
// lets a page's own requests through, so a permanent link works through it as
// it does through localhost.run. (pinggy.io was tried and doesn't do: its
// warning stops a page's WebSocket too.)

type sshTunnel struct {
	name   string
	server string
	user   string
	url    *regexp.Regexp // the address, in what the server says
}

var (
	localhostRun = sshTunnel{"localhost.run", "localhost.run:22", "nokey", // localhost.run's account-less mode; any key will do
		regexp.MustCompile(`https://[a-z0-9][a-z0-9.-]*\.lhr\.life`)}
	serveo = sshTunnel{"serveo.net", "serveo.net:22", "p2p-call",
		regexp.MustCompile(`https://[a-z0-9][a-z0-9.-]*\.(serveousercontent\.com|serveo\.net)`)}
)

var debug = os.Getenv("SM_DEBUG") != ""

var ansi = regexp.MustCompile("\x1b\\[[0-9;]*[A-Za-z]")

// startLocalhostRun is startSSH with localhost.run.
func startLocalhostRun(ctx context.Context, localAddr string, announce func(string)) error {
	return startSSH(ctx, localhostRun, localAddr, nil, announce)
}

// startSSH returns once the first address is known and keeps the tunnel up
// (reconnecting if it drops) until ctx ends. Every address, the first
// included, goes to announce. A word on again makes it drop the connection
// and come back as somebody new, under another address.
func startSSH(ctx context.Context, t sshTunnel, localAddr string, again <-chan struct{}, announce func(string)) error {
	// One key for the whole call: localhost.run names the address after the
	// key, so reconnecting with the same one has a chance of getting the
	// same address back — and the guests' pages a chance of finding the call
	// again.
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	// If no address comes in a minute, this tunnel is given up for good —
	// stopped, so that it doesn't turn up with an address later, when
	// another tunnel is already carrying the call.
	parent := ctx
	ctx, cancel := context.WithCancel(parent)
	context.AfterFunc(parent, cancel)
	var mu sync.Mutex
	gaveUp := false
	first := make(chan error, 1)
	go func() {
		got := false
		for {
			// One connection, which a word on again cuts short.
			one, cut := context.WithCancel(ctx)
			var fresh atomic.Bool
			go func() {
				select {
				case <-again:
					fresh.Store(true)
					cut()
				case <-one.Done():
				}
			}()
			err := sshSession(one, t, key, localAddr, func(u string) {
				mu.Lock()
				defer mu.Unlock()
				if gaveUp {
					return
				}
				announce(u)
				if !got {
					got = true
					first <- nil
				}
			})
			cut()
			if ctx.Err() != nil {
				return
			}
			if !got {
				first <- err
				return
			}
			if fresh.Load() {
				// Asked for: a new key, since the address goes by the key.
				if _, k, err := ed25519.GenerateKey(rand.Reader); err == nil {
					key = k
				}
				log.Printf("Reconnecting the tunnel…")
				continue
			}
			log.Printf("The tunnel dropped (%v), reconnecting…", err)
			select {
			case <-time.After(5 * time.Second):
			case <-ctx.Done():
				return
			}
		}
	}()
	select {
	case err := <-first:
		return err
	case <-time.After(60 * time.Second):
		mu.Lock()
		select {
		case err := <-first: // it made it at the last moment after all
			mu.Unlock()
			return err
		default:
		}
		gaveUp = true
		mu.Unlock()
		cancel()
		return fmt.Errorf("%s gave no link within a minute", t.name)
	case <-ctx.Done():
		return ctx.Err()
	}
}

// sshSession is one connection: it lasts until the server or the network
// drops it. announce is called from this goroutine.
func sshSession(ctx context.Context, t sshTunnel, key ed25519.PrivateKey, localAddr string, announce func(string)) error {
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		return err
	}
	cfg := &ssh.ClientConfig{
		User: t.user,
		// serveo.net asks for "keyboard-interactive" with no questions.
		Auth: []ssh.AuthMethod{ssh.PublicKeys(signer), ssh.KeyboardInteractive(func(_, _ string, q []string, _ []bool) ([]string, error) {
			return make([]string, len(q)), nil
		})},
		// A public relay with nothing secret to protect at this layer: the
		// browsers' connection to it is HTTPS, and the audio is end-to-end
		// encrypted WebRTC that never passes through it.
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         20 * time.Second,
	}

	d := net.Dialer{Timeout: 20 * time.Second}
	raw, err := d.DialContext(ctx, "tcp", t.server)
	if err != nil {
		return err
	}
	conn, chans, reqs, err := ssh.NewClientConn(raw, t.server, cfg)
	if err != nil {
		raw.Close()
		return err
	}
	// Incoming visitors arrive as forwarded-tcpip channels; they are taken
	// here rather than by the ssh.Client.
	go func() {
		for nc := range chans {
			if nc.ChannelType() != "forwarded-tcpip" {
				nc.Reject(ssh.UnknownChannelType, "")
				continue
			}
			go forward(nc, localAddr)
		}
	}()
	client := ssh.NewClient(conn, make(chan ssh.NewChannel), reqs)
	defer client.Close()

	stop := context.AfterFunc(ctx, func() { client.Close() })
	defer stop()

	// The same request as `ssh -R 80:…`: "send what reaches port 80 to me".
	payload := ssh.Marshal(&struct {
		Addr string
		Port uint32
	}{"localhost", 80})
	ok, _, err := client.SendRequest("tcpip-forward", true, payload)
	if debug {
		log.Printf("%s: tcpip-forward ok=%v err=%v", t.name, ok, err)
	}
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%s refused the tunnel", t.name)
	}

	go keepAlive(client)

	// The session is opened by hand: localhost.run never answers the
	// "shell" request, so ssh.Session.Shell, which waits for the answer,
	// would hang forever. The text comes as soon as the channel is open.
	// (No terminal is asked for: with one, some say nothing at all.)
	ch, chReqs, err := client.OpenChannel("session", nil)
	if err != nil {
		return err
	}
	defer ch.Close()
	go ssh.DiscardRequests(chReqs)
	go io.Copy(io.Discard, ch.Stderr())
	if _, err := ch.SendRequest("shell", false, nil); err != nil {
		return err
	}

	// The address comes as text in the welcome message, and again if it
	// changes.
	last := ""
	sc := bufio.NewScanner(ch)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		if debug {
			log.Printf("%s: %q", t.name, sc.Text())
		}
		if u := t.url.FindString(ansi.ReplaceAllString(sc.Text(), "")); u != "" && u != last {
			last = u
			announce(u)
		}
	}
	err = client.Wait()
	if err == nil {
		err = io.EOF
	}
	return fmt.Errorf("connection closed: %w", err)
}

func keepAlive(client *ssh.Client) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for range t.C {
		if _, _, err := client.SendRequest("keepalive@openssh.com", true, nil); err != nil {
			client.Close()
			return
		}
	}
}

func forward(nc ssh.NewChannel, localAddr string) {
	local, err := net.DialTimeout("tcp", localAddr, 5*time.Second)
	if err != nil {
		nc.Reject(ssh.ConnectionFailed, err.Error())
		return
	}
	ch, reqs, err := nc.Accept()
	if err != nil {
		local.Close()
		return
	}
	go ssh.DiscardRequests(reqs)

	// Each direction ends on its own (half-close), so a reply still gets
	// out after the visitor has finished sending.
	done := make(chan struct{})
	go func() {
		io.Copy(ch, local)
		ch.CloseWrite()
		close(done)
	}()
	io.Copy(local, ch)
	if tc, ok := local.(*net.TCPConn); ok {
		tc.CloseWrite()
	}
	<-done
	ch.Close()
	local.Close()
}
