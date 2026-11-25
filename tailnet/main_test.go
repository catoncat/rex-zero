package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
)

type fakeBackend struct {
	status   *ipnstate.Status
	statusFn func(ctx context.Context) (*ipnstate.Status, error)
	pingFn   func(ctx context.Context, ip netip.Addr, pingtype tailcfg.PingType) (*ipnstate.PingResult, error)
	dialFn   func(ctx context.Context, network, addr string) (net.Conn, error)
}

func (f *fakeBackend) Status(ctx context.Context) (*ipnstate.Status, error) {
	if f.statusFn != nil {
		return f.statusFn(ctx)
	}
	return f.status, nil
}

func (f *fakeBackend) Ping(ctx context.Context, ip netip.Addr, pingtype tailcfg.PingType) (*ipnstate.PingResult, error) {
	return f.pingFn(ctx, ip, pingtype)
}

func (f *fakeBackend) Dial(ctx context.Context, network, addr string) (net.Conn, error) {
	return f.dialFn(ctx, network, addr)
}

func TestPrepareStateDir(t *testing.T) {
	if err := prepareStateDir(""); err == nil {
		t.Fatal("expected error for empty stateDir")
	}

	dir := filepath.Join(t.TempDir(), "tsnet-state")
	if err := prepareStateDir(dir); err != nil {
		t.Fatalf("prepareStateDir failed: %v", err)
	}

	for _, p := range []string{dir, filepath.Join(dir, "logs"), filepath.Join(dir, "tmp")} {
		info, err := os.Stat(p)
		if err != nil {
			t.Fatalf("stat %s: %v", p, err)
		}
		if !info.IsDir() {
			t.Fatalf("%s is not a dir", p)
		}
		if perm := info.Mode().Perm(); perm != 0o700 {
			t.Fatalf("%s perm = %o, want 0700", p, perm)
		}
	}

	if got := os.Getenv("TS_LOGS_DIR"); got != filepath.Join(dir, "logs") {
		t.Fatalf("TS_LOGS_DIR = %q", got)
	}
	if got := os.Getenv("TMPDIR"); got != filepath.Join(dir, "tmp") {
		t.Fatalf("TMPDIR = %q", got)
	}
}

func TestBuildStateEvent(t *testing.T) {
	k1 := key.NewNode().Public()
	k2 := key.NewNode().Public()

	st := &ipnstate.Status{
		BackendState: "Running",
		CurrentTailnet: &ipnstate.TailnetStatus{
			Name: "example-tailnet.ts.net",
		},
		Self: &ipnstate.PeerStatus{
			HostName: "rex-zero",
			DNSName:  "rex-zero.example-tailnet.ts.net.",
		},
		Peer: map[key.NodePublic]*ipnstate.PeerStatus{
			k2: {
				HostName:     "moon",
				DNSName:      "moon.example-tailnet.ts.net.",
				TailscaleIPs: []netip.Addr{netip.MustParseAddr("100.64.0.2")},
				Online:       false,
				Relay:        "sin",
			},
			k1: {
				HostName:     "mini-rex",
				DNSName:      "mini-rex.example-tailnet.ts.net.",
				TailscaleIPs: []netip.Addr{netip.MustParseAddr("100.64.0.1")},
				Online:       true,
				CurAddr:      "192.168.1.10:41641",
				Relay:        "tok",
			},
		},
	}

	ev := buildStateEvent(st, "https://login.tailscale.com/a/ignored", 41234)
	if ev.BackendState != "Running" || ev.AuthURL != "" {
		t.Fatalf("unexpected state/authUrl: %+v", ev)
	}
	if ev.Tailnet != "example-tailnet.ts.net" || ev.Self != "rex-zero.example-tailnet.ts.net" {
		t.Fatalf("unexpected tailnet/self: %+v", ev)
	}
	if ev.ProxyPort != 41234 || len(ev.Peers) != 2 {
		t.Fatalf("unexpected proxyPort/peers: %+v", ev)
	}
	if ev.Peers[0].HostName != "mini-rex" || ev.Peers[0].DNSName != "mini-rex.example-tailnet.ts.net" || !ev.Peers[0].Online {
		t.Fatalf("unexpected first peer: %+v", ev.Peers[0])
	}
	if ev.Peers[1].HostName != "moon" || ev.Peers[1].Online {
		t.Fatalf("unexpected second peer: %+v", ev.Peers[1])
	}

	// NeedsLogin falls back to browseURL if st.AuthURL is empty.
	loginEv := buildStateEvent(&ipnstate.Status{BackendState: "NeedsLogin"}, "https://login.tailscale.com/a/abc", 9001)
	if loginEv.AuthURL != "https://login.tailscale.com/a/abc" {
		t.Fatalf("expected browseURL fallback, got %q", loginEv.AuthURL)
	}
	if loginEv.Peers == nil {
		t.Fatal("expected non-nil empty peers slice")
	}
}

func TestFormatPingReply(t *testing.T) {
	direct := formatPingReply(7, &ipnstate.PingResult{
		LatencySeconds: 0.0124,
		Endpoint:       "192.168.1.10:41641",
		DERPRegionCode: "tok",
	}, nil)
	if !direct.OK || direct.PathKind != "direct" || direct.Endpoint != "192.168.1.10:41641" || direct.LatencyMs == nil || *direct.LatencyMs != 12.4 {
		t.Fatalf("unexpected direct reply: %+v", direct)
	}

	relay := formatPingReply(8, &ipnstate.PingResult{
		LatencySeconds: 0.045,
		PeerRelay:      "203.0.113.1:40000:vni:1",
	}, nil)
	if !relay.OK || relay.PathKind != "relay" || relay.Endpoint != "203.0.113.1:40000:vni:1" {
		t.Fatalf("unexpected relay reply: %+v", relay)
	}

	derp := formatPingReply(9, &ipnstate.PingResult{
		LatencySeconds: 0.088,
		DERPRegionID:   18,
		DERPRegionCode: "sin",
	}, nil)
	if !derp.OK || derp.PathKind != "derp" || derp.DERPRegion != "sin" {
		t.Fatalf("unexpected derp reply: %+v", derp)
	}

	errRep := formatPingReply(10, nil, errors.New("timeout"))
	if errRep.OK || errRep.Error != "timeout" {
		t.Fatalf("unexpected error reply: %+v", errRep)
	}
}

func TestProbeRexEndpoint(t *testing.T) {
	dial443 := func(ctx context.Context, network, addr string) (net.Conn, error) {
		if strings.HasSuffix(addr, ":443") {
			c1, c2 := net.Pipe()
			_ = c2.Close()
			return c1, nil
		}
		return nil, errors.New("refused")
	}
	ep, err := probeRexEndpoint(context.Background(), dial443, "mini-rex.example-tailnet.ts.net.")
	if err != nil || ep != "https://mini-rex.example-tailnet.ts.net" {
		t.Fatalf("got (%q, %v), want https://mini-rex.example-tailnet.ts.net", ep, err)
	}

	dial7297 := func(ctx context.Context, network, addr string) (net.Conn, error) {
		if strings.HasSuffix(addr, ":7297") {
			c1, c2 := net.Pipe()
			_ = c2.Close()
			return c1, nil
		}
		return nil, errors.New("refused")
	}
	ep, err = probeRexEndpoint(context.Background(), dial7297, "mini-rex.example-tailnet.ts.net")
	if err != nil || ep != "http://mini-rex.example-tailnet.ts.net:7297" {
		t.Fatalf("got (%q, %v), want http://mini-rex.example-tailnet.ts.net:7297", ep, err)
	}

	dialFail := func(ctx context.Context, network, addr string) (net.Conn, error) {
		return nil, errors.New("unreachable")
	}
	if _, err := probeRexEndpoint(context.Background(), dialFail, "mini-rex.example-tailnet.ts.net"); err == nil {
		t.Fatal("expected error when both ports fail")
	}
}

func TestReadStdinLoopCommandsAndEOF(t *testing.T) {
	var out bytes.Buffer
	emit := newEmitter(&out)

	backend := &fakeBackend{
		pingFn: func(ctx context.Context, ip netip.Addr, pingtype tailcfg.PingType) (*ipnstate.PingResult, error) {
			return &ipnstate.PingResult{
				LatencySeconds: 0.005,
				Endpoint:       "10.0.0.2:41641",
			}, nil
		},
		dialFn: func(ctx context.Context, network, addr string) (net.Conn, error) {
			if strings.HasSuffix(addr, ":443") {
				c1, c2 := net.Pipe()
				_ = c2.Close()
				return c1, nil
			}
			return nil, errors.New("closed")
		},
	}

	var statusForced atomic.Int32
	var shutdownCount atomic.Int32

	input := strings.Join([]string{
		`{"id":1,"cmd":"status"}`,
		`{"id":2,"cmd":"ping","ip":"100.64.0.1"}`,
		`{"id":3,"cmd":" probe_rex","dnsName":"mini-rex.example-tailnet.ts.net"}`,
		`{"id":4,"cmd":"bogus"}`,
		`not-json`,
	}, "\n") + "\n"

	readStdinLoop(
		context.Background(),
		strings.NewReader(input),
		backend,
		emit,
		func(force bool) error {
			if force {
				statusForced.Add(1)
			}
			return nil
		},
		func() {
			shutdownCount.Add(1)
		},
	)

	if statusForced.Load() != 1 {
		t.Fatalf("statusForced = %d, want 1", statusForced.Load())
	}
	if shutdownCount.Load() != 1 {
		t.Fatalf("shutdownCount on EOF = %d, want 1", shutdownCount.Load())
	}

	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 5 {
		t.Fatalf("expected 5 reply lines, got %d:\n%s", len(lines), out.String())
	}

	replies := make(map[int64]replyEvent)
	for _, line := range lines {
		var rep replyEvent
		if err := json.Unmarshal([]byte(line), &rep); err != nil {
			t.Fatalf("unmarshal reply %q: %v", line, err)
		}
		replies[rep.ID] = rep
	}

	if !replies[1].OK {
		t.Fatalf("status reply not ok: %+v", replies[1])
	}
	if !replies[2].OK || replies[2].PathKind != "direct" {
		t.Fatalf("ping reply unexpected: %+v", replies[2])
	}
	if !replies[3].OK || replies[3].RexEndpoint != "https://mini-rex.example-tailnet.ts.net" {
		t.Fatalf("probe_rex reply unexpected: %+v", replies[3])
	}
	if replies[4].OK {
		t.Fatalf("unknown cmd should fail: %+v", replies[4])
	}
	if replies[0].OK {
		t.Fatalf("invalid json should fail: %+v", replies[0])
	}

	// Also verify stop command triggers shutdown without waiting for EOF.
	var stopOut bytes.Buffer
	var stopCount atomic.Int32
	done := make(chan struct{})
	go func() {
		defer close(done)
		readStdinLoop(
			context.Background(),
			strings.NewReader(`{"id":99,"cmd":"stop"}`+"\n"),
			backend,
			newEmitter(&stopOut),
			func(bool) error { return nil },
			func() { stopCount.Add(1) },
		)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("stop command timed out")
	}
	if stopCount.Load() != 1 {
		t.Fatalf("stopCount = %d, want 1", stopCount.Load())
	}
}

type syncReplyCollector struct {
	mu    sync.Mutex
	lines []string
	ch    chan string
}

func newSyncReplyCollector() *syncReplyCollector {
	return &syncReplyCollector{ch: make(chan string, 32)}
}

func (c *syncReplyCollector) Write(p []byte) (int, error) {
	c.mu.Lock()
	s := strings.TrimSpace(string(p))
	c.lines = append(c.lines, s)
	c.mu.Unlock()
	c.ch <- s
	return len(p), nil
}

func (c *syncReplyCollector) Lines() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, len(c.lines))
	copy(out, c.lines)
	return out
}

func TestReadStdinLoopBoundedConcurrency(t *testing.T) {
	collector := newSyncReplyCollector()
	emit := newEmitter(collector)

	var active atomic.Int32
	var maxActive atomic.Int32
	entered := make(chan struct{}, 10)
	release := make(chan struct{})

	backend := &fakeBackend{
		pingFn: func(ctx context.Context, ip netip.Addr, pingtype tailcfg.PingType) (*ipnstate.PingResult, error) {
			cur := active.Add(1)
			for {
				prev := maxActive.Load()
				if cur <= prev || maxActive.CompareAndSwap(prev, cur) {
					break
				}
			}
			entered <- struct{}{}
			select {
			case <-release:
			case <-ctx.Done():
			}
			active.Add(-1)
			return &ipnstate.PingResult{LatencySeconds: 0.001, Endpoint: "10.0.0.1:41641"}, nil
		},
	}

	pr, pw := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		readStdinLoop(ctx, pr, backend, emit, func(bool) error { return nil }, cancel)
	}()

	for i := 1; i <= maxConcurrentCommands; i++ {
		_, _ = io.WriteString(pw, `{"id":`+string(rune('0'+i))+`,"cmd":"ping","ip":"100.64.0.1"}`+"\n")
	}

	for i := 0; i < maxConcurrentCommands; i++ {
		select {
		case <-entered:
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for %d concurrent commands", maxConcurrentCommands)
		}
	}

	// Send 2 overflow commands while all 4 workers are busy: they must be rejected immediately without blocking the reader.
	_, _ = io.WriteString(pw, `{"id":5,"cmd":"ping","ip":"100.64.0.1"}`+"\n")
	_, _ = io.WriteString(pw, `{"id":6,"cmd":"ping","ip":"100.64.0.1"}`+"\n")

	for i := 0; i < 2; i++ {
		select {
		case line := <-collector.ch:
			var rep replyEvent
			if err := json.Unmarshal([]byte(line), &rep); err != nil {
				t.Fatalf("unmarshal busy reply %q: %v", line, err)
			}
			if rep.OK || rep.Error != "command queue busy" || (rep.ID != 5 && rep.ID != 6) {
				t.Fatalf("unexpected overload reply: %+v", rep)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for immediate command queue busy reply")
		}
	}

	if got := maxActive.Load(); got != maxConcurrentCommands {
		t.Fatalf("maxActive = %d, want %d", got, maxConcurrentCommands)
	}

	// Release the 4 in-flight workers and confirm new commands can run again.
	close(release)
	for i := 0; i < maxConcurrentCommands; i++ {
		select {
		case <-collector.ch:
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for released worker replies")
		}
	}

	_, _ = io.WriteString(pw, `{"id":7,"cmd":"ping","ip":"100.64.0.1"}`+"\n")
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("command after slot release did not run")
	}
	select {
	case line := <-collector.ch:
		var rep replyEvent
		if err := json.Unmarshal([]byte(line), &rep); err != nil {
			t.Fatalf("unmarshal reply 7: %v", err)
		}
		if rep.ID != 7 || !rep.OK {
			t.Fatalf("expected ok reply for id 7, got %+v", rep)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for reply 7")
	}

	_ = pw.Close()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("readStdinLoop did not exit after EOF")
	}
}

type blockingWriter struct {
	unblock <-chan struct{}
}

func (b *blockingWriter) Write(p []byte) (int, error) {
	<-b.unblock
	return len(p), nil
}

func TestReadStdinLoopStopImmediateAndFullStdout(t *testing.T) {
	// 1. Stop arrives while 4 slow commands are still blocked: stop must not wait for them.
	unblockSlow := make(chan struct{})
	defer close(unblockSlow)

	slowStarted := make(chan struct{}, maxConcurrentCommands)
	backend := &fakeBackend{
		pingFn: func(ctx context.Context, ip netip.Addr, pingtype tailcfg.PingType) (*ipnstate.PingResult, error) {
			slowStarted <- struct{}{}
			<-unblockSlow
			return &ipnstate.PingResult{LatencySeconds: 0.001, Endpoint: "10.0.0.1:41641"}, nil
		},
	}

	pr, pw := io.Pipe()
	var shutdownCount atomic.Int32
	done := make(chan struct{})
	go func() {
		defer close(done)
		readStdinLoop(context.Background(), pr, backend, newEmitter(&bytes.Buffer{}), func(bool) error { return nil }, func() {
			shutdownCount.Add(1)
		})
	}()

	for i := 0; i < maxConcurrentCommands; i++ {
		_, _ = io.WriteString(pw, `{"id":1,"cmd":"ping","ip":"100.64.0.1"}`+"\n")
	}
	for i := 0; i < maxConcurrentCommands; i++ {
		<-slowStarted
	}
	_, _ = io.WriteString(pw, `{"id":99,"cmd":"stop"}`+"\n")

	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("stop blocked on slow in-flight commands")
	}
	if shutdownCount.Load() != 1 {
		t.Fatalf("shutdownCount = %d, want 1", shutdownCount.Load())
	}
	_ = pw.Close()

	// 2. Full/blocked stdout pipe must not block stop shutdown or EOF exit.
	unblockPipe := make(chan struct{})
	defer close(unblockPipe)
	blockedEmit := newEmitter(&blockingWriter{unblock: unblockPipe})

	var stopShutdown atomic.Int32
	doneStop := make(chan struct{})
	go func() {
		defer close(doneStop)
		readStdinLoop(
			context.Background(),
			strings.NewReader(`{"id":100,"cmd":"stop"}`+"\n"),
			backend,
			blockedEmit,
			func(bool) error { return nil },
			func() { stopShutdown.Add(1) },
		)
	}()
	select {
	case <-doneStop:
	case <-time.After(1 * time.Second):
		t.Fatal("stop hung on blocked stdout")
	}
	if stopShutdown.Load() != 1 {
		t.Fatalf("stopShutdown = %d, want 1", stopShutdown.Load())
	}

	var eofShutdown atomic.Int32
	doneEOF := make(chan struct{})
	blockedEmit2 := newEmitter(&blockingWriter{unblock: unblockPipe})
	go func() {
		defer close(doneEOF)
		readStdinLoop(
			context.Background(),
			strings.NewReader(`{"id":101,"cmd":"unknown"}`+"\n"),
			backend,
			blockedEmit2,
			func(bool) error { return nil },
			func() { eofShutdown.Add(1) },
		)
	}()
	select {
	case <-doneEOF:
	case <-time.After(1500 * time.Millisecond):
		t.Fatal("EOF hung on blocked stdout")
	}
	if eofShutdown.Load() != 1 {
		t.Fatalf("eofShutdown = %d, want 1", eofShutdown.Load())
	}
}

func TestReadStdinLoopSaturationStopAndEOFWithBlockedStdout(t *testing.T) {
	unblockPipe := make(chan struct{})
	defer close(unblockPipe)

	t.Run("stop exits promptly with 4 saturated workers and blocked stdout", func(t *testing.T) {
		unblockSlow := make(chan struct{})
		defer close(unblockSlow)

		slowStarted := make(chan struct{}, maxConcurrentCommands)
		backend := &fakeBackend{
			pingFn: func(ctx context.Context, ip netip.Addr, pingtype tailcfg.PingType) (*ipnstate.PingResult, error) {
				slowStarted <- struct{}{}
				select {
				case <-unblockSlow:
				case <-ctx.Done():
				}
				return &ipnstate.PingResult{LatencySeconds: 0.001, Endpoint: "10.0.0.1:41641"}, nil
			},
		}

		blockedEmit := newEmitter(&blockingWriter{unblock: unblockPipe})
		pr, pw := io.Pipe()
		var shutdownCount atomic.Int32
		done := make(chan struct{})
		go func() {
			defer close(done)
			readStdinLoop(context.Background(), pr, backend, blockedEmit, func(bool) error { return nil }, func() {
				shutdownCount.Add(1)
			})
		}()

		for i := 1; i <= maxConcurrentCommands; i++ {
			_, _ = io.WriteString(pw, `{"id":1,"cmd":"ping","ip":"100.64.0.1"}`+"\n")
		}
		for i := 0; i < maxConcurrentCommands; i++ {
			<-slowStarted
		}

		// 5th command saturates sem while stdout is unconsumed; stop right behind it must still run promptly.
		_, _ = io.WriteString(pw, `{"id":5,"cmd":"ping","ip":"100.64.0.1"}`+"\n")
		_, _ = io.WriteString(pw, `{"id":99,"cmd":"stop"}`+"\n")

		select {
		case <-done:
		case <-time.After(1 * time.Second):
			t.Fatal("stop blocked with 4 saturated workers and blocked stdout")
		}
		if shutdownCount.Load() != 1 {
			t.Fatalf("shutdownCount = %d, want 1", shutdownCount.Load())
		}
		_ = pw.Close()
	})

	t.Run("EOF exits promptly when 4 workers block on stdout", func(t *testing.T) {
		workerEntered := make(chan struct{}, maxConcurrentCommands)
		backend := &fakeBackend{
			pingFn: func(ctx context.Context, ip netip.Addr, pingtype tailcfg.PingType) (*ipnstate.PingResult, error) {
				workerEntered <- struct{}{}
				// Return immediately so all 4 workers block inside emit on the full/unconsumed stdout writer.
				return &ipnstate.PingResult{LatencySeconds: 0.001, Endpoint: "10.0.0.1:41641"}, nil
			},
		}

		blockedEmit := newEmitter(&blockingWriter{unblock: unblockPipe})
		pr, pw := io.Pipe()
		var shutdownCount atomic.Int32
		done := make(chan struct{})
		go func() {
			defer close(done)
			readStdinLoop(context.Background(), pr, backend, blockedEmit, func(bool) error { return nil }, func() {
				shutdownCount.Add(1)
			})
		}()

		for i := 1; i <= maxConcurrentCommands; i++ {
			_, _ = io.WriteString(pw, `{"id":1,"cmd":"ping","ip":"100.64.0.1"}`+"\n")
		}
		for i := 0; i < maxConcurrentCommands; i++ {
			<-workerEntered
		}
		// Give workers a moment to enter blocked stdout write while holding sem.
		time.Sleep(20 * time.Millisecond)

		// 5th command hits busy path, then stdin closes (EOF).
		_, _ = io.WriteString(pw, `{"id":5,"cmd":"ping","ip":"100.64.0.1"}`+"\n")
		_ = pw.Close()

		select {
		case <-done:
		case <-time.After(1500 * time.Millisecond):
			t.Fatal("EOF hung with 4 saturated workers blocked on stdout")
		}
		if shutdownCount.Load() != 1 {
			t.Fatalf("shutdownCount = %d, want 1", shutdownCount.Load())
		}
	})
}

func TestStateTrackerSerializesConcurrentStatusAndWatcher(t *testing.T) {
	firstEntered := make(chan struct{})
	releaseFirst := make(chan struct{})
	var callNum atomic.Int32

	backend := &fakeBackend{
		statusFn: func(ctx context.Context) (*ipnstate.Status, error) {
			n := callNum.Add(1)
			if n == 1 {
				close(firstEntered)
				<-releaseFirst
				return &ipnstate.Status{BackendState: "Starting"}, nil
			}
			return &ipnstate.Status{BackendState: "Running"}, nil
		},
	}

	collector := newSyncReplyCollector()
	tracker := newStateTracker(backend, newEmitter(collector), 41234)

	watcherDone := make(chan error, 1)
	go func() {
		watcherDone <- tracker.emitState(context.Background(), false)
	}()

	<-firstEntered

	statusDone := make(chan error, 1)
	go func() {
		statusDone <- tracker.emitState(context.Background(), true)
	}()

	// Give statusDone a moment to contend on statusMu; it must not overtake the watcher snapshot.
	time.Sleep(20 * time.Millisecond)
	select {
	case <-statusDone:
		t.Fatal("concurrent status command overtook in-flight watcher snapshot")
	default:
	}

	close(releaseFirst)
	if err := <-watcherDone; err != nil {
		t.Fatalf("watcher emitState failed: %v", err)
	}
	if err := <-statusDone; err != nil {
		t.Fatalf("status emitState failed: %v", err)
	}

	lines := collector.Lines()
	if len(lines) != 2 {
		t.Fatalf("expected 2 state events, got %d: %v", len(lines), lines)
	}
	var firstEv, secondEv stateEvent
	if err := json.Unmarshal([]byte(lines[0]), &firstEv); err != nil {
		t.Fatalf("unmarshal first event: %v", err)
	}
	if err := json.Unmarshal([]byte(lines[1]), &secondEv); err != nil {
		t.Fatalf("unmarshal second event: %v", err)
	}
	if firstEv.BackendState != "Starting" || secondEv.BackendState != "Running" {
		t.Fatalf("expected [Starting, Running], got [%s, %s]", firstEv.BackendState, secondEv.BackendState)
	}

	// Subsequent non-forced Running snapshot must be deduplicated (lastStateJSON holds Running, not Starting).
	if err := tracker.emitState(context.Background(), false); err != nil {
		t.Fatalf("dedup emitState failed: %v", err)
	}
	if len(collector.Lines()) != 2 {
		t.Fatalf("expected deduplication after Running snapshot, got %d events", len(collector.Lines()))
	}
}

func TestStatusErrorPropagationPreservesPeers(t *testing.T) {
	k1 := key.NewNode().Public()
	goodStatus := &ipnstate.Status{
		BackendState: "Running",
		Self:         &ipnstate.PeerStatus{HostName: "rex-zero", DNSName: "rex-zero.ts.net."},
		Peer: map[key.NodePublic]*ipnstate.PeerStatus{
			k1: {
				HostName:     "mini-rex",
				DNSName:      "mini-rex.ts.net.",
				TailscaleIPs: []netip.Addr{netip.MustParseAddr("100.64.0.1")},
				Online:       true,
			},
		},
	}

	var mu sync.Mutex
	var statusErr error
	backend := &fakeBackend{
		statusFn: func(ctx context.Context) (*ipnstate.Status, error) {
			mu.Lock()
			defer mu.Unlock()
			if statusErr != nil {
				return nil, statusErr
			}
			return goodStatus, nil
		},
	}

	var out bytes.Buffer
	emit := newEmitter(&out)
	tracker := newStateTracker(backend, emit, 41234)
	emitState := func(force bool) error {
		return tracker.emitState(context.Background(), force)
	}

	// Initial good status populates lastStateJSON and emits 1 peer.
	if err := emitState(true); err != nil {
		t.Fatalf("initial emitState failed: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("expected 1 state event, got %d", len(lines))
	}
	var stEv stateEvent
	if err := json.Unmarshal([]byte(lines[0]), &stEv); err != nil {
		t.Fatalf("unmarshal state: %v", err)
	}
	if len(stEv.Peers) != 1 || stEv.Peers[0].HostName != "mini-rex" {
		t.Fatalf("unexpected initial peers: %+v", stEv.Peers)
	}

	// Simulate lc.Status failure during explicit status command.
	out.Reset()
	mu.Lock()
	statusErr = errors.New("status timeout")
	mu.Unlock()

	handleCommand(context.Background(), stdinCommand{ID: 7, Cmd: "status"}, backend, emit, emitState, func() {})

	errLines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(errLines) != 1 {
		t.Fatalf("expected only 1 reply line (no wiped state event), got %d:\n%s", len(errLines), out.String())
	}
	var rep replyEvent
	if err := json.Unmarshal([]byte(errLines[0]), &rep); err != nil {
		t.Fatalf("unmarshal reply: %v", err)
	}
	if rep.ID != 7 || rep.OK || !strings.Contains(rep.Error, "status timeout") {
		t.Fatalf("expected ok:false with status timeout, got %+v", rep)
	}

	// Clear error and run non-forced emitState: lastStateJSON must still match goodStatus so no spurious diff is emitted.
	out.Reset()
	mu.Lock()
	statusErr = nil
	mu.Unlock()
	if err := emitState(false); err != nil {
		t.Fatalf("emitState after recovery failed: %v", err)
	}
	if out.Len() != 0 {
		t.Fatalf("expected lastStateJSON preserved (no re-emit), got:\n%s", out.String())
	}
}

type fakeWatcher struct {
	mu     sync.Mutex
	items  []ipn.Notify
	err    error
	closed atomic.Bool
}

func (w *fakeWatcher) Next() (ipn.Notify, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.items) > 0 {
		n := w.items[0]
		w.items = w.items[1:]
		return n, nil
	}
	if w.err != nil {
		return ipn.Notify{}, w.err
	}
	return ipn.Notify{}, io.EOF
}

func (w *fakeWatcher) Close() error {
	w.closed.Store(true)
	return nil
}

func TestWatchLoopReconnectsOnDisconnect(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var statusCalls atomic.Int32
	backend := &fakeBackend{
		statusFn: func(ctx context.Context) (*ipnstate.Status, error) {
			statusCalls.Add(1)
			return &ipnstate.Status{BackendState: "Running"}, nil
		},
	}

	var out bytes.Buffer
	tracker := newStateTracker(backend, newEmitter(&out), 9000)

	w1 := &fakeWatcher{
		items: []ipn.Notify{{BrowseToURL: ptr("https://login.tailscale.com/a/1")}},
		err:   errors.New("bus disconnected"),
	}
	w2 := &fakeWatcher{
		items: []ipn.Notify{{State: ptr(ipn.Running)}},
		err:   context.Canceled,
	}

	var watchAttempts atomic.Int32
	watchFn := func(watchCtx context.Context) (ipnBusWatcher, error) {
		n := watchAttempts.Add(1)
		switch n {
		case 1:
			return w1, nil
		case 2:
			return nil, errors.New("temporary dial error")
		case 3:
			cancel()
			return w2, nil
		default:
			return nil, context.Canceled
		}
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		watchLoop(ctx, watchFn, tracker, 10*time.Millisecond)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("watchLoop did not reconnect and exit on cancel")
	}

	if !w1.closed.Load() {
		t.Fatal("expected disconnected watcher w1 to be closed")
	}
	if watchAttempts.Load() != 3 {
		t.Fatalf("watchAttempts = %d, want 3", watchAttempts.Load())
	}
	if statusCalls.Load() < 2 {
		t.Fatalf("expected fallback status polls while disconnected, got %d", statusCalls.Load())
	}
}

type gatedCollector struct {
	mu      sync.Mutex
	lines   []string
	blockB  bool
	entered chan struct{}
	release chan struct{}
}

func (g *gatedCollector) Write(p []byte) (int, error) {
	s := strings.TrimSpace(string(p))
	g.mu.Lock()
	shouldBlock := g.blockB && strings.Contains(s, `"backendState":"NeedsLogin"`)
	if shouldBlock {
		g.blockB = false
	}
	g.mu.Unlock()
	if shouldBlock {
		close(g.entered)
		<-g.release
	}
	g.mu.Lock()
	g.lines = append(g.lines, s)
	g.mu.Unlock()
	return len(p), nil
}

func (g *gatedCollector) Lines() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]string, len(g.lines))
	copy(out, g.lines)
	return out
}

func TestTimedOutStateWriteConvergesToLatestSnapshot(t *testing.T) {
	gc := &gatedCollector{
		blockB:  true,
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
	emit := newEmitter(gc)

	stateA, _ := json.Marshal(stateEvent{Type: "state", BackendState: "Running", Peers: []peerInfo{}})
	stateB, _ := json.Marshal(stateEvent{Type: "state", BackendState: "NeedsLogin", Peers: []peerInfo{}})

	if !emit.publishState(stateA, false, 200*time.Millisecond) {
		t.Fatal("initial state A should publish")
	}

	// Publish B while writer blocks >50ms -> times out, leaving B in flight.
	if emit.publishState(stateB, false, 30*time.Millisecond) {
		t.Fatal("expected state B write to time out while gated")
	}
	<-gc.entered

	// Backend returns to A before B finishes draining: A must NOT be suppressed by stale cache!
	_ = emit.publishState(stateA, false, 10*time.Millisecond)

	// Unblock stdout and wait for emitter to drain.
	close(gc.release)
	if !emit.drain(500 * time.Millisecond) {
		t.Fatal("emitter failed to drain after unblocking")
	}

	lines := gc.Lines()
	if len(lines) != 3 {
		t.Fatalf("expected [Running, NeedsLogin, Running], got %d lines: %v", len(lines), lines)
	}
	var last stateEvent
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &last); err != nil {
		t.Fatalf("unmarshal last state: %v", err)
	}
	if last.BackendState != "Running" {
		t.Fatalf("consumer left on stale state %q, want Running", last.BackendState)
	}
}

func TestBurstBusyCommandsDoNotDelayStopWithBlockedStdout(t *testing.T) {
	unblockPipe := make(chan struct{})
	defer close(unblockPipe)
	unblockSlow := make(chan struct{})
	defer close(unblockSlow)

	slowStarted := make(chan struct{}, maxConcurrentCommands)
	backend := &fakeBackend{
		pingFn: func(ctx context.Context, ip netip.Addr, pingtype tailcfg.PingType) (*ipnstate.PingResult, error) {
			slowStarted <- struct{}{}
			<-unblockSlow
			return &ipnstate.PingResult{LatencySeconds: 0.001, Endpoint: "10.0.0.1:41641"}, nil
		},
	}

	blockedEmit := newEmitter(&blockingWriter{unblock: unblockPipe})
	pr, pw := io.Pipe()
	var shutdownCount atomic.Int32
	done := make(chan struct{})
	go func() {
		defer close(done)
		readStdinLoop(context.Background(), pr, backend, blockedEmit, func(bool) error { return nil }, func() {
			shutdownCount.Add(1)
		})
	}()

	for i := 0; i < maxConcurrentCommands; i++ {
		_, _ = io.WriteString(pw, `{"id":1,"cmd":"ping","ip":"100.64.0.1"}`+"\n")
	}
	for i := 0; i < maxConcurrentCommands; i++ {
		<-slowStarted
	}

	// Send 150 rejected commands + stop while stdout is completely blocked: must finish in <350ms, not 15s!
	start := time.Now()
	var burst strings.Builder
	for i := 0; i < 150; i++ {
		burst.WriteString(`{"id":50,"cmd":"ping","ip":"100.64.0.1"}` + "\n")
	}
	burst.WriteString(`{"id":999,"cmd":"stop"}` + "\n")
	_, _ = io.WriteString(pw, burst.String())

	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("150 rejected commands delayed stop under blocked stdout")
	}
	if elapsed := time.Since(start); elapsed > 400*time.Millisecond {
		t.Fatalf("stop took too long (%v)", elapsed)
	}
	if shutdownCount.Load() != 1 {
		t.Fatalf("shutdownCount = %d, want 1", shutdownCount.Load())
	}
	_ = pw.Close()
}

func ptr[T any](v T) *T { return &v }
