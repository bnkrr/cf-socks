package token

import (
	"encoding/base64"
	"errors"
	"testing"
	"time"
)

func TestSealOpen(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	writeCloseAfterMS := int64(200)
	claims := Claims{Op: "dial", Host: "example.test", Port: 443, WriteCloseAfterMS: &writeCloseAfterMS}
	sealed, err := Seal("secret", AAD("GET", "/wss"), claims, now)
	if err != nil {
		t.Fatal(err)
	}
	opened, err := Open("secret", AAD("GET", "/wss"), sealed, OpenOptions{Now: now})
	if err != nil {
		t.Fatal(err)
	}
	if opened.Op != "dial" || opened.Host != "example.test" || opened.Port != 443 || opened.TS != now.Unix() {
		t.Fatalf("claims = %+v", opened)
	}
	if opened.WriteCloseAfterMS == nil || *opened.WriteCloseAfterMS != writeCloseAfterMS {
		t.Fatalf("write_close_after_ms = %v, want %d", opened.WriteCloseAfterMS, writeCloseAfterMS)
	}
}

func TestOpenRejectsWrongSecretAADAndExpiry(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	sealed, err := Seal("secret", AAD("GET", "/wss"), Claims{Op: "dial", Host: "example.test", Port: 443}, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Open("other", AAD("GET", "/wss"), sealed, OpenOptions{Now: now}); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("wrong secret err = %v", err)
	}
	if _, err := Open("secret", AAD("POST", "/h2"), sealed, OpenOptions{Now: now}); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("wrong aad err = %v", err)
	}
	if _, err := Open("secret", AAD("GET", "/wss"), sealed, OpenOptions{Now: now.Add(3 * time.Minute)}); !errors.Is(err, ErrExpiredToken) {
		t.Fatalf("expired err = %v", err)
	}
}

func TestOpenRejectsReplay(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	cache := testCache{seen: map[string]bool{}}
	sealed, err := Seal("secret", AAD("GET", "/wss"), Claims{Op: "dial", Host: "example.test", Port: 443}, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Open("secret", AAD("GET", "/wss"), sealed, OpenOptions{Now: now, Cache: &cache}); err != nil {
		t.Fatal(err)
	}
	if _, err := Open("secret", AAD("GET", "/wss"), sealed, OpenOptions{Now: now, Cache: &cache}); !errors.Is(err, ErrReplayToken) {
		t.Fatalf("replay err = %v", err)
	}
}

func TestSealRejectsMalformedClaims(t *testing.T) {
	if _, err := Seal("secret", AAD("GET", "/wss"), Claims{Op: "dial", Host: "", Port: 443}, time.Now()); err == nil {
		t.Fatal("expected bad host")
	}
	if _, err := Seal("secret", AAD("GET", "/wss"), Claims{Op: "other", Host: "example.test", Port: 443}, time.Now()); err == nil {
		t.Fatal("expected bad op")
	}
	writeCloseAfterMS := int64(-1)
	if _, err := Seal("secret", AAD("POST", "/h2"), Claims{Op: "payload", Host: "example.test", Port: 443, WriteCloseAfterMS: &writeCloseAfterMS}, time.Now()); err == nil {
		t.Fatal("expected bad write_close_after_ms")
	}
	writeCloseAfterMS = MaxWriteCloseAfter.Milliseconds() + 1
	if _, err := Seal("secret", AAD("POST", "/h2"), Claims{Op: "payload", Host: "example.test", Port: 443, WriteCloseAfterMS: &writeCloseAfterMS}, time.Now()); err == nil {
		t.Fatal("expected oversized write_close_after_ms")
	}
}

func TestOpenRejectsMalformedClaims(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	sealed, err := sealPlaintext("secret", AAD("POST", "/h2"), []byte(`{"op":"payload","host":"example.test","port":80}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Open("secret", AAD("POST", "/h2"), sealed, OpenOptions{Now: now}); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("malformed claims err = %v", err)
	}
}

type testCache struct {
	seen map[string]bool
}

func (c *testCache) Consume(nonce string, _ time.Time, _ time.Time) bool {
	if c.seen[nonce] {
		return false
	}
	c.seen[nonce] = true
	return true
}

func sealPlaintext(secret string, aad []byte, plaintext []byte) (string, error) {
	aead, err := aead(secret)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	out := make([]byte, 0, 1+len(nonce)+len(plaintext)+aead.Overhead())
	out = append(out, Version)
	out = append(out, nonce...)
	out = aead.Seal(out, nonce, plaintext, aad)
	return base64.RawURLEncoding.EncodeToString(out), nil
}
