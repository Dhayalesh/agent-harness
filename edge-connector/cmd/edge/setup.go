package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/trueai/edge-connector/internal/config"
	"github.com/trueai/edge-connector/internal/mcp/process"
)

func promptLine(in *bufio.Reader, out io.Writer, label, fallback string) (string, error) {
	if fallback == "" {
		fmt.Fprintf(out, "%s:\n> ", label)
	} else {
		fmt.Fprintf(out, "%s [%s]:\n> ", label, fallback)
	}
	line, err := in.ReadString('\n')
	if err != nil && len(line) == 0 {
		return "", fmt.Errorf("input required for %s", label)
	}
	value := strings.TrimSpace(line)
	if value == "" {
		value = fallback
	}
	return value, nil
}

func sapStoreDir(configPath string) string {
	if configPath == "" {
		return config.GetDefaultBaseDir()
	}
	return filepath.Dir(configPath)
}

func setupIdentity(cfg *config.Config, configPath string, force bool, in *bufio.Reader, out io.Writer) error {
	if cfg.UserEmail == "" || force {
		for {
			v, err := promptLine(in, out, "Email", cfg.UserEmail)
			if err != nil {
				return err
			}
			if config.ValidEmail(v) {
				cfg.UserEmail = v
				break
			}
			fmt.Fprintln(out, "Enter a valid email address.")
		}
	}
	if err := cfg.EnsureDeviceID(); err != nil {
		return fmt.Errorf("device identity unavailable")
	}
	if err := cfg.SaveConnectionFields(configPath); err != nil {
		return fmt.Errorf("cannot save Edge identity: %w", err)
	}
	return nil
}

func setupSAP(cfg *config.Config, configPath string, force bool, in *bufio.Reader, out io.Writer, credentials config.CredentialStore) (*config.SAPConfig, error) {
	store := config.NewLocalFileSAPConfigStore(sapStoreDir(configPath))
	target := config.CredentialTarget(configPath)
	current, loadErr := store.Load()
	if loadErr == nil && !force && current.ValidateSetup() == nil {
		username, secret, err := credentials.GetCredential(target)
		if err == nil && username == current.Username && len(secret) > 0 {
			for i := range secret {
				secret[i] = 0
			}
			fmt.Fprintln(out, "✓ SAP configuration loaded\n✓ SAP credentials available")
			return current, nil
		}
	}
	if current == nil {
		current = &config.SAPConfig{}
	}
	for {
		var err error
		current.URL, err = promptLine(in, out, "SAP System URL", current.URL)
		if err != nil {
			return nil, err
		}
		current.Client, err = promptLine(in, out, "SAP Client", current.Client)
		if err != nil {
			return nil, err
		}
		current.Username, err = promptLine(in, out, "SAP Username", current.Username)
		if err != nil {
			return nil, err
		}
		password, err := readPassword(in, out)
		if err != nil {
			return nil, err
		}
		current.SystemType, err = promptLine(in, out, "SAP System Type", "onprem")
		if err != nil {
			return nil, err
		}
		current.AuthType = "basic"
		current.ConnectionType = "http"
		if err := current.ValidateSetup(); err != nil {
			fmt.Fprintf(out, "Invalid SAP configuration: %v\n", err)
			continue
		}
		if password == "" {
			fmt.Fprintln(out, "SAP Password is required.")
			continue
		}
		secret := []byte(password)
		err = credentials.SetCredential(target, current.Username, secret)
		for i := range secret {
			secret[i] = 0
		}
		if err != nil {
			return nil, fmt.Errorf("could not store SAP password securely")
		}
		if err := store.Save(current); err != nil {
			return nil, fmt.Errorf("could not save SAP configuration: %w", err)
		}
		return current, nil
	}
}

func attachSAPRuntime(inst *process.Instance, cfg *config.Config, sap *config.SAPConfig, credentials config.CredentialStore, configPath string) {
	inst.SetLaunchEnvironment(func() (string, func(), error) {
		username, secret, err := credentials.GetCredential(config.CredentialTarget(configPath))
		if err != nil || username != sap.Username {
			return "", nil, fmt.Errorf("SAP credentials unavailable")
		}
		path, err := config.CreateSAPRuntimeEnv(cfg.StateDir, sap, secret)
		for i := range secret {
			secret[i] = 0
		}
		if err != nil {
			return "", nil, err
		}
		return path, func() { _ = os.Remove(path) }, nil
	})
}
