package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/bnkrr/cf-socks/socksagent"
)

func main() {
	listen := flag.String("listen", env("CF_SOCKS_LISTEN", "127.0.0.1:1080"), "local SOCKS5 listen address")
	httpListen := flag.String("http-listen", env("CF_SOCKS_HTTP_LISTEN", ""), "local HTTP CONNECT proxy listen address; empty disables it")
	workerURL := flag.String("worker-url", env("CF_SOCKS_WORKER_URL", ""), "Worker endpoint URL, for example https://name.workers.dev")
	authSecret := flag.String("auth-secret", env("CF_SOCKS_AUTH_SECRET", ""), "secret used for Worker encrypted bearer-token authentication")
	dialTimeout := flag.Duration("dial-timeout", durationEnv("CF_SOCKS_DIAL_TIMEOUT", 15*time.Second), "Worker/target dial timeout")
	idleTimeout := flag.Duration("idle-timeout", durationEnv("CF_SOCKS_IDLE_TIMEOUT", 5*time.Minute), "proxied connection idle timeout; negative disables it")
	insecureAllowHTTP := flag.Bool("insecure-allow-http", boolEnv("CF_SOCKS_INSECURE_ALLOW_HTTP", false), "allow http:// or ws:// Worker endpoints for local development only")
	flag.Parse()

	if *workerURL == "" || *authSecret == "" {
		fmt.Fprintln(os.Stderr, "worker-url and auth-secret are required")
		os.Exit(2)
	}
	if *listen == "" && *httpListen == "" {
		fmt.Fprintln(os.Stderr, "at least one of listen or http-listen must be set")
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	cfg := socksagent.Config{
		WorkerURL:         *workerURL,
		AuthSecret:        *authSecret,
		DialTimeout:       *dialTimeout,
		IdleTimeout:       *idleTimeout,
		InsecureAllowHTTP: *insecureAllowHTTP,
	}
	errc := make(chan error, 2)
	listeners := 0

	if *listen != "" {
		ln, err := net.Listen("tcp", *listen)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		listeners++
		fmt.Fprintf(os.Stderr, "cf-socks-agent SOCKS5 listening on %s\n", ln.Addr())
		go func() {
			errc <- socksagent.Serve(ctx, ln, cfg)
		}()
	}
	if *httpListen != "" {
		ln, err := net.Listen("tcp", *httpListen)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		listeners++
		fmt.Fprintf(os.Stderr, "cf-socks-agent HTTP CONNECT listening on %s\n", ln.Addr())
		go func() {
			errc <- socksagent.ServeHTTPConnect(ctx, ln, cfg)
		}()
	}

	err := <-errc
	cancel()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for i := 1; i < listeners; i++ {
		if err := <-errc; err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func boolEnv(key string, fallback bool) bool {
	if value := os.Getenv(key); value != "" {
		switch value {
		case "1", "true", "TRUE", "yes", "YES":
			return true
		case "0", "false", "FALSE", "no", "NO":
			return false
		}
	}
	return fallback
}

func durationEnv(key string, fallback time.Duration) time.Duration {
	if value := os.Getenv(key); value != "" {
		if parsed, err := time.ParseDuration(value); err == nil {
			return parsed
		}
	}
	return fallback
}
