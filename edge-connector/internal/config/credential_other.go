//go:build !windows

package config

import "errors"

type unsupportedCredentialStore struct{}

func NewCredentialStore() CredentialStore { return unsupportedCredentialStore{} }
func (unsupportedCredentialStore) SetCredential(string, string, []byte) error {
	return errors.New("secure credential storage requires Windows")
}
func (unsupportedCredentialStore) GetCredential(string) (string, []byte, error) {
	return "", nil, errors.New("secure credential storage requires Windows")
}
func (unsupportedCredentialStore) DeleteCredential(string) error {
	return errors.New("secure credential storage requires Windows")
}
