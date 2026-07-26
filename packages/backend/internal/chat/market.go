package chat

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Reach describes who could receive a broadcast source in 2001.
//
// It classifies PROGRAMMING, not transmitters. A network affiliate is a local
// transmitter, but on September 11 it carried its network's national feed all
// day -- someone watching CBS in Ohio saw substantially what a Washington
// viewer watching WUSA saw. Calling that "Washington only" would claim a
// distinction the tape does not contain.
//
// So ReachLocal is for sources whose CONTENT was local: on this corpus that is
// the New York news radio, which had its own newsroom and no national feed.
const (
	ReachLocal         = "local"
	ReachNational      = "national"
	ReachInternational = "international"
	// ReachOutbound is US international broadcasting -- WORLDNET, the USIA
	// service. It was produced in the United States for foreign audiences and
	// barred from domestic broadcast by the Smith-Mundt Act, so no American
	// could have been watching it. Every profile in this product is US-based,
	// so it currently reaches nobody; a non-US buddy would need a country
	// dimension alongside market, which is the extension point if one is added.
	ReachOutbound = "outbound"
)

// BroadcastSource is one classified signal. TV sources carry a ChannelID
// (chat_transcript_segments.channel); radio sources carry a Slug
// (chat_transcript_segments.channel_slug), because radio has no tv_channels row.
type BroadcastSource struct {
	ChannelID *int
	Slug      string
	Name      string
	Reach     string
	Market    string
}

// BroadcastFilter restricts a transcript query to particular sources.
//
// A nil *BroadcastFilter means unfiltered. A non-nil filter with empty slices
// means nothing matches — the distinction is load-bearing, because collapsing
// "allow nothing" into "allow everything" is how an omission becomes a leak.
type BroadcastFilter struct {
	ChannelIDs []int
	Slugs      []string
}

// AllowedFor returns the sources a buddy in the given market could receive:
// everything national or international, plus locals from their own market.
//
// With no classification at all it returns nil — unfiltered. That is the case
// where the boot-time load failed or the columns are not yet populated, and
// muting every buddy's broadcast tier because a config query failed would be a
// far worse outcome than a buddy hearing a station slightly out of range. Once
// any classification exists the filter is applied as computed, even if it
// permits nothing: past that point silence is a curation answer, not an
// accident.
//
// An unclassified source inside a populated set is carried rather than dropped,
// so adding a channel cannot silently make it inaudible; LoadBroadcastSources
// logs those gaps at boot instead.
func AllowedFor(sources []BroadcastSource, market string) *BroadcastFilter {
	if len(sources) == 0 {
		return nil
	}
	f := &BroadcastFilter{}
	for _, s := range sources {
		if s.Reach == ReachOutbound {
			continue
		}
		if s.Reach == ReachLocal && s.Market != market {
			continue
		}
		switch {
		case s.ChannelID != nil:
			f.ChannelIDs = append(f.ChannelIDs, *s.ChannelID)
		case s.Slug != "":
			f.Slugs = append(f.Slugs, s.Slug)
		}
	}
	return f
}

// UnclassifiedNames lists sources with no reach set, for a boot-time warning.
func UnclassifiedNames(sources []BroadcastSource) []string {
	var out []string
	for _, s := range sources {
		if s.Reach == "" {
			out = append(out, s.Name)
		}
	}
	return out
}

// broadcastSourceSelect unions the two shapes a transcript row can reference:
// a tv_channels row by id, or an mp3_items row by the synthetic "mp3:<id>" slug
// the ingest writes. Both hang off sources, which is where the classification
// lives so one row covers a call sign on either medium.
const broadcastSourceSelect = `
	SELECT c.id, NULL::text AS slug, s.name, s.reach, s.market
	FROM tv_channels c JOIN sources s ON s.id = c.source
	UNION ALL
	SELECT NULL::int, 'mp3:' || m.id, s.name, s.reach, s.market
	FROM mp3_items m JOIN sources s ON s.id = m.source`

func LoadBroadcastSources(ctx context.Context, pool *pgxpool.Pool) ([]BroadcastSource, error) {
	rows, err := pool.Query(ctx, broadcastSourceSelect)
	if err != nil {
		return nil, fmt.Errorf("query broadcast sources: %w", err)
	}
	defer rows.Close()

	var out []BroadcastSource
	for rows.Next() {
		var (
			b                   BroadcastSource
			slug, reach, market *string
		)
		if err := rows.Scan(&b.ChannelID, &slug, &b.Name, &reach, &market); err != nil {
			return nil, fmt.Errorf("scan broadcast source: %w", err)
		}
		b.Slug = derefStr(slug)
		b.Reach = derefStr(reach)
		b.Market = derefStr(market)
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate broadcast sources: %w", err)
	}
	return out, nil
}
