package token

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
)

const (
	Version            byte = 0x02
	keyPrefix               = "cf-socks auth v2\n"
	defaultWindow           = 120 * time.Second
	maxTokenBytes           = 4096
	MaxWriteCloseAfter      = 10 * time.Minute
)

type Claims struct {
	Op                string `json:"op"`
	Host              string `json:"host"`
	Port              int    `json:"port"`
	TS                int64  `json:"ts"`
	SecureTransport   string `json:"secure_transport,omitempty"`
	WriteCloseAfterMS *int64 `json:"write_close_after_ms,omitempty"`
}

type NonceCache interface {
	Consume(nonce string, expiresAt time.Time, now time.Time) bool
}

type OpenOptions struct {
	Now    time.Time
	Window time.Duration
	Cache  NonceCache
}

var (
	ErrInvalidToken = errors.New("invalid token")
	ErrExpiredToken = errors.New("expired token")
	ErrReplayToken  = errors.New("replayed token")
)

func Seal(secret string, aad []byte, claims Claims, now time.Time) (string, error) {
	if now.IsZero() {
		now = time.Now()
	}
	claims.TS = now.Unix()
	if err := validateClaims(claims); err != nil {
		return "", err
	}

	aead, err := aead(secret)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	plaintext, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	out := make([]byte, 0, 1+len(nonce)+len(plaintext)+aead.Overhead())
	out = append(out, Version)
	out = append(out, nonce...)
	out = aead.Seal(out, nonce, plaintext, aad)
	return base64.RawURLEncoding.EncodeToString(out), nil
}

func Open(secret string, aad []byte, encoded string, options OpenOptions) (Claims, error) {
	now := options.Now
	if now.IsZero() {
		now = time.Now()
	}
	window := options.Window
	if window == 0 {
		window = defaultWindow
	}

	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(raw) > maxTokenBytes {
		return Claims{}, ErrInvalidToken
	}
	aead, err := aead(secret)
	if err != nil {
		return Claims{}, err
	}
	nonceSize := aead.NonceSize()
	if len(raw) < 1+nonceSize+aead.Overhead() || raw[0] != Version {
		return Claims{}, ErrInvalidToken
	}
	nonce := raw[1 : 1+nonceSize]
	ciphertext := raw[1+nonceSize:]
	plaintext, err := aead.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	var claims Claims
	if err := json.Unmarshal(plaintext, &claims); err != nil {
		return Claims{}, ErrInvalidToken
	}
	if err := validateClaims(claims); err != nil {
		return Claims{}, ErrInvalidToken
	}
	ts := time.Unix(claims.TS, 0)
	if now.Sub(ts) > window || ts.Sub(now) > window {
		return Claims{}, ErrExpiredToken
	}
	if options.Cache != nil {
		key := base64.RawURLEncoding.EncodeToString(nonce)
		if !options.Cache.Consume(key, ts.Add(window), now) {
			return Claims{}, ErrReplayToken
		}
	}
	return claims, nil
}

func AAD(method, path string) []byte {
	return []byte(method + "\n" + path)
}

func AuthorizationHeader(token string) string {
	return "Bearer " + token
}

func BearerToken(header string) (string, bool) {
	const prefix = "Bearer "
	if len(header) <= len(prefix) || header[:len(prefix)] != prefix {
		return "", false
	}
	return header[len(prefix):], true
}

func aead(secret string) (cipher.AEAD, error) {
	if secret == "" {
		return nil, errors.New("secret is required")
	}
	sum := sha256.Sum256([]byte(keyPrefix + secret))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func validateClaims(claims Claims) error {
	if claims.Op != "dial" && claims.Op != "payload" {
		return fmt.Errorf("invalid op %q", claims.Op)
	}
	if claims.Host == "" || len(claims.Host) > 253 {
		return errors.New("invalid host")
	}
	for _, r := range claims.Host {
		if r == '\n' || r == '\r' {
			return errors.New("invalid host")
		}
	}
	if claims.Port < 1 || claims.Port > 65535 {
		return errors.New("invalid port")
	}
	if claims.TS == 0 {
		return errors.New("invalid timestamp")
	}
	if claims.SecureTransport != "" && claims.SecureTransport != "off" && claims.SecureTransport != "on" {
		return errors.New("invalid secure_transport")
	}
	if claims.WriteCloseAfterMS != nil {
		maxMS := MaxWriteCloseAfter.Milliseconds()
		if *claims.WriteCloseAfterMS < 0 || *claims.WriteCloseAfterMS > maxMS {
			return errors.New("invalid write_close_after_ms")
		}
	}
	return nil
}
