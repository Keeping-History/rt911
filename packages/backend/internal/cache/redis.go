package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"classicy/streamer/internal/db"
	"classicy/streamer/internal/model"

	goredis "github.com/redis/go-redis/v9"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	keyItems   = "media:items"    // HASH  id → JSON
	keyByStart = "media:by_start" // ZSET  score=unix_start, member=id
)

// pipelineChunk bounds how many items we buffer into a single Redis pipeline
// before flushing. Warm/resync touch the full dataset (hundreds of thousands of
// rows × 2 commands each); one giant Exec exceeds the client write timeout, so
// we flush in chunks. See flushIfFull.
const pipelineChunk = 2000

// flushIfFull executes and replaces pipe once count is a non-zero multiple of
// pipelineChunk. Returns the pipe to keep using (a fresh one after a flush).
func flushIfFull(ctx context.Context, rdb *goredis.Client, pipe goredis.Pipeliner, count int) (goredis.Pipeliner, error) {
	if count > 0 && count%pipelineChunk == 0 {
		if _, err := pipe.Exec(ctx); err != nil {
			return nil, err
		}
		return rdb.Pipeline(), nil
	}
	return pipe, nil
}

// Connect parses a Redis URL and returns a client.
func Connect(url string) *goredis.Client {
	opt, err := goredis.ParseURL(url)
	if err != nil {
		opt = &goredis.Options{Addr: "localhost:6379"}
	}
	return goredis.NewClient(opt)
}

// WarmCache loads all items from PostgreSQL into Redis if not already present.
func WarmCache(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error {
	n, err := rdb.ZCard(ctx, keyByStart).Result()
	if err == nil && n > 0 {
		logger.Info("redis cache already warm", "items", n)
		return nil
	}

	logger.Info("warming redis cache from database…")
	items, err := db.AllItems(ctx, pool)
	if err != nil {
		return fmt.Errorf("load items: %w", err)
	}

	pipe := rdb.Pipeline()
	count := 0
	for _, it := range items {
		data, err := json.Marshal(it)
		if err != nil {
			continue
		}
		id := strconv.Itoa(it.ID)
		pipe.HSet(ctx, keyItems, id, data)
		pipe.ZAdd(ctx, keyByStart, goredis.Z{
			Score:  float64(it.StartDate.Unix()),
			Member: id,
		})
		count++
		if pipe, err = flushIfFull(ctx, rdb, pipe, count); err != nil {
			return fmt.Errorf("pipeline exec: %w", err)
		}
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("pipeline exec: %w", err)
	}

	logger.Info("redis cache warm", "items", len(items))
	return nil
}

// Upsert stores a single item in the cache, overwriting any existing entry.
// Used by the NOTIFY listener to apply INSERT/UPDATE events incrementally.
func Upsert(ctx context.Context, rdb *goredis.Client, it model.MediaItem) error {
	data, err := json.Marshal(it)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	id := strconv.Itoa(it.ID)
	pipe := rdb.Pipeline()
	pipe.HSet(ctx, keyItems, id, data)
	pipe.ZAdd(ctx, keyByStart, goredis.Z{
		Score:  float64(it.StartDate.Unix()),
		Member: id,
	})
	_, err = pipe.Exec(ctx)
	return err
}

// Forget removes an item from the cache. Used by the NOTIFY listener to
// apply DELETE events and to evict rows whose approved flag flipped to 0.
func Forget(ctx context.Context, rdb *goredis.Client, id int) error {
	sid := strconv.Itoa(id)
	pipe := rdb.Pipeline()
	pipe.HDel(ctx, keyItems, sid)
	pipe.ZRem(ctx, keyByStart, sid)
	_, err := pipe.Exec(ctx)
	return err
}

// ItemsAt returns items whose start_date Unix-second exactly equals t.Unix().
func ItemsAt(ctx context.Context, rdb *goredis.Client, t time.Time) ([]model.MediaItem, error) {
	lo := float64(t.Unix())
	hi := lo

	ids, err := rdb.ZRangeByScore(ctx, keyByStart, &goredis.ZRangeBy{
		Min: strconv.FormatFloat(lo, 'f', 0, 64),
		Max: strconv.FormatFloat(hi, 'f', 0, 64),
	}).Result()
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	return fetchByIDs(ctx, rdb, ids)
}

func fetchByIDs(ctx context.Context, rdb *goredis.Client, ids []string) ([]model.MediaItem, error) {
	vals, err := rdb.HMGet(ctx, keyItems, ids...).Result()
	if err != nil {
		return nil, err
	}
	items := make([]model.MediaItem, 0, len(vals))
	for _, v := range vals {
		if v == nil {
			continue
		}
		var it model.MediaItem
		if err := json.Unmarshal([]byte(v.(string)), &it); err == nil {
			items = append(items, it)
		}
	}
	return items, nil
}
