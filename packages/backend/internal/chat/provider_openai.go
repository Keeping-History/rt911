package chat

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/openai/openai-go"
	"github.com/openai/openai-go/option"
	"github.com/openai/openai-go/shared"
)

// openAICompatProvider adapts Request/Reply to openai-go's Chat Completions
// API. It serves both OpenAI and OpenRouter, since OpenRouter speaks the same
// chat-completions API at a different base URL — it is deliberately the only
// place in this package that imports the SDK for either vendor.
type openAICompatProvider struct {
	client openai.Client
	name   string
	logger *slog.Logger
}

// NewOpenAICompatProvider builds a Provider backed by any OpenAI-compatible
// chat-completions endpoint. name is what Generate reports from Name() and is
// what ends up in chat_messages.model and the logs — passing it explicitly
// (rather than hardcoding "openai") is what keeps the two vendors this
// adapter serves distinguishable after the fact. baseURL is left empty to
// take the SDK's own OpenAI default; a non-empty value points at OpenRouter
// or any other compatible endpoint.
func NewOpenAICompatProvider(apiKey, baseURL, name string, logger *slog.Logger) Provider {
	opts := []option.RequestOption{option.WithAPIKey(apiKey)}
	if baseURL != "" {
		opts = append(opts, option.WithBaseURL(baseURL))
	}
	return &openAICompatProvider{
		client: openai.NewClient(opts...),
		name:   name,
		logger: logger,
	}
}

func (p *openAICompatProvider) Name() string {
	return p.name
}

// Generate applies Temperature — the deliberate asymmetry with the Anthropic
// adapter, which must drop it because Opus 5 returns HTTP 400. On OpenAI and
// OpenRouter it is a genuine second per-message variance lever.
//
// No explicit cache markers are set: these endpoints cache prefixes
// automatically above roughly 1024 tokens, driven purely by the message order
// openAIMessages already preserves.
func (p *openAICompatProvider) Generate(ctx context.Context, r Request) (Reply, error) {
	params := openai.ChatCompletionNewParams{
		Model:    r.Model,
		Messages: toSDKMessages(openAIMessages(r.Segments)),
	}
	if r.MaxTokens > 0 {
		params.MaxCompletionTokens = openai.Int(int64(r.MaxTokens))
	}
	if r.Temperature != nil {
		params.Temperature = openai.Float(*r.Temperature)
	}
	// reasoning_effort is only meaningful on reasoning models; sending it to a
	// non-reasoning model is a request the API rejects, so it is dropped rather
	// than sent unconditionally. Dropping it is silent to the caller by design
	// (Reply carries no room for a warning), so an operator who configured an
	// effort that never gets sent needs the debug log to find out.
	if r.Effort != "" {
		if isReasoningModel(r.Model) {
			params.ReasoningEffort = shared.ReasoningEffort(r.Effort)
		} else {
			p.logger.Debug("openai effort dropped: not a reasoning model",
				"provider", p.name, "model", r.Model, "effort", r.Effort)
		}
	}

	completion, err := p.client.Chat.Completions.New(ctx, params)
	if err != nil {
		p.logger.Error("openai generate failed", "provider", p.name, "model", r.Model, "error", err)
		return Reply{Outcome: OutcomeError, Model: r.Model}, fmt.Errorf("%s generate: %w", p.name, err)
	}

	if len(completion.Choices) == 0 {
		p.logger.Error("openai generate returned no choices", "provider", p.name, "model", r.Model)
		return Reply{Outcome: OutcomeError, Model: completion.Model}, fmt.Errorf("%s generate: no choices returned", p.name)
	}
	choice := completion.Choices[0]

	// content_filter is a policy decline delivered as a normal HTTP 200; length
	// means the reply was cut off mid-thought but is still worth showing.
	outcome := OutcomeOK
	// A GPT model usually declines conversationally -- finish_reason "stop"
	// with the refusal in the text -- and only sets this field for structured
	// refusals. Checking it means a decline is reported as one instead of being
	// delivered to a student as the buddy's own words.
	if choice.Message.Refusal != "" {
		outcome = OutcomeRefused
	}
	switch choice.FinishReason {
	case "content_filter":
		outcome = OutcomeRefused
	case "length":
		outcome = OutcomeTruncated
	}

	if outcome == OutcomeRefused {
		p.logger.Info("openai refused", "provider", p.name, "model", completion.Model)
		return Reply{Outcome: OutcomeRefused, Model: completion.Model}, nil
	}

	return Reply{
		Body:      choice.Message.Content,
		Outcome:   outcome,
		TokensIn:  int(completion.Usage.PromptTokens),
		TokensOut: int(completion.Usage.CompletionTokens),
		CachedIn:  int(completion.Usage.PromptTokensDetails.CachedTokens),
		Model:     completion.Model,
	}, nil
}

// isReasoningModel is a name-based heuristic: this SDK version's ChatModel is
// a plain string alias with no reasoning-vs-standard distinction encoded in
// the type system, and the API — not the SDK — is what rejects
// reasoning_effort on a non-reasoning model. o-series and gpt-5-family models
// are the reasoning families as of this writing.
//
// OpenRouter model ids are conventionally vendor-prefixed (e.g.
// "openai/o3-mini"), so the prefix match runs against the segment after the
// final "/" rather than the whole string — otherwise every OpenRouter
// reasoning model would silently fail to match.
func isReasoningModel(model string) bool {
	if i := strings.LastIndex(model, "/"); i >= 0 {
		model = model[i+1:]
	}
	for _, prefix := range []string{"o1", "o3", "o4", "gpt-5"} {
		if strings.HasPrefix(model, prefix) {
			return true
		}
	}
	return false
}

// openAIMessage is openAIMessages' output shape: a role/content pair plain
// enough for callers and tests to read without reaching into the SDK's
// content union.
type openAIMessage struct {
	Role    string
	Content string
}

// openAIMessages renders composed segments in order, system first. Prefix
// caching on OpenAI-compatible endpoints is automatic and depends entirely on
// this order being preserved end to end.
func openAIMessages(segs []PromptSegment) []openAIMessage {
	msgs := make([]openAIMessage, 0, len(segs))
	for _, seg := range segs {
		msgs = append(msgs, openAIMessage{Role: seg.Role, Content: seg.Text})
	}
	return msgs
}

// toSDKMessages converts openAIMessages' vendor-neutral shape to the SDK's
// param union at the last possible moment, per the SDK's own guidance for
// these helpers.
func toSDKMessages(msgs []openAIMessage) []openai.ChatCompletionMessageParamUnion {
	out := make([]openai.ChatCompletionMessageParamUnion, 0, len(msgs))
	for _, m := range msgs {
		if m.Role == "system" {
			out = append(out, openai.SystemMessage(m.Content))
			continue
		}
		out = append(out, openai.UserMessage(m.Content))
	}
	return out
}
