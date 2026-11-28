import { useState, useEffect, useRef } from 'react';
import { Terminal, Play, Square, Trash2, Send } from 'lucide-react';
import { useWebSocket } from '../context/WebSocketContext';

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

function cleanTerminalChunk(raw) {
  return String(raw || '').replace(ANSI_REGEX, '').replace(/\r\n/g, '\n').replace(/\r/g, '');
}

const PRESET_COMMANDS = ['pwd', 'ls -la', 'node -v', 'ps aux', 'df -h'];

function ContainerTerminal({ appId, appName, running, canExec }) {
  const { connected, subscribe, send } = useWebSocket();
  const [sessionId, setSessionId] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [cmdInput, setCmdInput] = useState('');
  const [history, setHistory] = useState([]);
  const [histIndex, setHistIndex] = useState(-1);
  const screenRef = useRef(null);
  const activeSessionRef = useRef(null);

  useEffect(() => {
    activeSessionRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    const unsub = subscribe((msg) => {
      if (Number(msg.appId) !== Number(appId)) return;

      if (msg.type === 'exec:started') {
        setSessionId(msg.sessionId);
        setConnecting(false);
        setError('');
        setOutput((prev) => `${prev}[Connected to container shell for ${appName}]\n`);
      } else if (msg.type === 'exec:data' && msg.sessionId === activeSessionRef.current) {
        const clean = cleanTerminalChunk(msg.data);
        setOutput((prev) => (prev + clean).slice(-24000));
      } else if (msg.type === 'exec:closed' && msg.sessionId === activeSessionRef.current) {
        setSessionId(null);
        setConnecting(false);
        setOutput((prev) => `${prev}\n[Session closed]\n`);
      } else if (msg.type === 'exec:error') {
        setConnecting(false);
        setError(msg.error || 'Terminal error');
      }
    });

    return () => {
      unsub();
      if (activeSessionRef.current) {
        send({ type: 'exec:close', sessionId: activeSessionRef.current });
      }
    };
  }, [appId, appName, subscribe, send]);

  useEffect(() => {
    if (screenRef.current) {
      screenRef.current.scrollTop = screenRef.current.scrollHeight;
    }
  }, [output]);

  const handleConnect = () => {
    setError('');
    setConnecting(true);
    const ok = send({ type: 'exec:start', appId: Number(appId), cols: 100, rows: 28 });
    if (!ok) {
      setConnecting(false);
      setError('WebSocket connection is not ready yet.');
    }
  };

  const handleDisconnect = () => {
    if (sessionId) {
      send({ type: 'exec:close', sessionId });
      setSessionId(null);
    }
  };

  const sendCommand = (rawCmd) => {
    if (!sessionId) return;
    send({ type: 'exec:input', sessionId, data: `${rawCmd}\n` });
  };

  const handleRunInput = (e) => {
    e.preventDefault();
    if (!sessionId) return;
    const cmd = cmdInput;
    if (cmd.trim()) {
      setHistory((prev) => [cmd, ...prev.slice(0, 49)]);
      setHistIndex(-1);
    }
    sendCommand(cmd);
    setCmdInput('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowUp' && history.length > 0) {
      e.preventDefault();
      const nextIdx = Math.min(histIndex + 1, history.length - 1);
      setHistIndex(nextIdx);
      setCmdInput(history[nextIdx]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIndex <= 0) {
        setHistIndex(-1);
        setCmdInput('');
      } else {
        const nextIdx = histIndex - 1;
        setHistIndex(nextIdx);
        setCmdInput(history[nextIdx]);
      }
    }
  };

  if (!canExec) {
    return (
      <div className="empty-state-sm">
        Interactive container terminal access requires Operator or Administrator privileges.
      </div>
    );
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-toolbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {!sessionId ? (
            <button
              type="button"
              className="btn btn-xs btn-primary"
              onClick={handleConnect}
              disabled={!running || !connected || connecting}
            >
              <Play size={12} /> {connecting ? 'Connecting…' : 'Open Shell'}
            </button>
          ) : (
            <button type="button" className="btn btn-xs btn-danger" onClick={handleDisconnect}>
              <Square size={12} /> Disconnect
            </button>
          )}

          {sessionId && (
            <>
              <button
                type="button"
                className="btn btn-xs btn-secondary"
                onClick={() => send({ type: 'exec:input', sessionId, data: '\x03' })}
                title="Send Ctrl+C interrupt"
              >
                Ctrl+C
              </button>
              {PRESET_COMMANDS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="btn btn-xs btn-secondary"
                  onClick={() => sendCommand(preset)}
                >
                  {preset}
                </button>
              ))}
            </>
          )}
        </div>

        <button
          type="button"
          className="btn btn-xs btn-secondary"
          onClick={() => setOutput('')}
          disabled={!output}
        >
          <Trash2 size={12} /> Clear
        </button>
      </div>

      {!running && (
        <div className="alert alert-error" style={{ marginBottom: '10px' }}>
          Container is currently stopped. Start or deploy the application to open a shell.
        </div>
      )}
      {error && <div className="alert alert-error" style={{ marginBottom: '10px' }}>{error}</div>}

      <pre ref={screenRef} className="log-viewer terminal-screen">
        {output || (running ? 'Click "Open Shell" to attach an interactive shell inside the running container.' : 'Container not running.')}
      </pre>

      <form className="terminal-input-row" onSubmit={handleRunInput}>
        <span className="terminal-prompt">
          <Terminal size={13} /> $
        </span>
        <input
          type="text"
          className="form-input terminal-input"
          value={cmdInput}
          onChange={(e) => setCmdInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={sessionId ? 'Type command and press Enter (Up/Down for history)…' : 'Shell disconnected'}
          disabled={!sessionId}
          aria-label="Container terminal command input"
        />
        <button type="submit" className="btn btn-sm btn-primary" disabled={!sessionId}>
          <Send size={13} /> Run
        </button>
      </form>
    </div>
  );
}

export default ContainerTerminal;
