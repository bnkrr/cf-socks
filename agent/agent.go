package agent

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"net/url"
	"strconv"
	"time"

	"github.com/bnkrr/cf-socks/internal/handshake"
	"nhooyr.io/websocket"
)

type Config struct {
	WorkerURL       string
	AuthSecret      string
	DialTimeout     time.Duration
	IdleTimeout     time.Duration
	AllowInsecureWS bool
}

func (c Config) withDefaults() Config {
	if c.DialTimeout == 0 {
		c.DialTimeout = 15 * time.Second
	}
	if c.IdleTimeout == 0 {
		c.IdleTimeout = 5 * time.Minute
	}
	return c
}

func Serve(ctx context.Context, ln net.Listener, cfg Config) error {
	cfg = cfg.withDefaults()
	if cfg.WorkerURL == "" {
		return errors.New("worker URL is required")
	}
	if cfg.AuthSecret == "" {
		return errors.New("auth secret is required")
	}
	if err := validateWorkerURL(cfg.WorkerURL, cfg.AllowInsecureWS); err != nil {
		return err
	}

	errc := make(chan error, 1)
	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				errc <- err
				return
			}
			go func() {
				_ = handleClient(ctx, conn, cfg)
			}()
		}
	}()

	err := <-errc
	if ctx.Err() != nil {
		return nil
	}
	return err
}

func validateWorkerURL(rawURL string, allowInsecure bool) error {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	switch parsed.Scheme {
	case "wss":
		return nil
	case "ws":
		if allowInsecure {
			return nil
		}
		return errors.New("worker URL must use wss://")
	default:
		return errors.New("worker URL must use wss://")
	}
}

func handleClient(parent context.Context, client net.Conn, cfg Config) error {
	defer client.Close()
	target, err := negotiate(client)
	if err != nil {
		return err
	}

	dialCtx, cancel := context.WithTimeout(parent, cfg.DialTimeout)
	defer cancel()

	ws, _, err := websocket.Dial(dialCtx, cfg.WorkerURL, nil)
	if err != nil {
		_ = writeReply(client, 0x01)
		return err
	}
	defer ws.Close(websocket.StatusNormalClosure, "")

	req, err := handshake.New(cfg.AuthSecret, target.Host, target.Port, time.Now())
	if err != nil {
		_ = writeReply(client, 0x01)
		return err
	}
	payload, err := handshake.Marshal(req)
	if err != nil {
		_ = writeReply(client, 0x01)
		return err
	}
	if err := ws.Write(dialCtx, websocket.MessageText, payload); err != nil {
		_ = writeReply(client, 0x01)
		return err
	}

	typ, data, err := ws.Read(dialCtx)
	if err != nil {
		_ = writeReply(client, 0x01)
		return err
	}
	if typ != websocket.MessageText || string(data) != "OK\n" {
		_ = writeReply(client, 0x05)
		return fmt.Errorf("worker rejected target %s:%d: %q", target.Host, target.Port, string(data))
	}
	if err := writeReply(client, 0x00); err != nil {
		return err
	}

	relayCtx, stop := context.WithCancel(parent)
	defer stop()
	errc := make(chan error, 2)
	go func() {
		errc <- relayClientToWorker(relayCtx, client, ws)
	}()
	go func() {
		errc <- relayWorkerToClient(relayCtx, ws, client)
	}()
	err = <-errc
	stop()
	return err
}

type targetAddr struct {
	Host string
	Port int
}

func negotiate(conn net.Conn) (targetAddr, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(conn, header); err != nil {
		return targetAddr{}, err
	}
	if header[0] != 0x05 {
		return targetAddr{}, errors.New("unsupported SOCKS version")
	}
	methods := make([]byte, int(header[1]))
	if _, err := io.ReadFull(conn, methods); err != nil {
		return targetAddr{}, err
	}
	if !contains(methods, 0x00) {
		_, _ = conn.Write([]byte{0x05, 0xff})
		return targetAddr{}, errors.New("no supported auth method")
	}
	if _, err := conn.Write([]byte{0x05, 0x00}); err != nil {
		return targetAddr{}, err
	}

	req := make([]byte, 4)
	if _, err := io.ReadFull(conn, req); err != nil {
		return targetAddr{}, err
	}
	if req[0] != 0x05 || req[1] != 0x01 || req[2] != 0x00 {
		_ = writeReply(conn, 0x07)
		return targetAddr{}, errors.New("only SOCKS5 CONNECT is supported")
	}

	host, err := readAddr(conn, req[3])
	if err != nil {
		_ = writeReply(conn, 0x08)
		return targetAddr{}, err
	}
	portBytes := make([]byte, 2)
	if _, err := io.ReadFull(conn, portBytes); err != nil {
		return targetAddr{}, err
	}
	port := int(binary.BigEndian.Uint16(portBytes))
	return targetAddr{Host: host, Port: port}, nil
}

func readAddr(r io.Reader, atyp byte) (string, error) {
	switch atyp {
	case 0x01:
		var b [4]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return "", err
		}
		return netip.AddrFrom4(b).String(), nil
	case 0x03:
		var l [1]byte
		if _, err := io.ReadFull(r, l[:]); err != nil {
			return "", err
		}
		if l[0] == 0 {
			return "", errors.New("empty domain")
		}
		b := make([]byte, int(l[0]))
		if _, err := io.ReadFull(r, b); err != nil {
			return "", err
		}
		return string(b), nil
	case 0x04:
		var b [16]byte
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return "", err
		}
		return netip.AddrFrom16(b).String(), nil
	default:
		return "", errors.New("unsupported address type")
	}
}

func writeReply(w io.Writer, rep byte) error {
	_, err := w.Write([]byte{0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
	return err
}

func relayClientToWorker(ctx context.Context, client net.Conn, ws *websocket.Conn) error {
	buf := make([]byte, 32*1024)
	for {
		_ = client.SetReadDeadline(time.Now().Add(5 * time.Minute))
		n, err := client.Read(buf)
		if n > 0 {
			writeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			werr := ws.Write(writeCtx, websocket.MessageBinary, buf[:n])
			cancel()
			if werr != nil {
				return werr
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				_ = ws.Close(websocket.StatusNormalClosure, "")
				return nil
			}
			return err
		}
	}
}

func relayWorkerToClient(ctx context.Context, ws *websocket.Conn, client net.Conn) error {
	for {
		typ, data, err := ws.Read(ctx)
		if err != nil {
			return err
		}
		if typ != websocket.MessageBinary {
			continue
		}
		if _, err := client.Write(data); err != nil {
			return err
		}
	}
}

func contains(values []byte, needle byte) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

func SplitHostPort(value string) (string, int, error) {
	host, portText, err := net.SplitHostPort(value)
	if err != nil {
		return "", 0, err
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		return "", 0, err
	}
	if port < 1 || port > 65535 {
		return "", 0, fmt.Errorf("invalid port %d", port)
	}
	return host, port, nil
}
