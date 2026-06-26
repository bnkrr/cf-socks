package main

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	cfsocks "github.com/bnkrr/cf-socks/sdk/go"
	"github.com/quic-go/quic-go/http3"
)

func main() {
	endpoint := os.Getenv("CF_SOCKS_WORKER_URL")
	secret := os.Getenv("CF_SOCKS_AUTH_SECRET")
	if endpoint == "" || secret == "" {
		log.Fatal("CF_SOCKS_WORKER_URL and CF_SOCKS_AUTH_SECRET are required")
	}

	transport := &http3.Transport{}
	defer transport.Close()
	client := cfsocks.Client{
		Endpoint:   endpoint,
		Secret:     secret,
		Transport:  cfsocks.TransportH3,
		HTTPClient: &http.Client{Transport: transport},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	resp, err := client.Do(ctx, "tcp", "github.com:22", nil)
	if err != nil {
		log.Fatal(err)
	}
	defer resp.Body.Close()

	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	if err != nil {
		log.Fatal(err)
	}
	fmt.Print(line)
}
