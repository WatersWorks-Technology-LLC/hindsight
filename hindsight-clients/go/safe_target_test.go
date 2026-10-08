package hindsight

import (
	"errors"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"testing"
	"time"
)

// No network calls: authorize the isolated fixture before constructing a client.
func validateIsolatedSDKTarget(raw, authorized string) (string, error) {
	if authorized != "1" {
		return "", errors.New("explicit isolated mutation-test authorization required")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" || (u.Path != "" && u.Path != "/") {
		return "", errors.New("only a plain loopback fixture URL is allowed")
	}
	if u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" {
		return "", errors.New("fixture must use a literal loopback address")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1024 || port > 65535 {
		return "", errors.New("explicit unprivileged fixture port required")
	}
	protected := map[int]bool{3200: true, 3291: true, 3293: true, 3847: true, 5001: true, 8888: true, 9998: true, 9999: true, 55438: true}
	if protected[port] {
		return "", errors.New("protected service port cannot be a mutation-test target")
	}
	return u.Scheme + "://" + u.Host, nil
}

func isolatedSDKTestURL(t *testing.T) string {
	t.Helper()
	raw := os.Getenv("HINDSIGHT_API_URL")
	if raw == "" {
		t.Skip("No isolated fixture URL supplied; mutation test skipped")
	}
	target, err := validateIsolatedSDKTarget(raw, os.Getenv("HINDSIGHT_SDK_ISOLATED_TESTS"))
	if err != nil {
		// Deliberately omit the input URL, which could contain credentials.
		t.Fatal(err)
	}
	return target
}

func isolatedSDKHTTPClient() *http.Client {
	return &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return errors.New("SDK mutation tests do not follow redirects")
	}}
}

func TestIsolatedSDKRedirectGate(t *testing.T) {
	client := isolatedSDKHTTPClient()
	if client.Timeout != 30*time.Second || client.CheckRedirect(nil, nil) == nil {
		t.Fatal("fixture requests must be bounded and reject redirects")
	}
}

func TestIsolatedSDKTargetGate(t *testing.T) {
	cases := []struct {
		url, authorization string
		allowed            bool
	}{
		{"http://127.0.0.1:58154", "1", true},
		{"http://[::1]:58154/", "1", true},
		{"http://127.0.0.1:58154", "", false},
		{"http://127.0.0.1:58154", "true", false},
		{"http://127.0.0.1:8888", "1", false},
		{"http://[::1]:8888", "1", false},
		{"http://localhost:8888", "1", false},
		{"http://localhost:58154", "1", false},
		{"http://127.0.0.1:9999", "1", false},
		{"http://127.0.0.1:9998", "1", false},
		{"http://127.0.0.1:55438", "1", false},
		{"http://127.0.0.1:3200", "1", false},
		{"http://127.0.0.1:3291", "1", false},
		{"http://127.0.0.1:3293", "1", false},
		{"http://127.0.0.1:3847", "1", false},
		{"http://127.0.0.1:5001", "1", false},
		{"https://127.0.0.1:58154", "1", false},
		{"http://127.0.0.1", "1", false},
		{"http://127.0.0.1:80", "1", false},
		{"http://127.0.0.1:65536", "1", false},
		{"http://127.0.0.1:58154/path", "1", false},
		{"http://127.0.0.1:58154?secret=fixture", "1", false},
		{"http://127.0.0.1:58154#fragment", "1", false},
		{"http://user:fixture@127.0.0.1:58154", "1", false},
		{"http://example.invalid:58154", "1", false},
		{"http://127.0.0.2:58154", "1", false},
		{"http://127.1:58154", "1", false},
	}
	for i, c := range cases {
		_, err := validateIsolatedSDKTarget(c.url, c.authorization)
		if (err == nil) != c.allowed {
			t.Errorf("case %d: allowed=%v error=%v", i, c.allowed, err)
		}
	}
}
