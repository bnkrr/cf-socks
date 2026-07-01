package cfsocks

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"

	"nhooyr.io/websocket"
)

type Transport string

const (
	TransportWSS Transport = "wss"
	TransportH2  Transport = "h2"
	TransportH3  Transport = "h3"
)

type Client struct {
	Endpoint          string
	Secret            string
	Transport         Transport
	HTTPClient        *http.Client
	InsecureAllowHTTP bool
	TargetTLS         TLSMode
}

type Response struct {
	Body       io.ReadCloser
	StatusCode int
}

var (
	ErrUnsupportedTransport = errors.New("unsupported transport")
	ErrUnsupportedNetwork   = errors.New("unsupported network")
	ErrWorkerRejected       = errors.New("worker rejected request")
	ErrUnexpectedProtocol   = errors.New("unexpected protocol")
	ErrHTTPClientRequired   = errors.New("http client is required")
)

func (c *Client) Dial(ctx context.Context, network, address string) (net.Conn, error) {
	if c.transport() != TransportWSS {
		return nil, ErrUnsupportedTransport
	}
	route, err := c.buildRoute(network, address, routeSpec{
		method: http.MethodGet,
		path:   "/wss",
		op:     "dial",
		ws:     true,
	})
	if err != nil {
		return nil, err
	}
	headers := http.Header{}
	headers.Set("Authorization", route.auth)
	ws, _, err := websocket.Dial(ctx, route.endpoint, &websocket.DialOptions{
		HTTPClient: c.HTTPClient,
		HTTPHeader: headers,
	})
	if err != nil {
		return nil, err
	}
	typ, data, err := ws.Read(ctx)
	if err != nil {
		_ = ws.Close(websocket.StatusInternalError, "")
		return nil, err
	}
	if typ != websocket.MessageText || string(data) != "OK\n" {
		_ = ws.Close(websocket.StatusPolicyViolation, "")
		return nil, fmt.Errorf("%w: %q", ErrWorkerRejected, string(data))
	}
	connCtx, cancel := context.WithCancel(context.Background())
	return newWSConn(connCtx, cancel, ws, address), nil
}

func (c *Client) Do(ctx context.Context, network, address string, payload io.Reader, options ...DoOption) (*Response, error) {
	transport := c.transport()
	if transport != TransportH2 && transport != TransportH3 {
		return nil, ErrUnsupportedTransport
	}
	doOptions, err := applyDoOptions(options)
	if err != nil {
		return nil, err
	}
	path := "/h2"
	expectedProtoMajor := 2
	if transport == TransportH3 {
		path = "/h3"
		expectedProtoMajor = 3
	}
	route, err := c.buildRoute(network, address, routeSpec{
		method:  http.MethodPost,
		path:    path,
		op:      "payload",
		ws:      false,
		options: doOptions,
	})
	if err != nil {
		return nil, err
	}
	if payload == nil {
		payload = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, route.endpoint, payload)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", route.auth)
	req.Header.Set("Content-Type", "application/octet-stream")
	client := c.HTTPClient
	if client == nil {
		if transport == TransportH3 {
			return nil, ErrHTTPClientRequired
		}
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		_ = resp.Body.Close()
		return nil, fmt.Errorf("%w: status %d", ErrWorkerRejected, resp.StatusCode)
	}
	if resp.ProtoMajor != expectedProtoMajor {
		_ = resp.Body.Close()
		return nil, fmt.Errorf("%w: expected HTTP/%d, got %s", ErrUnexpectedProtocol, expectedProtoMajor, resp.Proto)
	}
	return &Response{Body: resp.Body, StatusCode: resp.StatusCode}, nil
}
