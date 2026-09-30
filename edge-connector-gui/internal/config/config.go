package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const MCPID = "sapgui"

var ErrSetupRequired = errors.New("set email in the generated EdgeGUI config.json, then run edge-gui.exe again")

type Config struct {
	ServerURL        string `json:"serverUrl"`
	Email            string `json:"email"`
	DeviceID         string `json:"deviceId"`
	MCPID            string `json:"mcpId"`
	HeartbeatSeconds int    `json:"heartbeatSeconds"`
	Root             string `json:"-"`
}

func Root() (string, error) {
	if override := os.Getenv("EDGE_GUI_HOME"); override != "" {
		return filepath.Abs(override)
	}
	if local := os.Getenv("LOCALAPPDATA"); local != "" {
		return filepath.Join(local, "TrueAI", "EdgeGUI"), nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "TrueAI", "EdgeGUI"), nil
}

func deviceID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func write(path string, c Config) error {
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	tmp, err := os.CreateTemp(filepath.Dir(path), "config-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err = tmp.Write(b); err != nil {
		_ = tmp.Close()
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func LoadForSetup(root string) (Config, error) {
	if root == "" {
		var err error
		root, err = Root()
		if err != nil {
			return Config{}, err
		}
	}
	for _, name := range []string{"", "state", "logs", "runtime"} {
		if err := os.MkdirAll(filepath.Join(root, name), 0700); err != nil {
			return Config{}, err
		}
	}
	path := filepath.Join(root, "config.json")
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		id, err := deviceID()
		if err != nil {
			return Config{}, err
		}
		cfg := Config{ServerURL: "wss://gui-edge-server.duckdns.org/ws", DeviceID: id, MCPID: MCPID, HeartbeatSeconds: 30, Root: root}
		if err := write(path, cfg); err != nil {
			return Config{}, err
		}
		return cfg, nil
	}
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("invalid config.json: %w", err)
	}
	cfg.Root = root
	if cfg.DeviceID == "" {
		cfg.DeviceID, err = deviceID()
		if err != nil {
			return Config{}, err
		}
		if err := write(path, cfg); err != nil {
			return Config{}, err
		}
	}
	return cfg, nil
}

func Save(cfg Config) error {
	if cfg.Root == "" {
		return errors.New("config root is required")
	}
	return write(filepath.Join(cfg.Root, "config.json"), cfg)
}

func ValidEmail(value string) bool {
	if value == "" || len(value) > 254 || strings.TrimSpace(value) != value {
		return false
	}
	address, err := mail.ParseAddress(value)
	return err == nil && address.Address == value
}

func Validate(cfg Config) error {
	u, err := url.Parse(cfg.ServerURL)
	if err != nil || u.Host == "" || u.Path != "/ws" || u.User != nil || u.RawQuery != "" || u.Fragment != "" ||
		(u.Scheme != "ws" && u.Scheme != "wss") {
		return errors.New("serverUrl must be ws://localhost:<port>/ws or wss://<host>/ws")
	}
	if u.Scheme == "ws" && u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" {
		return errors.New("unencrypted ws is allowed only on localhost")
	}
	if !ValidEmail(cfg.Email) || cfg.DeviceID == "" || len(cfg.DeviceID) > 128 ||
		cfg.MCPID != MCPID || cfg.HeartbeatSeconds < 5 || cfg.HeartbeatSeconds > 300 {
		return errors.New("config requires email, deviceId, mcpId=sapgui and heartbeatSeconds between 5 and 300")
	}
	return nil
}

func Load(root string) (Config, error) {
	cfg, err := LoadForSetup(root)
	if err != nil {
		return Config{}, err
	}
	if cfg.Email == "" {
		return Config{}, fmt.Errorf("created %s: %w", filepath.Join(cfg.Root, "config.json"), ErrSetupRequired)
	}
	if err := Validate(cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}
