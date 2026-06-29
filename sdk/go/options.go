package cfsocks

import (
	"errors"
	"time"
)

const MaxWriteCloseAfter = 10 * time.Minute

type DoOption func(*DoOptions)

type DoOptions struct {
	WriteCloseAfter *time.Duration
}

func WithWriteCloseAfter(delay time.Duration) DoOption {
	return func(options *DoOptions) {
		options.WriteCloseAfter = &delay
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
	return out, nil
}
