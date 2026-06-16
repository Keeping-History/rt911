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

// mp3 items reuse the MediaItem shape but live in their own Redis keyspace,
// separate from media:* and pager:*, so the default media tick path never
// scans them — they ride the opt-in "mp3" channel instead.
const (
	keyMp3Items   = "mp3:items"    // HASH  id → JSON
	keyMp3ByStart = "mp3:by_start" // ZSET  score=unix_start, member=id
)

// WarmMp3Cache loads all approved mp3 items from PostgreSQL into Redis if not
// already present.
func WarmMp3Cache(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error {
	n, err := rdb.ZCard(ctx, keyMp3ByStart).Result()
	if err == nil && n > 0 {
		logger.Info("mp3 cache already warm", "items", n)
		return nil
	}

	logger.Info("warming mp3 cache from database…")
	items, err := db.AllMp3Items(ctx, pool)
	if err != nil {
		return fmt.Errorf("load mp3 items: %w", err)
	}

	pipe := rdb.Pipeline()
	count := 0
	for _, it := range items {
		data, err := json.Marshal(it)
		if err != nil {
			continue
		}
		id := strconv.Itoa(it.ID)
		pipe.HSet(ctx, keyMp3Items, id, data)
		pipe.ZAdd(ctx, keyMp3ByStart, goredis.Z{
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

	logger.Info("mp3 cache warm", "items", len(items))
	return nil
}

// UpsertMp3 stores a single mp3 item in the cache, overwriting any existing
// entry. Used by the NOTIFY listener to apply INSERT/UPDATE events incrementally.
func UpsertMp3(ctx context.Context, rdb *goredis.Client, it model.MediaItem) error {
	data, err := json.Marshal(it)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	id := strconv.Itoa(it.ID)
	pipe := rdb.Pipeline()
	pipe.HSet(ctx, keyMp3Items, id, data)
	pipe.ZAdd(ctx, keyMp3ByStart, goredis.Z{
		Score:  float64(it.StartDate.Unix()),
		Member: id,
	})
	_, err = pipe.Exec(ctx)
	return err
}

// ForgetMp3 removes an mp3 item from the cache. Used by the NOTIFY listener to
// apply DELETE events and to evict rows whose approved flag flipped to 0.
func ForgetMp3(ctx context.Context, rdb *goredis.Client, id int) error {
	sid := strconv.Itoa(id)
	pipe := rdb.Pipeline()
	pipe.HDel(ctx, keyMp3Items, sid)
	pipe.ZRem(ctx, keyMp3ByStart, sid)
	_, err := pipe.Exec(ctx)
	return err
}

// Mp3ItemsAt returns mp3 items whose start_date Unix-second exactly equals
// t.Unix().
func Mp3ItemsAt(ctx context.Context, rdb *goredis.Client, t time.Time) ([]model.MediaItem, error) {
	lo := float64(t.Unix())
	hi := lo

	ids, err := rdb.ZRangeByScore(ctx, keyMp3ByStart, &goredis.ZRangeBy{
		Min: strconv.FormatFloat(lo, 'f', 0, 64),
		Max: strconv.FormatFloat(hi, 'f', 0, 64),
	}).Result()
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	return fetchMp3ByIDs(ctx, rdb, ids)
}

// Mp3ItemsInRange returns mp3 items whose start_date Unix-second is in the
// half-open interval [lo, hi). The windowing refill path queries forward windows
// with this; recordings already playing at the window's lower edge are covered by
// the init/seek/subscribe overlap snapshot (CurrentMp3Items), not here.
func Mp3ItemsInRange(ctx context.Context, rdb *goredis.Client, lo, hi time.Time) ([]model.MediaItem, error) {
	ids, err := rdb.ZRangeByScore(ctx, keyMp3ByStart, &goredis.ZRangeBy{
		Min: strconv.FormatInt(lo.Unix(), 10),
		Max: "(" + strconv.FormatInt(hi.Unix(), 10), // exclusive upper bound
	}).Result()
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	return fetchMp3ByIDs(ctx, rdb, ids)
}

func fetchMp3ByIDs(ctx context.Context, rdb *goredis.Client, ids []string) ([]model.MediaItem, error) {
	vals, err := rdb.HMGet(ctx, keyMp3Items, ids...).Result()
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
