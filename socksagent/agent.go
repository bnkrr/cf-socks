package socksagent

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"sync"
	"time"

	cfsocks "github.com/bnkrr/cf-socks/sdk/go"
)

type Config struct {
	WorkerURL         string
	AuthSecret        string
	DialTimeout       time.Duration
	IdleTimeout       time.Duration
	HTTPClient        *http.Client
	InsecureAllowHTTP bool
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

func handleClient(parent context.Context, client net.Conn, cfg Config) error {
	defer client.Close()
	target, err := negotiate(client)
	if err != nil {
		return err
	}

	dialCtx, cancel := context.WithTimeout(parent, cfg.DialTimeout)
	defer cancel()

	remote, err := (&cfsocks.Client{
		Endpoint:          cfg.WorkerURL,
		Secret:            cfg.AuthSecret,
		Transport:         cfsocks.TransportWSS,
		HTTPClient:        cfg.HTTPClient,
		InsecureAllowHTTP: cfg.InsecureAllowHTTP,
	}).Dial(dialCtx, "tcp", net.JoinHostPort(target.Host, strconv.Itoa(target.Port)))
	if err != nil {
		_ = writeReply(client, 0x01)
		return err
	}
	defer remote.Close()
	if err := writeReply(client, 0x00); err != nil {
		return err
	}

	relayCtx, stop := context.WithCancel(parent)
	defer stop()
	var closeOnce sync.Once
	closeBoth := func() {
		closeOnce.Do(func() {
			_ = client.Close()
			_ = remote.Close()
		})
	}
	var activity chan struct{}
	if cfg.IdleTimeout > 0 {
		activity = make(chan struct{}, 1)
		go monitorIdle(relayCtx, cfg.IdleTimeout, activity, func() {
			stop()
			closeBoth()
		})
	}
	errc := make(chan error, 2)
	go func() {
		errc <- relay(relayCtx, remote, client, activity)
	}()
	go func() {
		errc <- relay(relayCtx, client, remote, activity)
	}()
	err = <-errc
	stop()
	closeBoth()
	<-errc
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

func relay(ctx context.Context, dst net.Conn, src net.Conn, activity chan<- struct{}) error {
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = src.SetReadDeadline(time.Now())
		case <-done:
		}
	}()
	defer close(done)

	buf := make([]byte, 32*1024)
	for {
		n, readErr := src.Read(buf)
		if n > 0 {
			if err := writeAll(dst, buf[:n]); err != nil {
				return err
			}
			notifyActivity(activity)
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return nil
			}
			return readErr
		}
	}
}

func writeAll(dst net.Conn, data []byte) error {
	for len(data) > 0 {
		n, err := dst.Write(data)
		if n > 0 {
			data = data[n:]
		}
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

func monitorIdle(ctx context.Context, timeout time.Duration, activity <-chan struct{}, onIdle func()) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-activity:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(timeout)
		case <-timer.C:
			onIdle()
			return
		}
	}
}

func notifyActivity(activity chan<- struct{}) {
	if activity == nil {
		return
	}
	select {
	case activity <- struct{}{}:
	default:
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
	return cfsocks.SplitHostPort(value)
}
