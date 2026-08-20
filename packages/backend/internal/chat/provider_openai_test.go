package chat

import (
	"log/slog"
	"testing"
)

func TestOpenAIProviderReportsItsConfiguredName(t *testing.T) {
	// One adapter serves two vendors; the name is what lands in chat_messages
	// and in the logs, so it must reflect the configured vendor rather than
	// the adapter's implementation.
	p := NewOpenAICompatProvider("k", "https://openrouter.ai/api/v1", "openrouter", slog.Default())
	if p.Name() != "openrouter" {
		t.Errorf("Name() = %q, want openrouter", p.Name())
	}
}

func TestSegmentsRenderInOrderWithSystemFirst(t *testing.T) {
	msgs := openAIMessages([]PromptSegment{
		{Stability: StabilityStable, Role: "system", Text: "you are danny"},
		{Stability: StabilityAppendOnly, Role: "user", Text: "what you know"},
		{Stability: StabilityVolatile, Role: "user", Text: "it is 8:47"},
	})

	if len(msgs) != 3 {
		t.Fatalf("got %d messages, want 3", len(msgs))
	}
	// Prefix caching on OpenAI-compatible endpoints is automatic and depends
	// entirely on this order being preserved.
	if msgs[0].Role != "system" || msgs[2].Content != "it is 8:47" {
		t.Errorf("segment order not preserved: %+v", msgs)
	}
}

func TestIsReasoningModelRecognisesBareAndVendorPrefixedIDs(t *testing.T) {
	// OpenRouter namespaces model ids by upstream vendor (e.g. "openai/o3-mini"),
	// so the bare name and the OpenRouter-prefixed name must both be recognised —
	// this is the one adapter's two vendors, in miniature.
	cases := []struct {
		model string
		want  bool
	}{
		{"o3-mini", true},
		{"gpt-5", true},
		{"openai/o3-mini", true},
		{"openai/gpt-5-mini", true},
		{"gpt-4o", false},
		{"", false},
	}
	for _, c := range cases {
		if got := isReasoningModel(c.model); got != c.want {
			t.Errorf("isReasoningModel(%q) = %v, want %v", c.model, got, c.want)
		}
	}
}
