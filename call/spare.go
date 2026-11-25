package call

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// The spare boards (see site.go) are public MQTT servers. Each remembers the
// last message said under a name and hands it to whoever asks later — which
// is all a notice needs. This is just enough of their language to leave one:
// say hello, say it, hear that it was taken, hang up.

func mqttString(s string) []byte {
	return append([]byte{byte(len(s) >> 8), byte(len(s))}, s...)
}

func mqttPacket(head byte, parts ...[]byte) []byte {
	n := 0
	for _, p := range parts {
		n += len(p)
	}
	out := []byte{head}
	for l := n; ; {
		d := byte(l % 128)
		if l /= 128; l > 0 {
			out = append(out, d|128)
			continue
		}
		out = append(out, d)
		break
	}
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

// spareLeave leaves msg on the board at url (wss://…) under topic, to be
// remembered there.
func spareLeave(ctx context.Context, url, topic string, msg []byte) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	err := spareLeaveWith(ctx, http.DefaultClient, url, topic, msg)
	// As with the first board: a phone may not show this program whom to
	// trust, and a sealed, signed notice loses nothing by going unchecked.
	var unknown x509.UnknownAuthorityError
	var verify *tls.CertificateVerificationError
	if errors.As(err, &unknown) || errors.As(err, &verify) {
		err = spareLeaveWith(ctx, unchecked, url, topic, msg)
	}
	return err
}

func spareLeaveWith(ctx context.Context, client *http.Client, url, topic string, msg []byte) error {
	ws, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPClient: client, Subprotocols: []string{"mqtt"}})
	if err != nil {
		return err
	}
	defer ws.CloseNow()
	say := func(p []byte) error { return ws.Write(ctx, websocket.MessageBinary, p) }
	// The answers are a few bytes each; the server may send them in one piece
	// or in several, so they are read as a stream.
	var buf []byte
	hear := func(kind byte, n int) ([]byte, error) {
		for len(buf) < n {
			_, b, err := ws.Read(ctx)
			if err != nil {
				return nil, err
			}
			buf = append(buf, b...)
		}
		got := buf[:n]
		buf = buf[n:]
		if got[0]>>4 != kind {
			return nil, fmt.Errorf("the board answered %#x where %d was due", got[0], kind)
		}
		return got, nil
	}

	// Hello: MQTT 3.1.1, a clean session, a name made up for the occasion.
	if err := say(mqttPacket(0x10, mqttString("MQTT"), []byte{4, 2, 0, 30}, mqttString("p"+randomHex(8)))); err != nil {
		return err
	}
	if ack, err := hear(2, 4); err != nil {
		return err
	} else if ack[3] != 0 {
		return fmt.Errorf("the board refused: %d", ack[3])
	}
	// The notice: to be remembered (retain), and acknowledged (QoS 1).
	if err := say(mqttPacket(0x33, mqttString(topic), []byte{0, 1}, msg)); err != nil {
		return err
	}
	if _, err := hear(4, 4); err != nil {
		return err
	}
	// Taken. The goodbye is a courtesy; how the line ends no longer matters.
	say([]byte{0xe0, 0})
	return nil
}
