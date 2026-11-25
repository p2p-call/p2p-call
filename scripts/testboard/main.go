// testboard stands in for the public notice board (ntfy.sh) when the call
// page is tried out on this computer: the real one allows 250 messages a day
// from one address, and a test run must not spend them. It keeps messages in
// memory and speaks just as much of ntfy's language as the page uses:
// POST /<topic>, /<topic>/ws?since=<unix time or "12h">, and
// /<topic>/json?poll=1 for everything said so far.
//
//	go run ./scripts/testboard -port 8794
//
// The page uses it when opened from localhost with sessionStorage
// "sm.board" set to its address (see conf in call/web/app.js).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type message struct {
	ID      string `json:"id"`
	Time    int64  `json:"time"`
	Event   string `json:"event"`
	Topic   string `json:"topic"`
	Message string `json:"message"`
}

var (
	mu     sync.Mutex
	posted []message
	subs   = map[chan message]string{}
	count  int
)

func main() {
	port := flag.Int("port", 8794, "port on this computer")
	flag.Parse()
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		topic, ws := strings.CutSuffix(strings.Trim(r.URL.Path, "/"), "/ws")
		past, poll := strings.CutSuffix(topic, "/json")
		switch {
		case ws:
			listen(w, r, topic)
		case poll:
			// Everything said under the name, a line each.
			mu.Lock()
			for _, m := range posted {
				if m.Topic == past {
					json.NewEncoder(w).Encode(m)
				}
			}
			mu.Unlock()
		case r.Method == http.MethodPost:
			b, _ := io.ReadAll(io.LimitReader(r.Body, 4097))
			if len(b) > 4096 {
				http.Error(w, "too long", http.StatusRequestEntityTooLarge)
				return
			}
			mu.Lock()
			count++
			m := message{ID: fmt.Sprint("m", count), Time: time.Now().Unix(), Event: "message", Topic: topic, Message: string(b)}
			posted = append(posted, m)
			for ch, t := range subs {
				if t == topic {
					select {
					case ch <- m:
					default:
					}
				}
			}
			n := count
			mu.Unlock()
			log.Printf("message %d on %s: %d bytes", n, topic, len(b))
			json.NewEncoder(w).Encode(m)
		default:
			http.NotFound(w, r)
		}
	})
	log.Printf("test board on http://localhost:%d", *port)
	log.Fatal(http.ListenAndServe(fmt.Sprintf("127.0.0.1:%d", *port), nil))
}

func listen(w http.ResponseWriter, r *http.Request, topic string) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	ctx := conn.CloseRead(r.Context())

	var since int64 = time.Now().Unix() + 1 // nothing from before, unless asked
	if s := r.URL.Query().Get("since"); s != "" {
		if n, err := strconv.ParseInt(s, 10, 64); err == nil {
			since = n
		} else {
			since = 0
		}
	}
	ch := make(chan message, 256)
	mu.Lock()
	var old []message
	for _, m := range posted {
		if m.Topic == topic && m.Time >= since {
			old = append(old, m)
		}
	}
	subs[ch] = topic
	mu.Unlock()
	defer func() {
		mu.Lock()
		delete(subs, ch)
		mu.Unlock()
	}()

	send := func(m message) error {
		b, _ := json.Marshal(m)
		wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		return conn.Write(wctx, websocket.MessageText, b)
	}
	for _, m := range old {
		if send(m) != nil {
			return
		}
	}
	for {
		select {
		case m := <-ch:
			if send(m) != nil {
				return
			}
		case <-ctx.Done():
			return
		}
	}
}
