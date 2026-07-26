package chat

import (
	"context"
	"fmt"
	"sort"
	"strings"

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
	// ReachPrivate is recorded audio that was never broadcast to anyone: air
	// traffic control, NEADS/NORAD, cockpit and emergency-line tapes. It is the
	// same provenance judgement that keeps these out of the transcript ingest --
	// no civilian could hear them on the day, so no buddy can have heard them --
	// stated a second time here so the classification explains itself rather
	// than leaving 17 sources looking like an uncurated gap.
	ReachPrivate = "private"
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
//
// watching optionally narrows the result to the source(s) this buddy actually
// had on -- a comma-separated list of source names. A person watched one
// channel, not twenty-two, and without this the "what you have just heard"
// block is a blend of CNN, NHK and Mexican network audio that no one saw.
//
// It only ever NARROWS. A name the buddy could not receive is ignored rather
// than honoured, so a curator typing WINS onto an Ohio profile cannot turn a
// mistake into a way to hear New York radio. If nothing watchable survives, the
// full receivable set is returned instead of silence -- a typo should not
// deafen a buddy -- and UnwatchableNames surfaces it at boot.
func AllowedFor(sources []BroadcastSource, market, watching string) *BroadcastFilter {
	if len(sources) == 0 {
		return nil
	}

	want := nameSet(watching)
	all, chosen := &BroadcastFilter{}, &BroadcastFilter{}
	for _, s := range sources {
		if s.Reach == ReachOutbound || s.Reach == ReachPrivate {
			continue
		}
		if s.Reach == ReachLocal && s.Market != market {
			continue
		}
		add(all, s)
		if _, ok := want[s.Name]; ok {
			add(chosen, s)
		}
	}

	if len(want) > 0 && (len(chosen.ChannelIDs) > 0 || len(chosen.Slugs) > 0) {
		return chosen
	}
	return all
}

func add(f *BroadcastFilter, s BroadcastSource) {
	switch {
	case s.ChannelID != nil:
		f.ChannelIDs = append(f.ChannelIDs, *s.ChannelID)
	case s.Slug != "":
		f.Slugs = append(f.Slugs, s.Slug)
	}
}

func nameSet(csv string) map[string]struct{} {
	out := map[string]struct{}{}
	for _, n := range strings.Split(csv, ",") {
		if n = strings.TrimSpace(n); n != "" {
			out[n] = struct{}{}
		}
	}
	return out
}

// UnwatchableNames reports profiles whose `watching` names nothing they could
// actually receive -- a misspelling, or a source outside their market. These
// buddies silently fall back to everything receivable, so the mistake is
// invisible in behaviour and needs saying out loud at boot.
func UnwatchableNames(sources []BroadcastSource, profiles []Profile) []string {
	var out []string
	for _, p := range profiles {
		want := nameSet(p.Watching)
		if len(want) == 0 {
			continue
		}
		f := AllowedFor(sources, p.Market, p.Watching)
		if f != nil && len(f.ChannelIDs) == 0 && len(f.Slugs) == 0 {
			out = append(out, p.ScreenName+": "+p.Watching)
			continue
		}
		// A narrowed filter means at least one name resolved; report the ones
		// that did not, so a two-name value with one typo still gets flagged.
		for name := range want {
			if !receivable(sources, p.Market, name) {
				out = append(out, p.ScreenName+": "+name)
			}
		}
	}
	sort.Strings(out)
	return out
}

func receivable(sources []BroadcastSource, market, name string) bool {
	for _, s := range sources {
		if s.Name != name {
			continue
		}
		if s.Reach == ReachOutbound || s.Reach == ReachPrivate {
			continue
		}
		if s.Reach == ReachLocal && s.Market != market {
			continue
		}
		return true
	}
	return false
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
