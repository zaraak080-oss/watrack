import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, CheckCircle2, QrCode, Smartphone } from 'lucide-react';
import type { AuthMode, SessionState } from '../types';

type ModalStep = 'choose' | 'form' | 'pairing';

interface AuthModalProps {
  open: boolean;
  pairingSession: SessionState | null;
  onClose: () => void;
  onSubmit: (payload: { sessionName: string; phoneNumber: string; mode: AuthMode }) => Promise<void> | void;
}

export function AuthModal({ open, pairingSession, onClose, onSubmit }: AuthModalProps) {
  const [step, setStep] = useState<ModalStep>('choose');
  const [mode, setMode] = useState<AuthMode>('pairing');
  const [sessionName, setSessionName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [startedSessionName, setStartedSessionName] = useState<string | null>(null);

  const resetState = () => {
    setStep('choose');
    setMode('pairing');
    setSessionName('');
    setPhoneNumber('');
    setSubmitting(false);
    setStartedSessionName(null);
  };

  useEffect(() => {
    if (!open) {
      resetState();
    }
  }, [open]);

  useEffect(() => {
    if (pairingSession?.connected && pairingSession.sessionName === startedSessionName) {
      setStep('pairing');
    }
  }, [pairingSession, startedSessionName]);

  if (!open) {
    return null;
  }

  const handleClose = () => {
    resetState();
    onClose();
  };

  const chooseMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setStep('form');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!sessionName.trim()) {
      return;
    }
    if (mode === 'pairing' && !phoneNumber.trim()) {
      return;
    }

    setSubmitting(true);
    try {
      const trimmedName = sessionName.trim();
      setStartedSessionName(trimmedName);
      await onSubmit({
        sessionName: trimmedName,
        phoneNumber: phoneNumber.replace(/\D/g, ''),
        mode,
      });
      setStep('pairing');
    } finally {
      setSubmitting(false);
    }
  };

  const activePairing = pairingSession?.sessionName === startedSessionName ? pairingSession : null;
  const isConnected = Boolean(activePairing?.connected);

  return (
    <div className="modal-backdrop" role="presentation" onClick={handleClose}>
      <div className="modal-card" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">Connect device</p>
            <h2>
              {step === 'choose' && 'Connect new device'}
              {step === 'form' && (mode === 'pairing' ? 'Pair with phone number' : 'Pair with QR code')}
              {step === 'pairing' && (isConnected ? 'Device connected' : 'Waiting for WhatsApp')}
            </h2>
          </div>
          <button className="ghost-button" onClick={handleClose} type="button">
            Close
          </button>
        </div>

        {step === 'choose' ? (
          <div className="connect-options">
            <button className="connect-option" type="button" onClick={() => chooseMode('pairing')}>
              <Smartphone size={28} />
              <div>
                <strong>Connect with phone number</strong>
                <p>Get an 8-digit pairing code to enter on your phone.</p>
              </div>
            </button>
            <button className="connect-option" type="button" onClick={() => chooseMode('qr')}>
              <QrCode size={28} />
              <div>
                <strong>Connect with QR code</strong>
                <p>Scan a QR code from WhatsApp linked devices.</p>
              </div>
            </button>
          </div>
        ) : null}

        {step === 'form' ? (
          <form className="auth-form" onSubmit={submit}>
            <button className="back-link" type="button" onClick={() => setStep('choose')}>
              <ArrowLeft size={16} /> Back
            </button>
            <label>
              Device name
              <input
                value={sessionName}
                onChange={(event) => setSessionName(event.target.value)}
                placeholder="My Phone"
                required
              />
            </label>
            {mode === 'pairing' ? (
              <label>
                Phone number (with country code)
                <input
                  value={phoneNumber}
                  onChange={(event) => setPhoneNumber(event.target.value)}
                  placeholder="923001234567"
                  inputMode="numeric"
                  required
                />
              </label>
            ) : null}
            <p className="helper-text">
              {mode === 'pairing'
                ? 'Use digits only — no +, spaces, or dashes.'
                : 'After you start, a scannable QR code will appear here.'}
            </p>
            <button className="primary-button" type="submit" disabled={submitting}>
              {submitting ? 'Starting…' : mode === 'pairing' ? 'Get pairing code' : 'Show QR code'}
            </button>
          </form>
        ) : null}

        {step === 'pairing' ? (
          <div className="pairing-panel">
            {!isConnected ? (
              <p className="helper-text">{activePairing?.message || 'Starting connection…'}</p>
            ) : null}

            {mode === 'pairing' && !isConnected ? (
              <div className="pairing-display">
                <p className="pairing-label">Your pairing code</p>
                {activePairing?.pairingCode ? (
                  <div className="pairing-code">{activePairing.pairingCode}</div>
                ) : (
                  <div className="pairing-code pairing-code-loading">········</div>
                )}
                <p className="helper-text">
                  On your phone: WhatsApp → Linked devices → Link a device → Link with phone number instead
                </p>
              </div>
            ) : null}

            {mode === 'qr' && !isConnected ? (
              <div className="pairing-display">
                <p className="pairing-label">Scan this QR code</p>
                {activePairing?.qrDataUrl ? (
                  <img className="qr-preview qr-preview-large" src={activePairing.qrDataUrl} alt="WhatsApp QR code" />
                ) : (
                  <div className="qr-placeholder">Generating QR code…</div>
                )}
                <p className="helper-text">On your phone: WhatsApp → Linked devices → Link a device</p>
              </div>
            ) : null}

            {isConnected ? (
              <div className="pairing-success">
                <CheckCircle2 size={40} />
                <p><strong>{activePairing?.sessionName}</strong> is connected and ready.</p>
                <button className="primary-button" type="button" onClick={handleClose}>
                  Done
                </button>
              </div>
            ) : (
              <button className="ghost-button" type="button" onClick={handleClose}>
                Cancel
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
