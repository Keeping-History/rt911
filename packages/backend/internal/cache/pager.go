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

// Pager items live in their own Redis keys, separate from media:* so the 1 Hz
// media tick path never scans the ~447k-row pager set.
const (
	keyPagerItems   = "pager:items"    // HASH  id → JSON
	keyPagerByStart = "pager:by_start" // ZSET  score=unix_start, member=id
)

// WarmPagerCache loads all approved pager items from PostgreSQL into Redis if
// not already present.
func WarmPagerCache(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error {
	n, err := rdb.ZCard(ctx, keyPagerByStart).Result()
	if err == nil && n > 0 {
		logger.Info("pager cache already warm", "items", n)
		return nil
	}

	logger.Info("warming pager cache from database…")
	items, err := db.AllPagerItems(ctx, pool)
	if err != nil {
		return fmt.Errorf("load pager items: %w", err)
	}

	pipe := rdb.Pipeline()
	for _, it := range items {
		data, err := json.Marshal(it)
		if err != nil {
			continue
		}
		id := strconv.Itoa(it.ID)
		pipe.HSet(ctx, keyPagerItems, id, data)
		pipe.ZAdd(ctx, keyPagerByStart, goredis.Z{
			Score:  float64(it.StartDate.Unix()),
			Member: id,
		})
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("pipeline exec: %w", err)
	}

	logger.Info("pager cache warm", "items", len(items))
	return nil
}

// UpsertPager stores a single pager item in the cache, overwriting any existing
// entry. Used by the NOTIFY listener to apply INSERT/UPDATE events incrementally.
func UpsertPager(ctx context.Context, rdb *goredis.Client, it model.PagerItem) error {
	data, err := json.Marshal(it)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	id := strconv.Itoa(it.ID)
	pipe := rdb.Pipeline()
	pipe.HSet(ctx, keyPagerItems, id, data)
	pipe.ZAdd(ctx, keyPagerByStart, goredis.Z{
		Score:  float64(it.StartDate.Unix()),
		Member: id,
	})
	_, err = pipe.Exec(ctx)
	return err
}

// ForgetPager removes a pager item from the cache. Used by the NOTIFY listener
// to apply DELETE events and to evict rows whose approved flag flipped to 0.
func ForgetPager(ctx context.Context, rdb *goredis.Client, id int) error {
	sid := strconv.Itoa(id)
	pipe := rdb.Pipeline()
	pipe.HDel(ctx, keyPagerItems, sid)
	pipe.ZRem(ctx, keyPagerByStart, sid)
	_, err := pipe.Exec(ctx)
	return err
}

// PagerItemsAt returns pager items whose start_date Unix-second exactly equals
// t.Unix().
func PagerItemsAt(ctx context.Context, rdb *goredis.Client, t time.Time) ([]model.PagerItem, error) {
	lo := float64(t.Unix())
	hi := lo

	ids, err := rdb.ZRangeByScore(ctx, keyPagerByStart, &goredis.ZRangeBy{
		Min: strconv.FormatFloat(lo, 'f', 0, 64),
		Max: strconv.FormatFloat(hi, 'f', 0, 64),
	}).Result()
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	return fetchPagerByIDs(ctx, rdb, ids)
}

func fetchPagerByIDs(ctx context.Context, rdb *goredis.Client, ids []string) ([]model.PagerItem, error) {
	vals, err := rdb.HMGet(ctx, keyPagerItems, ids...).Result()
	if err != nil {
		return nil, err
	}
	items := make([]model.PagerItem, 0, len(vals))
	for _, v := range vals {
		if v == nil {
			continue
		}
		var it model.PagerItem
		if err := json.Unmarshal([]byte(v.(string)), &it); err == nil {
			items = append(items, it)
		}
	}
	return items, nil
}
