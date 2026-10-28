// SPDX-FileCopyrightText: Copyright The Miniflux Authors. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package server

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"testing"

	"miniflux.app/v2/internal/config"
)

func TestHTTPSIsScopedToRequest(t *testing.T) {
	t.Setenv("HTTPS", "0")
	t.Setenv("TRUSTED_REVERSE_PROXY_NETWORKS", "127.0.0.0/8")
	options, err := config.NewConfigParser().ParseEnvironmentVariables()
	if err != nil {
		t.Fatal(err)
	}
	previousOptions := config.Opts
	config.Opts = options
	t.Cleanup(func() { config.Opts = previousOptions })

	handler := middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	for _, tc := range []struct {
		name       string
		remoteAddr string
		proto      string
		tls        bool
		wantHSTS   bool
	}{
		{"trusted HTTPS proxy", "127.0.0.1:12345", "https", false, true},
		{"trusted HTTP proxy after HTTPS", "127.0.0.1:12345", "http", false, false},
		{"untrusted HTTPS header", "192.0.2.1:12345", "https", false, false},
		{"native TLS", "192.0.2.1:12345", "", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "http://example.test/", nil)
			req.RemoteAddr = tc.remoteAddr
			if tc.proto != "" {
				req.Header.Set("X-Forwarded-Proto", tc.proto)
			}
			if tc.tls {
				req.TLS = &tls.ConnectionState{}
			}
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, req)
			if got := recorder.Header().Get("Strict-Transport-Security") != ""; got != tc.wantHSTS {
				t.Errorf("HSTS header present = %v, want %v", got, tc.wantHSTS)
			}
			if config.Opts.HTTPS() {
				t.Error("request changed the global HTTPS setting")
			}
		})
	}
}
