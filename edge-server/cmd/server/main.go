package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"time"

	websocketserver "github.com/trueai/edge-server/internal/websocket"
)

const Version = "1.0.0"

func main() {
	addr := flag.String("listen", "127.0.0.1:8080", "Listen address")
	cert := flag.String("tls-cert", "", "Optional TLS certificate for WSS")
	key := flag.String("tls-key", "", "Optional TLS private key for WSS")
	showVersion := flag.Bool("version", false, "Print Edge Server version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Printf("True.ai Edge Server v%s\n", Version)
		return
	}
	if (*cert == "") != (*key == "") {
		log.Fatal("--tls-cert and --tls-key must be supplied together")
	}
	s := websocketserver.New()
	httpServer := &http.Server{Addr: *addr, Handler: s, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second}
	if *cert != "" {
		log.Fatal(httpServer.ListenAndServeTLS(*cert, *key))
	}
	log.Fatal(httpServer.ListenAndServe())
}
