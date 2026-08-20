package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"golang.org/x/sync/errgroup"
	"golang.org/x/time/rate"
)

// issueFields holds the parsed form fields for a feedback submission.
type issueFields struct {
	Name        string
	Email       string
	GitHub      string
	Title       string
	Description string
	SessionURL  string
}

// attachmentRecord is a file that has been successfully uploaded to S3.
type attachmentRecord struct {
	Name string
	URL  string
}

// formatIssueBody returns a Markdown string for the GitHub issue body.
func formatIssueBody(fields issueFields, attachments []attachmentRecord) string {
	var sb strings.Builder

	fmt.Fprintf(&sb, "## Feedback\n\n**Type:** Bug Report\n\n**Description:**\n%s\n\n---\n\n## Reporter\n\n| Field | Value |\n|---|---|\n", fields.Description)
	fmt.Fprintf(&sb, "| Name | %s |\n| Email | %s |\n", fields.Name, fields.Email)
	if fields.GitHub != "" {
		fmt.Fprintf(&sb, "| GitHub | @%s |\n", fields.GitHub)
	}

	if fields.SessionURL != "" {
		fmt.Fprintf(&sb, "\n---\n\n## Session\n\n| Field | Value |\n|---|---|\n| Session URL | %s |\n", fields.SessionURL)
	}

	if len(attachments) > 0 {
		sb.WriteString("\n---\n\n## Attachments\n\n")
		for _, a := range attachments {
			fmt.Fprintf(&sb, "- [%s](%s)\n", a.Name, a.URL)
		}
	}

	return sb.String()
}

// ipLimiterMap holds one rate.Limiter per remote IP.
type ipLimiterMap struct {
	mu       sync.Mutex
	limiters map[string]*rate.Limiter
}

func newIPLimiterMap() *ipLimiterMap {
	m := &ipLimiterMap{limiters: make(map[string]*rate.Limiter)}
	go m.periodicCleanup()
	return m
}

func (m *ipLimiterMap) allow(ip string) bool {
	m.mu.Lock()
	l, ok := m.limiters[ip]
	if !ok {
		// 5 requests per minute, burst of 3.
		l = rate.NewLimiter(rate.Every(time.Minute/5), 3)
		m.limiters[ip] = l
	}
	m.mu.Unlock()
	return l.Allow()
}

func (m *ipLimiterMap) periodicCleanup() {
	for range time.Tick(5 * time.Minute) {
		m.mu.Lock()
		clear(m.limiters)
		m.mu.Unlock()
	}
}

// NewFeedbackHandler returns an http.HandlerFunc for POST /feedback.
// githubAPIURL and s3Endpoint are injectable for testing.
func NewFeedbackHandler(githubAPIURL, s3Endpoint, s3Bucket, s3AccessKey, s3SecretKey, githubToken string, logger *slog.Logger) http.HandlerFunc {
	limiters := newIPLimiterMap()

	// Best-effort: ensure the "feedback" label exists in the repo.
	go ensureFeedbackLabel(githubAPIURL, githubToken, logger)

	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}

		// CSRF: reject explicit cross-site fetches. Requests lacking Sec-Fetch-Site
		// (legacy browsers) are allowed through.
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			writeJSONError(w, http.StatusForbidden, "cross-site requests not allowed")
			return
		}

		// Per-IP rate limiting: 5 req/min, burst 3.
		ip := extractIPAddr(r.RemoteAddr)
		if !limiters.allow(ip) {
			writeJSONError(w, http.StatusTooManyRequests, "rate limit exceeded")
			return
		}

		// Body size limit must be set before ParseMultipartForm.
		r.Body = http.MaxBytesReader(w, r.Body, 26<<20)

		if err := r.ParseMultipartForm(4 << 20); err != nil {
			if strings.Contains(err.Error(), "too large") {
				writeJSONError(w, http.StatusRequestEntityTooLarge, "request too large")
				return
			}
			writeJSONError(w, http.StatusBadRequest, "invalid form data")
			return
		}

		fields := issueFields{
			Name:        strings.TrimSpace(r.FormValue("name")),
			Email:       strings.TrimSpace(r.FormValue("email")),
			GitHub:      strings.TrimSpace(r.FormValue("github")),
			Title:       strings.TrimSpace(r.FormValue("title")),
			Description: strings.TrimSpace(r.FormValue("description")),
			SessionURL:  strings.TrimSpace(r.FormValue("sessionUrl")),
		}

		for _, f := range []struct{ field, val string }{
			{"name", fields.Name},
			{"email", fields.Email},
			{"title", fields.Title},
			{"description", fields.Description},
		} {
			if f.val == "" {
				writeJSONError(w, http.StatusBadRequest, "missing required field: "+f.field)
				return
			}
		}

		fileHeaders := r.MultipartForm.File["attachments[]"]
		if len(fileHeaders) > 5 {
			writeJSONError(w, http.StatusBadRequest, "too many files: max 5")
			return
		}

		for _, fh := range fileHeaders {
			if fh.Size > 5<<20 {
				writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("file %q exceeds 5 MB", fh.Filename))
				return
			}
		}

		// Upload attachments concurrently.
		var attachments []attachmentRecord
		if len(fileHeaders) > 0 {
			secure := strings.HasPrefix(s3Endpoint, "https://")
			host := strings.TrimPrefix(strings.TrimPrefix(s3Endpoint, "https://"), "http://")
			s3, err := minio.New(host, &minio.Options{
				Creds:        credentials.NewStaticV4(s3AccessKey, s3SecretKey, ""),
				Secure:       secure,
				Region:       "us-east-1",
				BucketLookup: minio.BucketLookupPath,
			})
			if err != nil {
				logger.Error("s3 client creation failed", "error", err)
				writeJSONError(w, http.StatusInternalServerError, "storage unavailable")
				return
			}

			uploadID := uuid.New().String()
			type result struct {
				idx int
				rec attachmentRecord
			}
			results := make([]result, len(fileHeaders))

			batchCtx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
			defer cancel()

			g, gCtx := errgroup.WithContext(batchCtx)
			g.SetLimit(5)

			for i, fh := range fileHeaders {
				i, fh := i, fh
				g.Go(func() error {
					upCtx, upCancel := context.WithTimeout(gCtx, 30*time.Second)
					defer upCancel()

					f, err := fh.Open()
					if err != nil {
						return fmt.Errorf("open %s: %w", fh.Filename, err)
					}
					defer f.Close()

					// Read all bytes so we can detect MIME and reuse the reader.
					data, err := io.ReadAll(f)
					if err != nil {
						return fmt.Errorf("read %s: %w", fh.Filename, err)
					}
					mimeType := http.DetectContentType(data)

					key := fmt.Sprintf("feedback/%s/%s", uploadID, fh.Filename)
					_, err = s3.PutObject(upCtx, s3Bucket, key, bytes.NewReader(data), int64(len(data)),
						minio.PutObjectOptions{ContentType: mimeType})
					if err != nil {
						return fmt.Errorf("upload %s: %w", fh.Filename, err)
					}

					results[i] = result{
						idx: i,
						rec: attachmentRecord{
							Name: fh.Filename,
							URL:  fmt.Sprintf("https://files.911realtime.org/feedback/%s/%s", uploadID, fh.Filename),
						},
					}
					return nil
				})
			}

			if err := g.Wait(); err != nil {
				logger.Error("s3 upload failed", "error", err)
				writeJSONError(w, http.StatusBadGateway, "upload failed: "+err.Error())
				return
			}

			attachments = make([]attachmentRecord, len(results))
			for _, res := range results {
				attachments[res.idx] = res.rec
			}
		}

		// Build and create the GitHub issue.
		issueBody := formatIssueBody(fields, attachments)
		issueURL, err := createGitHubIssue(r.Context(), githubAPIURL, githubToken, "[Feedback] "+fields.Title, issueBody, logger)
		if err != nil {
			logger.Error("github issue creation failed", "error", err)
			writeJSONError(w, http.StatusBadGateway, "github api error: "+err.Error())
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "issueUrl": issueURL})
	}
}

// ensureFeedbackLabel creates the "feedback" label in the repo. A 422 means it
// already exists, which is fine. Any other error is logged as a warning only —
// GitHub silently ignores unknown labels at issue-creation time, so this is cosmetic.
func ensureFeedbackLabel(githubAPIURL, token string, logger *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	payload := `{"name":"feedback","color":"0075ca"}`
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		githubAPIURL+"/repos/Keeping-History/rt911/labels",
		strings.NewReader(payload))
	if err != nil {
		logger.Warn("ensureFeedbackLabel: build request", "error", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		logger.Warn("ensureFeedbackLabel: request failed", "error", err)
		return
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusUnprocessableEntity {
		logger.Warn("ensureFeedbackLabel: unexpected status", "status", resp.StatusCode)
	}
}

// createGitHubIssue posts to the GitHub Issues API and returns the HTML URL.
func createGitHubIssue(ctx context.Context, githubAPIURL, token, title, body string, logger *slog.Logger) (string, error) {
	payload, _ := json.Marshal(map[string]any{
		"title":  title,
		"body":   body,
		"labels": []string{"feedback"},
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		githubAPIURL+"/repos/Keeping-History/rt911/issues",
		bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("status %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	var result struct {
		HTMLURL string `json:"html_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("decode response: %w", err)
	}
	return result.HTMLURL, nil
}

// writeJSONError writes a JSON {"error": "..."} response.
func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// extractIPAddr extracts the host portion from an addr string like "1.2.3.4:5678".
func extractIPAddr(addr string) string {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	return host
}
