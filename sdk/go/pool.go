package cfsocks

import (
	"context"
	"errors"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
)

const defaultClientPoolSize = 4

type ClientPoolConfig struct {
	Endpoint          string
	Secret            string
	Transport         Transport
	Size              int
	HTTPClients       []*http.Client
	InsecureAllowHTTP bool
	TargetTLS         TLSMode
}

type ClientPool struct {
	clients []*Client
	owned   []*http.Transport
	next    atomic.Uint64

	closeOnce sync.Once
}

func NewClientPool(cfg ClientPoolConfig) (*ClientPool, error) {
	transport := cfg.Transport
	if transport == "" {
		transport = TransportH2
	}
	if transport != TransportH2 && transport != TransportH3 {
		return nil, ErrUnsupportedTransport
	}
	size := cfg.Size
	if size == 0 {
		if len(cfg.HTTPClients) > 0 {
			size = len(cfg.HTTPClients)
		} else {
			size = defaultClientPoolSize
		}
	}
	if size < 1 {
		return nil, errors.New("client pool size must be positive")
	}
	if len(cfg.HTTPClients) > 0 && len(cfg.HTTPClients) != size {
		return nil, errors.New("HTTPClients length must match client pool size")
	}
	if transport == TransportH3 && len(cfg.HTTPClients) == 0 {
		return nil, ErrHTTPClientRequired
	}

	clients := make([]*Client, size)
	var owned []*http.Transport
	for i := 0; i < size; i++ {
		var httpClient *http.Client
		if len(cfg.HTTPClients) > 0 {
			httpClient = cfg.HTTPClients[i]
			if httpClient == nil {
				return nil, errors.New("HTTPClients must not contain nil clients")
			}
		} else {
			roundTripper := newPoolTransport()
			httpClient = &http.Client{Transport: roundTripper}
			owned = append(owned, roundTripper)
		}
		clients[i] = &Client{
			Endpoint:          cfg.Endpoint,
			Secret:            cfg.Secret,
			Transport:         transport,
			HTTPClient:        httpClient,
			InsecureAllowHTTP: cfg.InsecureAllowHTTP,
			TargetTLS:         cfg.TargetTLS,
		}
	}
	return &ClientPool{clients: clients, owned: owned}, nil
}

func (p *ClientPool) Do(ctx context.Context, network, address string, payload io.Reader, options ...DoOption) (*Response, error) {
	if p == nil || len(p.clients) == 0 {
		return nil, errors.New("client pool is not initialized")
	}
	idx := p.next.Add(1) - 1
	return p.clients[idx%uint64(len(p.clients))].Do(ctx, network, address, payload, options...)
}

func (p *ClientPool) Close() error {
	if p == nil {
		return nil
	}
	p.closeOnce.Do(func() {
		for _, transport := range p.owned {
			transport.CloseIdleConnections()
		}
	})
	return nil
}

func newPoolTransport() *http.Transport {
	if base, ok := http.DefaultTransport.(*http.Transport); ok {
		transport := base.Clone()
		transport.ForceAttemptHTTP2 = true
		return transport
	}
	return &http.Transport{ForceAttemptHTTP2: true}
}
