package h3

import (
	"context"
	"errors"
	"io"
	"net/http"
	"sync"

	cfsocks "github.com/bnkrr/cf-socks/sdk/go"
	"github.com/quic-go/quic-go/http3"
)

const defaultPoolSize = 4

type ClientConfig struct {
	Endpoint          string
	Secret            string
	InsecureAllowHTTP bool
	TargetTLS         cfsocks.TLSMode
}

type Client struct {
	client    *cfsocks.Client
	transport *http3.Transport
	closeOnce sync.Once
}

func NewClient(cfg ClientConfig) (*Client, error) {
	transport := &http3.Transport{}
	client := &cfsocks.Client{
		Endpoint:          cfg.Endpoint,
		Secret:            cfg.Secret,
		Transport:         cfsocks.TransportH3,
		HTTPClient:        &http.Client{Transport: transport},
		InsecureAllowHTTP: cfg.InsecureAllowHTTP,
		TargetTLS:         cfg.TargetTLS,
	}
	return &Client{client: client, transport: transport}, nil
}

func (c *Client) Do(ctx context.Context, network, address string, payload io.Reader, options ...cfsocks.DoOption) (*cfsocks.Response, error) {
	if c == nil || c.client == nil {
		return nil, errors.New("h3 client is not initialized")
	}
	return c.client.Do(ctx, network, address, payload, options...)
}

func (c *Client) Close() error {
	if c == nil {
		return nil
	}
	var err error
	c.closeOnce.Do(func() {
		if c.transport != nil {
			err = c.transport.Close()
		}
	})
	return err
}

type PoolConfig struct {
	Endpoint          string
	Secret            string
	Size              int
	InsecureAllowHTTP bool
	TargetTLS         cfsocks.TLSMode
}

type Pool struct {
	pool       *cfsocks.ClientPool
	transports []*http3.Transport
	closeOnce  sync.Once
}

func NewPool(cfg PoolConfig) (*Pool, error) {
	size := cfg.Size
	if size == 0 {
		size = defaultPoolSize
	}
	if size < 1 {
		return nil, errors.New("h3 pool size must be positive")
	}
	transports := make([]*http3.Transport, size)
	clients := make([]*http.Client, size)
	for i := 0; i < size; i++ {
		transport := &http3.Transport{}
		transports[i] = transport
		clients[i] = &http.Client{Transport: transport}
	}
	pool, err := cfsocks.NewClientPool(cfsocks.ClientPoolConfig{
		Endpoint:          cfg.Endpoint,
		Secret:            cfg.Secret,
		Transport:         cfsocks.TransportH3,
		Size:              size,
		HTTPClients:       clients,
		InsecureAllowHTTP: cfg.InsecureAllowHTTP,
		TargetTLS:         cfg.TargetTLS,
	})
	if err != nil {
		for _, transport := range transports {
			_ = transport.Close()
		}
		return nil, err
	}
	return &Pool{pool: pool, transports: transports}, nil
}

func (p *Pool) Do(ctx context.Context, network, address string, payload io.Reader, options ...cfsocks.DoOption) (*cfsocks.Response, error) {
	if p == nil || p.pool == nil {
		return nil, errors.New("h3 pool is not initialized")
	}
	return p.pool.Do(ctx, network, address, payload, options...)
}

func (p *Pool) Close() error {
	if p == nil {
		return nil
	}
	var first error
	p.closeOnce.Do(func() {
		if p.pool != nil {
			_ = p.pool.Close()
		}
		for _, transport := range p.transports {
			if transport == nil {
				continue
			}
			if err := transport.Close(); err != nil && first == nil {
				first = err
			}
		}
	})
	return first
}
