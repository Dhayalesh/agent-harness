package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"
)

type JSONRPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type JSONRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   interface{}     `json:"error,omitempty"`
}

func main() {
	crashOnStart := flag.Bool("crash-on-start", false, "Exit immediately with non-zero status")
	delay := flag.Duration("delay", 0, "Delay before responding to requests")
	noisyStderr := flag.Bool("noisy-stderr", false, "Emit diagnostic messages to stderr on execution")
	envPath := flag.String("env-path", "", "Path to environment file")
	systemType := flag.String("system-type", "", "SAP system type (e.g. onprem, cloud)")
	_ = flag.String("transport", "stdio", "Transport protocol")
	_ = flag.String("mcp", "", "SAP Destination")
	flag.Parse()

	if *crashOnStart {
		fmt.Fprintln(os.Stderr, "fake-mcp: crashing on startup as instructed")
		os.Exit(42)
	}

	if *noisyStderr {
		fmt.Fprintln(os.Stderr, "fake-mcp: SAP RFC connection initialized to DEV")
		fmt.Fprintln(os.Stderr, "fake-mcp: diagnostic log: tracing enabled")
	}

	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var req JSONRPCRequest
		if err := json.Unmarshal(line, &req); err != nil {
			fmt.Fprintf(os.Stderr, "fake-mcp: invalid json: %v\n", err)
			continue
		}

		if *noisyStderr {
			fmt.Fprintf(os.Stderr, "fake-mcp: processing method %s\n", req.Method)
		}

		if *delay > 0 {
			time.Sleep(*delay)
		}

		switch req.Method {
		case "initialize":
			resultJSON := []byte(`{
				"protocolVersion": "2024-11-05",
				"capabilities": {
					"tools": { "listChanged": false }
				},
				"serverInfo": {
					"name": "fake-sap-adt",
					"version": "1.0.0"
				},
				"instructions": "Simulated SAP ABAP ADT MCP for local development and testing"
			}`)
			respond(req.ID, resultJSON, nil)

		case "notifications/initialized":
			// MCP initialized notification; no response required

		case "tools/list":
			resultJSON := []byte(`{
				"tools": [
					{
						"name": "read_abap_class",
						"description": "Read ABAP OO class definition and implementation from simulated SAP",
						"inputSchema": {
							"type": "object",
							"properties": {
								"class_name": { "type": "string" }
							},
							"required": ["class_name"]
						}
					},
					{
						"name": "list_packages",
						"description": "List development packages from simulated SAP",
						"inputSchema": {
							"type": "object",
							"properties": {
								"super_package": { "type": "string" }
							}
						}
					},
					{
						"name": "simulate_crash",
						"description": "Simulate an unhandled crash in the external MCP process",
						"inputSchema": {
							"type": "object",
							"properties": {}
						}
					},
					{
						"name": "get_mcp_config",
						"description": "Return runtime process configuration passed to fake-mcp",
						"inputSchema": {
							"type": "object",
							"properties": {}
						}
					}
				]
			}`)
			respond(req.ID, resultJSON, nil)

		case "tools/call":
			var params struct {
				Name      string                 `json:"name"`
				Arguments map[string]interface{} `json:"arguments"`
			}
			_ = json.Unmarshal(req.Params, &params)

			switch params.Name {
			case "get_mcp_config":
				respMap := map[string]interface{}{
					"content": []map[string]interface{}{
						{
							"type": "text",
							"text": fmt.Sprintf("env-path=%s;system-type=%s", *envPath, *systemType),
						},
					},
					"isError": false,
				}
				resultJSON, _ := json.Marshal(respMap)
				respond(req.ID, resultJSON, nil)

			case "simulate_crash":
				fmt.Fprintln(os.Stderr, "fake-mcp: simulated process crash triggered")
				os.Exit(99)

			case "read_abap_class":
				className, _ := params.Arguments["class_name"].(string)
				if className == "" {
					className = "ZCL_SAMPLE_DEMO"
				}
				resultJSON := []byte(fmt.Sprintf(`{
					"content": [
						{
							"type": "text",
							"text": "CLASS %s DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS execute.\nENDCLASS.\nCLASS %s IMPLEMENTATION.\n  METHOD execute.\n    WRITE: / 'Hello from SAP ADT'.\n  ENDMETHOD.\nENDCLASS."
						}
					],
					"isError": false
				}`, className, className))
				respond(req.ID, resultJSON, nil)

			case "list_packages":
				resultJSON := []byte(`{
					"content": [
						{
							"type": "text",
							"text": "[\"Z_FINANCE\", \"Z_SALES\", \"Z_CORE_INFRA\"]"
						}
					],
					"isError": false
				}`)
				respond(req.ID, resultJSON, nil)

			default:
				errObj := map[string]interface{}{
					"code":    -32601,
					"message": fmt.Sprintf("tool '%s' not found on fake-mcp", params.Name),
				}
				respond(req.ID, nil, errObj)
			}

		case "$/cancelRequest":
			// Handled cancellation notification

		default:
			errObj := map[string]interface{}{
				"code":    -32601,
				"message": fmt.Sprintf("method '%s' not found", req.Method),
			}
			respond(req.ID, nil, errObj)
		}
	}
}

func respond(id interface{}, result json.RawMessage, errObj interface{}) {
	if id == nil {
		return
	}

	resp := JSONRPCResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result:  result,
		Error:   errObj,
	}

	data, err := json.Marshal(resp)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fake-mcp: failed to marshal response: %v\n", err)
		return
	}

	os.Stdout.Write(data)
	os.Stdout.Write([]byte("\n"))
}

