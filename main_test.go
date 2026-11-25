package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"p2p-call/call"
)

// The start page: only whoever has its token may press the buttons, and
// "create" begins one call however many times it is pressed.
func TestStartPage(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	st := &starter{ctx: ctx, cfg: call.Config{Tunnel: "none", Port: 0, StateDir: t.TempDir()}, tunnelNamed: true}
	defer st.close()
	quit := make(chan struct{}, 1)
	page, err := st.serve(func() { quit <- struct{}{} })
	if err != nil {
		t.Fatal(err)
	}
	base, token, _ := strings.Cut(page, "/?t=")

	status := func(method, url string) int {
		req, _ := http.NewRequest(method, url, nil)
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		r.Body.Close()
		return r.StatusCode
	}
	post := func(what string) map[string]any {
		sep := "?"
		if strings.Contains(what, "?") {
			sep = "&"
		}
		r, err := http.Post(base+"/"+what+sep+"t="+token, "", nil)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		var m map[string]any
		if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
			t.Fatalf("%s: %v", what, err)
		}
		return m
	}

	if c := status("GET", page); c != 200 {
		t.Fatalf("the page: %d", c)
	}
	if c := status("GET", base+"/"); c != 403 {
		t.Fatalf("the page without the token: %d", c)
	}
	if c := status("POST", base+"/create?t=guess"); c != 403 {
		t.Fatalf("create with a wrong token: %d", c)
	}
	if m := post("new-link"); m["ok"] != true {
		t.Fatalf("new-link before a call: %v", m)
	}
	// How the call is begun is kept too.
	if m := post("mode"); m["mode"] != "permanent" {
		t.Fatalf("mode: %v", m)
	}
	if m := post("mode?save=direct"); m["mode"] != "direct" {
		t.Fatalf("mode saved: %v", m)
	}
	if m := post("mode?save=nonsense"); m["mode"] != "direct" {
		t.Fatalf("a mode that doesn't exist was taken: %v", m)
	}
	// The choice of tunnel is kept, and a wrong name is refused.
	if m := post("tunnel"); m["tunnel"] != "auto" || m["fixed"] != true {
		t.Fatalf("tunnel: %v", m)
	}
	if m := post("tunnel?save=serveo"); m["tunnel"] != "serveo" || call.LoadTunnel(st.cfg.StateDir) != "serveo" {
		t.Fatalf("tunnel saved: %v", m)
	}
	if m := post("tunnel?save=pinggy"); m["error"] == nil {
		t.Fatalf("a tunnel that doesn't exist was taken: %v", m)
	}
	if m := post("tunnel?save=auto"); m["tunnel"] != "auto" || call.LoadTunnel(st.cfg.StateDir) != "" {
		t.Fatalf("tunnel forgotten: %v", m)
	}

	first, _ := post("create?once=1&x")["url"].(string)
	if !strings.Contains(first, "/?host=") {
		t.Fatalf("create: %q", first)
	}
	if c := status("GET", first); c != 200 {
		t.Fatalf("the call page: %d", c)
	}
	if again, _ := post("create")["url"].(string); again != first {
		t.Fatalf("a second call was begun: %q, %q", first, again)
	}
	if m := post("new-link"); m["error"] == nil {
		t.Fatalf("new-link during a call: %v", m)
	}

	// "Close the program".
	if c := status("POST", base+"/quit?t=guess"); c != 403 {
		t.Fatalf("quit with a wrong token: %d", c)
	}
	post("quit")
	select {
	case <-quit:
	case <-time.After(3 * time.Second):
		t.Fatal("the program wasn't told to quit")
	}
}

func TestNewerRelease(t *testing.T) {
	for _, c := range []struct {
		latest, mine string
		want         bool
	}{
		{"v0.2.1", "v0.2.0", true},
		{"v0.10.0", "v0.9.9", true},
		{"v1.0.0", "v0.9.9", true},
		{"v0.2.0", "v0.2.0", false},
		{"v0.2.0", "v0.2.1", false},
		{"v0.2.0", "v0.2.0-test3", true},
		{"v0.2.0-test3", "v0.2.0", false},
		{"", "v0.2.0", false},
	} {
		if got := newer(c.latest, c.mine); got != c.want {
			t.Errorf("newer(%q, %q) = %v", c.latest, c.mine, got)
		}
	}
	if releaseFile("windows", "amd64") == "" || releaseFile("plan9", "arm") != "" {
		t.Error("releaseFile")
	}
}
