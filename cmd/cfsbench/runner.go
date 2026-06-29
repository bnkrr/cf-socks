package main

import (
	"context"
	"io"
	"net"
	"sync"
	"time"

	cfsocks "github.com/bnkrr/cf-socks/sdk/go"
	cfh3 "github.com/bnkrr/cf-socks/sdk/go/h3"
	"github.com/bnkrr/cf-socks/socksagent"
)

type result struct {
	duration time.Duration
	bytes    int64
	err      string
}

type runner func(context.Context, int) (int64, error)

func buildRunner(cfg config) (runner, func(), error) {
	switch cfg.mode {
	case "wss-dial":
		client := cfsocks.Client{
			Endpoint:          cfg.endpoint,
			Secret:            cfg.secret,
			Transport:         cfsocks.TransportWSS,
			InsecureAllowHTTP: cfg.insecureAllowHTTP,
		}
		return func(ctx context.Context, job int) (int64, error) {
			target := cfg.targetFor(job)
			conn, err := client.Dial(ctx, "tcp", target)
			if err != nil {
				return 0, err
			}
			defer conn.Close()
			return exerciseConn(ctx, conn, cfg, target)
		}, func() {}, nil
	case "socks-wss":
		addr, stop, err := startLocalAgent(cfg)
		if err != nil {
			return nil, nil, err
		}
		return func(ctx context.Context, job int) (int64, error) {
			target := cfg.targetFor(job)
			dialer := net.Dialer{}
			conn, err := dialer.DialContext(ctx, "tcp", addr)
			if err != nil {
				return 0, err
			}
			defer conn.Close()
			if err := socksConnect(conn, target); err != nil {
				return 0, err
			}
			return exerciseConn(ctx, conn, cfg, target)
		}, stop, nil
	case "h2-do":
		if cfg.poolSize > 0 {
			pool, err := cfsocks.NewClientPool(cfsocks.ClientPoolConfig{
				Endpoint:          cfg.endpoint,
				Secret:            cfg.secret,
				Transport:         cfsocks.TransportH2,
				Size:              cfg.poolSize,
				InsecureAllowHTTP: cfg.insecureAllowHTTP,
			})
			if err != nil {
				return nil, nil, err
			}
			return doRunner(cfg, pool), func() { _ = pool.Close() }, nil
		}
		client := cfsocks.Client{
			Endpoint:          cfg.endpoint,
			Secret:            cfg.secret,
			Transport:         cfsocks.TransportH2,
			InsecureAllowHTTP: cfg.insecureAllowHTTP,
		}
		return doRunner(cfg, &client), func() {}, nil
	case "h3-do":
		if cfg.poolSize > 0 {
			pool, err := cfh3.NewPool(cfh3.PoolConfig{
				Endpoint:          cfg.endpoint,
				Secret:            cfg.secret,
				Size:              cfg.poolSize,
				InsecureAllowHTTP: cfg.insecureAllowHTTP,
			})
			if err != nil {
				return nil, nil, err
			}
			return doRunner(cfg, pool), func() { _ = pool.Close() }, nil
		}
		client, err := cfh3.NewClient(cfh3.ClientConfig{
			Endpoint:          cfg.endpoint,
			Secret:            cfg.secret,
			InsecureAllowHTTP: cfg.insecureAllowHTTP,
		})
		if err != nil {
			return nil, nil, err
		}
		return doRunner(cfg, client), func() { _ = client.Close() }, nil
	default:
		return nil, nil, errUnsupportedMode(cfg.mode)
	}
}

type doer interface {
	Do(context.Context, string, string, io.Reader, ...cfsocks.DoOption) (*cfsocks.Response, error)
}

func doRunner(cfg config, client doer) runner {
	return func(ctx context.Context, job int) (int64, error) {
		target := cfg.targetFor(job)
		body, err := payloadReader(cfg, target)
		if err != nil {
			return 0, err
		}
		resp, err := client.Do(ctx, "tcp", target, body)
		if err != nil {
			return 0, err
		}
		defer resp.Body.Close()
		return readResponse(resp.Body, cfg, target)
	}
}

func startLocalAgent(cfg config) (string, func(), error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}
	ctx, stop := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- socksagent.Serve(ctx, ln, socksagent.Config{
			WorkerURL:         cfg.endpoint,
			AuthSecret:        cfg.secret,
			DialTimeout:       cfg.timeout,
			IdleTimeout:       -1,
			InsecureAllowHTTP: cfg.insecureAllowHTTP,
		})
	}()
	cleanup := func() {
		stop()
		_ = ln.Close()
		<-done
	}
	return ln.Addr().String(), cleanup, nil
}

func runLoad(cfg config, run runner) ([]result, time.Duration) {
	jobs := make(chan int)
	results := make(chan result, cfg.requests)
	var wg sync.WaitGroup
	started := time.Now()
	for i := 0; i < cfg.concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for job := range jobs {
				ctx, cancel := context.WithTimeout(context.Background(), cfg.timeout)
				start := time.Now()
				bytes, err := run(ctx, job)
				cancel()
				res := result{duration: time.Since(start), bytes: bytes}
				if err != nil {
					res.err = classifyErr(err)
				}
				results <- res
			}
		}()
	}
	for i := 0; i < cfg.requests; i++ {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	elapsed := time.Since(started)
	close(results)

	out := make([]result, 0, cfg.requests)
	for res := range results {
		out = append(out, res)
	}
	return out, elapsed
}

func exerciseConn(ctx context.Context, conn net.Conn, cfg config, target string) (int64, error) {
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	body, err := payloadBytes(cfg, target)
	if err != nil {
		return 0, err
	}
	if len(body) > 0 {
		if _, err := conn.Write(body); err != nil {
			return 0, err
		}
	}
	return readResponse(conn, cfg, target)
}
