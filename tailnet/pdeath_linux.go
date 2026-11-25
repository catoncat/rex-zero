//go:build linux

package main

import (
	"os"

	"golang.org/x/sys/unix"
)

func installParentDeathSignal() error {
	if err := unix.Prctl(unix.PR_SET_PDEATHSIG, uintptr(unix.SIGTERM), 0, 0, 0); err != nil {
		return err
	}
	if os.Getppid() == 1 {
		os.Exit(0)
	}
	return nil
}
