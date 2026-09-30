//go:build windows

package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"unsafe"
)

var consoleDLL = syscall.NewLazyDLL("kernel32.dll")
var getConsoleMode = consoleDLL.NewProc("GetConsoleMode")
var setConsoleMode = consoleDLL.NewProc("SetConsoleMode")

func readPassword(in *bufio.Reader, out io.Writer) (string, error) {
	fmt.Fprint(out, "SAP Password:\n> ")
	handle := uintptr(os.Stdin.Fd())
	var mode uint32
	if r, _, _ := getConsoleMode.Call(handle, uintptr(unsafe.Pointer(&mode))); r != 0 {
		if r, _, _ := setConsoleMode.Call(handle, uintptr(mode&^0x0004)); r == 0 {
			return "", fmt.Errorf("cannot mask password input")
		}
		defer setConsoleMode.Call(handle, uintptr(mode))
		defer fmt.Fprintln(out)
	}
	line, err := in.ReadString('\n')
	if err != nil && len(line) == 0 {
		return "", fmt.Errorf("SAP password input required")
	}
	return strings.TrimRight(line, "\r\n"), nil
}
