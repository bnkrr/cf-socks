package handshake

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"
)

const Prefix = "cf-socks-v1"

type Request struct {
	Version int    `json:"v"`
	Host    string `json:"host"`
	Port    int    `json:"port"`
	TS      int64  `json:"ts"`
	Nonce   string `json:"nonce"`
	MAC     string `json:"mac"`
}

func New(secret, host string, port int, now time.Time) (Request, error) {
	nonce, err := nonce()
	if err != nil {
		return Request{}, err
	}
	req := Request{
		Version: 1,
		Host:    host,
		Port:    port,
		TS:      now.Unix(),
		Nonce:   nonce,
	}
	req.MAC = Sign(secret, req.Host, req.Port, req.TS, req.Nonce)
	return req, nil
}

func Sign(secret, host string, port int, ts int64, nonce string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(Message(host, port, ts, nonce)))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func Message(host string, port int, ts int64, nonce string) string {
	return fmt.Sprintf("%s\n%s\n%d\n%d\n%s", Prefix, host, port, ts, nonce)
}

func Marshal(req Request) ([]byte, error) {
	return json.Marshal(req)
}

func nonce() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}
