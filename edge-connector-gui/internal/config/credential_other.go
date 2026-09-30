//go:build !windows

package config

import "errors"

type unavailableCredentialStore struct{}

func NewCredentialStore() CredentialStore { return unavailableCredentialStore{} }

func (unavailableCredentialStore) SetCredential(string, string, []byte) error {
	return errors.New("Windows Credential Manager required")
}

func (unavailableCredentialStore) GetCredential(string) (string, []byte, error) {
	return "", nil, errors.New("Windows Credential Manager required")
}
