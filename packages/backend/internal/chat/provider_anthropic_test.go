package chat

import "testing"

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
