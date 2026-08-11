// Package fanout delivers one message to every pod in the deployment.
//
// The streamer runs as N replicas behind a load balancer, so a client's
// WebSocket lives on exactly one pod. Anything that originates on a single pod
// — an operator's HTTP call, a teacher's command — reaches only that pod's
// sessions unless it is re-published for the others to pick up. This package is
// that re-publish: a typed Redis pub/sub channel carrying a JSON payload.
//
// Deliberately no persistence and no delivery guarantee. Redis pub/sub is
// fire-and-forget, so a pod that is down (or still booting) when a message is
// published never sees it. That is the right trade for a live command — a
// forced-clock jump replayed ten minutes late would be worse than one missed —
// but it means anything a late joiner must still observe has to be persisted
// separately by the caller. internal/clock does exactly that: it keeps its own
// Redis key for boot recovery and uses this bus only for the live edge.
//
// Redis pub/sub echoes a message back to the publishing pod when it is also
// subscribed, so handlers see their own sends. Handlers must therefore be
// idempotent, or the caller must dedupe (clock.setLocal compares against the
// current state before firing onChange).
package fanout

import (
	"context"
	"encoding/json"
	"log/slog"

	goredis "github.com/redis/go-redis/v9"
)

// Bus is a typed publish/subscribe channel shared by every pod.
type Bus[T any] struct {
	rdb     *goredis.Client
	channel string
	logger  *slog.Logger
	handler func(T)
}

// New returns a bus over the given Redis pub/sub channel. Channel names are
// namespaced by subsystem and suffixed with the event, matching the existing
// "clock:master:changed".
func New[T any](rdb *goredis.Client, channel string, logger *slog.Logger) *Bus[T] {
	return &Bus[T]{rdb: rdb, channel: channel, logger: logger}
}

// Channel reports the Redis channel this bus publishes on, for logging.
func (b *Bus[T]) Channel() string { return b.channel }

// OnMessage registers the handler run for every message received, including
// this pod's own publishes. Set it once, before Run.
func (b *Bus[T]) OnMessage(fn func(T)) { b.handler = fn }

// Publish encodes msg as JSON and publishes it to every subscribed pod.
//
// The error is returned rather than swallowed so each caller picks its own
// policy: the clock treats a publish failure as non-fatal because it has
// already applied locally and other pods recover on their next boot Load,
// whereas a purely ephemeral command has no such backstop and should surface
// the failure to whoever issued it.
func (b *Bus[T]) Publish(ctx context.Context, msg T) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return b.rdb.Publish(ctx, b.channel, data).Err()
}

// Run applies published messages for the process lifetime. go-redis's PubSub
// reconnects internally, so this survives a Redis blip; the loop exits when ctx
// is canceled. Call it in its own goroutine.
func (b *Bus[T]) Run(ctx context.Context) {
	sub := b.rdb.Subscribe(ctx, b.channel)
	defer sub.Close()
	// Subscribe's own ctx does not close the channel on cancel, so the receive
	// loop below would block forever on shutdown without this.
	go func() { <-ctx.Done(); sub.Close() }()
	for msg := range sub.Channel() {
		var decoded T
		if err := json.Unmarshal([]byte(msg.Payload), &decoded); err != nil {
			b.logger.Warn("bad fanout notification",
				"channel", b.channel, "payload", msg.Payload, "error", err)
			continue
		}
		if b.handler != nil {
			b.handler(decoded)
		}
	}
}
