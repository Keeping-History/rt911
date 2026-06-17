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

// Usenet messages live in their own Redis keyspace. Unlike the other channels the
// time index is sharded *per newsgroup* — one ZSET per group — because a single
// group can hold millions of messages and a client only ever views one group at a
// time. Sharding lets a window query scan just the active group's ZSET instead of
// filtering the whole corpus in Go.
const (
	keyUsenetItems       = "usenet:items"     // HASH  id → JSON (all groups)
	keyUsenetByStartBase = "usenet:by_start:" // + group → ZSET score=unix_start, member=id
)

// usenetGroupKey returns the per-group time-index ZSET key for a newsgroup.
func usenetGroupKey(group string) string { return keyUsenetByStartBase + group }

// WarmUsenetCache loads all approved Usenet messages from PostgreSQL into Redis if
// not already present. The HASH doubles as the warm/membership marker.
func WarmUsenetCache(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error {
	n, err := rdb.HLen(ctx, keyUsenetItems).Result()
	if err == nil && n > 0 {
		logger.Info("usenet cache already warm", "items", n)
		return nil
	}

	logger.Info("warming usenet cache from database…")
	items, err := db.AllUsenetItems(ctx, pool)
	if err != nil {
		return fmt.Errorf("load usenet items: %w", err)
	}

	pipe := rdb.Pipeline()
	count := 0
	for _, it := range items {
		data, err := json.Marshal(it)
		if err != nil {
			continue
		}
		id := strconv.Itoa(it.ID)
		pipe.HSet(ctx, keyUsenetItems, id, data)
		pipe.ZAdd(ctx, usenetGroupKey(it.Newsgroup), goredis.Z{
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

	logger.Info("usenet cache warm", "items", len(items))
	return nil
}

// UpsertUsenet stores a single Usenet message, overwriting any existing entry.
// Used by the NOTIFY listener to apply INSERT/UPDATE events incrementally.
func UpsertUsenet(ctx context.Context, rdb *goredis.Client, it model.UsenetItem) error {
	data, err := json.Marshal(it)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	id := strconv.Itoa(it.ID)
	pipe := rdb.Pipeline()
	pipe.HSet(ctx, keyUsenetItems, id, data)
	pipe.ZAdd(ctx, usenetGroupKey(it.Newsgroup), goredis.Z{
		Score:  float64(it.StartDate.Unix()),
		Member: id,
	})
	_, err = pipe.Exec(ctx)
	return err
}

// ForgetUsenet removes a message from the cache. The per-group ZSET it belongs to
// is read back from the stored JSON (the DELETE notification carries only an id),
// then the HASH entry is dropped.
func ForgetUsenet(ctx context.Context, rdb *goredis.Client, id int) error {
	sid := strconv.Itoa(id)
	if raw, err := rdb.HGet(ctx, keyUsenetItems, sid).Result(); err == nil {
		var it model.UsenetItem
		if json.Unmarshal([]byte(raw), &it) == nil && it.Newsgroup != "" {
			rdb.ZRem(ctx, usenetGroupKey(it.Newsgroup), sid)
		}
	}
	return rdb.HDel(ctx, keyUsenetItems, sid).Err()
}

// UsenetItemsAt returns messages in a single newsgroup whose start_date Unix-second
// exactly equals t.Unix(). Used for the single-second boundary snapshot and tests.
func UsenetItemsAt(ctx context.Context, rdb *goredis.Client, group string, t time.Time) ([]model.UsenetItem, error) {
	sec := strconv.FormatInt(t.Unix(), 10)
	ids, err := rdb.ZRangeByScore(ctx, usenetGroupKey(group), &goredis.ZRangeBy{Min: sec, Max: sec}).Result()
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	return fetchUsenetByIDs(ctx, rdb, ids)
}

// UsenetItemsInRange returns messages in a single newsgroup whose start_date
// Unix-second is in the half-open interval [lo, hi). Used by the windowing refill
// path; the client reveal-gates them by its virtual clock.
func UsenetItemsInRange(ctx context.Context, rdb *goredis.Client, group string, lo, hi time.Time) ([]model.UsenetItem, error) {
	ids, err := rdb.ZRangeByScore(ctx, usenetGroupKey(group), &goredis.ZRangeBy{
		Min: strconv.FormatInt(lo.Unix(), 10),
		Max: "(" + strconv.FormatInt(hi.Unix(), 10), // exclusive upper bound
	}).Result()
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	return fetchUsenetByIDs(ctx, rdb, ids)
}

func fetchUsenetByIDs(ctx context.Context, rdb *goredis.Client, ids []string) ([]model.UsenetItem, error) {
	vals, err := rdb.HMGet(ctx, keyUsenetItems, ids...).Result()
	if err != nil {
		return nil, err
	}
	items := make([]model.UsenetItem, 0, len(vals))
	for _, v := range vals {
		if v == nil {
			continue
		}
		var it model.UsenetItem
		if err := json.Unmarshal([]byte(v.(string)), &it); err == nil {
			items = append(items, it)
		}
	}
	return items, nil
}
