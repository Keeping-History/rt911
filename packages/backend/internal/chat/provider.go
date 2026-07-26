package chat

import (
	"context"
)

// Outcome classifies how a generation ended. Written verbatim to
// chat_messages.moderation and read by the dev harness — the string values
// are a wire contract, not an implementation detail.
type Outcome string

const (
	OutcomeOK        Outcome = "ok"
	OutcomeRefused   Outcome = "refused"
	OutcomeTruncated Outcome = "truncated"
	OutcomeError     Outcome = "error"
)

// Request is a vendor-neutral generation request. It deliberately does not
// embed Settings: Settings resolves *configuration* (which provider, which
// model), while Request is what a specific call to a specific provider needs.
// Coupling the two would force every adapter to understand fields (like
// OpenAIBaseURL) that only matter to one of them.
type Request struct {
	Segments    []PromptSegment
	Model       string
	MaxTokens   int
	Effort      string
	Temperature *float64
}

// Reply is a vendor-neutral generation result.
type Reply struct {
	Body      string
	Outcome   Outcome
	TokensIn  int
	TokensOut int
	CachedIn  int
	Model     string
}

// Provider is implemented once per vendor. Generate must return a non-nil
// error alongside Reply{Outcome: OutcomeError} on transport failure, so
// callers can distinguish an outage from a clean model refusal.
type Provider interface {
	Name() string
	Generate(ctx context.Context, r Request) (Reply, error)
}

// cacheBreakpoints returns the indices that should carry a cache_control marker:
// the last segment of each non-volatile stability run. Anthropic permits four
// per request; volatile segments are never marked because they differ every turn
// and would pay the 1.25x write premium for a guaranteed miss.
func cacheBreakpoints(segs []PromptSegment) []int {
	var out []int
	for i, s := range segs {
		if s.Stability == StabilityVolatile {
			continue
		}
		if i+1 == len(segs) || segs[i+1].Stability != s.Stability {
			out = append(out, i)
		}
	}
	if len(out) > 4 {
		out = out[len(out)-4:]
	}
	return out
}
