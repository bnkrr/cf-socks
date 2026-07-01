package cfsocks

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bnkrr/cf-socks/sdk/go/internal/token"
	"nhooyr.io/websocket"
)

func TestClientDialRelaysThroughWSS(t *testing.T) {
	const secret = "test-secret"
	var got token.Claims
	worker := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, err := token.Open(secret, token.AAD(r.Method, r.URL.Path), bearer(t, r), token.OpenOptions{Now: time.Now()})
		if err != nil {
			t.Errorf("open token: %v", err)
			http.NotFound(w, r)
			return
		}
		got = claims
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

	client := Client{Endpoint: worker.URL, Secret: secret, Transport: TransportWSS, HTTPClient: worker.Client()}
	conn, err := client.Dial(context.Background(), "tcp", "example.test:1234")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if got.Op != "dial" || got.Host != "example.test" || got.Port != 1234 {
		t.Fatalf("claims = %+v", got)
	}
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(buf, []byte("ping")) {
		t.Fatalf("echo = %q", buf)
	}
}

func TestWSConnReadDeadlineInterruptsBlockedRead(t *testing.T) {
	const secret = "test-secret"
	worker := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := token.Open(secret, token.AAD(r.Method, r.URL.Path), bearer(t, r), token.OpenOptions{Now: time.Now()}); err != nil {
			t.Errorf("open token: %v", err)
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
		<-ctx.Done()
	}))
	defer worker.Close()

	client := Client{Endpoint: worker.URL, Secret: secret, Transport: TransportWSS, HTTPClient: worker.Client()}
	conn, err := client.Dial(context.Background(), "tcp", "example.test:1234")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	errc := make(chan error, 1)
	go func() {
		_, err := conn.Read(make([]byte, 1))
		errc <- err
	}()
	time.Sleep(50 * time.Millisecond)
	if err := conn.SetReadDeadline(time.Now()); err != nil {
		t.Fatal(err)
	}

	select {
	case err := <-errc:
		var netErr net.Error
		if !errors.As(err, &netErr) || !netErr.Timeout() {
			t.Fatalf("read err = %v, want timeout", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Read did not unblock after SetReadDeadline")
	}
}

func TestWSConnReadDeadlineTimeoutIsRecoverable(t *testing.T) {
	const secret = "test-secret"
	worker := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := token.Open(secret, token.AAD(r.Method, r.URL.Path), bearer(t, r), token.OpenOptions{Now: time.Now()}); err != nil {
			t.Errorf("open token: %v", err)
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
		time.Sleep(150 * time.Millisecond)
		_ = c.Write(ctx, websocket.MessageBinary, []byte("x"))
	}))
	defer worker.Close()

	client := Client{Endpoint: worker.URL, Secret: secret, Transport: TransportWSS, HTTPClient: worker.Client()}
	conn, err := client.Dial(context.Background(), "tcp", "example.test:1234")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	if err := conn.SetReadDeadline(time.Now().Add(50 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	_, err = conn.Read(make([]byte, 1))
	var netErr net.Error
	if !errors.As(err, &netErr) || !netErr.Timeout() {
		t.Fatalf("read err = %v, want timeout", err)
	}
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 1)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "x" {
		t.Fatalf("buf = %q", buf)
	}
}

func TestWSConnReadDeadlineRefreshKeepsReadAlive(t *testing.T) {
	const secret = "test-secret"
	worker := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := token.Open(secret, token.AAD(r.Method, r.URL.Path), bearer(t, r), token.OpenOptions{Now: time.Now()}); err != nil {
			t.Errorf("open token: %v", err)
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
		time.Sleep(150 * time.Millisecond)
		_ = c.Write(ctx, websocket.MessageBinary, []byte("x"))
	}))
	defer worker.Close()

	client := Client{Endpoint: worker.URL, Secret: secret, Transport: TransportWSS, HTTPClient: worker.Client()}
	conn, err := client.Dial(context.Background(), "tcp", "example.test:1234")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	errc := make(chan error, 1)
	buf := make([]byte, 1)
	go func() {
		_, err := io.ReadFull(conn, buf)
		errc <- err
	}()
	time.Sleep(50 * time.Millisecond)
	if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}

	select {
	case err := <-errc:
		if err != nil {
			t.Fatal(err)
		}
		if string(buf) != "x" {
			t.Fatalf("buf = %q", buf)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Read did not complete after deadline refresh")
	}
}

func TestWSConnWriteDeadlineCancelsWaitingWrite(t *testing.T) {
	const secret = "test-secret"
	worker := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := token.Open(secret, token.AAD(r.Method, r.URL.Path), bearer(t, r), token.OpenOptions{Now: time.Now()}); err != nil {
			t.Errorf("open token: %v", err)
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
		<-ctx.Done()
	}))
	defer worker.Close()

	client := Client{Endpoint: worker.URL, Secret: secret, Transport: TransportWSS, HTTPClient: worker.Client()}
	conn, err := client.Dial(context.Background(), "tcp", "example.test:1234")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	wc, ok := conn.(*wsConn)
	if !ok {
		t.Fatalf("conn type = %T", conn)
	}
	<-wc.writeLock

	errc := make(chan error, 1)
	go func() {
		_, err := conn.Write([]byte("x"))
		errc <- err
	}()
	time.Sleep(50 * time.Millisecond)
	if err := conn.SetWriteDeadline(time.Now()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-errc:
		var netErr net.Error
		if !errors.As(err, &netErr) || !netErr.Timeout() {
			t.Fatalf("write err = %v, want timeout", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Write did not unblock after SetWriteDeadline")
	}
	wc.writeLock <- struct{}{}
}

func TestClientDoPayloadThroughH2(t *testing.T) {
	const secret = "test-secret"
	worker := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, err := token.Open(secret, token.AAD(r.Method, r.URL.Path), bearer(t, r), token.OpenOptions{Now: time.Now()})
		if err != nil {
			t.Errorf("open token: %v", err)
			http.NotFound(w, r)
			return
		}
		if claims.Op != "payload" || claims.Host != "example.test" || claims.Port != 80 {
			t.Errorf("claims = %+v", claims)
		}
		body, _ := io.ReadAll(r.Body)
		_, _ = fmt.Fprintf(w, "got:%s", body)
	}))
	worker.EnableHTTP2 = true
	worker.StartTLS()
	defer worker.Close()

	client := Client{Endpoint: worker.URL, Secret: secret, Transport: TransportH2, HTTPClient: worker.Client()}
	resp, err := client.Do(context.Background(), "tcp", "example.test:80", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "got:payload" {
		t.Fatalf("body = %q", body)
	}
}

func TestClientDoIncludesWriteCloseAfterClaim(t *testing.T) {
	const secret = "test-secret"
	worker := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, err := token.Open(secret, token.AAD(r.Method, r.URL.Path), bearer(t, r), token.OpenOptions{Now: time.Now()})
		if err != nil {
			t.Errorf("open token: %v", err)
			http.NotFound(w, r)
			return
		}
		if claims.WriteCloseAfterMS == nil || *claims.WriteCloseAfterMS != 200 {
			t.Errorf("write_close_after_ms = %v, want 200", claims.WriteCloseAfterMS)
		}
		_, _ = w.Write([]byte("ok"))
	}))
	worker.EnableHTTP2 = true
	worker.StartTLS()
	defer worker.Close()

	client := Client{Endpoint: worker.URL, Secret: secret, Transport: TransportH2, HTTPClient: worker.Client()}
	resp, err := client.Do(context.Background(), "tcp", "example.test:80", nil, WithWriteCloseAfter(200*time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
}

func TestClientDoIncludesTLSClaim(t *testing.T) {
	const secret = "test-secret"
	worker := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, err := token.Open(secret, token.AAD(r.Method, r.URL.Path), bearer(t, r), token.OpenOptions{Now: time.Now()})
		if err != nil {
			t.Errorf("open token: %v", err)
			http.NotFound(w, r)
			return
		}
		if claims.SecureTransport != "on" {
			t.Errorf("secure_transport = %q, want on", claims.SecureTransport)
		}
		_, _ = w.Write([]byte("ok"))
	}))
	worker.EnableHTTP2 = true
	worker.StartTLS()
	defer worker.Close()

	client := Client{Endpoint: worker.URL, Secret: secret, Transport: TransportH2, HTTPClient: worker.Client()}
	resp, err := client.Do(context.Background(), "tcp", "example.test:443", nil, WithTLS(TLSOn))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
}

func TestClientDialIncludesDefaultTLSClaim(t *testing.T) {
	const secret = "test-secret"
	var got token.Claims
	worker := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, err := token.Open(secret, token.AAD(r.Method, r.URL.Path), bearer(t, r), token.OpenOptions{Now: time.Now()})
		if err != nil {
			t.Errorf("open token: %v", err)
			http.NotFound(w, r)
			return
		}
		got = claims
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept websocket: %v", err)
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "")
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		_ = c.Write(ctx, websocket.MessageText, []byte("OK\n"))
	}))
	defer worker.Close()

	client := Client{Endpoint: worker.URL, Secret: secret, Transport: TransportWSS, HTTPClient: worker.Client(), TargetTLS: TLSOn}
	conn, err := client.Dial(context.Background(), "tcp", "example.test:443")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if got.SecureTransport != "on" {
		t.Fatalf("secure_transport = %q, want on", got.SecureTransport)
	}
}

func TestClientRejectsInvalidTLSMode(t *testing.T) {
	client := Client{Endpoint: "https://worker.test", Secret: "secret", Transport: TransportH2}
	_, err := client.Do(context.Background(), "tcp", "example.test:443", nil, WithTLS("starttls"))
	if err == nil {
		t.Fatal("expected invalid tls mode error")
	}
}

func TestClientDoRejectsNegativeWriteCloseAfter(t *testing.T) {
	client := Client{Endpoint: "https://worker.test", Secret: "secret", Transport: TransportH2}
	_, err := client.Do(context.Background(), "tcp", "example.test:80", nil, WithWriteCloseAfter(-time.Millisecond))
	if err == nil {
		t.Fatal("expected negative write_close_after error")
	}
}

func TestClientDoRejectsTooLargeWriteCloseAfter(t *testing.T) {
	client := Client{Endpoint: "https://worker.test", Secret: "secret", Transport: TransportH2}
	_, err := client.Do(context.Background(), "tcp", "example.test:80", nil, WithWriteCloseAfter(MaxWriteCloseAfter+time.Millisecond))
	if err == nil {
		t.Fatal("expected oversized write_close_after error")
	}
}

func TestClientDoPayloadThroughH3(t *testing.T) {
	const secret = "test-secret"
	client := h3TestClient(t, secret, "payload", "h3-response")

	resp, err := client.Do(context.Background(), "tcp", "example.test:443", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "h3-response" {
		t.Fatalf("body = %q", body)
	}
}

func TestClientDoH3NilPayloadReadsServerFirstResponse(t *testing.T) {
	const secret = "test-secret"
	client := h3TestClient(t, secret, "", "SSH-2.0-h3-test\r\n")

	resp, err := client.Do(context.Background(), "tcp", "example.test:443", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(line, "SSH-") {
		t.Fatalf("line = %q", line)
	}
}

func h3TestClient(t *testing.T, secret string, wantBody string, responseBody string) Client {
	t.Helper()
	roundTripper := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path != "/h3" {
			t.Fatalf("path = %q", req.URL.Path)
		}
		claims, err := token.Open(secret, token.AAD(req.Method, req.URL.Path), bearer(t, req), token.OpenOptions{Now: time.Now()})
		if err != nil {
			t.Fatalf("open token: %v", err)
		}
		if claims.Op != "payload" || claims.Host != "example.test" || claims.Port != 443 {
			t.Fatalf("claims = %+v", claims)
		}
		body, err := io.ReadAll(req.Body)
		if err != nil {
			t.Fatal(err)
		}
		if string(body) != wantBody {
			t.Fatalf("body = %q", body)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Status:     "200 OK",
			Proto:      "HTTP/3.0",
			ProtoMajor: 3,
			ProtoMinor: 0,
			Body:       io.NopCloser(strings.NewReader(responseBody)),
			Header:     make(http.Header),
			Request:    req,
		}, nil
	})

	return Client{
		Endpoint:   "https://worker.test",
		Secret:     secret,
		Transport:  TransportH3,
		HTTPClient: &http.Client{Transport: roundTripper},
	}
}

func TestClientDoH3RequiresHTTPClient(t *testing.T) {
	client := Client{Endpoint: "https://worker.test", Secret: "secret", Transport: TransportH3}
	if _, err := client.Do(context.Background(), "tcp", "example.test:443", nil); !errors.Is(err, ErrHTTPClientRequired) {
		t.Fatalf("err = %v, want ErrHTTPClientRequired", err)
	}
}

func TestClientPoolRejectsUnsupportedTransports(t *testing.T) {
	if _, err := NewClientPool(ClientPoolConfig{Transport: TransportWSS}); !errors.Is(err, ErrUnsupportedTransport) {
		t.Fatalf("wss err = %v, want ErrUnsupportedTransport", err)
	}
	if _, err := NewClientPool(ClientPoolConfig{Transport: "bogus"}); !errors.Is(err, ErrUnsupportedTransport) {
		t.Fatalf("bogus err = %v, want ErrUnsupportedTransport", err)
	}
}

func TestClientPoolDefaultsH2SizeAndOwnsTransports(t *testing.T) {
	pool, err := NewClientPool(ClientPoolConfig{Endpoint: "https://worker.test", Secret: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if len(pool.clients) != defaultClientPoolSize {
		t.Fatalf("clients = %d, want %d", len(pool.clients), defaultClientPoolSize)
	}
	if len(pool.owned) != defaultClientPoolSize {
		t.Fatalf("owned = %d, want %d", len(pool.owned), defaultClientPoolSize)
	}
	if pool.clients[0].HTTPClient == pool.clients[1].HTTPClient {
		t.Fatal("pool slots share HTTP clients")
	}
	if err := pool.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestClientPoolToleratesReplacedDefaultTransport(t *testing.T) {
	orig := http.DefaultTransport
	http.DefaultTransport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return nil, errors.New("unexpected request")
	})
	defer func() { http.DefaultTransport = orig }()

	pool, err := NewClientPool(ClientPoolConfig{Endpoint: "https://worker.test", Secret: "secret", Size: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if len(pool.owned) != 2 {
		t.Fatalf("owned = %d, want 2", len(pool.owned))
	}
}

func TestClientPoolH3RequiresHTTPClients(t *testing.T) {
	if _, err := NewClientPool(ClientPoolConfig{
		Endpoint:  "https://worker.test",
		Secret:    "secret",
		Transport: TransportH3,
		Size:      2,
	}); !errors.Is(err, ErrHTTPClientRequired) {
		t.Fatalf("err = %v, want ErrHTTPClientRequired", err)
	}
}

func TestClientPoolRejectsMismatchedHTTPClients(t *testing.T) {
	if _, err := NewClientPool(ClientPoolConfig{
		Endpoint:    "https://worker.test",
		Secret:      "secret",
		Transport:   TransportH2,
		Size:        2,
		HTTPClients: []*http.Client{{}},
	}); err == nil {
		t.Fatal("expected mismatched HTTPClients error")
	}
	if _, err := NewClientPool(ClientPoolConfig{
		Endpoint:    "https://worker.test",
		Secret:      "secret",
		Transport:   TransportH2,
		Size:        1,
		HTTPClients: []*http.Client{nil},
	}); err == nil {
		t.Fatal("expected nil HTTPClients error")
	}
}

func TestClientPoolInfersSizeFromHTTPClients(t *testing.T) {
	pool, err := NewClientPool(ClientPoolConfig{
		Endpoint:    "https://worker.test",
		Secret:      "secret",
		Transport:   TransportH3,
		HTTPClients: []*http.Client{{}, {}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(pool.clients) != 2 {
		t.Fatalf("clients = %d, want 2", len(pool.clients))
	}
	if len(pool.owned) != 0 {
		t.Fatalf("owned = %d, want 0", len(pool.owned))
	}
}

func TestClientPoolRoundRobinDo(t *testing.T) {
	const secret = "test-secret"
	counts := make([]int, 2)
	clients := make([]*http.Client, len(counts))
	for i := range counts {
		slot := i
		clients[i] = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			counts[slot]++
			if _, err := token.Open(secret, token.AAD(req.Method, req.URL.Path), bearer(t, req), token.OpenOptions{Now: time.Now()}); err != nil {
				t.Fatalf("open token: %v", err)
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Status:     "200 OK",
				Proto:      "HTTP/2.0",
				ProtoMajor: 2,
				ProtoMinor: 0,
				Body:       io.NopCloser(strings.NewReader("ok")),
				Header:     make(http.Header),
				Request:    req,
			}, nil
		})}
	}
	pool, err := NewClientPool(ClientPoolConfig{
		Endpoint:    "https://worker.test",
		Secret:      secret,
		Transport:   TransportH2,
		Size:        len(clients),
		HTTPClients: clients,
	})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		resp, err := pool.Do(context.Background(), "tcp", "example.test:80", strings.NewReader("payload"))
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
	}
	if counts[0] != 2 || counts[1] != 2 {
		t.Fatalf("counts = %v, want [2 2]", counts)
	}
}

func TestClientPoolH2DoWithProvidedClients(t *testing.T) {
	const secret = "test-secret"
	worker := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := token.Open(secret, token.AAD(r.Method, r.URL.Path), bearer(t, r), token.OpenOptions{Now: time.Now()}); err != nil {
			t.Errorf("open token: %v", err)
			http.NotFound(w, r)
			return
		}
		body, _ := io.ReadAll(r.Body)
		_, _ = fmt.Fprintf(w, "got:%s", body)
	}))
	worker.EnableHTTP2 = true
	worker.StartTLS()
	defer worker.Close()

	pool, err := NewClientPool(ClientPoolConfig{
		Endpoint:    worker.URL,
		Secret:      secret,
		Transport:   TransportH2,
		Size:        2,
		HTTPClients: []*http.Client{worker.Client(), worker.Client()},
	})
	if err != nil {
		t.Fatal(err)
	}
	resp, err := pool.Do(context.Background(), "tcp", "example.test:80", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "got:payload" {
		t.Fatalf("body = %q", body)
	}
}

func TestClientDoRejectsNonHTTP2Response(t *testing.T) {
	const secret = "test-secret"
	worker := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := token.Open(secret, token.AAD(r.Method, r.URL.Path), bearer(t, r), token.OpenOptions{Now: time.Now()}); err != nil {
			t.Errorf("open token: %v", err)
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte("ok"))
	}))
	defer worker.Close()

	client := Client{Endpoint: worker.URL, Secret: secret, Transport: TransportH2, HTTPClient: worker.Client()}
	resp, err := client.Do(context.Background(), "tcp", "example.test:80", strings.NewReader("payload"))
	if err == nil {
		_ = resp.Body.Close()
		t.Fatal("expected non-HTTP/2 error")
	}
}

func TestClientDoNilPayloadReadsServerFirstResponse(t *testing.T) {
	const secret = "test-secret"
	worker := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := token.Open(secret, token.AAD(r.Method, r.URL.Path), bearer(t, r), token.OpenOptions{Now: time.Now()})
		if err != nil {
			t.Errorf("open token: %v", err)
			http.NotFound(w, r)
			return
		}
		body, _ := io.ReadAll(r.Body)
		if len(body) != 0 {
			t.Errorf("body = %q", body)
		}
		_, _ = w.Write([]byte("SSH-2.0-test\r\n"))
	}))
	worker.EnableHTTP2 = true
	worker.StartTLS()
	defer worker.Close()

	client := Client{Endpoint: worker.URL, Secret: secret, Transport: TransportH2, HTTPClient: worker.Client()}
	resp, err := client.Do(context.Background(), "tcp", "github.com:22", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(line, "SSH-") {
		t.Fatalf("line = %q", line)
	}
}

func TestClientRejectsUnsupportedTransportAndNetwork(t *testing.T) {
	if _, err := (&Client{Transport: TransportH2}).Dial(context.Background(), "tcp", "example.test:80"); err != ErrUnsupportedTransport {
		t.Fatalf("Dial h2 err = %v", err)
	}
	if _, err := (&Client{Transport: TransportWSS}).Do(context.Background(), "tcp", "example.test:80", nil); err != ErrUnsupportedTransport {
		t.Fatalf("Do wss err = %v", err)
	}
	if _, err := (&Client{Transport: TransportWSS}).Dial(context.Background(), "udp", "example.test:80"); err != ErrUnsupportedNetwork {
		t.Fatalf("network err = %v", err)
	}
}

func TestClientEndpointRejectsInsecureByDefault(t *testing.T) {
	client := Client{Endpoint: "http://127.0.0.1:8787", Transport: TransportH2}
	if _, err := client.endpoint("/h2", false); err == nil {
		t.Fatal("expected insecure endpoint rejection")
	}
}

func TestClientEndpointAllowsInsecureWhenExplicit(t *testing.T) {
	client := Client{Endpoint: "http://127.0.0.1:8787/base", InsecureAllowHTTP: true}
	got, err := client.endpoint("/wss", true)
	if err != nil {
		t.Fatal(err)
	}
	if got != "ws://127.0.0.1:8787/wss" {
		t.Fatalf("wss endpoint = %q", got)
	}
	got, err = client.endpoint("/h2", false)
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://127.0.0.1:8787/h2" {
		t.Fatalf("h2 endpoint = %q", got)
	}
}

func bearer(t *testing.T, r *http.Request) string {
	t.Helper()
	value, ok := token.BearerToken(r.Header.Get("Authorization"))
	if !ok {
		t.Fatal("missing bearer token")
	}
	return value
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestSplitHostPort(t *testing.T) {
	host, port, err := SplitHostPort(net.JoinHostPort("::1", "443"))
	if err != nil {
		t.Fatal(err)
	}
	if host != "::1" || port != 443 {
		t.Fatalf("target = %s:%d", host, port)
	}
}
