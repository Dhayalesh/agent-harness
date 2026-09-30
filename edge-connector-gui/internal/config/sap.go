package config

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const SAPPasswordEnv = "TRUEAI_GUI_SAP_PASSWORD"
const passwordReference = "${env:" + SAPPasswordEnv + "}"

type SAPSystem struct {
	ConnectionName string `json:"connection_name"`
	Host           string `json:"host"`
	Client         string `json:"client"`
	User           string `json:"user"`
	Password       string `json:"password"`
	Language       string `json:"language"`
}

type sapDocument struct {
	DefaultSystem string               `json:"default_system"`
	Systems       map[string]SAPSystem `json:"systems"`
}

type CredentialStore interface {
	SetCredential(target, username string, secret []byte) error
	GetCredential(target string) (username string, secret []byte, err error)
}

func SAPConfigPath(root string) string { return filepath.Join(root, "systems.json") }

func CredentialTarget(root string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(root))))
	return "TrueAI/EdgeGUI/SAP/" + hex.EncodeToString(sum[:16])
}

func ValidateSAP(system SAPSystem) error {
	if strings.TrimSpace(system.ConnectionName) == "" || strings.ContainsAny(system.ConnectionName, "\r\n") {
		return errors.New("SAP Logon connection name is required")
	}
	host, err := url.Parse(system.Host)
	if err != nil || host.Host == "" || (host.Scheme != "https" && host.Scheme != "http") ||
		host.User != nil || host.Fragment != "" {
		return errors.New("SAP system URL must be a valid http or https URL")
	}
	if len(system.Client) != 3 || strings.Trim(system.Client, "0123456789") != "" {
		return errors.New("SAP client must be three digits")
	}
	if strings.TrimSpace(system.User) == "" || strings.ContainsAny(system.User, "\r\n") {
		return errors.New("SAP username is required")
	}
	if system.Language != "EN" && system.Language != "DE" {
		return errors.New("SAP language must be EN or DE")
	}
	return nil
}

func LoadSAP(root string) (SAPSystem, error) {
	data, err := os.ReadFile(SAPConfigPath(root))
	if err != nil {
		return SAPSystem{}, err
	}
	var document sapDocument
	if err := json.Unmarshal(data, &document); err != nil {
		return SAPSystem{}, errors.New("invalid SAP GUI systems.json")
	}
	system, ok := document.Systems[document.DefaultSystem]
	if !ok || system.Password != passwordReference || ValidateSAP(system) != nil {
		return SAPSystem{}, errors.New("invalid SAP GUI systems.json; run edge-gui.exe --setup")
	}
	return system, nil
}

func SaveSAP(root string, system SAPSystem) error {
	if err := ValidateSAP(system); err != nil {
		return err
	}
	system.Password = passwordReference
	data, err := json.MarshalIndent(sapDocument{
		DefaultSystem: "default",
		Systems:       map[string]SAPSystem{"default": system},
	}, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	path := SAPConfigPath(root)
	tmp, err := os.CreateTemp(filepath.Dir(path), "systems-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
