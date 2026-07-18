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

// Alerts live in their own Redis keyspace, delivered on the opt-in "alerts" channel.
const (
	keyAlertItems   = "alert:items"    // HASH  id → JSON(AlertItem)
	keyAlertByStart = "alert:by_start" // ZSET  score=unix_start, member=id
)

// WarmAlertCache loads all approved alerts from Postgres into Redis if not present.
func WarmAlertCache(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error {
	n, err := rdb.ZCard(ctx, keyAlertByStart).Result()
	if err == nil && n > 0 {
		logger.Info("alert cache already warm", "items", n)
		return nil
	}

	logger.Info("warming alert cache from database…")
	items, err := db.AllAlertItems(ctx, pool)
	if err != nil {
		return fmt.Errorf("load alert items: %w", err)
	}

	pipe := rdb.Pipeline()
	count := 0
	for _, it := range items {
		data, err := json.Marshal(it)
		if err != nil {
			continue
		}
		id := strconv.Itoa(it.ID)
		pipe.HSet(ctx, keyAlertItems, id, data)
		pipe.ZAdd(ctx, keyAlertByStart, goredis.Z{Score: float64(it.StartDate.Unix()), Member: id})
		count++
		if pipe, err = flushIfFull(ctx, rdb, pipe, count); err != nil {
			return fmt.Errorf("pipeline exec: %w", err)
		}
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("pipeline exec: %w", err)
	}
	logger.Info("alert cache warm", "items", len(items))
	return nil
}

// UpsertAlert stores a single alert, overwriting any existing entry.
func UpsertAlert(ctx context.Context, rdb *goredis.Client, it model.AlertItem) error {
	data, err := json.Marshal(it)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	id := strconv.Itoa(it.ID)
	pipe := rdb.Pipeline()
	pipe.HSet(ctx, keyAlertItems, id, data)
	pipe.ZAdd(ctx, keyAlertByStart, goredis.Z{Score: float64(it.StartDate.Unix()), Member: id})
	_, err = pipe.Exec(ctx)
	return err
}

// ForgetAlert removes an alert from the cache.
func ForgetAlert(ctx context.Context, rdb *goredis.Client, id int) error {
	sid := strconv.Itoa(id)
	pipe := rdb.Pipeline()
	pipe.HDel(ctx, keyAlertItems, sid)
	pipe.ZRem(ctx, keyAlertByStart, sid)
	_, err := pipe.Exec(ctx)
	return err
}

// AlertItemsAt returns alerts whose start_date Unix-second exactly equals t.Unix().
func AlertItemsAt(ctx context.Context, rdb *goredis.Client, t time.Time) ([]model.AlertItem, error) {
	lo := strconv.FormatInt(t.Unix(), 10)
	ids, err := rdb.ZRangeByScore(ctx, keyAlertByStart, &goredis.ZRangeBy{Min: lo, Max: lo}).Result()
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	return fetchAlertsByIDs(ctx, rdb, ids)
}

// AlertItemsInRange returns alerts whose start_date Unix-second is in [lo, hi).
func AlertItemsInRange(ctx context.Context, rdb *goredis.Client, lo, hi time.Time) ([]model.AlertItem, error) {
	ids, err := rdb.ZRangeByScore(ctx, keyAlertByStart, &goredis.ZRangeBy{
		Min: strconv.FormatInt(lo.Unix(), 10),
		Max: "(" + strconv.FormatInt(hi.Unix(), 10),
	}).Result()
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	return fetchAlertsByIDs(ctx, rdb, ids)
}

func fetchAlertsByIDs(ctx context.Context, rdb *goredis.Client, ids []string) ([]model.AlertItem, error) {
	vals, err := rdb.HMGet(ctx, keyAlertItems, ids...).Result()
	if err != nil {
		return nil, err
	}
	items := make([]model.AlertItem, 0, len(vals))
	for _, v := range vals {
		if v == nil {
			continue
		}
		var it model.AlertItem
		if err := json.Unmarshal([]byte(v.(string)), &it); err == nil {
			items = append(items, it)
		}
	}
	return items, nil
}
