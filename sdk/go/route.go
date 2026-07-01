package cfsocks

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/bnkrr/cf-socks/sdk/go/internal/token"
)

type routeSpec struct {
	method  string
	path    string
	op      string
	ws      bool
	options DoOptions
}

type routePlan struct {
	endpoint string
	auth     string
	target   target
}

type target struct {
	host string
	port int
}

func (c *Client) buildRoute(network, address string, spec routeSpec) (routePlan, error) {
	if network != "tcp" {
		return routePlan{}, ErrUnsupportedNetwork
	}
	host, port, err := SplitHostPort(address)
	if err != nil {
		return routePlan{}, err
	}
	endpoint, err := c.endpoint(spec.path, spec.ws)
	if err != nil {
		return routePlan{}, err
	}
	claims := token.Claims{Op: spec.op, Host: host, Port: port}
	targetTLS := c.TargetTLS
	if spec.options.TargetTLS != nil {
		targetTLS = *spec.options.TargetTLS
	}
	targetTLS, err = ParseTLSMode(string(targetTLS))
	if err != nil {
		return routePlan{}, err
	}
	if targetTLS != TLSOff {
		claims.SecureTransport = string(targetTLS)
	}
	if spec.options.WriteCloseAfter != nil {
		ms := spec.options.WriteCloseAfter.Milliseconds()
		claims.WriteCloseAfterMS = &ms
	}
	auth, err := c.authHeader(spec.method, spec.path, claims)
	if err != nil {
		return routePlan{}, err
	}
	return routePlan{
		endpoint: endpoint,
		auth:     auth,
		target:   target{host: host, port: port},
	}, nil
}

func (c *Client) transport() Transport {
	if c.Transport == "" {
		return TransportWSS
	}
	return c.Transport
}

func (c *Client) authHeader(method, path string, claims token.Claims) (string, error) {
	sealed, err := token.Seal(c.Secret, token.AAD(method, path), claims, time.Now())
	if err != nil {
		return "", err
	}
	return token.AuthorizationHeader(sealed), nil
}

func (c *Client) endpoint(path string, ws bool) (string, error) {
	if c.Endpoint == "" {
		return "", errors.New("endpoint is required")
	}
	parsed, err := url.Parse(c.Endpoint)
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "https", "wss":
	case "http", "ws":
		if !c.InsecureAllowHTTP {
			return "", errors.New("endpoint must use https:// or wss://")
		}
	default:
		return "", errors.New("endpoint must use https:// or wss://")
	}
	if ws {
		if parsed.Scheme == "http" || parsed.Scheme == "ws" {
			parsed.Scheme = "ws"
		} else {
			parsed.Scheme = "wss"
		}
	} else {
		if parsed.Scheme == "http" || parsed.Scheme == "ws" {
			parsed.Scheme = "http"
		} else {
			parsed.Scheme = "https"
		}
	}
	parsed.Path = path
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

func SplitHostPort(value string) (string, int, error) {
	host, portText, err := net.SplitHostPort(value)
	if err != nil {
		return "", 0, err
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		return "", 0, err
	}
	if port < 1 || port > 65535 {
		return "", 0, fmt.Errorf("invalid port %d", port)
	}
	if strings.ContainsAny(host, "\r\n") || host == "" {
		return "", 0, errors.New("invalid host")
	}
	return host, port, nil
}
