package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"strings"
	"testing"
)

// The entrypoint and outbound connection layer must never create a listener.
func TestNoInboundListener(t *testing.T) {
	for _, pattern := range []string{"*.go", filepath.Join("..", "..", "internal", "connection", "*.go")} {
		files, err := filepath.Glob(pattern)
		if err != nil {
			t.Fatal(err)
		}
		for _, path := range files {
			if strings.HasSuffix(path, "_test.go") {
				continue
			}
			f, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
			if err != nil {
				t.Fatal(err)
			}
			ast.Inspect(f, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				switch sel.Sel.Name {
				case "Listen", "ListenAndServe", "ListenAndServeTLS":
					t.Errorf("inbound listener call in %s", path)
				}
				return true
			})
		}
	}
}
