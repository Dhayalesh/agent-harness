package config

import (
	"bytes"
	"os"
	"testing"
)

func TestSAPDefinitionKeepsPasswordOutOfFile(t *testing.T) {
	root := t.TempDir()
	system := SAPSystem{ConnectionName: "Test SAP Logon", Host: "https://sap.example.test",
		Client: "100", User: "TESTUSER", Password: "must-not-be-saved", Language: "EN"}
	if err := SaveSAP(root, system); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(SAPConfigPath(root))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte("must-not-be-saved")) {
		t.Fatal("SAP password was saved")
	}
	if !bytes.Contains(data, []byte("${env:"+SAPPasswordEnv+"}")) {
		t.Fatal("password reference missing")
	}
	loaded, err := LoadSAP(root)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ConnectionName != system.ConnectionName || loaded.Host != system.Host || loaded.User != system.User {
		t.Fatal("SAP system fields were not preserved")
	}
}
