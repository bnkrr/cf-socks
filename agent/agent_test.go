package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bnkrr/cf-socks/internal/handshake"
	"nhooyr.io/websocket"
)

func TestAgentRelaysThroughAuthenticatedWorker(t *testing.T) {
	const secret = "test-secret"
	var got handshake.Request

	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept websocket: %v", err)
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "")

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		typ, data, err := c.Read(ctx)
		if err != nil {
			t.Errorf("read handshake: %v", err)
			return
		}
		if typ != websocket.MessageText {
			t.Errorf("handshake type = %v", typ)
			return
		}
		if err := json.Unmarshal(data, &got); err != nil {
			t.Errorf("decode handshake: %v", err)
			return
		}
		if got.MAC != handshake.Sign(secret, got.Host, got.Port, got.TS, got.Nonce) {
			t.Errorf("bad MAC")
			return
		}
		if err := c.Write(ctx, websocket.MessageText, []byte("OK\n")); err != nil {
			t.Errorf("write OK: %v", err)
			return
		}

		for {
			typ, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			if typ == websocket.MessageBinary {
				_ = c.Write(ctx, websocket.MessageBinary, data)
			}
		}
	}))
	defer worker.Close()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() {
		_ = Serve(ctx, ln, Config{
			WorkerURL:       "ws" + strings.TrimPrefix(worker.URL, "http"),
			AuthSecret:      secret,
			DialTimeout:     5 * time.Second,
			AllowInsecureWS: true,
		})
	}()

	client, err := net.DialTimeout("tcp", ln.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := socksConnect(client, "example.test", 1234); err != nil {
		t.Fatal(err)
	}

	if got.Host != "example.test" || got.Port != 1234 {
		t.Fatalf("target = %s:%d", got.Host, got.Port)
	}

	if _, err := client.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := bufio.NewReader(client).Read(buf); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(buf, []byte("ping")) {
		t.Fatalf("echo = %q", buf)
	}
}

func TestValidateWorkerURLRejectsPlainWebSocket(t *testing.T) {
	if err := validateWorkerURL("ws://example.test/tcp", false); err == nil {
		t.Fatal("expected ws:// to be rejected by default")
	}
	if err := validateWorkerURL("ws://example.test/tcp", true); err != nil {
		t.Fatalf("expected test-only ws:// allowance: %v", err)
	}
	if err := validateWorkerURL("wss://example.test/tcp", false); err != nil {
		t.Fatalf("expected wss:// to be accepted: %v", err)
	}
}

func socksConnect(conn net.Conn, host string, port int) error {
	if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		return err
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil {
		return err
	}
	req := []byte{0x05, 0x01, 0x00, 0x03, byte(len(host))}
	req = append(req, []byte(host)...)
	var portBytes [2]byte
	binary.BigEndian.PutUint16(portBytes[:], uint16(port))
	req = append(req, portBytes[:]...)
	if _, err := conn.Write(req); err != nil {
		return err
	}
	resp := make([]byte, 10)
	if _, err := io.ReadFull(conn, resp); err != nil {
		return err
	}
	if resp[1] != 0x00 {
		return &net.OpError{Op: "socks", Err: errSocksFailure(resp[1])}
	}
	return nil
}

type errSocksFailure byte

func (e errSocksFailure) Error() string {
	return fmt.Sprintf("SOCKS failure %d", byte(e))
}
