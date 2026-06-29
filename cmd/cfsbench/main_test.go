package main

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
	"time"
)

func TestConfigTargets(t *testing.T) {
	cfg := config{target: "8.8.8.8:53, 9.9.9.9:53 ,,149.112.112.112:53"}
	got := cfg.targets()
	want := []string{"8.8.8.8:53", "9.9.9.9:53", "149.112.112.112:53"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("targets = %v, want %v", got, want)
	}
	if cfg.targetFor(4) != "9.9.9.9:53" {
		t.Fatalf("targetFor = %q", cfg.targetFor(4))
	}
}

func TestConfigValidateRejectsInvalidTarget(t *testing.T) {
	cfg := validConfig()
	cfg.target = "8.8.8.8"
	if err := cfg.validate(); err == nil {
		t.Fatal("expected invalid target error")
	}
}

func TestConfigValidateRejectsPoolForWSS(t *testing.T) {
	cfg := validConfig()
	cfg.mode = "wss-dial"
	cfg.poolSize = 1
	if err := cfg.validate(); err == nil {
		t.Fatal("expected pool-size rejection")
	}
}

func TestConfigValidateAllowsDefaultPoolSizeZero(t *testing.T) {
	cfg := validConfig()
	cfg.poolSize = 0
	if err := cfg.validate(); err != nil {
		t.Fatal(err)
	}
}

func TestReadDNSResponse(t *testing.T) {
	resp := dnsResponse(t, dnsQueryID, 1)
	n, err := readDNSResponse(bytes.NewReader(resp))
	if err != nil {
		t.Fatal(err)
	}
	if n != int64(len(resp)) {
		t.Fatalf("n = %d, want %d", n, len(resp))
	}
}

func TestReadDNSResponseRejectsMalformed(t *testing.T) {
	if _, err := readDNSResponse(bytes.NewReader(dnsResponse(t, 0x1234, 1))); err == nil {
		t.Fatal("expected ID mismatch")
	}
	if _, err := readDNSResponse(bytes.NewReader(dnsResponse(t, dnsQueryID, 0))); err == nil {
		t.Fatal("expected empty records error")
	}
}

func validConfig() config {
	return config{
		mode:        "h2-do",
		endpoint:    "https://worker.test",
		secret:      "secret",
		target:      "8.8.8.8:53",
		payload:     "dns",
		requests:    1,
		concurrency: 1,
		poolSize:    0,
		timeout:     time.Second,
	}
}

func dnsResponse(t *testing.T, id uint16, answers uint16) []byte {
	t.Helper()
	msg := []byte{
		0x00, 0x00, // ID
		0x81, 0x80, // response, no error
		0x00, 0x01, // QDCOUNT
		0x00, 0x00, // ANCOUNT
		0x00, 0x00, // NSCOUNT
		0x00, 0x00, // ARCOUNT
		0x00,       // QNAME root "."
		0x00, 0x02, // QTYPE NS
		0x00, 0x01, // QCLASS IN
	}
	binary.BigEndian.PutUint16(msg[0:2], id)
	binary.BigEndian.PutUint16(msg[6:8], answers)
	packet := make([]byte, 2+len(msg))
	binary.BigEndian.PutUint16(packet[:2], uint16(len(msg)))
	copy(packet[2:], msg)
	return packet
}
