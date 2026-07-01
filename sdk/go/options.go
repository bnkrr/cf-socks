package cfsocks

import (
	"errors"
	"time"
)

const MaxWriteCloseAfter = 10 * time.Minute

type TLSMode string

const (
	TLSOff TLSMode = "off"
	TLSOn  TLSMode = "on"
)

type DoOption func(*DoOptions)

type DoOptions struct {
	WriteCloseAfter *time.Duration
	TargetTLS       *TLSMode
}

func WithWriteCloseAfter(delay time.Duration) DoOption {
	return func(options *DoOptions) {
		options.WriteCloseAfter = &delay
	}
}

func WithTLS(mode TLSMode) DoOption {
	return func(options *DoOptions) {
		options.TargetTLS = &mode
	}
}

func ParseTLSMode(value string) (TLSMode, error) {
	switch TLSMode(value) {
	case "", TLSOff:
		return TLSOff, nil
	case TLSOn:
		return TLSOn, nil
	default:
		return "", errors.New("tls must be off or on")
	}
}

func applyDoOptions(options []DoOption) (DoOptions, error) {
	var out DoOptions
	for _, option := range options {
		if option != nil {
			option(&out)
		}
	}
	if out.WriteCloseAfter != nil && *out.WriteCloseAfter < 0 {
		return DoOptions{}, errors.New("write_close_after must not be negative")
	}
	if out.WriteCloseAfter != nil && *out.WriteCloseAfter > MaxWriteCloseAfter {
		return DoOptions{}, errors.New("write_close_after must not exceed 10 minutes")
	}
	if out.TargetTLS != nil {
		if _, err := ParseTLSMode(string(*out.TargetTLS)); err != nil {
			return DoOptions{}, err
		}
	}
	return out, nil
}
