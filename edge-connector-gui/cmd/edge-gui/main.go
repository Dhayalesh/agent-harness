package main

import (
	"context"
	"errors"
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
	if runtime.GOOS != "windows" {
		fmt.Fprintln(os.Stderr, "edge-gui requires Windows for SAP GUI COM scripting")
		os.Exit(1)
	}
	cfg, err := config.Load("")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		if errors.Is(err, config.ErrSetupRequired) {
			return
		}
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	host := mcp.New(cfg.Root, logger)
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
