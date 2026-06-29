package h3

import (
	"testing"

	cfsocks "github.com/bnkrr/cf-socks/sdk/go"
)

func TestNewClientCreatesH3Client(t *testing.T) {
	client, err := NewClient(ClientConfig{
		Endpoint:          "https://worker.test",
		Secret:            "secret",
		InsecureAllowHTTP: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if client.client == nil {
		t.Fatal("client is nil")
	}
	if client.transport == nil {
		t.Fatal("transport is nil")
	}
	if client.client.Transport != cfsocks.TransportH3 {
		t.Fatalf("transport = %q, want h3", client.client.Transport)
	}
	if !client.client.InsecureAllowHTTP {
		t.Fatal("InsecureAllowHTTP was not propagated")
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestNewPoolDefaultsSizeAndCreatesIndependentTransports(t *testing.T) {
	pool, err := NewPool(PoolConfig{
		Endpoint: "https://worker.test",
		Secret:   "secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if len(pool.transports) != defaultPoolSize {
		t.Fatalf("transports = %d, want %d", len(pool.transports), defaultPoolSize)
	}
	if pool.transports[0] == pool.transports[1] {
		t.Fatal("pool slots share H3 transports")
	}
	if err := pool.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestNewPoolRejectsInvalidSize(t *testing.T) {
	if _, err := NewPool(PoolConfig{Endpoint: "https://worker.test", Secret: "secret", Size: -1}); err == nil {
		t.Fatal("expected invalid size error")
	}
}

func TestZeroValueCloseIsSafe(t *testing.T) {
	var client Client
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	var pool Pool
	if err := pool.Close(); err != nil {
		t.Fatal(err)
	}
}
