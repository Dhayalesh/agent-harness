package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/trueai/edge-connector/assets"
	"github.com/trueai/edge-connector/internal/config"
	"github.com/trueai/edge-connector/internal/connection"
	"github.com/trueai/edge-connector/internal/health"
	"github.com/trueai/edge-connector/internal/logging"
	"github.com/trueai/edge-connector/internal/mcp/manifest"
	"github.com/trueai/edge-connector/internal/mcp/process"
	"github.com/trueai/edge-connector/internal/mcp/registry"
	"github.com/trueai/edge-connector/internal/mcp/router"
	"github.com/trueai/edge-connector/internal/policy"
	"github.com/trueai/edge-connector/internal/runtime"
)

const (
	Version   = "1.0.0"
	AppName   = "True.ai Edge Connector"
	DefaultID = "sap-adt"
)

func main() {
	configPath := flag.String("config", "", "Path to optional config JSON file")
	manifestDir := flag.String("manifests", "", "Path to directory containing MCP manifests")
	logLevel := flag.String("log-level", "", "Logging verbosity: debug, info, warn, error")
	destination := flag.String("destination", "", "SAP destination identifier (e.g. DEV, PROD)")
	sapExec := flag.String("sap-executable", "", "Explicit path to external SAP ADT MCP executable")
	sapEnvPath := flag.String("sap-env-path", "", "Path to local SAP environment file (passed to external MCP via --env-path)")
	sapSysType := flag.String("sap-system-type", "", "SAP system type, e.g. onprem (passed to external MCP via --system-type)")
	callTool := flag.String("call-tool", "", "Execute specified MCP tool and exit")
	callArgs := flag.String("call-args", "", "JSON arguments string for -call-tool")
	describeTool := flag.String("describe-tool", "", "Print description and input schema for specified MCP tool and exit")
	testRestart := flag.Bool("test-restart", false, "Test process crash detection and automatic supervisor restart recovery")
	showVersion := flag.Bool("version", false, "Print Edge version and exit")
	serverURL := flag.String("server", "", "Outbound Edge Connection Server WebSocket URL")
	userEmail := flag.String("email", "", "Registered user email")
	tenantID := flag.String("tenant", "", "Tenant identifier")
	forceSetup := flag.Bool("setup", false, "Reconfigure email and SAP connection")
	changeAccount := flag.Bool("change-account", false, "Change registered email")
	flag.Parse()

	if *showVersion {
		fmt.Printf("%s v%s\n", AppName, Version)
		os.Exit(0)
	}

	// 1. Load configuration
	cfg, err := config.LoadConfig(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: Failed to initialize configuration: %v\n", err)
		os.Exit(1)
	}

	if *manifestDir != "" {
		cfg.ManifestDir = *manifestDir
	}
	if *logLevel != "" {
		cfg.LogLevel = *logLevel
	}
	if *destination != "" {
		cfg.Destination = *destination
	}
	if *sapExec != "" {
		cfg.SAPExecutable = *sapExec
	}
	if *sapEnvPath != "" {
		cfg.SAPEnvPath = *sapEnvPath
	}
	if *sapSysType != "" {
		cfg.SAPSystemType = *sapSysType
	}
	if *serverURL != "" {
		cfg.ServerURL = *serverURL
	}
	if *userEmail != "" {
		cfg.UserEmail = *userEmail
	}
	if *tenantID != "" {
		cfg.TenantID = *tenantID
	}

	// 2. Ensure non-admin user directories (%LOCALAPPDATA%\TrueAI\Edge)
	if err := cfg.EnsureDirectories(); err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: Failed to prepare state directories: %v\n", err)
		os.Exit(1)
	}
	config.CleanupStaleSAPRuntimeEnv(cfg.StateDir)

	// 3. Initialize structured logger
	logger := logging.NewLogger(os.Stdout, cfg.LogLevel, cfg.LogJSON)
	mainLogger := logging.WithComponent(logger, logging.ComponentMain)

	mainLogger.Info("Initializing True.ai Edge Connector",
		"version", Version,
		"stateDir", cfg.StateDir,
		"logDir", cfg.LogDir,
		"manifestDir", cfg.ManifestDir,
	)
	connectionMode := !*testRestart && *describeTool == "" && *callTool == ""
	var sapConfig *config.SAPConfig
	var credentialStore config.CredentialStore
	input := bufio.NewReader(os.Stdin)
	if connectionMode {
		fmt.Printf("\n%s\n\n", AppName)
		if err := setupIdentity(cfg, *configPath, *forceSetup || *changeAccount, input, os.Stdout); err != nil {
			fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("✓ Edge identity configured\n  %s\n", cfg.UserEmail)
		credentialStore = config.NewCredentialStore()
		sapConfig, err = setupSAP(cfg, *configPath, *forceSetup, input, os.Stdout, credentialStore)
		if err != nil {
			fmt.Fprintf(os.Stderr, "FATAL: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("SAP Connection\n  System URL : %s\n  Client     : %s\n  Username   : %s\n  System     : %s\n", sapConfig.URL, sapConfig.Client, sapConfig.Username, sapConfig.SystemType)
		mainLogger.Info("Edge identity ready", "deviceId", cfg.DeviceID, "email", cfg.UserEmail)
		if cfg.ServerURL == "" {
			mainLogger.Info("Edge server not configured; local MCP mode active")
		}
	}

	// 4. Initialize core components
	pm := process.NewProcessManager(logger)
	reg := registry.NewRegistry(pm, logger)

	// Load manifests from local manifest directory if specified, or use embedded manifest
	if cfg.ManifestDir != "" {
		if err := reg.LoadManifestsDir(cfg.ManifestDir); err != nil {
			mainLogger.Warn("Could not load manifests from directory", "dir", cfg.ManifestDir, "error", err)
		}
	} else {
		mainLogger.Info("Using embedded MCP manifest", "mcpId", DefaultID)
		if len(assets.EmbeddedDefaultManifest) > 0 {
			if _, err := reg.RegisterManifestBytes(assets.EmbeddedDefaultManifest, ".yaml"); err != nil {
				mainLogger.Warn("Could not register embedded manifest", "error", err)
			}
		}
	}
	// 5. Initialize local policy engine
	policyConfig := policy.Config{
		AllowedMCPs:          []string{DefaultID},
		MaxResponseSizeBytes: cfg.MaxResponseSizeBytes,
		DefaultTimeout:       cfg.DefaultRequestTimeout,
	}
	pol := policy.NewEngine(policyConfig, logger)

	// 6. Initialize deterministic router
	mcpRouter := router.NewRouter(reg, pol, logger)

	// 7. Initialize local health monitor
	healthMon := health.NewMonitor(pm, Version)

	// Context for operational lifecycle
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var connectionDone chan struct{}
	var edgeReady chan struct{}
	var edgeConnected atomic.Bool
	if connectionMode && cfg.ServerURL != "" {
		connectionDone = make(chan struct{})
		edgeReady = make(chan struct{}, 1)
		manager := connection.New(connection.Options{ServerURL: cfg.ServerURL, UserEmail: cfg.UserEmail, DeviceID: cfg.DeviceID, Logger: mainLogger, OnMCP: connection.MCPHandler(reg, mcpRouter), OnState: func(s connection.State) {
			if s == connection.Ready {
				edgeConnected.Store(true)
				select {
				case edgeReady <- struct{}{}:
				default:
				}
			} else {
				edgeConnected.Store(false)
			}
		}})
		go func() {
			defer close(connectionDone)
			if err := manager.Run(ctx); err != nil {
				mainLogger.Error("Edge connection failed", "error", err)
			}
		}()
	}

	// 8. Ensure default MCP manifest is registered (from directory or runtime config)
	if _, ok := reg.GetInstance(DefaultID); !ok {
		execCandidate := cfg.SAPExecutable
		if execCandidate == "" && runtime.HasEmbeddedHost() {
			mainLogger.Info("Extracting embedded SAP ADT host")
			if extractedPath, err := runtime.EnsureExtracted(); err == nil {
				execCandidate = extractedPath
				mainLogger.Info("Configured embedded SAP ADT host runtime",
					"path", extractedPath,
					"sha256", runtime.EmbeddedSHA256(),
				)
			} else {
				mainLogger.Warn("Failed to extract embedded SAP ADT MCP host runtime", "error", err)
			}
		}
		if execCandidate == "" {
			execCandidate = "sap-adt-host"
		}
		defManifest := &manifest.Manifest{
			ID:             DefaultID,
			Name:           "SAP ABAP ADT MCP",
			Version:        Version,
			Transport:      "stdio",
			Executable:     execCandidate,
			Destination:    cfg.Destination,
			EnvPath:        cfg.SAPEnvPath,
			SystemType:     cfg.SAPSystemType,
			Arguments:      []string{"--transport=stdio"},
			StartupTimeout: 30 * time.Second,
			RequestTimeout: cfg.DefaultRequestTimeout,
			RestartPolicy:  manifest.DefaultRestartPolicy(),
			AllowedTools:   []string{"*"},
		}
		if err := defManifest.Validate(); err == nil {
			_, _ = reg.RegisterManifest(defManifest)
		}
	}

	if inst, ok := reg.GetInstance(DefaultID); ok {
		if connectionMode {
			attachSAPRuntime(inst, cfg, sapConfig, credentialStore, *configPath)
		}
		if *destination != "" {
			inst.Manifest().Destination = *destination
		}
		if *sapExec != "" {
			inst.Manifest().Executable = *sapExec
		}
		if *sapEnvPath != "" {
			inst.Manifest().EnvPath = *sapEnvPath
		}
		if *sapSysType != "" {
			inst.Manifest().SystemType = *sapSysType
		}

		// Check for local non-admin SAP env file if not specified via CLI or manifest
		if inst.Manifest().EnvPath == "" {
			defaultEnv := filepath.Join(cfg.StateDir, "..", "sap.env")
			if fi, err := os.Stat(defaultEnv); err == nil && !fi.IsDir() {
				inst.Manifest().EnvPath = defaultEnv
			}
		}

		// If no explicit executable override was given and embedded host is present, ensure extracted
		if *sapExec == "" && cfg.SAPExecutable == "" && runtime.HasEmbeddedHost() {
			currentExec := inst.Manifest().Executable
			if currentExec == "mcp-abap-adt" || currentExec == "sap-adt-host" || currentExec == "" {
				mainLogger.Info("Extracting embedded SAP ADT host")
				if extractedPath, err := runtime.EnsureExtracted(); err == nil {
					inst.Manifest().Executable = extractedPath
					mainLogger.Info("Configured embedded SAP ADT host runtime",
						"path", extractedPath,
						"sha256", runtime.EmbeddedSHA256(),
					)
				}
			}
		}
		mainLogger.Info("Auto-starting configured default MCP",
			"mcpId", DefaultID,
			"destination", inst.Manifest().Destination,
			"envPath", inst.Manifest().EnvPath,
			"systemType", inst.Manifest().SystemType,
			"executable", inst.Manifest().ResolveExecutable(),
		)
		if connectionMode {
			fmt.Println("Starting SAP ADT MCP...")
		}
		startCtx, cancelStart := context.WithTimeout(ctx, inst.Manifest().StartupTimeout)
		if err := inst.Start(startCtx); err != nil {
			mainLogger.Warn("Default MCP failed initial start; supervisor will retry on demand or crash backoff", "mcpId", DefaultID, "error", err)
			if connectionMode {
				fmt.Fprintln(os.Stderr, "✗ ADT MCP failed to start")
				os.Exit(1)
			}
		}
		cancelStart()
		if connectionMode {
			info := inst.ServerInfo()
			fmt.Printf("✓ MCP process started\n✓ MCP handshake succeeded\n  %s v%s\n✓ Discovered %d SAP ADT tools\n", info.Name, info.Version, len(inst.Tools()))
			for {
				checkCtx, cancelCheck := context.WithTimeout(ctx, cfg.DefaultRequestTimeout)
				checkErr := verifySAP(checkCtx, inst.Tools(), inst.Client().CallTool)
				cancelCheck()
				if checkErr == nil {
					fmt.Println("✓ SAP connection successful")
					break
				}
				fmt.Printf("✗ SAP connection failed\nReason: %s\n", checkErr)
				answer, err := promptLine(input, os.Stdout, "Retry connection? [Y/n]", "")
				if err != nil || answer == "n" || answer == "N" {
					stopCtx, stopCancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
					_ = inst.Stop(stopCtx)
					stopCancel()
					os.Exit(1)
				}
			}
			if edgeReady != nil {
				select {
				case <-edgeReady:
					if edgeConnected.Load() {
						fmt.Println("✓ Edge Server connected")
					} else {
						fmt.Println("Edge Server connection pending")
					}
				case <-time.After(12 * time.Second):
					fmt.Println("Edge Server connection pending")
				}
			} else {
				fmt.Println("Edge Server not configured")
			}
			fmt.Println("✓ ADT MCP connected")
			if edgeConnected.Load() {
				fmt.Printf("✓ %d tools available\n\n%s is READY\n", len(inst.Tools()), AppName)
			}
		}
	}

	// Mode A: Test Process Supervisor Crash Detection & Automatic Backoff Restart
	if *testRestart {
		mainLogger.Info("Starting process supervisor restart verification test...")
		inst, ok := reg.GetInstance(DefaultID)
		if !ok || inst.Status().State != process.StateRunning {
			mainLogger.Error("Default MCP process is not running for restart test")
			os.Exit(1)
		}

		initialPID := inst.Status().PID
		mainLogger.Info("Child process running normally", "initialPID", initialPID)

		// Trigger deliberate child process crash via simulate_crash tool
		mainLogger.Info("Triggering simulated crash on external child process...")
		_, _ = mcpRouter.Route(ctx, router.CallRequest{
			RequestID: "restart-test-crash-1",
			MCPID:     DefaultID,
			Tool:      "simulate_crash",
		})

		// Wait for process supervisor to detect crash and restart child process
		mainLogger.Info("Awaiting process supervisor crash detection and backoff restart...")
		restarted := false
		for i := 0; i < 40; i++ {
			time.Sleep(250 * time.Millisecond)
			st := inst.Status()
			if st.State == process.StateRunning && st.PID != 0 && st.PID != initialPID {
				mainLogger.Info("Child process successfully recovered and restarted by supervisor!",
					"oldPID", initialPID,
					"newPID", st.PID,
					"restartCount", st.RestartCount,
				)
				restarted = true
				break
			}
		}

		if !restarted {
			mainLogger.Error("Supervisor failed to automatically restart child process within timeout")
			os.Exit(1)
		}

		// Verify that tool calls execute successfully on the restarted child process
		mainLogger.Info("Verifying tool execution on restarted child process...")
		callResp, err := mcpRouter.Route(ctx, router.CallRequest{
			RequestID: "restart-test-verify-1",
			MCPID:     DefaultID,
			Tool:      "read_abap_class",
			Arguments: map[string]interface{}{
				"class_name": "ZCL_AFTER_RESTART",
			},
		})
		if err != nil {
			mainLogger.Error("Tool call on restarted process failed", "error", err)
			os.Exit(1)
		}

		mainLogger.Info("Tool call succeeded on restarted process!", "tool", "read_abap_class", "isError", callResp.IsError)
		respBytes, _ := json.MarshalIndent(callResp.Result, "", "  ")
		fmt.Printf("\n--- VERIFICATION RESULT (POST-RESTART) ---\n%s\n------------------------------------------\n\n", string(respBytes))

		// Clean shutdown
		shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancelShutdown()
		_ = mcpRouter.Close(shutdownCtx)
		pm.StopAll(shutdownCtx)
		mainLogger.Info("Restart test completed successfully. Clean shutdown.")
		_ = healthMon.FormatSummary(os.Stdout)
		os.Exit(0)
	}

	// Mode B: Describe Specified Tool and Exit Cleanly
	if *describeTool != "" {
		mainLogger.Info("Describing requested tool", "tool", *describeTool)
		inst, ok := reg.GetInstance(DefaultID)
		if !ok {
			mainLogger.Error("Default MCP instance not found")
			os.Exit(1)
		}

		desc, err := inst.DescribeTool(*describeTool)
		if err != nil {
			mainLogger.Error("Failed to describe tool", "tool", *describeTool, "error", err)
			shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
			defer cancelShutdown()
			_ = mcpRouter.Close(shutdownCtx)
			pm.StopAll(shutdownCtx)
			os.Exit(1)
		}

		fmt.Printf("\n--- TOOL DESCRIPTION ---\n%s\n------------------------\n\n", desc)

		shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancelShutdown()
		_ = mcpRouter.Close(shutdownCtx)
		pm.StopAll(shutdownCtx)
		mainLogger.Info("Graceful shutdown complete. Exiting.")
		_ = healthMon.FormatSummary(os.Stdout)
		os.Exit(0)
	}

	// Mode C: Execute Requested Tool Call via Router and Exit Cleanly
	if *callTool != "" {
		mainLogger.Info("Executing requested tool call", "tool", *callTool)
		var args map[string]interface{}
		if *callArgs != "" {
			if err := json.Unmarshal([]byte(*callArgs), &args); err != nil {
				mainLogger.Error("Invalid JSON in -call-args", "error", err)
				os.Exit(1)
			}
		}

		callCtx, cancelCall := context.WithTimeout(ctx, cfg.DefaultRequestTimeout)
		defer cancelCall()

		callResp, err := mcpRouter.Route(callCtx, router.CallRequest{
			RequestID: "cli-call-1",
			MCPID:     DefaultID,
			Tool:      *callTool,
			Arguments: args,
		})
		if err != nil {
			mainLogger.Error("Tool call execution failed", "tool", *callTool, "error", err)
			shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
			defer cancelShutdown()
			_ = mcpRouter.Close(shutdownCtx)
			pm.StopAll(shutdownCtx)
			os.Exit(1)
		}

		mainLogger.Info("Tool call executed successfully",
			"tool", *callTool,
			"duration", callResp.Duration,
			"isError", callResp.IsError,
		)

		respBytes, _ := json.MarshalIndent(callResp.Result, "", "  ")
		fmt.Printf("\n--- TOOL EXECUTION RESULT ---\n%s\n-----------------------------\n\n", string(respBytes))

		shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancelShutdown()
		_ = mcpRouter.Close(shutdownCtx)
		pm.StopAll(shutdownCtx)
		mainLogger.Info("Graceful shutdown complete. Exiting.")
		_ = healthMon.FormatSummary(os.Stdout)
		os.Exit(0)
	}

	mainLogger.Info("True.ai Edge Connector running. Awaiting requests and signals...")
	_ = healthMon.FormatSummary(os.Stdout)

	// 9. Setup OS signal trapping for graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM, syscall.SIGINT)

	sig := <-sigChan
	mainLogger.Info("Shutdown signal received; initiating graceful termination", "signal", sig.String())
	cancel()
	if connectionDone != nil {
		select {
		case <-connectionDone:
		case <-time.After(2 * time.Second):
			mainLogger.Warn("Edge connection shutdown timed out")
		}
	}

	// Graceful shutdown sequence:
	// 1. Set shutdown timeout deadline
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancelShutdown()

	// 2. Stop accepting new router requests and wait for in-flight requests
	mainLogger.Info("Step 1/3: Closing router and waiting for in-flight requests...")
	if err := mcpRouter.Close(shutdownCtx); err != nil {
		mainLogger.Warn("Router shutdown timed out or was interrupted", "error", err)
	}

	// 3. Stop all supervised MCP child processes cleanly
	mainLogger.Info("Step 2/3: Terminating all supervised MCP child processes gracefully...")
	pm.StopAll(shutdownCtx)

	// 4. Flush and exit
	mainLogger.Info("Step 3/3: Graceful shutdown complete. Exiting cleanly.")
	_ = healthMon.FormatSummary(os.Stdout)

	os.Exit(0)
}
