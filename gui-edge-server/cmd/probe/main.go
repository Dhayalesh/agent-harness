package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/gorilla/websocket"
	"github.com/trueai/gui-edge-server/server"
)

func ask(conn *websocket.Conn, email string, message json.RawMessage) (json.RawMessage, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return nil, err
	}
	requestID := hex.EncodeToString(id[:])
	payload, _ := json.Marshal(struct {
		MCPID   string          `json:"mcpId"`
		Message json.RawMessage `json:"message"`
	}{server.MCPID, message})
	request := server.Envelope{Version: 1, Type: "mcp.request", RequestID: requestID, Email: email, Payload: payload}
	if err := conn.WriteJSON(request); err != nil {
		return nil, err
	}
	_ = conn.SetReadDeadline(time.Now().Add(120 * time.Second))
	var response server.Envelope
	if err := conn.ReadJSON(&response); err != nil {
		return nil, err
	}
	if response.Type != "mcp.response" || response.RequestID != requestID {
		return nil, fmt.Errorf("relay returned %s", response.Type)
	}
	var result struct {
		Message json.RawMessage `json:"message"`
	}
	if err := json.Unmarshal(response.Payload, &result); err != nil {
		return nil, err
	}
	return result.Message, nil
}

func run(url, email string) error {
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	init, err := ask(conn, email, json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"gui-poc-probe","version":"1"}}}`))
	if err != nil {
		return err
	}
	var initialized struct {
		Result struct {
			ServerInfo struct {
				Name string `json:"name"`
			} `json:"serverInfo"`
		} `json:"result"`
	}
	if json.Unmarshal(init, &initialized) != nil || initialized.Result.ServerInfo.Name == "" {
		return fmt.Errorf("invalid MCP initialize response")
	}
	fmt.Println("MCP server:", initialized.Result.ServerInfo.Name)
	listed, err := ask(conn, email, json.RawMessage(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`))
	if err != nil {
		return err
	}
	var tools struct {
		Result struct {
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		} `json:"result"`
	}
	if json.Unmarshal(listed, &tools) != nil || len(tools.Result.Tools) == 0 {
		return fmt.Errorf("invalid MCP tools/list response")
	}
	fmt.Println("Actual tools discovered:", len(tools.Result.Tools))
	found := false
	for _, tool := range tools.Result.Tools {
		if tool.Name == "sap_list_connections" {
			found = true
		}
	}
	if !found {
		return fmt.Errorf("upstream read-only tool missing")
	}
	called, err := ask(conn, email, json.RawMessage(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"sap_list_connections","arguments":{}}}`))
	if err != nil {
		return err
	}
	var result struct {
		Result struct {
			Content []json.RawMessage `json:"content"`
		} `json:"result"`
	}
	if json.Unmarshal(called, &result) != nil || len(result.Result.Content) == 0 {
		return fmt.Errorf("upstream tool returned no content")
	}
	fmt.Println("Read-only content blocks:", len(result.Result.Content))
	return nil
}

func main() {
	url := flag.String("url", "ws://127.0.0.1:8765/ws", "GUI Edge Server WebSocket URL")
	email := flag.String("email", "", "Registered connector email")
	flag.Parse()
	if *email == "" {
		fmt.Fprintln(os.Stderr, "-email required")
		os.Exit(2)
	}
	if err := run(*url, *email); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
