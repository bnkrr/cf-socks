package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"
)

type config struct {
	mode              string
	endpoint          string
	secret            string
	target            string
	payload           string
	requests          int
	concurrency       int
	poolSize          int
	timeout           time.Duration
	insecureAllowHTTP bool
	jsonOutput        bool
}

func main() {
	cfg := parseFlags()
	if err := cfg.validate(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	run, cleanup, err := buildRunner(cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	defer cleanup()

	results, elapsed := runLoad(cfg, run)
	sum := summarize(cfg, results, elapsed)
	if cfg.jsonOutput {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		_ = enc.Encode(sum)
	} else {
		printSummary(sum)
	}
	if sum.Failed > 0 {
		os.Exit(1)
	}
}

func parseFlags() config {
	cfg := config{}
	flag.StringVar(&cfg.mode, "mode", "wss-dial", "wss-dial, socks-wss, h2-do, or h3-do")
	flag.StringVar(&cfg.endpoint, "endpoint", firstEnv("CF_SOCKS_WORKER_URL", "E2E_WORKER_URL"), "Worker endpoint URL")
	flag.StringVar(&cfg.secret, "secret", firstEnv("CF_SOCKS_AUTH_SECRET", "E2E_AUTH_SECRET"), "Worker auth secret")
	flag.StringVar(&cfg.target, "target", "httpforever.com:80", "target host:port, or comma-separated host:port list")
	flag.StringVar(&cfg.payload, "payload", "http", "http, dns, banner, echo, or none")
	flag.IntVar(&cfg.requests, "requests", 20, "total operations")
	flag.IntVar(&cfg.concurrency, "concurrency", 2, "concurrent operations")
	flag.IntVar(&cfg.poolSize, "pool-size", 0, "H2/H3 client pool size; 0 disables pooled Do")
	flag.DurationVar(&cfg.timeout, "timeout", 15*time.Second, "per-operation timeout")
	flag.BoolVar(&cfg.insecureAllowHTTP, "insecure-allow-http", false, "allow http:// or ws:// Worker endpoints for local development only")
	flag.BoolVar(&cfg.jsonOutput, "json", false, "print JSON summary")
	flag.Parse()
	return cfg
}

func (c config) validate() error {
	switch c.mode {
	case "wss-dial", "socks-wss", "h2-do", "h3-do":
	default:
		return fmt.Errorf("unsupported mode %q", c.mode)
	}
	switch c.payload {
	case "http", "dns", "banner", "echo", "none":
	default:
		return fmt.Errorf("unsupported payload %q", c.payload)
	}
	if c.endpoint == "" {
		return errors.New("endpoint is required")
	}
	if c.secret == "" {
		return errors.New("secret is required")
	}
	targets := c.targets()
	if len(targets) == 0 {
		return errors.New("target is required")
	}
	for _, target := range targets {
		if _, _, err := splitTarget(target); err != nil {
			return err
		}
	}
	if c.requests < 1 {
		return errors.New("requests must be positive")
	}
	if c.concurrency < 1 {
		return errors.New("concurrency must be positive")
	}
	if c.poolSize < 0 {
		return errors.New("pool-size must be non-negative")
	}
	if c.poolSize > 0 && (c.mode == "wss-dial" || c.mode == "socks-wss") {
		return errors.New("pool-size is only supported for h2-do and h3-do")
	}
	if c.timeout <= 0 {
		return errors.New("timeout must be positive")
	}
	return nil
}

func (c config) targets() []string {
	parts := strings.Split(c.target, ",")
	targets := make([]string, 0, len(parts))
	for _, part := range parts {
		if target := strings.TrimSpace(part); target != "" {
			targets = append(targets, target)
		}
	}
	return targets
}

func (c config) targetFor(job int) string {
	targets := c.targets()
	return targets[job%len(targets)]
}

func firstEnv(keys ...string) string {
	for _, key := range keys {
		if value := os.Getenv(key); value != "" {
			return value
		}
	}
	return ""
}
