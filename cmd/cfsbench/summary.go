package main

import (
	"fmt"
	"sort"
	"time"
)

type summary struct {
	Mode        string         `json:"mode"`
	Target      string         `json:"target"`
	Targets     int            `json:"targets"`
	Payload     string         `json:"payload"`
	Requests    int            `json:"requests"`
	Concurrency int            `json:"concurrency"`
	PoolSize    int            `json:"pool_size"`
	Success     int            `json:"success"`
	Failed      int            `json:"failed"`
	ElapsedMS   float64        `json:"elapsed_ms"`
	Rate        float64        `json:"rate_per_second"`
	Bytes       int64          `json:"bytes"`
	LatencyMS   latencySummary `json:"latency_ms"`
	Errors      map[string]int `json:"errors,omitempty"`
}

type latencySummary struct {
	Min float64 `json:"min"`
	P50 float64 `json:"p50"`
	P90 float64 `json:"p90"`
	P95 float64 `json:"p95"`
	P99 float64 `json:"p99"`
	Max float64 `json:"max"`
}

func summarize(cfg config, results []result, elapsed time.Duration) summary {
	started := len(results)
	errs := map[string]int{}
	durations := make([]time.Duration, 0, started)
	var bytes int64
	for _, res := range results {
		bytes += res.bytes
		if res.err != "" {
			errs[res.err]++
			continue
		}
		durations = append(durations, res.duration)
	}
	sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
	sum := summary{
		Mode:        cfg.mode,
		Target:      cfg.target,
		Targets:     len(cfg.targets()),
		Payload:     cfg.payload,
		Requests:    cfg.requests,
		Concurrency: cfg.concurrency,
		PoolSize:    cfg.poolSize,
		Success:     len(durations),
		Failed:      started - len(durations),
		ElapsedMS:   ms(elapsed),
		Bytes:       bytes,
		Errors:      errs,
	}
	if elapsed > 0 {
		sum.Rate = float64(started) / elapsed.Seconds()
	}
	if len(durations) > 0 {
		sum.LatencyMS = latencySummary{
			Min: ms(durations[0]),
			P50: ms(percentile(durations, 0.50)),
			P90: ms(percentile(durations, 0.90)),
			P95: ms(percentile(durations, 0.95)),
			P99: ms(percentile(durations, 0.99)),
			Max: ms(durations[len(durations)-1]),
		}
	}
	if len(errs) == 0 {
		sum.Errors = nil
	}
	return sum
}

func percentile(values []time.Duration, q float64) time.Duration {
	if len(values) == 0 {
		return 0
	}
	idx := int(q*float64(len(values)-1) + 0.5)
	if idx < 0 {
		idx = 0
	}
	if idx >= len(values) {
		idx = len(values) - 1
	}
	return values[idx]
}

func printSummary(sum summary) {
	fmt.Printf("mode=%s target=%s targets=%d payload=%s requests=%d concurrency=%d pool_size=%d\n", sum.Mode, sum.Target, sum.Targets, sum.Payload, sum.Requests, sum.Concurrency, sum.PoolSize)
	fmt.Printf("success=%d failed=%d rate=%.2f/s bytes=%d elapsed=%.1fms\n", sum.Success, sum.Failed, sum.Rate, sum.Bytes, sum.ElapsedMS)
	if sum.Success > 0 {
		fmt.Printf("latency_ms min=%.1f p50=%.1f p90=%.1f p95=%.1f p99=%.1f max=%.1f\n",
			sum.LatencyMS.Min, sum.LatencyMS.P50, sum.LatencyMS.P90, sum.LatencyMS.P95, sum.LatencyMS.P99, sum.LatencyMS.Max)
	}
	if len(sum.Errors) > 0 {
		fmt.Println("errors:")
		keys := make([]string, 0, len(sum.Errors))
		for key := range sum.Errors {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			fmt.Printf("  %s: %d\n", key, sum.Errors[key])
		}
	}
}

func ms(d time.Duration) float64 {
	return float64(d.Microseconds()) / 1000
}
