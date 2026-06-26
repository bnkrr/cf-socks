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

	"github.com/bnkrr/cf-socks/internal/token"
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

func bearer(t *testing.T, r *http.Request) string {
	t.Helper()
	value, ok := token.BearerToken(r.Header.Get("Authorization"))
	if !ok {
		t.Fatal("missing bearer token")
	}
	return value
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
