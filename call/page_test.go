package call

import (
	"bytes"
	"io/fs"
	"testing"
)

// The page is served whole: no script or style left to fetch on its own.
func TestWholePage(t *testing.T) {
	web, _ := fs.Sub(webFiles, "web")
	page := wholePage(web)
	for _, left := range []string{`<script src=`, `<link rel="stylesheet"`} {
		if bytes.Contains(page, []byte(left)) {
			t.Errorf("still in the page: %s", left)
		}
	}
	for _, in := range []string{"function bridgeWord(", "function onMessage(", ".hint.warn"} {
		if !bytes.Contains(page, []byte(in)) {
			t.Errorf("missing from the page: %s", in)
		}
	}
}
