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

	"github.com/jackc/pgx/v5/pgxpool"
	goredis "github.com/redis/go-redis/v9"
)

// news items reuse the MediaItem shape but live in their own Redis keyspace,
// separate from media:*, pager:* and mp3:*, so the default media tick path never
// scans them — they ride the opt-in "news" channel instead.
const (
	keyNewsItems   = "news:items"    // HASH  id → JSON
	keyNewsByStart = "news:by_start" // ZSET  score=unix_start, member=id
)

// WarmNewsCache loads all approved news items from PostgreSQL into Redis if not
// already present.
func WarmNewsCache(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error {
	n, err := rdb.ZCard(ctx, keyNewsByStart).Result()
	if err == nil && n > 0 {
		logger.Info("news cache already warm", "items", n)
		return nil
	}

	logger.Info("warming news cache from database…")
	items, err := db.AllNewsItems(ctx, pool)
	if err != nil {
		return fmt.Errorf("load news items: %w", err)
	}

	pipe := rdb.Pipeline()
	count := 0
	for _, it := range items {
		data, err := json.Marshal(it)
		if err != nil {
			continue
		}
		id := strconv.Itoa(it.ID)
		pipe.HSet(ctx, keyNewsItems, id, data)
		pipe.ZAdd(ctx, keyNewsByStart, goredis.Z{
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

	logger.Info("news cache warm", "items", len(items))
	return nil
}

// UpsertNews stores a single news item in the cache, overwriting any existing
// entry. Used by the NOTIFY listener to apply INSERT/UPDATE events incrementally.
func UpsertNews(ctx context.Context, rdb *goredis.Client, it model.MediaItem) error {
	data, err := json.Marshal(it)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	id := strconv.Itoa(it.ID)
	pipe := rdb.Pipeline()
	pipe.HSet(ctx, keyNewsItems, id, data)
	pipe.ZAdd(ctx, keyNewsByStart, goredis.Z{
		Score:  float64(it.StartDate.Unix()),
		Member: id,
	})
	_, err = pipe.Exec(ctx)
	return err
}

// ForgetNews removes a news item from the cache. Used by the NOTIFY listener to
// apply DELETE events and to evict rows whose approved flag flipped to 0.
func ForgetNews(ctx context.Context, rdb *goredis.Client, id int) error {
	sid := strconv.Itoa(id)
	pipe := rdb.Pipeline()
	pipe.HDel(ctx, keyNewsItems, sid)
	pipe.ZRem(ctx, keyNewsByStart, sid)
	_, err := pipe.Exec(ctx)
	return err
}

// NewsItemsAt returns news items whose start_date Unix-second exactly equals
// t.Unix().
func NewsItemsAt(ctx context.Context, rdb *goredis.Client, t time.Time) ([]model.MediaItem, error) {
	lo := float64(t.Unix())
	hi := lo

	ids, err := rdb.ZRangeByScore(ctx, keyNewsByStart, &goredis.ZRangeBy{
		Min: strconv.FormatFloat(lo, 'f', 0, 64),
		Max: strconv.FormatFloat(hi, 'f', 0, 64),
	}).Result()
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	return fetchNewsByIDs(ctx, rdb, ids)
}

func fetchNewsByIDs(ctx context.Context, rdb *goredis.Client, ids []string) ([]model.MediaItem, error) {
	vals, err := rdb.HMGet(ctx, keyNewsItems, ids...).Result()
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
