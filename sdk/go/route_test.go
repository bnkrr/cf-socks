package cfsocks

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/bnkrr/cf-socks/sdk/go/internal/token"
)

func TestBuildRouteForWSSBearerClaims(t *testing.T) {
	const secret = "test-secret"
	client := Client{Endpoint: "https://worker.test/base", Secret: secret}

	route, err := client.buildRoute("tcp", "example.test:443", routeSpec{
		method: http.MethodGet,
		path:   "/wss",
		op:     "dial",
		ws:     true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if route.endpoint != "wss://worker.test/wss" {
		t.Fatalf("endpoint = %q", route.endpoint)
	}
	if route.target.host != "example.test" || route.target.port != 443 {
		t.Fatalf("target = %+v", route.target)
	}

	claims := openRouteToken(t, secret, http.MethodGet, "/wss", route.auth)
	if claims.Op != "dial" || claims.Host != "example.test" || claims.Port != 443 {
		t.Fatalf("claims = %+v", claims)
	}
}

func TestBuildRouteForPayloadBearerClaims(t *testing.T) {
	const secret = "test-secret"
	client := Client{Endpoint: "https://worker.test", Secret: secret}

	route, err := client.buildRoute("tcp", "example.test:80", routeSpec{
		method: http.MethodPost,
		path:   "/h3",
		op:     "payload",
		ws:     false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if route.endpoint != "https://worker.test/h3" {
		t.Fatalf("endpoint = %q", route.endpoint)
	}

	claims := openRouteToken(t, secret, http.MethodPost, "/h3", route.auth)
	if claims.Op != "payload" || claims.Host != "example.test" || claims.Port != 80 {
		t.Fatalf("claims = %+v", claims)
	}
}

func TestBuildRouteRejectsUnsupportedNetwork(t *testing.T) {
	client := Client{Endpoint: "https://worker.test", Secret: "secret"}
	_, err := client.buildRoute("udp", "example.test:443", routeSpec{method: http.MethodGet, path: "/wss", op: "dial", ws: true})
	if !errors.Is(err, ErrUnsupportedNetwork) {
		t.Fatalf("err = %v, want ErrUnsupportedNetwork", err)
	}
}

func openRouteToken(t *testing.T, secret string, method string, path string, header string) token.Claims {
	t.Helper()
	encoded, ok := token.BearerToken(header)
	if !ok {
		t.Fatal("missing bearer token")
	}
	claims, err := token.Open(secret, token.AAD(method, path), encoded, token.OpenOptions{Now: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	return claims
}
