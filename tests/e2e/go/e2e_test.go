package e2e

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"
	"time"

	cfsocks "github.com/bnkrr/cf-socks/sdk/go"
	"github.com/bnkrr/cf-socks/socksagent"
	"github.com/quic-go/quic-go/http3"
)

func TestRealHTTPOverSocks(t *testing.T) {
	requireE2E(t)
	host, port := target(t, "E2E_HTTP_TARGET", "httpforever.com:80")
	preflightTarget(t, host, port)

	conn := dialViaAgent(t, host, port)
	defer conn.Close()

	req := fmt.Sprintf("GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", host)
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(line, "HTTP/") {
		t.Fatalf("unexpected HTTP status line %q", line)
	}
}

func TestRealHTTPSThroughSocks(t *testing.T) {
	requireE2E(t)
	host, port := target(t, "E2E_HTTPS_TARGET", "www.google.com:443")
	preflightTarget(t, host, port)

	raw := dialViaAgent(t, host, port)
	defer raw.Close()

	tlsConn := tls.Client(raw, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
	defer tlsConn.Close()
	if err := tlsConn.Handshake(); err != nil {
		t.Fatal(err)
	}
	req := fmt.Sprintf("HEAD / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", host)
	if _, err := tlsConn.Write([]byte(req)); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(tlsConn).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(line, "HTTP/") {
		t.Fatalf("unexpected HTTPS status line %q", line)
	}
}

func TestRealTCPBannerThroughSocks(t *testing.T) {
	requireE2E(t)
	host, port := target(t, "E2E_TCP_BANNER_TARGET", "github.com:22")
	preflightTarget(t, host, port)

	conn := dialViaAgent(t, host, port)
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(line, "SSH-") {
		t.Fatalf("unexpected TCP banner %q", line)
	}
}

func TestRealCurlThroughSocks(t *testing.T) {
	requireE2E(t)
	curl, err := exec.LookPath("curl")
	if err != nil {
		t.Skip("curl is not available")
	}
	url := os.Getenv("E2E_CURL_URL")
	if url == "" {
		url = "https://ifconfig.me/ip"
	}
	host, port, err := urlHostPort(url)
	if err != nil {
		t.Fatal(err)
	}
	preflightTarget(t, host, port)

	addr := startAgent(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, curl, "--fail", "--silent", "--show-error", "--socks5-hostname", addr, url).CombinedOutput()
	if err != nil {
		t.Fatalf("curl through SOCKS failed: %v\n%s", err, out)
	}
	body := strings.TrimSpace(string(out))
	if !regexp.MustCompile(`^[0-9a-fA-F:.]+$`).MatchString(body) {
		t.Fatalf("unexpected curl response %q", body)
	}
}

func TestRealH2PayloadHTTP(t *testing.T) {
	requireE2E(t)
	requireHTTPVersionE2E(t)
	host, port := target(t, "E2E_HTTP_TARGET", "httpforever.com:80")
	preflightTarget(t, host, port)

	client := cfsocks.Client{
		Endpoint:          os.Getenv("E2E_WORKER_URL"),
		Secret:            os.Getenv("E2E_AUTH_SECRET"),
		Transport:         cfsocks.TransportH2,
		InsecureAllowHTTP: insecureAllowHTTP(),
	}
	payload := strings.NewReader(fmt.Sprintf("GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", host))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	resp, err := client.Do(ctx, "tcp", net.JoinHostPort(host, fmt.Sprint(port)), payload)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(line, "HTTP/") {
		t.Fatalf("unexpected HTTP status line %q", line)
	}
}

func TestRealH2NilPayloadTCPBanner(t *testing.T) {
	requireE2E(t)
	requireHTTPVersionE2E(t)
	host, port := target(t, "E2E_TCP_BANNER_TARGET", "github.com:22")
	preflightTarget(t, host, port)

	client := cfsocks.Client{
		Endpoint:          os.Getenv("E2E_WORKER_URL"),
		Secret:            os.Getenv("E2E_AUTH_SECRET"),
		Transport:         cfsocks.TransportH2,
		InsecureAllowHTTP: insecureAllowHTTP(),
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	resp, err := client.Do(
		ctx,
		"tcp",
		net.JoinHostPort(host, fmt.Sprint(port)),
		nil,
		cfsocks.WithWriteCloseAfter(500*time.Millisecond),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(line, "SSH-") {
		t.Fatalf("unexpected TCP banner %q", line)
	}
}

func TestRealH3PayloadHTTP(t *testing.T) {
	requireE2E(t)
	requireHTTPVersionE2E(t)
	host, port := target(t, "E2E_HTTP_TARGET", "httpforever.com:80")
	preflightTarget(t, host, port)

	transport := &http3.Transport{}
	defer transport.Close()
	client := cfsocks.Client{
		Endpoint:          os.Getenv("E2E_WORKER_URL"),
		Secret:            os.Getenv("E2E_AUTH_SECRET"),
		Transport:         cfsocks.TransportH3,
		HTTPClient:        &http.Client{Transport: transport},
		InsecureAllowHTTP: insecureAllowHTTP(),
	}
	payload := strings.NewReader(fmt.Sprintf("GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", host))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	resp, err := client.Do(ctx, "tcp", net.JoinHostPort(host, fmt.Sprint(port)), payload)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(line, "HTTP/") {
		t.Fatalf("unexpected HTTP status line %q", line)
	}
}

func TestRealH3NilPayloadTCPBanner(t *testing.T) {
	requireE2E(t)
	requireHTTPVersionE2E(t)
	host, port := target(t, "E2E_TCP_BANNER_TARGET", "github.com:22")
	preflightTarget(t, host, port)

	transport := &http3.Transport{}
	defer transport.Close()
	client := cfsocks.Client{
		Endpoint:          os.Getenv("E2E_WORKER_URL"),
		Secret:            os.Getenv("E2E_AUTH_SECRET"),
		Transport:         cfsocks.TransportH3,
		HTTPClient:        &http.Client{Transport: transport},
		InsecureAllowHTTP: insecureAllowHTTP(),
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	resp, err := client.Do(
		ctx,
		"tcp",
		net.JoinHostPort(host, fmt.Sprint(port)),
		nil,
		cfsocks.WithWriteCloseAfter(500*time.Millisecond),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(line, "SSH-") {
		t.Fatalf("unexpected TCP banner %q", line)
	}
}

func dialViaAgent(t *testing.T, host string, port int) net.Conn {
	t.Helper()

	addr := startAgent(t)
	conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err := socksConnect(conn, host, port); err != nil {
		_ = conn.Close()
		t.Fatal(err)
	}
	return conn
}

func startAgent(t *testing.T) string {
	t.Helper()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(context.Background())
	t.Cleanup(stop)
	t.Cleanup(func() { _ = ln.Close() })

	go func() {
		_ = socksagent.Serve(ctx, ln, socksagent.Config{
			WorkerURL:         os.Getenv("E2E_WORKER_URL"),
			AuthSecret:        os.Getenv("E2E_AUTH_SECRET"),
			DialTimeout:       20 * time.Second,
			InsecureAllowHTTP: insecureAllowHTTP(),
		})
	}()
	return ln.Addr().String()
}

func requireE2E(t *testing.T) {
	t.Helper()
	if os.Getenv("E2E_WORKER_URL") == "" || os.Getenv("E2E_AUTH_SECRET") == "" {
		t.Skip("E2E_WORKER_URL and E2E_AUTH_SECRET are required for real E2E")
	}
}

func requireHTTPVersionE2E(t *testing.T) {
	t.Helper()
	if insecureAllowHTTP() || !strings.HasPrefix(os.Getenv("E2E_WORKER_URL"), "https://") {
		t.Skip("HTTP/2 and HTTP/3 E2E require a working HTTPS Worker endpoint")
	}
}

func insecureAllowHTTP() bool {
	switch os.Getenv("E2E_INSECURE_ALLOW_HTTP") {
	case "1", "true", "TRUE", "yes", "YES":
		return true
	default:
		return false
	}
}

func target(t *testing.T, key, fallback string) (string, int) {
	t.Helper()
	value := os.Getenv(key)
	if value == "" {
		value = fallback
	}
	host, portText, err := net.SplitHostPort(value)
	if err != nil {
		t.Fatalf("%s must be host:port: %v", key, err)
	}
	port, err := net.LookupPort("tcp", portText)
	if err != nil {
		t.Fatalf("%s has invalid port: %v", key, err)
	}
	return host, port
}

func urlHostPort(rawURL string) (string, int, error) {
	withoutScheme := rawURL
	port := 80
	if strings.HasPrefix(rawURL, "https://") {
		withoutScheme = strings.TrimPrefix(rawURL, "https://")
		port = 443
	} else if strings.HasPrefix(rawURL, "http://") {
		withoutScheme = strings.TrimPrefix(rawURL, "http://")
	} else {
		return "", 0, fmt.Errorf("unsupported URL scheme in %q", rawURL)
	}
	hostPort := strings.SplitN(withoutScheme, "/", 2)[0]
	if host, portText, err := net.SplitHostPort(hostPort); err == nil {
		parsed, err := net.LookupPort("tcp", portText)
		if err != nil {
			return "", 0, err
		}
		return host, parsed, nil
	}
	return hostPort, port, nil
}

func preflightTarget(t *testing.T, host string, port int) {
	t.Helper()
	ips, err := net.DefaultResolver.LookupIPAddr(context.Background(), host)
	if err != nil {
		t.Fatalf("resolve %s:%d: %v", host, port, err)
	}
	if len(ips) == 0 {
		t.Fatalf("resolve %s:%d: no addresses", host, port)
	}
	for _, ip := range ips {
		addr, ok := netip.AddrFromSlice(ip.IP)
		if !ok {
			t.Fatalf("invalid resolved IP %s", ip.IP)
		}
		if isCloudflareIP(addr.Unmap()) {
			t.Fatalf("%s resolved to Cloudflare IP %s; choose a non-Cloudflare E2E target", host, ip.IP)
		}
	}

	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, fmt.Sprint(port)), 10*time.Second)
	if err != nil {
		t.Fatalf("target %s:%d is not reachable before proxy test: %v", host, port, err)
	}
	_ = conn.Close()
}

func socksConnect(conn net.Conn, host string, port int) error {
	if len(host) > 255 {
		return errors.New("SOCKS domain target is too long")
	}
	if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		return err
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil {
		return err
	}
	if reply[0] != 0x05 || reply[1] != 0x00 {
		return fmt.Errorf("SOCKS method reply %v", reply)
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
		return fmt.Errorf("SOCKS connect failed with code %d", resp[1])
	}
	return nil
}

func isCloudflareIP(addr netip.Addr) bool {
	for _, prefix := range cloudflarePrefixes {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

var cloudflarePrefixes = mustPrefixes([]string{
	"173.245.48.0/20",
	"103.21.244.0/22",
	"103.22.200.0/22",
	"103.31.4.0/22",
	"141.101.64.0/18",
	"108.162.192.0/18",
	"190.93.240.0/20",
	"188.114.96.0/20",
	"197.234.240.0/22",
	"198.41.128.0/17",
	"162.158.0.0/15",
	"104.16.0.0/13",
	"104.24.0.0/14",
	"172.64.0.0/13",
	"131.0.72.0/22",
	"2400:cb00::/32",
	"2606:4700::/32",
	"2803:f800::/32",
	"2405:b500::/32",
	"2405:8100::/32",
	"2a06:98c0::/29",
	"2c0f:f248::/32",
})

func mustPrefixes(values []string) []netip.Prefix {
	prefixes := make([]netip.Prefix, 0, len(values))
	for _, value := range values {
		prefix, err := netip.ParsePrefix(value)
		if err != nil {
			panic(err)
		}
		prefixes = append(prefixes, prefix)
	}
	return prefixes
}
