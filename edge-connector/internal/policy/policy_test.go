package policy

import (
	"errors"
	"testing"
)

func TestPolicyValidation(t *testing.T) {
	cfg := Config{
		AllowedMCPs: []string{"sap-adt"},
		AllowedTools: map[string][]string{
			"sap-adt": {"read_abap_class", "list_packages"},
		},
		MaxResponseSizeBytes: 1024,
	}
	engine := NewEngine(cfg, nil)

	// 1. Allowed MCP
	if err := engine.ValidateMCP("sap-adt"); err != nil {
		t.Errorf("Expected sap-adt to be allowed, got: %v", err)
	}

	// 2. Disallowed MCP
	if err := engine.ValidateMCP("unknown-mcp"); err == nil {
		t.Errorf("Expected unknown-mcp to be rejected, got nil")
	} else if !errors.Is(err, ErrMCPNotAllowed) {
		t.Errorf("Expected ErrMCPNotAllowed, got %v", err)
	}

	// 3. Allowed Tool
	discovered := []string{"read_abap_class", "list_packages", "secret_admin_tool"}
	if err := engine.ValidateTool("sap-adt", "read_abap_class", discovered); err != nil {
		t.Errorf("Expected read_abap_class to be allowed, got: %v", err)
	}

	// 4. Discovered but not whitelisted Tool
	if err := engine.ValidateTool("sap-adt", "secret_admin_tool", discovered); err == nil {
		t.Errorf("Expected secret_admin_tool to be rejected by whitelist, got nil")
	}

	// 5. Undiscovered Tool
	if err := engine.ValidateTool("sap-adt", "non_existent_tool", discovered); err == nil {
		t.Errorf("Expected non_existent_tool to be rejected, got nil")
	}

	// 6. Forbidden execution arguments
	forbiddenArgs := map[string]interface{}{
		"class_name": "ZCL_TEST",
		"executable": "powershell.exe",
	}
	if err := engine.ValidateArguments(forbiddenArgs); err == nil {
		t.Errorf("Expected rejection for forbidden argument 'executable', got nil")
	} else if !errors.Is(err, ErrDisallowedParameter) {
		t.Errorf("Expected ErrDisallowedParameter, got %v", err)
	}

	// 7. Allowed normal arguments
	safeArgs := map[string]interface{}{
		"class_name": "ZCL_TEST",
		"max_rows":   100,
	}
	if err := engine.ValidateArguments(safeArgs); err != nil {
		t.Errorf("Expected safe arguments to pass, got: %v", err)
	}

	// 8. Response size limit
	if err := engine.ValidateResponseSize(500); err != nil {
		t.Errorf("Expected 500 bytes to pass size limit, got %v", err)
	}
	if err := engine.ValidateResponseSize(2048); err == nil {
		t.Errorf("Expected 2048 bytes to exceed limit of 1024, got nil")
	} else if !errors.Is(err, ErrResponseTooLarge) {
		t.Errorf("Expected ErrResponseTooLarge, got %v", err)
	}
}

