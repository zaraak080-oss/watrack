import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, PlusCircle, RefreshCw, Smartphone, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import { AuthModal } from './components/AuthModal';
import { DirectoryTree } from './components/DirectoryTree';
import type { ChatSessionGroup, SessionState } from './types';

function formatStatus(status: string) {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'pairing':
      return 'Pairing';
    case 'pending':
      return 'Pending';
    case 'reconnecting':
      return 'Reconnecting';
    case 'error':
      return 'Error';
    default:
      return 'Offline';
  }
}

export default function App() {
  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [chatSessions, setChatSessions] = useState<ChatSessionGroup[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [isModalOpen, setModalOpen] = useState(false);
  const [pairingSessionName, setPairingSessionName] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isRefreshing, setRefreshing] = useState(false);
  const [removingSession, setRemovingSession] = useState<string | null>(null);

  const refreshData = useCallback(async () => {
    setRefreshing(true);
    try {
      const [sessionsResponse, chatsResponse] = await Promise.all([
        fetch('/api/sessions'),
        fetch('/api/chats'),
      ]);

      if (!sessionsResponse.ok || !chatsResponse.ok) {
        throw new Error('Unable to load dashboard data.');
      }

      const nextSessions = (await sessionsResponse.json()) as { sessions?: SessionState[] };
      const nextChats = (await chatsResponse.json()) as { sessions?: ChatSessionGroup[] };
      setSessions(nextSessions.sessions ?? []);
      setChatSessions(nextChats.sessions ?? []);
      setErrorMessage(null);

      setSelectedChatId((current) => {
        if (current) {
          const stillPresent = (nextChats.sessions ?? []).some((session: ChatSessionGroup) =>
            session.contacts.some((contact) => contact.id === current)
          );
          if (stillPresent) {
            return current;
          }
        }

        const firstContact = (nextChats.sessions ?? []).flatMap((session: ChatSessionGroup) => session.contacts)[0];
        return firstContact?.id ?? null;
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to refresh dashboard.');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refreshData();

    const eventSource = new EventSource('/api/events');
    eventSource.onmessage = () => {
      void refreshData();
    };
    eventSource.onerror = () => {
      console.error('Event stream disconnected.');
    };

    return () => eventSource.close();
  }, [refreshData]);

  const pairingSession = useMemo(() => {
    if (!pairingSessionName) {
      return null;
    }
    return sessions.find((session) => session.sessionName === pairingSessionName) ?? null;
  }, [pairingSessionName, sessions]);

  useEffect(() => {
    if (pairingSession?.connected) {
      setStatusMessage(`${pairingSession.sessionName} connected successfully.`);
    }
  }, [pairingSession?.connected, pairingSession?.sessionName]);

  const handleCreateSession = async (payload: { sessionName: string; phoneNumber: string; mode: 'pairing' | 'qr' }) => {
    setErrorMessage(null);
    setPairingSessionName(payload.sessionName);
    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to start session.');
      }
      setStatusMessage(data.message || 'Session started.');
      await refreshData();
    } catch (error) {
      setPairingSessionName(null);
      setErrorMessage(error instanceof Error ? error.message : 'Unable to create session.');
      throw error;
    }
  };

  const handleRemoveSession = async (sessionName: string) => {
    setRemovingSession(sessionName);
    setErrorMessage(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}?wipeAuth=true`, {
        method: 'DELETE',
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Unable to remove device.');
      }
      if (pairingSessionName === sessionName) {
        setPairingSessionName(null);
        setModalOpen(false);
      }
      setStatusMessage(data.message || 'Device removed.');
      await refreshData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to remove device.');
    } finally {
      setRemovingSession(null);
    }
  };

  const handleDeleteChat = async (sessionName: string, fileName: string) => {
    if (!confirm('Are you sure you want to delete this chat history? This cannot be undone.')) {
      return;
    }
    setErrorMessage(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/chats/${encodeURIComponent(fileName)}`, {
        method: 'DELETE',
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to delete chat.');
      }
      setStatusMessage(data.message || 'Chat deleted successfully.');
      await refreshData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to delete chat.');
    }
  };

  const handleRenameChat = async (sessionName: string, fileName: string) => {
    const defaultName = fileName.replace(/\.txt$/, '');
    const newName = prompt('Enter a new name for this chat:', defaultName);
    if (newName === null) {
      return;
    }
    const trimmed = newName.trim();
    if (!trimmed) {
      alert('Name cannot be empty.');
      return;
    }
    if (trimmed === defaultName) {
      return;
    }
    setErrorMessage(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/chats/${encodeURIComponent(fileName)}/rename`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ newName: trimmed }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to rename chat.');
      }
      setStatusMessage(data.message || 'Chat renamed successfully.');
      const oldId = `${sessionName}:${fileName}`;
      if (selectedChatId === oldId) {
        const newFileName = data.newFileName || `${trimmed}.txt`;
        setSelectedChatId(`${sessionName}:${newFileName}`);
      }
      await refreshData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to rename chat.');
    }
  };

  const handleDownloadChat = async (sessionName: string, fileName: string) => {
    setErrorMessage(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/chats/${encodeURIComponent(fileName)}/download`);
      if (!response.ok) {
        throw new Error('Unable to download chat file.');
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
      setStatusMessage('Chat file downloaded.');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to download chat file.');
    }
  };

  const handleCloseModal = () => {
    setModalOpen(false);
    if (pairingSession?.connected) {
      setPairingSessionName(null);
    }
  };

  const activeCount = useMemo(() => sessions.filter((session) => session.connected).length, [sessions]);

  return (
    <div className="app-shell">
      <header className="hero-card">
        <div>
          <p className="eyebrow">WhatsApp backup control center</p>
          <h1>WA Panel Vault</h1>
          <p className="hero-copy">
            Connect devices, capture conversations to local folders, and browse messages by contact.
          </p>
        </div>
        {sessions.length ? (
          <div className="hero-actions">
            <button className="ghost-button" onClick={() => void refreshData()} type="button">
              <RefreshCw size={16} className={isRefreshing ? 'spinning' : ''} />
              Refresh
            </button>
            <button className="primary-button" onClick={() => setModalOpen(true)} type="button">
              <PlusCircle size={16} /> Connect new device
            </button>
          </div>
        ) : null}
      </header>

      {sessions.length ? (
        <section className="stats-grid">
          <article className="stat-card">
            <div className="stat-icon"><ShieldCheck size={18} /></div>
            <div>
              <h3>{activeCount}</h3>
              <p>Active devices</p>
            </div>
          </article>
          <article className="stat-card">
            <div className="stat-icon"><Smartphone size={18} /></div>
            <div>
              <h3>{sessions.length}</h3>
              <p>Tracked devices</p>
            </div>
          </article>
          <article className="stat-card">
            <div className="stat-icon"><Sparkles size={18} /></div>
            <div>
              <h3>{chatSessions.reduce((total, session) => total + session.contacts.length, 0)}</h3>
              <p>Tracked chats</p>
            </div>
          </article>
        </section>
      ) : null}

      {statusMessage ? <div className="notice success">{statusMessage}</div> : null}
      {errorMessage ? <div className="notice error">{errorMessage}</div> : null}

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Devices</p>
            <h2>{sessions.length ? 'Connected devices' : 'No devices yet'}</h2>
          </div>
          {sessions.length ? (
            <button className="ghost-button" onClick={() => setModalOpen(true)} type="button">
              + Connect new device
            </button>
          ) : null}
        </div>

        {sessions.length ? (
          <div className="session-grid">
            {sessions.map((session) => (
              <article key={session.sessionName} className="session-card">
                <div className="session-topline">
                  <div>
                    <h3>{session.sessionName}</h3>
                    <p>{session.phoneNumber || 'QR linked device'}</p>
                  </div>
                  <span
                    className={`status-badge ${
                      session.connected ? 'connected' : session.status === 'pairing' ? 'pairing' : 'offline'
                    }`}
                  >
                    {formatStatus(session.status)}
                  </span>
                </div>
                <div className="session-body">
                  <p>{session.message || 'Waiting for update.'}</p>
                </div>
                <div className="session-footer session-actions">
                  <span>
                    {session.connected ? <CheckCircle2 size={16} /> : null}
                    {session.connected ? 'Ready for backups' : 'Not connected'}
                  </span>
                  <button
                    className="danger-button"
                    type="button"
                    disabled={removingSession === session.sessionName}
                    onClick={() => void handleRemoveSession(session.sessionName)}
                  >
                    <Trash2 size={14} />
                    {removingSession === session.sessionName ? 'Removing…' : 'Remove'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <Smartphone size={48} />
            <h3>No devices connected</h3>
            <p>Connect your first WhatsApp device to start capturing messages.</p>
            <button className="primary-button" onClick={() => setModalOpen(true)} type="button">
              <PlusCircle size={16} /> Connect new device
            </button>
          </div>
        )}
      </section>

      {sessions.some((session) => session.connected) ? (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Message browser</p>
              <h2>Conversations</h2>
            </div>
          </div>
          <DirectoryTree
            sessions={chatSessions}
            selectedChatId={selectedChatId}
            onSelectChat={(contact) => setSelectedChatId(contact.id)}
            onDeleteChat={handleDeleteChat}
            onRenameChat={handleRenameChat}
            onDownloadChat={handleDownloadChat}
          />
        </section>
      ) : null}

      <AuthModal
        open={isModalOpen}
        pairingSession={pairingSession}
        onClose={handleCloseModal}
        onSubmit={handleCreateSession}
      />
    </div>
  );
}
