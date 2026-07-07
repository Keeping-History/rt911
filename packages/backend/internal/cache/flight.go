package cache

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"classicy/streamer/internal/model"

	goredis "github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"
)

// Flight positions are per-minute samples, so they are cached as one value per
// minute (a msgpack-encoded []model.FlightPosition) instead of one entry per
// row: at ~3.5M rows, per-entry Redis overhead (~200 B of dictEntry/SDS/score
// bookkeeping per HASH+ZSET pair) would cost ~1 GB for ~100-byte payloads,
// while ~13k minute buckets cost ~350 MB total. Minutes form a regular grid,
// so a range lookup computes its keys arithmetically — no ZSET at all.
//
// There is no Upsert/Forget/NOTIFY path: flight data is immutable bulk data
// loaded via COPY (which bypasses row triggers anyway). After a flight-recon
// re-load, rewarm with `DEL flight:minutes` + a streamer restart.
const keyFlightMinutes = "flight:minutes" // HASH  unix-minute epoch → msgpack []FlightPosition

// minuteKey returns the HASH field for the minute containing t.
func minuteKey(t time.Time) string {
	return strconv.FormatInt(t.Truncate(time.Minute).Unix(), 10)
}

// Bucket values use msgpack with the json struct tags — the same encoding the
// wire uses (see session.encodeMsg) — so cache and wire never disagree on field
// names, and buckets stay ~30% smaller than JSON.
func encodeFlightBucket(items []model.FlightPosition) ([]byte, error) {
	var buf bytes.Buffer
	enc := msgpack.NewEncoder(&buf)
	enc.SetCustomStructTag("json")
	if err := enc.Encode(items); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func decodeFlightBucket(data []byte) ([]model.FlightPosition, error) {
	var items []model.FlightPosition
	dec := msgpack.NewDecoder(bytes.NewReader(data))
	dec.SetCustomStructTag("json")
	if err := dec.Decode(&items); err != nil {
		return nil, err
	}
	return items, nil
}

// PutFlightBucket stores the positions for one minute, replacing any existing
// bucket. The warm path writes via its own pipeline; this single-key variant
// exists for tests and one-off repairs.
func PutFlightBucket(ctx context.Context, rdb *goredis.Client, minute time.Time, items []model.FlightPosition) error {
	data, err := encodeFlightBucket(items)
	if err != nil {
		return fmt.Errorf("encode flight bucket: %w", err)
	}
	return rdb.HSet(ctx, keyFlightMinutes, minuteKey(minute), data).Err()
}

// FlightPositionsInRange returns flight positions whose start_date is in the
// half-open interval [lo, hi). Bucket keys are computed arithmetically (one per
// minute touching the range) and fetched in a single HMGET; items in the
// boundary buckets are filtered so the contract matches the other channels'
// *ItemsInRange exactly. Missing minutes are normal (nobody airborne, or
// outside the loaded data range). A bucket that fails to decode is logged and
// skipped — one corrupt bucket loses ≤1 minute of data, not the window; the
// logger parameter (absent from the sibling *ItemsInRange helpers) exists for
// exactly that partial-failure report.
func FlightPositionsInRange(ctx context.Context, rdb *goredis.Client, lo, hi time.Time, logger *slog.Logger) ([]model.FlightPosition, error) {
	if !hi.After(lo) {
		return nil, nil
	}
	fields := make([]string, 0, int(hi.Sub(lo)/time.Minute)+2)
	for m := lo.Truncate(time.Minute); m.Before(hi); m = m.Add(time.Minute) {
		fields = append(fields, minuteKey(m))
	}
	vals, err := rdb.HMGet(ctx, keyFlightMinutes, fields...).Result()
	if err != nil {
		return nil, err
	}
	var out []model.FlightPosition
	for i, v := range vals {
		if v == nil {
			continue
		}
		items, err := decodeFlightBucket([]byte(v.(string)))
		if err != nil {
			logger.Warn("flight bucket decode failed", "minute", fields[i], "error", err)
			continue
		}
		for _, it := range items {
			if !it.StartDate.Before(lo) && it.StartDate.Before(hi) {
				out = append(out, it)
			}
		}
	}
	return out, nil
}
