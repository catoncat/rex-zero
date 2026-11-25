package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/net/socks5"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/types/logger"
)

const (
	pingTimeout           = 4 * time.Second
	probeTimeout          = 2500 * time.Millisecond
	statusTimeout         = 3 * time.Second
	maxConcurrentCommands = 4
	stopReplyTimeout      = 100 * time.Millisecond
	readyWriteTimeout     = 2 * time.Second
	emitWriteTimeout      = 500 * time.Millisecond
	eofDrainTimeout       = 500 * time.Millisecond
	watchRetryInterval    = 1500 * time.Millisecond
	replyQueueCap         = 32
)

type queuedWrite struct {
	line []byte
	done chan error
}

type emitter struct {
	out     io.Writer
	replyCh chan queuedWrite
	stateCh chan struct{}

	mu                 sync.Mutex
	inFlightReplies    int
	pendingState       []byte
	pendingStateDone   chan error
	inFlightState      string
	lastDeliveredState string
	idleCh             chan struct{}
}

func newEmitter(out io.Writer) *emitter {
	idle := make(chan struct{})
	close(idle)
	e := &emitter{
		out:     out,
		replyCh: make(chan queuedWrite, replyQueueCap),
		stateCh: make(chan struct{}, 1),
		idleCh:  idle,
	}
	go e.writeLoop()
	return e
}

func (e *emitter) markBusyLocked() {
	select {
	case <-e.idleCh:
		e.idleCh = make(chan struct{})
	default:
	}
}

func (e *emitter) updateIdleLocked() {
	if e.inFlightReplies == 0 && len(e.replyCh) == 0 && len(e.pendingState) == 0 && e.inFlightState == "" {
		select {
		case <-e.idleCh:
		default:
			close(e.idleCh)
		}
	}
}

func (e *emitter) drain(timeout time.Duration) bool {
	e.mu.Lock()
	e.updateIdleLocked()
	ch := e.idleCh
	e.mu.Unlock()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-ch:
		return true
	case <-timer.C:
		return false
	}
}

func writeFull(w io.Writer, buf []byte) error {
	for len(buf) > 0 {
		n, err := w.Write(buf)
		if err != nil {
			return err
		}
		if n <= 0 {
			return io.ErrShortWrite
		}
		buf = buf[n:]
	}
	return nil
}

func (e *emitter) writeLoop() {
	writeReply := func(req queuedWrite) {
		err := writeFull(e.out, req.line)
		if req.done != nil {
			req.done <- err
			close(req.done)
		}

		e.mu.Lock()
		e.inFlightReplies--
		e.updateIdleLocked()
		e.mu.Unlock()
	}

	writeState := func() bool {
		e.mu.Lock()
		if len(e.pendingState) == 0 {
			e.updateIdleLocked()
			e.mu.Unlock()
			return false
		}
		e.markBusyLocked()
		payload := e.pendingState
		done := e.pendingStateDone
		e.pendingState = nil
		e.pendingStateDone = nil
		serialized := string(payload[:len(payload)-1])
		e.inFlightState = serialized
		e.lastDeliveredState = ""
		e.mu.Unlock()

		err := writeFull(e.out, payload)

		e.mu.Lock()
		e.inFlightState = ""
		if err == nil {
			e.lastDeliveredState = serialized
		}
		hasMore := len(e.pendingState) > 0
		e.updateIdleLocked()
		e.mu.Unlock()

		if done != nil {
			done <- err
			close(done)
		}
		if hasMore {
			select {
			case e.stateCh <- struct{}{}:
			default:
			}
		}
		return true
	}

	for {
		select {
		case req := <-e.replyCh:
			writeReply(req)
			continue
		default:
		}

		if writeState() {
			continue
		}

		select {
		case req := <-e.replyCh:
			writeReply(req)
		case <-e.stateCh:
			writeState()
		}
	}
}

func (e *emitter) emit(v any) {
	e.emitBounded(v, emitWriteTimeout)
}

func (e *emitter) emitNonBlocking(v any) bool {
	b, err := json.Marshal(v)
	if err != nil {
		return false
	}
	e.mu.Lock()
	select {
	case e.replyCh <- queuedWrite{line: append(b, '\n')}:
		e.inFlightReplies++
		e.markBusyLocked()
		e.mu.Unlock()
		return true
	default:
		e.mu.Unlock()
		return false
	}
}

func (e *emitter) emitBounded(v any, timeout time.Duration) bool {
	b, err := json.Marshal(v)
	if err != nil {
		return false
	}
	done := make(chan error, 1)
	req := queuedWrite{line: append(b, '\n'), done: done}
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	e.mu.Lock()
	e.inFlightReplies++
	e.markBusyLocked()
	select {
	case e.replyCh <- req:
		e.mu.Unlock()
	default:
		e.mu.Unlock()
		select {
		case e.replyCh <- req:
		case <-timer.C:
			e.mu.Lock()
			e.inFlightReplies--
			e.updateIdleLocked()
			e.mu.Unlock()
			return false
		}
	}

	select {
	case werr := <-done:
		return werr == nil
	case <-timer.C:
		return false
	}
}

func (e *emitter) publishState(encoded []byte, force bool, timeout time.Duration) bool {
	serialized := string(encoded)
	e.mu.Lock()
	if !force && len(e.pendingState) == 0 && e.inFlightState == "" && serialized == e.lastDeliveredState {
		e.mu.Unlock()
		return true
	}
	if !force && len(e.pendingState) > 0 && string(e.pendingState[:len(e.pendingState)-1]) == serialized {
		done := e.pendingStateDone
		e.mu.Unlock()
		return waitWriteResult(done, timeout)
	}
	// Replace any older unsent snapshot so blocked stdout always converges to latest state.
	if e.pendingStateDone != nil {
		e.pendingStateDone <- nil
		close(e.pendingStateDone)
	}
	done := make(chan error, 1)
	line := make([]byte, len(encoded)+1)
	copy(line, encoded)
	line[len(encoded)] = '\n'
	e.pendingState = line
	e.pendingStateDone = done
	e.markBusyLocked()
	e.mu.Unlock()

	select {
	case e.stateCh <- struct{}{}:
	default:
	}
	return waitWriteResult(done, timeout)
}

func waitWriteResult(ch <-chan error, timeout time.Duration) bool {
	if ch == nil {
		return true
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err, ok := <-ch:
		return !ok || err == nil
	case <-timer.C:
		return false
	}
}

type readyEvent struct {
	Type      string `json:"type"`
	ProxyPort int    `json:"proxyPort"`
}

type peerInfo struct {
	HostName string   `json:"hostName"`
	DNSName  string   `json:"dnsName"`
	IPs      []string `json:"ips"`
	Online   bool     `json:"online"`
	CurAddr  string   `json:"curAddr"`
	Relay    string   `json:"relay"`
}

type stateEvent struct {
	Type         string     `json:"type"`
	BackendState string     `json:"backendState"`
	AuthURL      string     `json:"authUrl"`
	Tailnet      string     `json:"tailnet"`
	Self         string     `json:"self"`
	ProxyPort    int        `json:"proxyPort"`
	Peers        []peerInfo `json:"peers"`
}

type replyEvent struct {
	Type        string   `json:"type"`
	ID          int64    `json:"id"`
	OK          bool     `json:"ok"`
	Error       string   `json:"error,omitempty"`
	LatencyMs   *float64 `json:"latencyMs,omitempty"`
	PathKind    string   `json:"pathKind,omitempty"`
	Endpoint    string   `json:"endpoint,omitempty"`
	DERPRegion  string   `json:"derpRegion,omitempty"`
	RexEndpoint string   `json:"rexEndpoint,omitempty"`
}

type stdinCommand struct {
	ID      int64  `json:"id"`
	Cmd     string `json:"cmd"`
	IP      string `json:"ip"`
	DNSName string `json:"dnsName"`
}

func prepareStateDir(stateDir string) error {
	if strings.TrimSpace(stateDir) == "" {
		return errors.New("--state-dir is required")
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return fmt.Errorf("create state dir: %w", err)
	}
	_ = os.Chmod(stateDir, 0o700)

	logsDir := filepath.Join(stateDir, "logs")
	if err := os.MkdirAll(logsDir, 0o700); err != nil {
		return fmt.Errorf("create logs dir: %w", err)
	}
	_ = os.Chmod(logsDir, 0o700)

	tmpDir := filepath.Join(stateDir, "tmp")
	if err := os.MkdirAll(tmpDir, 0o700); err != nil {
		return fmt.Errorf("create tmp dir: %w", err)
	}
	_ = os.Chmod(tmpDir, 0o700)

	if err := os.Setenv("TS_LOGS_DIR", logsDir); err != nil {
		return fmt.Errorf("set TS_LOGS_DIR: %w", err)
	}
	if err := os.Setenv("TMPDIR", tmpDir); err != nil {
		return fmt.Errorf("set TMPDIR: %w", err)
	}
	return nil
}

func buildStateEvent(st *ipnstate.Status, browseURL string, proxyPort int) stateEvent {
	ev := stateEvent{
		Type:      "state",
		ProxyPort: proxyPort,
		Peers:     make([]peerInfo, 0),
	}
	if st == nil {
		ev.AuthURL = browseURL
		return ev
	}
	ev.BackendState = st.BackendState
	ev.AuthURL = st.AuthURL
	if ev.AuthURL == "" && st.BackendState != "Running" {
		ev.AuthURL = browseURL
	}
	if st.CurrentTailnet != nil {
		ev.Tailnet = st.CurrentTailnet.Name
	}
	if st.Self != nil {
		ev.Self = strings.TrimSuffix(st.Self.DNSName, ".")
		if ev.Self == "" {
			ev.Self = st.Self.HostName
		}
	}
	if len(st.Peer) > 0 {
		peers := make([]peerInfo, 0, len(st.Peer))
		for _, p := range st.Peer {
			if p == nil {
				continue
			}
			ips := make([]string, 0, len(p.TailscaleIPs))
			for _, ip := range p.TailscaleIPs {
				if ip.IsValid() {
					ips = append(ips, ip.String())
				}
			}
			peers = append(peers, peerInfo{
				HostName: p.HostName,
				DNSName:  strings.TrimSuffix(p.DNSName, "."),
				IPs:      ips,
				Online:   p.Online,
				CurAddr:  p.CurAddr,
				Relay:    p.Relay,
			})
		}
		sort.Slice(peers, func(i, j int) bool {
			if peers[i].HostName != peers[j].HostName {
				return peers[i].HostName < peers[j].HostName
			}
			return peers[i].DNSName < peers[j].DNSName
		})
		ev.Peers = peers
	}
	return ev
}

func formatPingReply(id int64, res *ipnstate.PingResult, err error) replyEvent {
	if err != nil {
		return replyEvent{
			Type:  "reply",
			ID:    id,
			OK:    false,
			Error: err.Error(),
		}
	}
	if res == nil {
		return replyEvent{
			Type:  "reply",
			ID:    id,
			OK:    false,
			Error: "empty ping result",
		}
	}
	if res.Err != "" {
		return replyEvent{
			Type:  "reply",
			ID:    id,
			OK:    false,
			Error: res.Err,
		}
	}

	ms := math.Round(res.LatencySeconds*10000) / 10
	pathKind := "derp"
	endpoint := ""
	derpRegion := res.DERPRegionCode
	if derpRegion == "" && res.DERPRegionID != 0 {
		derpRegion = fmt.Sprintf("%d", res.DERPRegionID)
	}
	if res.Endpoint != "" {
		pathKind = "direct"
		endpoint = res.Endpoint
	} else if res.PeerRelay != "" {
		pathKind = "relay"
		endpoint = res.PeerRelay
	}

	return replyEvent{
		Type:       "reply",
		ID:         id,
		OK:         true,
		LatencyMs:  &ms,
		PathKind:   pathKind,
		Endpoint:   endpoint,
		DERPRegion: derpRegion,
	}
}

type dialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

func probeRexEndpoint(ctx context.Context, dial dialFunc, dnsName string) (string, error) {
	host := strings.TrimSuffix(strings.TrimSpace(dnsName), ".")
	if host == "" {
		return "", errors.New("dnsName is required")
	}

	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()

	type probeRes struct {
		port int
		err  error
	}

	ch := make(chan probeRes, 2)
	for _, port := range []int{443, 7297} {
		go func(p int) {
			addr := net.JoinHostPort(host, fmt.Sprintf("%d", p))
			conn, err := dial(probeCtx, "tcp", addr)
			if err == nil && conn != nil {
				_ = conn.Close()
			}
			ch <- probeRes{port: p, err: err}
		}(port)
	}

	var ok443, ok7297 bool
	var err443, err7297 error
	for i := 0; i < 2; i++ {
		r := <-ch
		if r.port == 443 {
			ok443 = r.err == nil
			err443 = r.err
			if ok443 {
				cancel()
				return "https://" + host, nil
			}
		} else {
			ok7297 = r.err == nil
			err7297 = r.err
		}
	}

	if ok7297 {
		return "http://" + net.JoinHostPort(host, "7297"), nil
	}
	return "", fmt.Errorf("no Rex listener on %s (443: %v; 7297: %v)", host, err443, err7297)
}

type backendClient interface {
	Status(ctx context.Context) (*ipnstate.Status, error)
	Ping(ctx context.Context, ip netip.Addr, pingtype tailcfg.PingType) (*ipnstate.PingResult, error)
	Dial(ctx context.Context, network, addr string) (net.Conn, error)
}

type tsnetBackend struct {
	srv *tsnet.Server
	lc  *local.Client
}

func (b *tsnetBackend) Status(ctx context.Context) (*ipnstate.Status, error) {
	return b.lc.Status(ctx)
}

func (b *tsnetBackend) Ping(ctx context.Context, ip netip.Addr, pingtype tailcfg.PingType) (*ipnstate.PingResult, error) {
	return b.lc.Ping(ctx, ip, pingtype)
}

func (b *tsnetBackend) Dial(ctx context.Context, network, addr string) (net.Conn, error) {
	return b.srv.Dial(ctx, network, addr)
}

type stateTracker struct {
	mu            sync.Mutex
	statusMu      sync.Mutex
	lastBrowseURL string
	proxyPort     int
	backend       backendClient
	emit          *emitter
}

func newStateTracker(backend backendClient, emit *emitter, proxyPort int) *stateTracker {
	return &stateTracker{
		backend:   backend,
		emit:      emit,
		proxyPort: proxyPort,
	}
}

func (s *stateTracker) setBrowseURL(url string) {
	s.mu.Lock()
	s.lastBrowseURL = url
	s.mu.Unlock()
}

func (s *stateTracker) emitState(ctx context.Context, force bool) error {
	s.statusMu.Lock()
	defer s.statusMu.Unlock()

	statusCtx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()
	st, err := s.backend.Status(statusCtx)
	if err != nil {
		return err
	}

	s.mu.Lock()
	browseURL := s.lastBrowseURL
	s.mu.Unlock()

	ev := buildStateEvent(st, browseURL, s.proxyPort)
	encoded, marshalErr := json.Marshal(ev)
	if marshalErr != nil {
		return marshalErr
	}
	if !s.emit.publishState(encoded, force, emitWriteTimeout) {
		return errors.New("emit state timed out")
	}
	return nil
}

type ipnBusWatcher interface {
	Next() (ipn.Notify, error)
	Close() error
}

func waitOrDone(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func watchLoop(
	ctx context.Context,
	watchFn func(context.Context) (ipnBusWatcher, error),
	tracker *stateTracker,
	retryInterval time.Duration,
) {
	_ = tracker.emitState(ctx, true)

	for {
		if ctx.Err() != nil {
			return
		}
		watcher, err := watchFn(ctx)
		if err != nil {
			if !waitOrDone(ctx, retryInterval) {
				return
			}
			_ = tracker.emitState(ctx, false)
			continue
		}

		for {
			n, err := watcher.Next()
			if err != nil {
				_ = watcher.Close()
				break
			}
			if n.BrowseToURL != nil {
				tracker.setBrowseURL(*n.BrowseToURL)
			} else if n.State != nil && *n.State == ipn.Running {
				tracker.setBrowseURL("")
			}
			if n.State != nil || n.BrowseToURL != nil || n.LoginFinished != nil || n.SelfChange != nil || len(n.PeersChanged) > 0 || len(n.PeersRemoved) > 0 || n.InitialStatus != nil {
				_ = tracker.emitState(ctx, false)
			}
		}

		if ctx.Err() != nil {
			return
		}
		if !waitOrDone(ctx, retryInterval) {
			return
		}
		_ = tracker.emitState(ctx, false)
	}
}

func waitGroupWithTimeout(wg *sync.WaitGroup, timeout time.Duration) {
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
	}
}

func handleCommand(
	ctx context.Context,
	cmd stdinCommand,
	backend backendClient,
	emit *emitter,
	emitState func(force bool) error,
	shutdown func(),
) {
	name := strings.TrimSpace(cmd.Cmd)
	switch name {
	case "status":
		if err := emitState(true); err != nil {
			emit.emit(replyEvent{Type: "reply", ID: cmd.ID, OK: false, Error: err.Error()})
			return
		}
		emit.emit(replyEvent{Type: "reply", ID: cmd.ID, OK: true})
	case "ping":
		addr, err := netip.ParseAddr(strings.TrimSpace(cmd.IP))
		if err != nil {
			emit.emit(replyEvent{Type: "reply", ID: cmd.ID, OK: false, Error: fmt.Sprintf("invalid ip %q: %v", cmd.IP, err)})
			return
		}
		pingCtx, cancel := context.WithTimeout(ctx, pingTimeout)
		defer cancel()
		res, err := backend.Ping(pingCtx, addr, tailcfg.PingDisco)
		emit.emit(formatPingReply(cmd.ID, res, err))
	case "probe_rex":
		endpoint, err := probeRexEndpoint(ctx, backend.Dial, cmd.DNSName)
		if err != nil {
			emit.emit(replyEvent{Type: "reply", ID: cmd.ID, OK: false, Error: err.Error()})
			return
		}
		emit.emit(replyEvent{Type: "reply", ID: cmd.ID, OK: true, RexEndpoint: endpoint})
	case "stop":
		shutdown()
		emit.emitBounded(replyEvent{Type: "reply", ID: cmd.ID, OK: true}, stopReplyTimeout)
	default:
		emit.emit(replyEvent{Type: "reply", ID: cmd.ID, OK: false, Error: fmt.Sprintf("unknown command %q", name)})
	}
}

func readStdinLoop(
	ctx context.Context,
	in io.Reader,
	backend backendClient,
	emit *emitter,
	emitState func(force bool) error,
	shutdown func(),
) {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 0, 16*1024), 256*1024)
	sem := make(chan struct{}, maxConcurrentCommands)
	var wg sync.WaitGroup

	for scanner.Scan() {
		if ctx.Err() != nil {
			shutdown()
			return
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var cmd stdinCommand
		if err := json.Unmarshal([]byte(line), &cmd); err != nil {
			emit.emitNonBlocking(replyEvent{
				Type:  "reply",
				ID:    0,
				OK:    false,
				Error: fmt.Sprintf("invalid json: %v", err),
			})
			continue
		}
		if strings.TrimSpace(cmd.Cmd) == "stop" {
			handleCommand(ctx, cmd, backend, emit, emitState, shutdown)
			return
		}
		select {
		case sem <- struct{}{}:
			wg.Add(1)
			go func(c stdinCommand) {
				defer func() {
					<-sem
					wg.Done()
				}()
				handleCommand(ctx, c, backend, emit, emitState, shutdown)
			}(cmd)
		default:
			emit.emitNonBlocking(replyEvent{
				Type:  "reply",
				ID:    cmd.ID,
				OK:    false,
				Error: "command queue busy",
			})
		}
	}
	// Stdin closed (EOF) or read error -> zero-orphan immediate shutdown.
	shutdown()
	waitGroupWithTimeout(&wg, eofDrainTimeout)
	emit.drain(stopReplyTimeout)
}

func main() {
	debug.SetMemoryLimit(28 << 20)
	debug.SetGCPercent(50)

	if err := installParentDeathSignal(); err != nil {
		fmt.Fprintf(os.Stderr, "rex-zero-tsnet: prctl failed: %v\n", err)
		os.Exit(1)
	}

	var (
		stateDir = flag.String("state-dir", "", "required directory for tsnet state, logs, and tmp")
		hostname = flag.String("hostname", "rex-zero", "Tailscale node hostname")
		authKey  = flag.String("auth-key", "", "optional Tailscale auth key")
		verbose  = flag.Bool("verbose", false, "emit tsnet/socks5 debug logs to stderr")
	)
	flag.Parse()

	if err := prepareStateDir(*stateDir); err != nil {
		fmt.Fprintf(os.Stderr, "rex-zero-tsnet: %v\n", err)
		flag.Usage()
		os.Exit(2)
	}

	logf := logger.Discard
	if *verbose {
		log.SetOutput(os.Stderr)
		logf = func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, format+"\n", args...)
		}
	} else {
		log.SetOutput(io.Discard)
	}

	sigCtx, stopSig := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stopSig()
	ctx, cancel := context.WithCancel(sigCtx)
	defer cancel()

	srv := &tsnet.Server{
		Dir:      *stateDir,
		Hostname: *hostname,
		AuthKey:  *authKey,
		Logf:     logf,
		UserLogf: logf,
	}

	if err := srv.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "rex-zero-tsnet: start tsnet: %v\n", err)
		os.Exit(1)
	}

	socksLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = srv.Close()
		fmt.Fprintf(os.Stderr, "rex-zero-tsnet: listen socks5: %v\n", err)
		os.Exit(1)
	}
	proxyPort := socksLn.Addr().(*net.TCPAddr).Port

	socksSrv := &socks5.Server{
		Logf:   logf,
		Dialer: srv.Dial,
	}
	go func() {
		_ = socksSrv.Serve(socksLn)
	}()

	emit := newEmitter(os.Stdout)
	if !emit.emitBounded(readyEvent{Type: "ready", ProxyPort: proxyPort}, readyWriteTimeout) {
		_ = socksLn.Close()
		_ = srv.Close()
		fmt.Fprintln(os.Stderr, "rex-zero-tsnet: timed out writing ready event")
		os.Exit(1)
	}

	lc, err := srv.LocalClient()
	if err != nil {
		_ = socksLn.Close()
		_ = srv.Close()
		fmt.Fprintf(os.Stderr, "rex-zero-tsnet: local client: %v\n", err)
		os.Exit(1)
	}

	backend := &tsnetBackend{srv: srv, lc: lc}
	tracker := newStateTracker(backend, emit, proxyPort)
	emitState := func(force bool) error {
		return tracker.emitState(ctx, force)
	}

	var shutdownOnce sync.Once
	shutdown := func() {
		shutdownOnce.Do(func() {
			cancel()
			_ = socksLn.Close()
			_ = srv.Close()
		})
	}

	// Watch IPN bus for reactive state transitions and peer updates.
	go watchLoop(ctx, func(watchCtx context.Context) (ipnBusWatcher, error) {
		return lc.WatchIPNBus(watchCtx, ipn.NotifyInitialState|ipn.NotifyInitialStatus|ipn.NotifyPeerChanges)
	}, tracker, watchRetryInterval)

	stdinDone := make(chan struct{})
	go func() {
		defer close(stdinDone)
		readStdinLoop(ctx, os.Stdin, backend, emit, emitState, shutdown)
	}()

	select {
	case <-stdinDone:
		shutdown()
	case <-sigCtx.Done():
		shutdown()
	}
	os.Exit(0)
}
