package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strings"
)

func readResponse(r io.Reader, cfg config, target string) (int64, error) {
	switch cfg.payload {
	case "none":
		return 0, nil
	case "http", "banner":
		line, err := bufio.NewReader(r).ReadString('\n')
		if err != nil {
			return int64(len(line)), err
		}
		if cfg.payload == "http" && !strings.HasPrefix(line, "HTTP/") {
			return int64(len(line)), fmt.Errorf("unexpected HTTP line %q", strings.TrimSpace(line))
		}
		if cfg.payload == "banner" && strings.TrimSpace(line) == "" {
			return int64(len(line)), errors.New("empty banner")
		}
		return int64(len(line)), nil
	case "dns":
		return readDNSResponse(r)
	case "echo":
		want, _ := payloadBytes(cfg, target)
		buf := make([]byte, len(want))
		n, err := io.ReadFull(r, buf)
		if err != nil {
			return int64(n), err
		}
		if string(buf) != string(want) {
			return int64(n), errors.New("echo mismatch")
		}
		return int64(n), nil
	default:
		return 0, fmt.Errorf("unsupported payload %q", cfg.payload)
	}
}

func payloadReader(cfg config, target string) (io.Reader, error) {
	if cfg.payload == "banner" || cfg.payload == "none" {
		return nil, nil
	}
	body, err := payloadBytes(cfg, target)
	if err != nil {
		return nil, err
	}
	return bytes.NewReader(body), nil
}

func payloadBytes(cfg config, target string) ([]byte, error) {
	host, _, err := splitTarget(target)
	if err != nil {
		return nil, err
	}
	switch cfg.payload {
	case "http":
		return []byte(fmt.Sprintf("GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", host)), nil
	case "dns":
		return dnsRootNSQuery(), nil
	case "banner", "none":
		return nil, nil
	case "echo":
		return []byte("cf-socks-bench-echo\n"), nil
	default:
		return nil, fmt.Errorf("unsupported payload %q", cfg.payload)
	}
}

const dnsQueryID uint16 = 0xcfd5

func dnsRootNSQuery() []byte {
	msg := []byte{
		0xcf, 0xd5, // ID
		0x01, 0x00, // standard recursive query
		0x00, 0x01, // QDCOUNT
		0x00, 0x00, // ANCOUNT
		0x00, 0x00, // NSCOUNT
		0x00, 0x00, // ARCOUNT
		0x00,       // QNAME root "."
		0x00, 0x02, // QTYPE NS
		0x00, 0x01, // QCLASS IN
	}
	packet := make([]byte, 2+len(msg))
	binary.BigEndian.PutUint16(packet[:2], uint16(len(msg)))
	copy(packet[2:], msg)
	return packet
}

func readDNSResponse(r io.Reader) (int64, error) {
	var lengthBytes [2]byte
	if _, err := io.ReadFull(r, lengthBytes[:]); err != nil {
		return 0, err
	}
	length := int(binary.BigEndian.Uint16(lengthBytes[:]))
	if length < 12 {
		return 2, fmt.Errorf("short DNS response length %d", length)
	}
	msg := make([]byte, length)
	n, err := io.ReadFull(r, msg)
	if err != nil {
		return int64(2 + n), err
	}
	if id := binary.BigEndian.Uint16(msg[0:2]); id != dnsQueryID {
		return int64(2 + n), fmt.Errorf("DNS id mismatch: 0x%04x", id)
	}
	flags := binary.BigEndian.Uint16(msg[2:4])
	if flags&0x8000 == 0 {
		return int64(2 + n), errors.New("DNS response missing QR bit")
	}
	if rcode := flags & 0x000f; rcode != 0 {
		return int64(2 + n), fmt.Errorf("DNS rcode %d", rcode)
	}
	answerCount := binary.BigEndian.Uint16(msg[6:8])
	authorityCount := binary.BigEndian.Uint16(msg[8:10])
	additionalCount := binary.BigEndian.Uint16(msg[10:12])
	if answerCount+authorityCount+additionalCount == 0 {
		return int64(2 + n), errors.New("DNS response contains no records")
	}
	return int64(2 + n), nil
}
