package handler

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// --- formatIssueBody (pure function) ---

func TestFormatIssueBody_AllFields(t *testing.T) {
	body := formatIssueBody(issueFields{
		Name:        "Alice",
		Email:       "alice@example.com",
		GitHub:      "alice",
		Title:       "Test",
		Description: "A description",
		SessionURL:  "https://or.example/s/abc",
	}, []attachmentRecord{{Name: "photo.png", URL: "https://files.911realtime.org/feedback/id/photo.png"}})

	for _, want := range []string{"Alice", "alice@example.com", "@alice", "A description", "https://or.example/s/abc", "photo.png", "https://files.911realtime.org/feedback/id/photo.png"} {
		if !strings.Contains(body, want) {
			t.Errorf("formatIssueBody: missing %q", want)
		}
	}
}

func TestFormatIssueBody_GitHubOmitted(t *testing.T) {
	body := formatIssueBody(issueFields{Name: "Bob", Email: "b@b.com", Description: "d"}, nil)
	if strings.Contains(body, "GitHub") {
		t.Error("GitHub row should be omitted when github field is blank")
	}
}

func TestFormatIssueBody_SessionURLOmitted(t *testing.T) {
	body := formatIssueBody(issueFields{Name: "Bob", Email: "b@b.com", Description: "d"}, nil)
	if strings.Contains(body, "Session") {
		t.Error("Session section should be omitted when sessionUrl is blank")
	}
}

func TestFormatIssueBody_AttachmentsOmitted(t *testing.T) {
	body := formatIssueBody(issueFields{Name: "Bob", Email: "b@b.com", Description: "d"}, nil)
	if strings.Contains(body, "Attachments") {
		t.Error("Attachments section should be omitted when no files")
	}
}

func TestFormatIssueBody_OneAttachment(t *testing.T) {
	body := formatIssueBody(issueFields{Name: "A", Email: "a@b.com", Description: "d"},
		[]attachmentRecord{{Name: "img.png", URL: "https://files.example.com/img.png"}})
	if !strings.Contains(body, "Attachments") {
		t.Error("Attachments section missing when one file present")
	}
	if !strings.Contains(body, "[img.png](https://files.example.com/img.png)") {
		t.Error("attachment link missing")
	}
}

func TestFormatIssueBody_MultipleAttachments(t *testing.T) {
	atts := []attachmentRecord{
		{Name: "a.png", URL: "https://files.example.com/a.png"},
		{Name: "b.png", URL: "https://files.example.com/b.png"},
	}
	body := formatIssueBody(issueFields{Name: "A", Email: "a@b.com", Description: "d"}, atts)
	if !strings.Contains(body, "a.png") || !strings.Contains(body, "b.png") {
		t.Error("both attachments should appear in body")
	}
}

// --- handler helpers ---

func feedbackHandler(t *testing.T, githubSrv *httptest.Server, s3Srv *httptest.Server) http.HandlerFunc {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	s3Endpoint := ""
	if s3Srv != nil {
		s3Endpoint = s3Srv.URL
	}
	return NewFeedbackHandler(githubSrv.URL, s3Endpoint, "test-bucket", "key", "secret", "test-token", logger)
}

func fakeGitHubAPI(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/labels"):
			// Label creation — already exists
			w.WriteHeader(http.StatusUnprocessableEntity)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/issues"):
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]any{
				"html_url": "https://github.com/Keeping-History/rt911/issues/1",
				"number":   1,
			})
		default:
			t.Errorf("unexpected GitHub API call: %s %s", r.Method, r.URL.Path)
			http.Error(w, "unexpected", http.StatusBadRequest)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func fakeS3(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPut:
			io.Copy(io.Discard, r.Body)
			w.Header().Set("ETag", `"test-etag"`)
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// buildMultipart creates a multipart/form-data body with the given fields and optional file.
func buildMultipart(t *testing.T, fields map[string]string, files map[string][]byte) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		_ = mw.WriteField(k, v)
	}
	for filename, content := range files {
		fw, _ := mw.CreateFormFile("attachments[]", filename)
		fw.Write(content)
	}
	mw.Close()
	return &buf, mw.FormDataContentType()
}

var validFields = map[string]string{
	"name":        "Alice",
	"email":       "alice@example.com",
	"title":       "Test bug",
	"description": "Something broke",
}

// --- handler tests ---

func TestFeedbackHandler_Success(t *testing.T) {
	ghSrv := fakeGitHubAPI(t)
	s3Srv := fakeS3(t)
	h := feedbackHandler(t, ghSrv, s3Srv)

	body, ct := buildMultipart(t, validFields, nil)
	req := httptest.NewRequest(http.MethodPost, "/feedback", body)
	req.Header.Set("Content-Type", ct)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	json.NewDecoder(rr.Body).Decode(&resp)
	if resp["ok"] != true {
		t.Error("response.ok should be true")
	}
	if !strings.Contains(resp["issueUrl"].(string), "github.com") {
		t.Errorf("issueUrl should be a github URL, got %v", resp["issueUrl"])
	}
}

func TestFeedbackHandler_MissingName(t *testing.T) {
	ghSrv := fakeGitHubAPI(t)
	h := feedbackHandler(t, ghSrv, nil)

	fields := map[string]string{"email": "a@b.com", "title": "t", "description": "d"}
	body, ct := buildMultipart(t, fields, nil)
	req := httptest.NewRequest(http.MethodPost, "/feedback", body)
	req.Header.Set("Content-Type", ct)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rr.Code)
	}
	var resp map[string]string
	json.NewDecoder(rr.Body).Decode(&resp)
	if !strings.Contains(resp["error"], "name") {
		t.Errorf("error should mention 'name', got %q", resp["error"])
	}
}

func TestFeedbackHandler_TooManyFiles(t *testing.T) {
	ghSrv := fakeGitHubAPI(t)
	h := feedbackHandler(t, ghSrv, nil)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range validFields {
		mw.WriteField(k, v)
	}
	for i := range 6 {
		fw, _ := mw.CreateFormFile("attachments[]", "file"+string(rune('a'+i))+".png")
		fw.Write([]byte("x"))
	}
	mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/feedback", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for >5 files, got %d", rr.Code)
	}
}

func TestFeedbackHandler_CSRF(t *testing.T) {
	ghSrv := fakeGitHubAPI(t)
	h := feedbackHandler(t, ghSrv, nil)

	body, ct := buildMultipart(t, validFields, nil)
	req := httptest.NewRequest(http.MethodPost, "/feedback", body)
	req.Header.Set("Content-Type", ct)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for cross-site request, got %d", rr.Code)
	}
}

func TestFeedbackHandler_RateLimit(t *testing.T) {
	ghSrv := fakeGitHubAPI(t)
	s3Srv := fakeS3(t)
	h := feedbackHandler(t, ghSrv, s3Srv)

	// burst is 3; the 4th request from the same IP should be rate-limited
	for i := range 3 {
		body, ct := buildMultipart(t, validFields, nil)
		req := httptest.NewRequest(http.MethodPost, "/feedback", body)
		req.Header.Set("Content-Type", ct)
		req.RemoteAddr = "1.2.3.4:9999"
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("request %d: expected 200, got %d", i+1, rr.Code)
		}
	}

	body, ct := buildMultipart(t, validFields, nil)
	req := httptest.NewRequest(http.MethodPost, "/feedback", body)
	req.Header.Set("Content-Type", ct)
	req.RemoteAddr = "1.2.3.4:9999"
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 after burst exhausted, got %d", rr.Code)
	}
}

func TestFeedbackHandler_WithAttachment(t *testing.T) {
	ghSrv := fakeGitHubAPI(t)
	s3Srv := fakeS3(t)
	h := feedbackHandler(t, ghSrv, s3Srv)

	body, ct := buildMultipart(t, validFields, map[string][]byte{"photo.png": {0x89, 0x50, 0x4e, 0x47}}) // PNG magic bytes
	req := httptest.NewRequest(http.MethodPost, "/feedback", body)
	req.Header.Set("Content-Type", ct)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 with attachment, got %d: %s", rr.Code, rr.Body.String())
	}
}
