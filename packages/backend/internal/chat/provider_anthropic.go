package chat

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
	"github.com/anthropics/anthropic-sdk-go/shared/constant"
)

// anthropicProvider adapts Request/Reply to anthropic-sdk-go's beta Messages
// API. It is deliberately the only place in this package that imports the SDK.
type anthropicProvider struct {
	client *anthropic.Client
	logger *slog.Logger
}

// NewAnthropicProvider builds a Provider backed by the Anthropic API. The SDK
// client reads no other configuration from the environment here — the key is
// passed explicitly so callers (and tests) control it.
func NewAnthropicProvider(apiKey string, logger *slog.Logger) Provider {
	client := anthropic.NewClient(option.WithAPIKey(apiKey))
	return &anthropicProvider{client: &client, logger: logger}
}

func (p *anthropicProvider) Name() string {
	return "anthropic"
}

// Generate never sets thinking:{type:"disabled"} — on Opus 5 that can leak
// <thinking> tags into the visible reply, which in this product means a buddy
// typing <thinking> into an IM window. output_config.effort is the intended
// dial instead.
//
// Temperature is dropped entirely: Opus 5 returns HTTP 400 if it is present.
// The field stays on Request only for the OpenAI-compatible adapter.
func (p *anthropicProvider) Generate(ctx context.Context, r Request) (Reply, error) {
	system, messages := renderSegments(r.Segments)

	params := anthropic.BetaMessageNewParams{
		Model:     anthropic.Model(r.Model),
		MaxTokens: int64(r.MaxTokens),
		System:    system,
		Messages:  messages,
		OutputConfig: anthropic.BetaOutputConfigParam{
			Effort: anthropic.BetaOutputConfigEffort(r.Effort),
		},
		// "default" lets a false-positive decline recover server-side rather
		// than surfacing as a dead buddy. Server-side fallbacks require the
		// beta endpoint, hence client.Beta.Messages.New below.
		Fallbacks: anthropic.BetaFallbacksParamUnion{
			OfDefault: constant.ValueOf[constant.Default](),
		},
		Betas: []anthropic.AnthropicBeta{anthropic.AnthropicBetaServerSideFallback2026_07_01},
	}

	msg, err := p.client.Beta.Messages.New(ctx, params)
	if err != nil {
		p.logger.Error("anthropic generate failed", "model", r.Model, "error", err)
		return Reply{Outcome: OutcomeError, Model: r.Model}, fmt.Errorf("anthropic generate: %w", err)
	}

	// A policy decline is HTTP 200 with empty or partial content. Checking
	// stop_reason before reading content is what keeps a refusal from reading
	// as a confusing empty reply instead of a clean OutcomeRefused.
	if msg.StopReason == anthropic.BetaStopReasonRefusal {
		p.logger.Info("anthropic refused", "model", string(msg.Model))
		return Reply{Outcome: OutcomeRefused, Model: string(msg.Model)}, nil
	}

	outcome := OutcomeOK
	if msg.StopReason == anthropic.BetaStopReasonMaxTokens {
		outcome = OutcomeTruncated
	}

	return Reply{
		Body:      textOf(msg.Content),
		Outcome:   outcome,
		TokensIn:  int(msg.Usage.InputTokens),
		TokensOut: int(msg.Usage.OutputTokens),
		CachedIn:  int(msg.Usage.CacheReadInputTokens),
		Model:     string(msg.Model),
	}, nil
}

// textOf concatenates every text block in the response. Non-text blocks
// (there are none in this product's tool-free requests) are silently skipped
// rather than erroring, since a partial reply is still worth delivering.
func textOf(blocks []anthropic.BetaContentBlockUnion) string {
	var body string
	for _, b := range blocks {
		if b.Type == "text" {
			body += b.Text
		}
	}
	return body
}

// renderSegments splits composed segments into the system prompt and the
// conversation, and stamps cache_control at each cacheBreakpoints index.
// System segments and conversation segments are interleaved in Segments, but
// the SDK carries them in two separate fields — the breakpoint index refers
// to a position in the original combined slice either way.
func renderSegments(segs []PromptSegment) ([]anthropic.BetaTextBlockParam, []anthropic.BetaMessageParam) {
	breaks := make(map[int]bool)
	for _, i := range cacheBreakpoints(segs) {
		breaks[i] = true
	}

	var system []anthropic.BetaTextBlockParam
	var messages []anthropic.BetaMessageParam
	for i, seg := range segs {
		if seg.Role == "system" {
			block := anthropic.BetaTextBlockParam{Text: seg.Text}
			if breaks[i] {
				block.CacheControl = ephemeralCacheControl
			}
			system = append(system, block)
			continue
		}

		block := anthropic.NewBetaTextBlock(seg.Text)
		if breaks[i] {
			block.OfText.CacheControl = ephemeralCacheControl
		}
		messages = append(messages, anthropic.NewBetaUserMessage(block))
	}
	return system, messages
}

var ephemeralCacheControl = anthropic.BetaCacheControlEphemeralParam{
	Type: constant.ValueOf[constant.Ephemeral](),
}
