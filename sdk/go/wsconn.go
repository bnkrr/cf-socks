package cfsocks

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"nhooyr.io/websocket"
)

type websocketMessageConn interface {
	SetReadLimit(int64)
	Read(context.Context) (websocket.MessageType, []byte, error)
	Write(context.Context, websocket.MessageType, []byte) error
	Close(websocket.StatusCode, string) error
}

type wsConn struct {
	ctx    context.Context
	cancel context.CancelFunc
	ws     websocketMessageConn
	remote string

	readMu   sync.Mutex
	pending  []byte
	messages chan []byte
	readDone chan struct{}

	readErrMu   sync.Mutex
	readErr     error
	readErrOnce sync.Once

	writeLock chan struct{}
	closeOnce sync.Once
	closeErr  error

	deadlineMu           sync.Mutex
	readDeadline         time.Time
	writeDeadline        time.Time
	readDeadlineChanged  chan struct{}
	writeDeadlineChanged chan struct{}
}

var _ net.Conn = (*wsConn)(nil)

func newWSConn(ctx context.Context, cancel context.CancelFunc, ws websocketMessageConn, remote string) *wsConn {
	ws.SetReadLimit(-1)
	c := &wsConn{
		ctx:                  ctx,
		cancel:               cancel,
		ws:                   ws,
		remote:               remote,
		messages:             make(chan []byte),
		readDone:             make(chan struct{}),
		writeLock:            make(chan struct{}, 1),
		readDeadlineChanged:  make(chan struct{}),
		writeDeadlineChanged: make(chan struct{}),
	}
	c.writeLock <- struct{}{}
	go c.readLoop()
	return c
}

func (c *wsConn) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	c.readMu.Lock()
	defer c.readMu.Unlock()

	for {
		if len(c.pending) > 0 {
			n := copy(p, c.pending)
			c.pending = c.pending[n:]
			return n, nil
		}
		if err := c.currentReadErr(); err != nil {
			return 0, err
		}
		if c.deadlineExpired(true) {
			return 0, timeoutError{}
		}

		deadline, changed := c.deadlineSnapshot(true)
		timer, timeout := deadlineTimer(deadline)
		select {
		case message := <-c.messages:
			stopTimer(timer)
			if len(message) == 0 {
				continue
			}
			c.pending = message
		case <-c.readDone:
			stopTimer(timer)
			if err := c.currentReadErr(); err != nil {
				return 0, err
			}
			return 0, io.EOF
		case <-timeout:
			stopTimer(timer)
			return 0, timeoutError{}
		case <-changed:
			stopTimer(timer)
			continue
		case <-c.ctx.Done():
			stopTimer(timer)
			return 0, net.ErrClosed
		}
	}
}

func (c *wsConn) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if err := c.acquireWriteLock(); err != nil {
		return 0, err
	}
	defer c.releaseWriteLock()

	if c.deadlineExpired(false) {
		return 0, timeoutError{}
	}
	if err := c.ws.Write(c.ctx, websocket.MessageBinary, p); err != nil {
		if errors.Is(c.ctx.Err(), context.Canceled) {
			return 0, net.ErrClosed
		}
		return 0, err
	}
	return len(p), nil
}

func (c *wsConn) Close() error {
	c.closeOnce.Do(func() {
		c.cancel()
		c.closeErr = c.ws.Close(websocket.StatusNormalClosure, "")
	})
	return c.closeErr
}

func (c *wsConn) SetDeadline(t time.Time) error {
	c.deadlineMu.Lock()
	c.readDeadline = t
	c.writeDeadline = t
	c.notifyReadDeadlineLocked()
	c.notifyWriteDeadlineLocked()
	c.deadlineMu.Unlock()
	return nil
}

func (c *wsConn) SetReadDeadline(t time.Time) error {
	c.deadlineMu.Lock()
	c.readDeadline = t
	c.notifyReadDeadlineLocked()
	c.deadlineMu.Unlock()
	return nil
}

func (c *wsConn) SetWriteDeadline(t time.Time) error {
	c.deadlineMu.Lock()
	c.writeDeadline = t
	c.notifyWriteDeadlineLocked()
	c.deadlineMu.Unlock()
	return nil
}

func (c *wsConn) LocalAddr() net.Addr {
	return dummyAddr("local")
}

func (c *wsConn) RemoteAddr() net.Addr {
	return dummyAddr(c.remote)
}

func (c *wsConn) readLoop() {
	for {
		typ, message, err := c.ws.Read(c.ctx)
		if err != nil {
			c.setReadErr(normalizeWSError(err))
			return
		}
		if typ != websocket.MessageBinary {
			err := fmt.Errorf("unexpected websocket message type %v", typ)
			_ = c.ws.Close(websocket.StatusUnsupportedData, err.Error())
			c.cancel()
			c.setReadErr(err)
			return
		}
		select {
		case c.messages <- message:
		case <-c.ctx.Done():
			c.setReadErr(net.ErrClosed)
			return
		}
	}
}

func (c *wsConn) acquireWriteLock() error {
	for {
		if errors.Is(c.ctx.Err(), context.Canceled) {
			return net.ErrClosed
		}
		if c.deadlineExpired(false) {
			return timeoutError{}
		}
		deadline, changed := c.deadlineSnapshot(false)
		timer, timeout := deadlineTimer(deadline)
		select {
		case <-c.writeLock:
			stopTimer(timer)
			return nil
		case <-timeout:
			stopTimer(timer)
			return timeoutError{}
		case <-changed:
			stopTimer(timer)
			continue
		case <-c.ctx.Done():
			stopTimer(timer)
			return net.ErrClosed
		}
	}
}

func (c *wsConn) releaseWriteLock() {
	c.writeLock <- struct{}{}
}

func (c *wsConn) setReadErr(err error) {
	c.readErrOnce.Do(func() {
		c.readErrMu.Lock()
		c.readErr = err
		c.readErrMu.Unlock()
		close(c.readDone)
	})
}

func (c *wsConn) currentReadErr() error {
	c.readErrMu.Lock()
	defer c.readErrMu.Unlock()
	return c.readErr
}

func (c *wsConn) deadlineExpired(read bool) bool {
	c.deadlineMu.Lock()
	deadline := c.writeDeadline
	if read {
		deadline = c.readDeadline
	}
	c.deadlineMu.Unlock()
	return !deadline.IsZero() && !time.Now().Before(deadline)
}

func (c *wsConn) deadlineSnapshot(read bool) (time.Time, <-chan struct{}) {
	c.deadlineMu.Lock()
	defer c.deadlineMu.Unlock()
	if read {
		return c.readDeadline, c.readDeadlineChanged
	}
	return c.writeDeadline, c.writeDeadlineChanged
}

func (c *wsConn) notifyReadDeadlineLocked() {
	close(c.readDeadlineChanged)
	c.readDeadlineChanged = make(chan struct{})
}

func (c *wsConn) notifyWriteDeadlineLocked() {
	close(c.writeDeadlineChanged)
	c.writeDeadlineChanged = make(chan struct{})
}

func deadlineTimer(deadline time.Time) (*time.Timer, <-chan time.Time) {
	if deadline.IsZero() {
		return nil, nil
	}
	d := time.Until(deadline)
	if d < 0 {
		d = 0
	}
	timer := time.NewTimer(d)
	return timer, timer.C
}

func stopTimer(timer *time.Timer) {
	if timer == nil {
		return
	}
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
}

func normalizeWSError(err error) error {
	switch websocket.CloseStatus(err) {
	case websocket.StatusNormalClosure, websocket.StatusGoingAway:
		return io.EOF
	}
	if errors.Is(err, context.Canceled) {
		return net.ErrClosed
	}
	return err
}

type timeoutError struct{}

func (timeoutError) Error() string   { return "i/o timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

type dummyAddr string

func (a dummyAddr) Network() string { return "tcp" }
func (a dummyAddr) String() string  { return string(a) }
