package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"

	"github.com/trueai/edge-connector-gui/internal/config"
	"github.com/trueai/edge-connector-gui/internal/connection"
	"github.com/trueai/edge-connector-gui/internal/mcp"
)

func main() {
	forceSetup := flag.Bool("setup", false, "Reconfigure email and SAP GUI connection")
	changeAccount := flag.Bool("change-account", false, "Change registered email")
	flag.Parse()
	if runtime.GOOS != "windows" {
		fmt.Fprintln(os.Stderr, "edge-gui requires Windows for SAP GUI COM scripting")
		os.Exit(1)
	}
	cfg, err := config.LoadForSetup("")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	file, err := os.OpenFile(filepath.Join(cfg.Root, "logs", "edge-gui.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer file.Close()
	logger := slog.New(slog.NewTextHandler(io.MultiWriter(os.Stdout, file), nil))
	logger.Info("Starting Go edge-gui")
	fmt.Print("\nTrue.ai GUI Edge Connector\n\n")
	input := bufio.NewReader(os.Stdin)
	if err := setupIdentity(&cfg, *forceSetup || *changeAccount, input, os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("✓ Edge identity configured\n  %s\n", cfg.Email)
	credentialStore := config.NewCredentialStore()
	sap, err := setupSAP(cfg.Root, *forceSetup, input, os.Stdout, credentialStore, readPassword)
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("SAP Connection\n  Connection : %s\n  System URL : %s\n  Client     : %s\n  Language   : %s\n  Credentials: available\n\n",
		sap.ConnectionName, sap.Host, sap.Client, sap.Language)
	logger.Info("GUI Edge configuration ready", "mcpId", cfg.MCPID, "serverUrl", cfg.ServerURL)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	host := mcp.New(cfg.Root, logger)
	host.ConfigureSAP(sap.User, credentialStore)
	defer host.Close()
	if err := host.Start(ctx); err != nil {
		logger.Warn("SAP GUI MCP startup unavailable; will retry on request", "errorType", fmt.Sprintf("%T", err))
	}
	manager := &connection.Manager{Config: cfg, MCP: host, Logger: logger}
	if err := manager.Run(ctx); err != nil {
		logger.Error("Connector stopped", "errorType", fmt.Sprintf("%T", err))
		os.Exit(1)
	}
}
