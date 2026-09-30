//go:build !windows

package main

import (
	"bufio"
	"errors"
	"io"
)

func readPassword(*bufio.Reader, io.Writer) (string, error) {
	return "", errors.New("masked password input requires Windows")
}
