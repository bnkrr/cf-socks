package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	cfsocks "github.com/bnkrr/cf-socks/sdk/go"
	"github.com/quic-go/quic-go/http3"
)

func main() {
	endpoint := os.Getenv("CF_SOCKS_WORKER_URL")
	secret := os.Getenv("CF_SOCKS_AUTH_SECRET")
	if endpoint == "" || secret == "" {
		fmt.Fprintln(os.Stderr, "CF_SOCKS_WORKER_URL and CF_SOCKS_AUTH_SECRET are required")
		os.Exit(2)
	}

	transport := &http3.Transport{}
	defer transport.Close()
	client := cfsocks.Client{
		Endpoint:   endpoint,
		Secret:     secret,
		Transport:  cfsocks.TransportH3,
		HTTPClient: &http.Client{Transport: transport},
	}
	payload := strings.NewReader("GET / HTTP/1.1\r\nHost: httpforever.com\r\nConnection: close\r\n\r\n")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	resp, err := client.Do(ctx, "tcp", "httpforever.com:80", payload)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer resp.Body.Close()
	if _, err := io.Copy(os.Stdout, resp.Body); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
