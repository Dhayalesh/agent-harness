package main

import (
	"bufio"
	"fmt"
	"io"
	"strings"

	"github.com/trueai/edge-connector-gui/internal/config"
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

func setupIdentity(cfg *config.Config, force bool, in *bufio.Reader, out io.Writer) error {
	if config.ValidEmail(cfg.Email) && !force {
		return config.Validate(*cfg)
	}
	for {
		value, err := promptLine(in, out, "Email", cfg.Email)
		if err != nil {
			return err
		}
		if config.ValidEmail(value) {
			cfg.Email = value
			break
		}
		fmt.Fprintln(out, "Enter a valid email address.")
	}
	if err := config.Validate(*cfg); err != nil {
		return err
	}
	return config.Save(*cfg)
}

type passwordReader func(*bufio.Reader, io.Writer) (string, error)

func setupSAP(root string, force bool, in *bufio.Reader, out io.Writer,
	credentials config.CredentialStore, readSecret passwordReader) (config.SAPSystem, error) {
	current, loadErr := config.LoadSAP(root)
	if loadErr == nil && !force {
		username, secret, err := credentials.GetCredential(config.CredentialTarget(root))
		valid := err == nil && username == current.User && len(secret) > 0
		for i := range secret {
			secret[i] = 0
		}
		if valid {
			fmt.Fprintln(out, "✓ SAP configuration loaded\n✓ SAP credentials available")
			return current, nil
		}
	}
	if loadErr != nil {
		current = config.SAPSystem{Language: "EN"}
	}
	for {
		var err error
		current.ConnectionName, err = promptLine(in, out, "SAP Logon connection name or connection string", current.ConnectionName)
		if err != nil {
			return config.SAPSystem{}, err
		}
		current.Host, err = promptLine(in, out, "SAP System URL", current.Host)
		if err != nil {
			return config.SAPSystem{}, err
		}
		current.Client, err = promptLine(in, out, "SAP Client", current.Client)
		if err != nil {
			return config.SAPSystem{}, err
		}
		current.User, err = promptLine(in, out, "SAP Username", current.User)
		if err != nil {
			return config.SAPSystem{}, err
		}
		current.Language, err = promptLine(in, out, "SAP Language", current.Language)
		if err != nil {
			return config.SAPSystem{}, err
		}
		current.Language = strings.ToUpper(current.Language)
		password, err := readSecret(in, out)
		if err != nil {
			return config.SAPSystem{}, err
		}
		if err := config.ValidateSAP(current); err != nil {
			fmt.Fprintf(out, "Invalid SAP configuration: %v\n", err)
			continue
		}
		if password == "" {
			fmt.Fprintln(out, "SAP Password is required.")
			continue
		}
		secret := []byte(password)
		err = credentials.SetCredential(config.CredentialTarget(root), current.User, secret)
		for i := range secret {
			secret[i] = 0
		}
		if err != nil {
			return config.SAPSystem{}, fmt.Errorf("could not store SAP password securely: %w", err)
		}
		if err := config.SaveSAP(root, current); err != nil {
			return config.SAPSystem{}, fmt.Errorf("could not save SAP configuration: %w", err)
		}
		return current, nil
	}
}
