import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Folder, MessageSquareText, Trash2, Edit2 } from 'lucide-react';
import type { ChatContact, ChatMessage, ChatSessionGroup } from '../types';

interface DirectoryTreeProps {
  sessions: ChatSessionGroup[];
  selectedChatId: string | null;
  onSelectChat: (contact: ChatContact) => void;
  onDeleteChat: (sessionName: string, fileName: string) => void;
  onRenameChat: (sessionName: string, fileName: string) => void;
  onDownloadChat: (sessionName: string, fileName: string) => void;
}

export function DirectoryTree({ sessions, selectedChatId, onSelectChat, onDeleteChat, onRenameChat, onDownloadChat }: DirectoryTreeProps) {
  const [expandedSessions, setExpandedSessions] = useState<Record<string, boolean>>({});
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedContact = useMemo(() => {
    return sessions.flatMap((session) => session.contacts).find((contact) => contact.id === selectedChatId) ?? null;
  }, [selectedChatId, sessions]);

  useEffect(() => {
    if (!selectedContact) {
      setMessages([]);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);

    const fetchMessages = async () => {
      try {
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(selectedContact.sessionName)}/chats/${encodeURIComponent(
            selectedContact.fileName
          )}`
        );
        if (!response.ok) {
          throw new Error('Failed to load chat messages.');
        }
        const data = (await response.json()) as { messages: ChatMessage[] };
        if (active) {
          setMessages(data.messages);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Error fetching messages.');
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void fetchMessages();

    return () => {
      active = false;
    };
  }, [selectedChatId, selectedContact?.sessionName, selectedContact?.fileName, sessions]);

  if (!sessions.length) {
    return <p className="muted">No chat sessions yet. Messages will appear here after the first successful connection.</p>;
  }

  const toggleSession = (sessionName: string) => {
    setExpandedSessions((current) => ({ ...current, [sessionName]: !current[sessionName] }));
  };

  return (
    <div className="chat-shell">
      <div className="chat-sidebar">
        {sessions.map((session) => {
          const isExpanded = Boolean(expandedSessions[session.sessionName]);
          return (
            <div key={session.sessionName} className="chat-session-group">
              <button className="chat-session-toggle" type="button" onClick={() => toggleSession(session.sessionName)}>
                {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <Folder size={16} />
                <span>{session.sessionName}</span>
              </button>
              {isExpanded ? (
                <div className="chat-contacts">
                  {session.contacts.length ? (
                    session.contacts.map((contact) => (
                      <div
                        key={contact.id}
                        className={`chat-contact-wrapper ${selectedChatId === contact.id ? 'active' : ''} ${contact.keywordAlert ? 'keyword-alert' : ''}`}
                      >
                        <button
                          className="chat-contact"
                          type="button"
                          onClick={() => onSelectChat(contact)}
                        >
                          <div className="chat-contact-main">
                            <MessageSquareText size={15} />
                            <span>{contact.contactName}</span>
                            {contact.messageCount !== undefined && (
                              <span className="msg-count">({contact.messageCount})</span>
                            )}
                            {contact.keywordAlert && (
                              <span className="alert-badge" title="Keyword alert triggered">⚠️ Alert</span>
                            )}
                          </div>
                        </button>
                        <button
                          className="chat-contact-edit"
                          type="button"
                          title="Rename chat"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRenameChat(contact.sessionName, contact.fileName);
                          }}
                        >
                          <Edit2 size={14} />
                        </button>
                        <button
                          className="chat-contact-download"
                          type="button"
                          title="Download chat file"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDownloadChat(contact.sessionName, contact.fileName);
                          }}
                        >
                          <Download size={14} />
                        </button>
                        <button
                          className="chat-contact-delete"
                          type="button"
                          title="Delete chat history"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteChat(contact.sessionName, contact.fileName);
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="muted">No chats captured for this session yet.</p>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="chat-detail">
        {selectedContact ? (
          <>
            <div className="chat-detail-header">
              <h3>{selectedContact.contactName}</h3>
              <p>{selectedContact.sessionName}</p>
            </div>
            <div className="chat-messages">
              {loading && !messages.length ? (
                <p className="muted">Loading messages...</p>
              ) : error ? (
                <p className="notice error">{error}</p>
              ) : messages.length ? (
                messages.map((message) => (
                  <div
                    key={message.id}
                    className={`chat-message ${message.direction === 'OUTGOING' ? 'outgoing' : 'incoming'}`}
                  >
                    <div className="chat-message-meta">
                      <span>{message.direction}</span>
                      {message.sender ? <span className="chat-sender">{message.sender}</span> : null}
                      <span>{message.timestamp || 'recent'}</span>
                    </div>
                    {(() => {
                      const contentStr = message.content || '';
                      const isMedia = contentStr.startsWith('media/');
                      const isImage = isMedia && (contentStr.endsWith('.jpg') || contentStr.endsWith('.jpeg') || contentStr.endsWith('.png'));
                      const isAudio = isMedia && (contentStr.endsWith('.ogg') || contentStr.endsWith('.mp3') || contentStr.endsWith('.wav') || contentStr.endsWith('.m4a'));

                      if (isImage) {
                        return (
                          <div className="chat-media-wrapper">
                            <img
                              src={`/vault/${encodeURIComponent(selectedContact.sessionName)}/${contentStr}`}
                              alt="Media attachment"
                              className="chat-media-image"
                            />
                          </div>
                        );
                      }
                      if (isAudio) {
                        return (
                          <div className="chat-media-wrapper">
                            <audio
                              src={`/vault/${encodeURIComponent(selectedContact.sessionName)}/${contentStr}`}
                              controls
                              className="chat-media-audio"
                            />
                          </div>
                        );
                      }
                      return <p>{message.content}</p>;
                    })()}
                  </div>
                ))
              ) : (
                <p className="muted">No messages to display yet.</p>
              )}
            </div>
          </>
        ) : (
          <div className="chat-empty-state">
            <p>Select a contact to inspect the message stream.</p>
          </div>
        )}
      </div>
    </div>
  );
}
