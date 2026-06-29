package main

import "fmt"

func errUnsupportedMode(mode string) error {
	return fmt.Errorf("unsupported mode %q", mode)
}

func classifyErr(err error) string {
	if err == nil {
		return ""
	}
	text := err.Error()
	if len(text) > 160 {
		text = text[:160]
	}
	return text
}
