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
