//go:build windows

package config

import (
	"fmt"
	"syscall"
	"unsafe"
)

const credentialTypeGeneric = 1
const credentialPersistLocalMachine = 2

type credential struct {
	Flags              uint32
	Type               uint32
	TargetName         *uint16
	Comment            *uint16
	LastWritten        syscall.Filetime
	CredentialBlobSize uint32
	CredentialBlob     *byte
	Persist            uint32
	AttributeCount     uint32
	Attributes         uintptr
	TargetAlias        *uint16
	UserName           *uint16
}

var advapi32 = syscall.NewLazyDLL("advapi32.dll")
var credWrite = advapi32.NewProc("CredWriteW")
var credRead = advapi32.NewProc("CredReadW")
var credDelete = advapi32.NewProc("CredDeleteW")
var credFree = advapi32.NewProc("CredFree")

// WindowsCredentialStore stores generic credentials in the current user's
// Windows Credential Manager vault. The secret is protected by Windows.
type WindowsCredentialStore struct{}

func NewCredentialStore() CredentialStore { return WindowsCredentialStore{} }

func (WindowsCredentialStore) SetCredential(target, username string, secret []byte) error {
	if target == "" || username == "" || len(secret) == 0 || len(secret) > 5120 {
		return fmt.Errorf("invalid credential metadata or size")
	}
	t, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return fmt.Errorf("invalid credential target")
	}
	u, err := syscall.UTF16PtrFromString(username)
	if err != nil {
		return fmt.Errorf("invalid credential username")
	}
	c := credential{Type: credentialTypeGeneric, TargetName: t, UserName: u, Persist: credentialPersistLocalMachine, CredentialBlobSize: uint32(len(secret)), CredentialBlob: &secret[0]}
	r, _, _ := credWrite.Call(uintptr(unsafe.Pointer(&c)), 0)
	if r == 0 {
		return fmt.Errorf("Windows Credential Manager write failed")
	}
	return nil
}

func (WindowsCredentialStore) GetCredential(target string) (string, []byte, error) {
	t, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return "", nil, fmt.Errorf("invalid credential target")
	}
	var p *credential
	r, _, e := credRead.Call(uintptr(unsafe.Pointer(t)), credentialTypeGeneric, 0, uintptr(unsafe.Pointer(&p)))
	if r == 0 {
		if e == syscall.Errno(1168) {
			return "", nil, ErrCredentialNotFound
		}
		return "", nil, fmt.Errorf("Windows Credential Manager read failed")
	}
	defer credFree.Call(uintptr(unsafe.Pointer(p)))
	if p == nil || p.CredentialBlobSize == 0 || p.CredentialBlob == nil {
		return "", nil, ErrCredentialNotFound
	}
	secret := make([]byte, p.CredentialBlobSize)
	copy(secret, unsafe.Slice(p.CredentialBlob, p.CredentialBlobSize))
	var units []uint16
	if p.UserName != nil {
		for i := 0; i < 32768; i++ {
			v := *(*uint16)(unsafe.Pointer(uintptr(unsafe.Pointer(p.UserName)) + uintptr(i)*2))
			if v == 0 {
				break
			}
			units = append(units, v)
		}
	}
	return syscall.UTF16ToString(units), secret, nil
}

func (WindowsCredentialStore) DeleteCredential(target string) error {
	t, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return fmt.Errorf("invalid credential target")
	}
	r, _, e := credDelete.Call(uintptr(unsafe.Pointer(t)), credentialTypeGeneric, 0)
	if r == 0 && e != syscall.Errno(1168) {
		return fmt.Errorf("Windows Credential Manager delete failed")
	}
	return nil
}
