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
	workerURL := flag.String("worker-url", env("CF_SOCKS_WORKER_URL", ""), "Worker endpoint URL, for example https://name.workers.dev")
	authSecret := flag.String("auth-secret", env("CF_SOCKS_AUTH_SECRET", ""), "secret used for Worker encrypted bearer-token authentication")
	dialTimeout := flag.Duration("dial-timeout", durationEnv("CF_SOCKS_DIAL_TIMEOUT", 15*time.Second), "Worker/target dial timeout")
	idleTimeout := flag.Duration("idle-timeout", durationEnv("CF_SOCKS_IDLE_TIMEOUT", 5*time.Minute), "proxied connection idle timeout; negative disables it")
	flag.Parse()

	if *workerURL == "" || *authSecret == "" {
		fmt.Fprintln(os.Stderr, "worker-url and auth-secret are required")
		os.Exit(2)
	}

	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "cf-socks-agent listening on %s\n", ln.Addr())

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := socksagent.Serve(ctx, ln, socksagent.Config{
		WorkerURL:   *workerURL,
		AuthSecret:  *authSecret,
		DialTimeout: *dialTimeout,
		IdleTimeout: *idleTimeout,
	}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
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
