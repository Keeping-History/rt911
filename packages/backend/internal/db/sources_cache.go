package db

import (
	"context"
	"sync"
	"time"

	"classicy/streamer/internal/model"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Sources is the time-independent, all-clients-identical source lists sent on
// init (TV channels, RadioScanner audio stations, pager providers, newsgroups).
type Sources struct {
	Video  []string
	Audio  []string
	Pager  []string
	Usenet []model.NewsgroupSource
}

type sourcesLoader func(ctx context.Context) (Sources, error)

// SourcesCache memoizes Sources with a TTL and single-flight refresh: under a
// connection storm at most one refresh runs per interval, and a failed refresh
// serves the last good value (sources are static, so staleness is harmless).
type SourcesCache struct {
	load sourcesLoader
	ttl  time.Duration

	mu       sync.Mutex
	val      Sources
	fetched  time.Time
	valid    bool
	inflight *sync.Once
}

// NewSourcesCache builds a cache backed by the four available-source queries.
func NewSourcesCache(pool *pgxpool.Pool, ttl time.Duration) *SourcesCache {
	return newSourcesCacheWithLoader(func(ctx context.Context) (Sources, error) {
		var s Sources
		var err error
		if s.Video, err = AvailableVideoSources(ctx, pool); err != nil {
			return Sources{}, err
		}
		if s.Audio, err = AvailableAudioSources(ctx, pool); err != nil {
			return Sources{}, err
		}
		if s.Pager, err = AvailablePagerProviders(ctx, pool); err != nil {
			return Sources{}, err
		}
		if s.Usenet, err = AvailableNewsgroups(ctx, pool); err != nil {
			return Sources{}, err
		}
		return s, nil
	}, ttl)
}

func newSourcesCacheWithLoader(load sourcesLoader, ttl time.Duration) *SourcesCache {
	return &SourcesCache{load: load, ttl: ttl}
}

// Get returns cached Sources, refreshing at most one caller at a time when stale.
func (c *SourcesCache) Get(ctx context.Context) Sources {
	c.mu.Lock()
	if c.valid && time.Since(c.fetched) < c.ttl {
		v := c.val
		c.mu.Unlock()
		return v
	}
	if c.inflight == nil {
		c.inflight = &sync.Once{}
	}
	once := c.inflight
	last := c.val
	hadValue := c.valid
	c.mu.Unlock()

	once.Do(func() {
		v, err := c.load(ctx)
		c.mu.Lock()
		if err == nil {
			c.val, c.fetched, c.valid = v, time.Now(), true
		}
		c.inflight = nil // allow the next refresh once this one settles
		c.mu.Unlock()
	})

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.valid {
		return c.val
	}
	if hadValue {
		return last
	}
	return Sources{}
}
