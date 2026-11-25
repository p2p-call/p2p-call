// Package mobile is what the Android app sees of the call (through gomobile
// bind): start it, stop it. Everything else — the invite link included —
// happens on the call page the app shows.
package mobile

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"

	"p2p-call/call"
)

var (
	mu      sync.Mutex
	current *call.Call
)

// Start begins a call (or returns the one already running) and gives back
// the organizer's page to show. dir is the app's private folder: the key
// behind the permanent link is kept there.
func Start(dir string) (string, error) {
	return StartWith(dir, false)
}

// StartWith is Start with a choice: oneTime gives the call a link of its
// own that dies with it, instead of the organizer's permanent one.
func StartWith(dir string, oneTime bool) (string, error) {
	kind := "permanent"
	if oneTime {
		kind = "once"
	}
	return StartAs(dir, kind)
}

// StartAs begins a call of the kind asked: "permanent" (the organizer's
// permanent link), "once" (a link that dies with the call) or "direct" (a
// link straight to the tunnel's address: no site and no notice boards).
func StartAs(dir, kind string) (string, error) {
	mu.Lock()
	defer mu.Unlock()
	if current != nil {
		return current.HostURL, nil
	}
	// The tunnels that need no program of their own: cloudflared doesn't
	// exist for Android. One after another, unless the organizer has
	// chosen one (SetTunnel).
	tunnel := "ssh"
	if t := Tunnel(dir); t != "" {
		tunnel = t
	}
	c, err := call.Start(context.Background(), call.Config{Port: 8765, Tunnel: tunnel, StateDir: dir, OneTime: kind == "once", Direct: kind == "direct"})
	if err != nil {
		return "", err
	}
	current = c
	return c.HostURL, nil
}

// Stop ends the call, if there is one.
func Stop() {
	mu.Lock()
	defer mu.Unlock()
	if current != nil {
		current.Close()
		current = nil
	}
}

// Tunnel gives back the tunnel the organizer has chosen for their calls:
// "localhostrun", "serveo", or "" — the app tries one after the other.
func Tunnel(dir string) string {
	if t := call.LoadTunnel(dir); t == "localhostrun" || t == "serveo" {
		return t
	}
	return ""
}

// SetTunnel keeps that choice; "" goes back to trying one after the other.
func SetTunnel(dir, name string) error {
	if name != "" && name != "localhostrun" && name != "serveo" {
		return errors.New("the app has no such tunnel")
	}
	return call.SaveTunnel(dir, name)
}

// ResetLink throws the permanent link away: the next call gets a new one,
// and the old link — with everyone who has it — is left behind.
func ResetLink(dir string) error {
	mu.Lock()
	defer mu.Unlock()
	if current != nil {
		return errors.New("end the call first")
	}
	err := os.Remove(filepath.Join(dir, "room.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
