package routing

import (
	"errors"
	"sync"

	"github.com/trueai/edge-server/internal/protocol"
)

var ErrDuplicate = errors.New("duplicate request ID")

type entry struct {
	connectionID string
	result       chan protocol.Message
}
type Pending struct {
	mu    sync.Mutex
	calls map[string]entry
}

func New() *Pending { return &Pending{calls: make(map[string]entry)} }
func (p *Pending) Add(id, connectionID string) (<-chan protocol.Message, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.calls[id]; ok {
		return nil, ErrDuplicate
	}
	ch := make(chan protocol.Message, 1)
	p.calls[id] = entry{connectionID, ch}
	return ch, nil
}
func (p *Pending) Resolve(id, connectionID string, m protocol.Message) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	e, ok := p.calls[id]
	if !ok || e.connectionID != connectionID {
		return false
	}
	delete(p.calls, id)
	e.result <- m
	return true
}
func (p *Pending) Remove(id string) { p.mu.Lock(); delete(p.calls, id); p.mu.Unlock() }
