package connections

import (
	"errors"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/trueai/edge-server/internal/protocol"
)

var ErrOffline = errors.New("device offline")

type Device struct {
	Email, DeviceID, ConnectionID string
	Conn                          *websocket.Conn
	mu                            sync.Mutex
}

func (d *Device) Send(m protocol.Message) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	_ = d.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return d.Conn.WriteJSON(m)
}

type Registry struct {
	mu      sync.RWMutex
	byEmail map[string]*Device
}

func New() *Registry { return &Registry{byEmail: make(map[string]*Device)} }
func (r *Registry) Register(d *Device) *Device {
	r.mu.Lock()
	old := r.byEmail[d.Email]
	r.byEmail[d.Email] = d
	r.mu.Unlock()
	if old != nil {
		_ = old.Conn.Close()
	}
	return old
}
func (r *Registry) Remove(d *Device) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.byEmail[d.Email] == d {
		delete(r.byEmail, d.Email)
	}
}
func (r *Registry) Get(email string) (*Device, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	device := r.byEmail[email]
	if device == nil {
		return nil, ErrOffline
	}
	return device, nil
}
