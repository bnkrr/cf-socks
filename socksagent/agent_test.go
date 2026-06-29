package socksagent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

func TestAgentRelaysThroughAuthenticatedWorker(t *testing.T) {
	const secret = "test-secret"
	var gotAuth string

	worker := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/wss" {
			http.NotFound(w, r)
			return
		}
		gotAuth = r.Header.Get("Authorization")
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept websocket: %v", err)
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "")

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

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
			WorkerURL:   worker.URL,
			AuthSecret:  secret,
			DialTimeout: 5 * time.Second,
			HTTPClient:  worker.Client(),
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

	if gotAuth == "" {
		t.Fatal("missing Authorization header")
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

func TestHTTPConnectRelaysThroughAuthenticatedWorker(t *testing.T) {
	const secret = "test-secret"
	worker := echoWorker(t, secret)
	defer worker.Close()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() {
		_ = ServeHTTPConnect(ctx, ln, Config{
			WorkerURL:   worker.URL,
			AuthSecret:  secret,
			DialTimeout: 5 * time.Second,
			HTTPClient:  worker.Client(),
		})
	}()

	client, err := net.DialTimeout("tcp", ln.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	reader := bufio.NewReader(client)
	if _, err := io.WriteString(client, "CONNECT example.test:1234 HTTP/1.1\r\nHost: example.test:1234\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}

	if _, err := client.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(reader, buf); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(buf, []byte("ping")) {
		t.Fatalf("echo = %q", buf)
	}
}

func TestHTTPConnectFlushesBufferedTunnelBytes(t *testing.T) {
	const secret = "test-secret"
	worker := echoWorker(t, secret)
	defer worker.Close()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() {
		_ = ServeHTTPConnect(ctx, ln, Config{
			WorkerURL:   worker.URL,
			AuthSecret:  secret,
			DialTimeout: 5 * time.Second,
			HTTPClient:  worker.Client(),
		})
	}()

	client, err := net.DialTimeout("tcp", ln.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	reader := bufio.NewReader(client)
	if _, err := io.WriteString(client, "CONNECT example.test:1234 HTTP/1.1\r\nHost: example.test:1234\r\n\r\nping"); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}

	buf := make([]byte, 4)
	if _, err := io.ReadFull(reader, buf); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(buf, []byte("ping")) {
		t.Fatalf("echo = %q", buf)
	}
}

func TestHTTPConnectWorksWithCurl(t *testing.T) {
	curl, err := exec.LookPath("curl")
	if err != nil {
		t.Skip("curl not found")
	}

	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "curl-ok")
	}))
	defer target.Close()

	worker := tcpRelayWorker(t, target.Listener.Addr().String())
	defer worker.Close()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() {
		_ = ServeHTTPConnect(ctx, ln, Config{
			WorkerURL:   worker.URL,
			AuthSecret:  "test-secret",
			DialTimeout: 5 * time.Second,
			HTTPClient:  worker.Client(),
		})
	}()

	cmdCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(
		cmdCtx,
		curl,
		"--fail",
		"--silent",
		"--show-error",
		"--insecure",
		"--noproxy",
		"",
		"-x",
		"http://"+ln.Addr().String(),
		target.URL,
	).CombinedOutput()
	if err != nil {
		t.Fatalf("curl failed: %v\n%s", err, out)
	}
	if string(out) != "curl-ok" {
		t.Fatalf("curl output = %q", out)
	}
}

func TestAgentClosesIdleConnections(t *testing.T) {
	const secret = "test-secret"
	worker := echoWorker(t, secret)
	defer worker.Close()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() {
		_ = Serve(ctx, ln, Config{
			WorkerURL:   worker.URL,
			AuthSecret:  secret,
			DialTimeout: 5 * time.Second,
			IdleTimeout: 50 * time.Millisecond,
			HTTPClient:  worker.Client(),
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

	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, err = client.Read(make([]byte, 1))
	if err == nil {
		t.Fatal("expected idle connection to close")
	}
	if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
		t.Fatalf("client read timed out waiting for idle close: %v", err)
	}
}

func TestAgentNegativeIdleTimeoutAllowsIdleConnections(t *testing.T) {
	const secret = "test-secret"
	worker := echoWorker(t, secret)
	defer worker.Close()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() {
		_ = Serve(ctx, ln, Config{
			WorkerURL:   worker.URL,
			AuthSecret:  secret,
			DialTimeout: 5 * time.Second,
			IdleTimeout: -1,
			HTTPClient:  worker.Client(),
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

	time.Sleep(150 * time.Millisecond)
	if _, err := client.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 4)
	if _, err := io.ReadFull(client, buf); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(buf, []byte("ping")) {
		t.Fatalf("echo = %q", buf)
	}
}

func TestAgentIdleTimeoutTracksConnectionActivity(t *testing.T) {
	const secret = "test-secret"
	worker := streamingWorker(t, secret)
	defer worker.Close()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() {
		_ = Serve(ctx, ln, Config{
			WorkerURL:   worker.URL,
			AuthSecret:  secret,
			DialTimeout: 5 * time.Second,
			IdleTimeout: 50 * time.Millisecond,
			HTTPClient:  worker.Client(),
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
	if _, err := client.Write([]byte("start")); err != nil {
		t.Fatal(err)
	}

	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, len("chunk-0\nchunk-1\nchunk-2\nchunk-3\nchunk-4\n"))
	if _, err := io.ReadFull(client, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "chunk-0\nchunk-1\nchunk-2\nchunk-3\nchunk-4\n" {
		t.Fatalf("stream = %q", buf)
	}
}

func echoWorker(t *testing.T, secret string) *httptest.Server {
	t.Helper()
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/wss" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") == "" {
			http.NotFound(w, r)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept websocket: %v", err)
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "")

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
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
}

func streamingWorker(t *testing.T, secret string) *httptest.Server {
	t.Helper()
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/wss" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") == "" {
			http.NotFound(w, r)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept websocket: %v", err)
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "")

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		if err := c.Write(ctx, websocket.MessageText, []byte("OK\n")); err != nil {
			t.Errorf("write OK: %v", err)
			return
		}
		if _, _, err := c.Read(ctx); err != nil {
			return
		}
		for i := 0; i < 5; i++ {
			time.Sleep(30 * time.Millisecond)
			if err := c.Write(ctx, websocket.MessageBinary, []byte(fmt.Sprintf("chunk-%d\n", i))); err != nil {
				return
			}
		}
	}))
}

func tcpRelayWorker(t *testing.T, targetAddress string) *httptest.Server {
	t.Helper()
	return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/wss" {
			http.NotFound(w, r)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept websocket: %v", err)
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "")

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		if err := c.Write(ctx, websocket.MessageText, []byte("OK\n")); err != nil {
			t.Errorf("write OK: %v", err)
			return
		}

		targetConn, err := net.DialTimeout("tcp", targetAddress, 5*time.Second)
		if err != nil {
			t.Errorf("dial target: %v", err)
			return
		}
		defer targetConn.Close()

		errc := make(chan error, 2)
		go func() {
			for {
				typ, data, err := c.Read(ctx)
				if err != nil {
					errc <- err
					return
				}
				if typ == websocket.MessageBinary {
					if err := writeAll(targetConn, data); err != nil {
						errc <- err
						return
					}
				}
			}
		}()
		go func() {
			buf := make([]byte, 32*1024)
			for {
				n, err := targetConn.Read(buf)
				if n > 0 {
					if writeErr := c.Write(ctx, websocket.MessageBinary, buf[:n]); writeErr != nil {
						errc <- writeErr
						return
					}
				}
				if err != nil {
					errc <- err
					return
				}
			}
		}()
		<-errc
	}))
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
