package main

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"os"
	"time"

	cfsocks "github.com/bnkrr/cf-socks/sdk/go"
)

func main() {
	endpoint := os.Getenv("CF_SOCKS_WORKER_URL")
	secret := os.Getenv("CF_SOCKS_AUTH_SECRET")
	if endpoint == "" || secret == "" {
		log.Fatal("CF_SOCKS_WORKER_URL and CF_SOCKS_AUTH_SECRET are required")
	}

	client := cfsocks.Client{Endpoint: endpoint, Secret: secret, Transport: cfsocks.TransportWSS}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	conn, err := client.Dial(ctx, "tcp", "httpforever.com:80")
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close()

	if _, err := fmt.Fprint(conn, "GET / HTTP/1.1\r\nHost: httpforever.com\r\nConnection: close\r\n\r\n"); err != nil {
		log.Fatal(err)
	}
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		log.Fatal(err)
	}
	fmt.Print(line)
}
