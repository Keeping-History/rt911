package cache

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestChangeNotificationParse(t *testing.T) {
	tests := []struct {
		payload string
		wantOp  string
		wantID  int
	}{
		{`{"op":"insert","id":1}`, "insert", 1},
		{`{"op":"update","id":42}`, "update", 42},
		{`{"op":"delete","id":999}`, "delete", 999},
	}
	for _, tc := range tests {
		var c changeNotification
		if err := json.Unmarshal([]byte(tc.payload), &c); err != nil {
			t.Errorf("unmarshal %q: %v", tc.payload, err)
			continue
		}
		if c.Op != tc.wantOp || c.ID != tc.wantID {
			t.Errorf("unmarshal %q: got %+v, want op=%s id=%d", tc.payload, c, tc.wantOp, tc.wantID)
		}
	}
}

func TestTriggerSQLUsesNotifyChannel(t *testing.T) {
	expected := "pg_notify('" + notifyChannel + "'"
	if !strings.Contains(createNotifyFunctionSQL, expected) {
		t.Errorf("trigger function SQL must call %s; got:\n%s", expected, createNotifyFunctionSQL)
	}
}

func TestTriggerSQLCoversAllWriteOps(t *testing.T) {
	for _, op := range []string{"INSERT", "UPDATE", "DELETE"} {
		if !strings.Contains(createNotifyTriggerSQL, op) {
			t.Errorf("trigger SQL must fire on %s; got:\n%s", op, createNotifyTriggerSQL)
		}
	}
}

func TestTriggerSQLEmitsExpectedOpStrings(t *testing.T) {
	// On DELETE the function builds {"op":"delete",...} explicitly.
	if !strings.Contains(createNotifyFunctionSQL, "'op', 'delete'") {
		t.Errorf("DELETE branch must emit op=delete; got:\n%s", createNotifyFunctionSQL)
	}
	// INSERT/UPDATE use lower(TG_OP), producing "insert" or "update".
	if !strings.Contains(createNotifyFunctionSQL, "lower(TG_OP)") {
		t.Errorf("INSERT/UPDATE branch must emit op=lower(TG_OP); got:\n%s", createNotifyFunctionSQL)
	}
}
