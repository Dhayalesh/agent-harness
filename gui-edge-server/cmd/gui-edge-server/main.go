package main

import (
	"context"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/trueai/gui-edge-server/server"
)

func main() {
	addr := flag.String("listen", "127.0.0.1:8765", "HTTP/WebSocket listen address")
	flag.Parse()
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))
	httpServer := &http.Server{Addr: *addr, Handler: server.New(logger), MaxHeaderBytes: 1 << 20}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}()
	logger.Info("GUI Edge Server listening", "address", *addr)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("server stopped", "error", err)
		os.Exit(1)
	}
}
