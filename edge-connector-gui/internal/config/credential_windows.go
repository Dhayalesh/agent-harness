//go:build windows

package config

import (
	"errors"
	"syscall"
	"unsafe"
)

type credential struct {
	Flags, Type    uint32
	TargetName     *uint16
	Comment        *uint16
	LastWritten    syscall.Filetime
	BlobSize       uint32
	Blob           *byte
	Persist        uint32
	AttributeCount uint32
	Attributes     uintptr
	TargetAlias    *uint16
	UserName       *uint16
}

var advapi32 = syscall.NewLazyDLL("advapi32.dll")
var credWrite = advapi32.NewProc("CredWriteW")
var credRead = advapi32.NewProc("CredReadW")
var credFree = advapi32.NewProc("CredFree")

type WindowsCredentialStore struct{}

func NewCredentialStore() CredentialStore { return WindowsCredentialStore{} }

func (WindowsCredentialStore) SetCredential(target, username string, secret []byte) error {
	if target == "" || username == "" || len(secret) == 0 || len(secret) > 5120 {
		return errors.New("invalid SAP credential metadata")
	}
	name, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return errors.New("invalid SAP credential target")
	}
	user, err := syscall.UTF16PtrFromString(username)
	if err != nil {
		return errors.New("invalid SAP username")
	}
	entry := credential{Type: 1, TargetName: name, UserName: user, Persist: 2,
		BlobSize: uint32(len(secret)), Blob: &secret[0]}
	result, _, _ := credWrite.Call(uintptr(unsafe.Pointer(&entry)), 0)
	if result == 0 {
		return errors.New("Windows Credential Manager write failed")
	}
	return nil
}

func (WindowsCredentialStore) GetCredential(target string) (string, []byte, error) {
	name, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return "", nil, errors.New("invalid SAP credential target")
	}
	var entry *credential
	result, _, _ := credRead.Call(uintptr(unsafe.Pointer(name)), 1, 0, uintptr(unsafe.Pointer(&entry)))
	if result == 0 || entry == nil {
		return "", nil, errors.New("SAP credential unavailable")
	}
	defer credFree.Call(uintptr(unsafe.Pointer(entry)))
	if entry.BlobSize == 0 || entry.Blob == nil {
		return "", nil, errors.New("SAP credential unavailable")
	}
	secret := make([]byte, entry.BlobSize)
	copy(secret, unsafe.Slice(entry.Blob, entry.BlobSize))
	var units []uint16
	if entry.UserName != nil {
		for i := 0; i < 32768; i++ {
			v := *(*uint16)(unsafe.Pointer(uintptr(unsafe.Pointer(entry.UserName)) + uintptr(i)*2))
			if v == 0 {
				break
			}
			units = append(units, v)
		}
	}
	return syscall.UTF16ToString(units), secret, nil
}
