//go:build !linux

package main

func installParentDeathSignal() error {
	return nil
}
