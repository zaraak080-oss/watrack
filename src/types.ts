export type AuthMode = 'pairing' | 'qr';

export interface SessionState {
  sessionName: string;
  phoneNumber: string | null;
  mode: AuthMode | 'restored' | null;
  status: string;
  connected: boolean;
  pairingCode: string | null;
  qrCode: string | null;
  qrDataUrl: string | null;
  message: string | null;
  lastUpdated: string | null;
}

export interface ChatMessage {
  id: string;
  timestamp: string | null;
  direction: 'INCOMING' | 'OUTGOING';
  sender?: string | null;
  content: string;
}

export interface ChatContact {
  id: string;
  sessionName: string;
  contactName: string;
  fileName: string;
  messageCount?: number;
  keywordAlert?: boolean;
}

export interface ChatSessionGroup {
  sessionName: string;
  contacts: ChatContact[];
}
