package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"p2p-call/call"
)

// version is set when a release is built (see .github/workflows/release.yml);
// a program built by hand doesn't know its own and looks for no updates.
var version = "dev"

// update is what the start page shows when there is a newer release: its
// name and where to get the file for this system.
type update struct {
	Version string `json:"version"`          // this program's own
	Latest  string `json:"latest,omitempty"` // set only if it is newer
	URL     string `json:"url,omitempty"`
}

var (
	updateOnce sync.Once
	updateInfo update
)

// checkUpdate asks GitHub what the latest release is — once per run.
func checkUpdate(ctx context.Context) update {
	updateOnce.Do(func() {
		updateInfo = update{Version: version}
		if version == "dev" {
			return
		}
		latest, err := latestRelease(ctx, "https://api.github.com/repos/"+call.Repo+"/releases/latest")
		if err != nil || !newer(latest, version) {
			return // no internet, GitHub busy: not worth a word
		}
		updateInfo.Latest = latest
		updateInfo.URL = "https://github.com/" + call.Repo + "/releases/latest"
		if file := releaseFile(runtime.GOOS, runtime.GOARCH); file != "" {
			updateInfo.URL += "/download/" + file
		}
	})
	return updateInfo
}

func latestRelease(ctx context.Context, url string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "p2p-call")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GitHub replied %s", resp.Status)
	}
	var r struct {
		Tag string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return "", err
	}
	return r.Tag, nil
}

// releaseFile is the name of this system's file in a release.
func releaseFile(goos, goarch string) string {
	switch goos + "/" + goarch {
	case "windows/amd64":
		return "p2p-call-windows-x64.exe"
	case "darwin/arm64":
		return "p2p-call-mac-apple-silicon.zip"
	case "darwin/amd64":
		return "p2p-call-mac-intel.zip"
	case "linux/amd64":
		return "p2p-call-linux-x64.tar.gz"
	case "linux/arm64":
		return "p2p-call-linux-arm64.tar.gz"
	}
	return ""
}

// newer tells whether release a (v1.2.3) is later than b. A trial build
// (v1.2.3-test4) counts as the release it leads up to: it is offered that one.
func newer(a, b string) bool {
	pa, trialA := numbers(a)
	pb, trialB := numbers(b)
	for i := range 3 {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return trialB && !trialA
}

func numbers(v string) (n [3]int, trial bool) {
	v, _, trial = strings.Cut(strings.TrimPrefix(v, "v"), "-")
	for i, part := range strings.SplitN(v, ".", 3) {
		n[i], _ = strconv.Atoi(part)
	}
	return n, trial
}
