package main

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	cfsocks "github.com/bnkrr/cf-socks/sdk/go"
)

func main() {
	endpoint := os.Getenv("CF_SOCKS_WORKER_URL")
	secret := os.Getenv("CF_SOCKS_AUTH_SECRET")
	if endpoint == "" || secret == "" {
		log.Fatal("CF_SOCKS_WORKER_URL and CF_SOCKS_AUTH_SECRET are required")
	}

	client := cfsocks.Client{Endpoint: endpoint, Secret: secret, Transport: cfsocks.TransportH2}
	payload := strings.NewReader("GET / HTTP/1.1\r\nHost: httpforever.com\r\nConnection: close\r\n\r\n")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	resp, err := client.Do(ctx, "tcp", "httpforever.com:80", payload)
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
