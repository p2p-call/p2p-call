package call

import (
	"encoding/json"
	"net/url"
)

// Where everything outside this program lives is written down once, in
// web/site.json: the program reads it here, the pages fetch it (it is served
// beside them, and copied to the site with them), and the Android build
// takes its links from it. To run all this under a name of your own, that
// file is the one to change.
type siteConf struct {
	// Site is the page the links lead to (docs/ of the repository, on
	// GitHub Pages), with the slash at the end.
	Site string `json:"site"`
	// Repo is the repository whose releases hold the programs: owner/name.
	Repo string `json:"repo"`
	// Board is the public notice board (ntfy.sh, or another server that
	// speaks its language).
	Board string `json:"board"`
	// Spare are more boards, for when that one is out of reach or has had
	// enough of this address for the day: public MQTT servers, reached over
	// a WebSocket (wss://…), which is how a page can reach them too.
	Spare []string `json:"spare"`
	// App is the Android app's name in the system.
	App string `json:"app"`
	// Stun are the public servers a browser asks "what is my address out
	// there?" before connecting to the others. Several, of different
	// owners: any one that answers will do, so none of them is a single
	// point of failure. The talk itself never goes through them.
	Stun []string `json:"stun"`
}

var (
	DefaultSite  string
	DefaultRelay string
	spareBoards  []string
	// Repo is where new versions are looked for: owner/name on GitHub.
	Repo string
	// siteHost is where the guests' call page comes from when the call has
	// a link.
	siteHost    string
	stunServers []string
)

func init() {
	b, err := webFiles.ReadFile("web/site.json")
	if err != nil {
		panic(err)
	}
	var c siteConf
	if err := json.Unmarshal(b, &c); err != nil {
		panic("web/site.json: " + err.Error())
	}
	u, err := url.Parse(c.Site)
	if err != nil || u.Scheme != "https" || u.Host == "" || c.Site[len(c.Site)-1] != '/' {
		panic("web/site.json: site must look like https://name.github.io/p2p-call/")
	}
	if len(c.Stun) == 0 {
		panic("web/site.json: stun is empty")
	}
	DefaultSite, DefaultRelay, Repo, siteHost, spareBoards, stunServers = c.Site, c.Board, c.Repo, u.Host, c.Spare, c.Stun
}
