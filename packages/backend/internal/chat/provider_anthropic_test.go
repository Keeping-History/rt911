package chat

import (
	"testing"

	"github.com/anthropics/anthropic-sdk-go"
)

func TestAnthropicParamsOmitsEffortWhenUnset(t *testing.T) {
	// chat_settings.effort is NULL and no profile override applies whenever
	// r.Effort is "". Sending output_config.effort anyway is what the OpenAI
	// adapter already guards against for reasoning_effort; this is the same
	// guard for the Anthropic adapter.
	params := anthropicParams(Request{Model: "claude-opus-5", MaxTokens: 100})
	if params.OutputConfig.Effort != "" {
		t.Errorf("OutputConfig.Effort = %q, want empty when Request.Effort is unset", params.OutputConfig.Effort)
	}
}

func TestAnthropicParamsSendsConfiguredEffort(t *testing.T) {
	params := anthropicParams(Request{Model: "claude-opus-5", MaxTokens: 100, Effort: "high"})
	if got := string(params.OutputConfig.Effort); got != "high" {
		t.Errorf("OutputConfig.Effort = %q, want \"high\"", got)
	}
}

func TestAnthropicParamsOmitsFallbacksOnModelsThatRejectThem(t *testing.T) {
	// Prod outage 2026-07-30: chat_settings.model was changed to
	// claude-sonnet-5 and every generation began failing with
	// 400 "'claude-sonnet-5' does not support the `fallbacks` parameter",
	// which the student sees as the canned stall line from every buddy.
	//
	// fallbacks is a per-model capability, so sending it unconditionally turns
	// an ordinary Directus config change into a total chat outage. Unknown and
	// unsupporting models must simply go without it.
	params := anthropicParams(Request{Model: "claude-sonnet-5", MaxTokens: 100})

	if params.Fallbacks.OfDefault != "" {
		t.Error("Fallbacks must be omitted for a model that rejects the parameter")
	}
	for _, b := range params.Betas {
		if b == anthropic.AnthropicBetaServerSideFallback2026_07_01 {
			t.Error("the server-side-fallback beta must not be sent to a model that rejects fallbacks")
		}
	}
}

func TestAnthropicParamsSendsFallbacksOnModelsThatSupportThem(t *testing.T) {
	// The resilience this buys is real -- a false-positive safety decline
	// recovers server-side instead of surfacing as a dead buddy -- so the guard
	// must not throw it away on the models that do support it.
	params := anthropicParams(Request{Model: "claude-opus-5", MaxTokens: 100})

	if params.Fallbacks.OfDefault == "" {
		t.Error("Fallbacks must be sent for claude-opus-5, which supports them")
	}
	var found bool
	for _, b := range params.Betas {
		if b == anthropic.AnthropicBetaServerSideFallback2026_07_01 {
			found = true
		}
	}
	if !found {
		t.Error("the server-side-fallback beta must accompany the fallbacks parameter")
	}
}

func TestUnknownModelsDoNotGetFallbacks(t *testing.T) {
	// Fail safe on the "we have not heard of this model" path: a model that
	// gains fallback support later merely misses out on server-side recovery
	// until it is listed, which is a degradation. Guessing the other way is an
	// outage, which is exactly what happened.
	for _, model := range []string{"claude-haiku-4-5", "claude-sonnet-4-6", "some-future-model"} {
		if anthropicParams(Request{Model: model, MaxTokens: 100}).Fallbacks.OfDefault != "" {
			t.Errorf("%s: unknown/unsupporting models must default to no fallbacks", model)
		}
	}
}
