//go:build windows

package config

import (
	"errors"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestWindowsCredentialStoreRoundTrip(t *testing.T) {
	store := NewCredentialStore()
	target := fmt.Sprintf("TrueAI/Edge/Test/%d/%d", os.Getpid(), time.Now().UnixNano())
	defer store.DeleteCredential(target)
	if err := store.SetCredential(target, "USR1", []byte("test-secret")); err != nil {
		t.Fatal(err)
	}
	user, secret, err := store.GetCredential(target)
	if err != nil || user != "USR1" || string(secret) != "test-secret" {
		t.Fatalf("credential roundtrip failed: %v", err)
	}
	if err := store.DeleteCredential(target); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.GetCredential(target); !errors.Is(err, ErrCredentialNotFound) {
		t.Fatalf("deleted credential still exists: %v", err)
	}
}
