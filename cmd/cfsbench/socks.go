package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
)

func socksConnect(conn net.Conn, target string) error {
	host, port, err := splitTarget(target)
	if err != nil {
		return err
	}
	if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		return err
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil {
		return err
	}
	if reply[1] != 0x00 {
		return fmt.Errorf("socks auth method rejected: 0x%02x", reply[1])
	}
	req := []byte{0x05, 0x01, 0x00}
	if ip := net.ParseIP(host); ip != nil {
		if v4 := ip.To4(); v4 != nil {
			req = append(req, 0x01)
			req = append(req, v4...)
		} else {
			req = append(req, 0x04)
			req = append(req, ip.To16()...)
		}
	} else {
		if len(host) > 255 {
			return errors.New("target host is too long for SOCKS5")
		}
		req = append(req, 0x03, byte(len(host)))
		req = append(req, host...)
	}
	var portBytes [2]byte
	binary.BigEndian.PutUint16(portBytes[:], uint16(port))
	req = append(req, portBytes[:]...)
	if _, err := conn.Write(req); err != nil {
		return err
	}
	resp := make([]byte, 10)
	if _, err := io.ReadFull(conn, resp); err != nil {
		return err
	}
	if resp[1] != 0x00 {
		return fmt.Errorf("socks connect failed: 0x%02x", resp[1])
	}
	return nil
}

func splitTarget(target string) (string, int, error) {
	host, portText, err := net.SplitHostPort(target)
	if err != nil {
		return "", 0, err
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return "", 0, fmt.Errorf("invalid target port %q", portText)
	}
	return host, port, nil
}
