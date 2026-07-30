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
	params := anthropicParams(r)

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

// anthropicParams builds the beta Messages request from a vendor-neutral
// Request. It is pure -- no client, no context -- so the one piece of
// judgment in it (whether output_config.effort gets sent at all) is testable
// without a network call.
func anthropicParams(r Request) anthropic.BetaMessageNewParams {
	system, messages := renderSegments(r.Segments)

	params := anthropic.BetaMessageNewParams{
		Model:     anthropic.Model(r.Model),
		MaxTokens: int64(r.MaxTokens),
		System:    system,
		Messages:  messages,
	}
	// "default" lets a false-positive decline recover server-side rather than
	// surfacing as a dead buddy. Server-side fallbacks require the beta
	// endpoint, hence client.Beta.Messages.New in Generate.
	//
	// Gated, because fallbacks is a per-model capability and a model that does
	// not have it rejects the WHOLE request with a 400. Sent unconditionally,
	// it meant a curator changing chat_settings.model in Directus — an ordinary
	// config edit, no deploy — took every buddy down at once, each one answering
	// with the canned stall line. That is what happened on 2026-07-30 when the
	// model was switched to claude-sonnet-5.
	if supportsServerSideFallback(r.Model) {
		params.Fallbacks = anthropic.BetaFallbacksParamUnion{
			OfDefault: constant.ValueOf[constant.Default](),
		}
		params.Betas = []anthropic.AnthropicBeta{anthropic.AnthropicBetaServerSideFallback2026_07_01}
	}
	// r.Effort is empty whenever chat_settings.effort is NULL and no profile
	// override applies; only set output_config.effort when there is an actual
	// value to send, the same guard the OpenAI adapter uses for
	// reasoning_effort.
	if r.Effort != "" {
		params.OutputConfig = anthropic.BetaOutputConfigParam{
			Effort: anthropic.BetaOutputConfigEffort(r.Effort),
		}
	}
	return params
}

// supportsServerSideFallback reports whether a model accepts the server-side
// `fallbacks` parameter.
//
// An allow-list rather than a deny-list, deliberately. The failure modes are not
// symmetric: omitting fallbacks from a model that supports them costs only
// server-side recovery from a false-positive safety decline, which the caller
// already handles as an ordinary error; sending them to a model that does not
// support them costs every single message. So an unrecognised model — including
// any released after this was written — gets no fallbacks and keeps working.
//
// Kept as an explicit list rather than read from /v1/models' allowed_fallback_models
// because that lookup would put a network call, and a new startup failure mode,
// in front of a feature whose entire purpose is resilience. Add a model here when
// it is verified to accept the parameter.
func supportsServerSideFallback(model string) bool {
	switch model {
	case "claude-opus-5", "claude-fable-5", "claude-mythos-5":
		return true
	default:
		return false
	}
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
//
// The SDK ships no NewBetaAssistantMessage helper (its assistant-side
// convenience is Message.ToParam, for echoing a response back), so an assistant
// turn is built from the param struct directly.
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
		role := anthropic.BetaMessageParamRoleUser
		if seg.Role == "assistant" {
			role = anthropic.BetaMessageParamRoleAssistant
		}
		messages = append(messages, anthropic.BetaMessageParam{
			Role:    role,
			Content: []anthropic.BetaContentBlockParamUnion{block},
		})
	}
	return system, messages
}

var ephemeralCacheControl = anthropic.BetaCacheControlEphemeralParam{
	Type: constant.ValueOf[constant.Ephemeral](),
}
