package chat

import "testing"

func TestShippedDefaultsMatchTheSpec(t *testing.T) {
	if ShippedDefaults.Provider != "anthropic" || ShippedDefaults.Model != "claude-opus-5" {
		t.Errorf("provider/model drifted: %+v", ShippedDefaults)
	}
	if ShippedDefaults.MaxTokens != 2000 {
		t.Errorf("max_tokens must be 2000, got %d", ShippedDefaults.MaxTokens)
	}
	if ShippedDefaults.Effort != "low" {
		t.Errorf("effort must be low, got %q", ShippedDefaults.Effort)
	}
	if ShippedDefaults.Temperature != nil {
		t.Errorf("temperature must default to unset, got %v", *ShippedDefaults.Temperature)
	}
}

func TestMergePrefersProfileOverGlobal(t *testing.T) {
	global := Settings{Provider: "anthropic", Model: "claude-opus-5", MaxTokens: 2000, Effort: "low"}
	model := "claude-haiku-4-5-20251001"
	tokens := 500

	got := global.Merge(Profile{Model: &model, MaxTokens: &tokens})

	if got.Model != model {
		t.Errorf("profile model ignored: %q", got.Model)
	}
	if got.MaxTokens != 500 {
		t.Errorf("profile max_tokens ignored: %d", got.MaxTokens)
	}
	if got.Provider != "anthropic" {
		t.Errorf("unset override must inherit, got %q", got.Provider)
	}
}

func TestMergeTreatsNilAsInheritNotAsZero(t *testing.T) {
	global := Settings{Provider: "openai", Model: "gpt-5", MaxTokens: 2000}

	got := global.Merge(Profile{})

	if got != global {
		t.Errorf("a profile with no overrides must be a no-op, got %+v", got)
	}
}
