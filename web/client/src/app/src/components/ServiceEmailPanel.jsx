// web/client/src/app/src/components/ServiceEmailPanel.jsx
//
// "Send service email" — the panel on the company profile.
//
// The whole point is speed between calls: type the address you were just
// given, tap the services they showed interest in, tap Send. Studio sends it
// and books a follow-up for 7 days' time. No writing, no modal, no navigation.
//
// A separate file rather than a section inside CompanyProfile.jsx for two
// reasons. It keeps a 1,200-line file from growing further, and it makes the
// sub-component rule easy to hold: every piece below is defined at module
// level, so nothing unmounts and remounts on re-render. Defining Chip inside
// the panel's function body would destroy focus in the address input on every
// keystroke — the same bug that bit CRM contacts.
//
// Props:
//   companyId    (required) contacts.id
//   defaultEmail (optional) contacts.email, used to prefill
//   onSent       (optional) called after a send settles, so the parent can
//                           refresh the history timeline

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Mail, Check, Undo2, Loader2 } from 'lucide-react';

// Theme tokens, duplicated from CompanyProfile.jsx. Pure constants with no
// behaviour — the codebase duplicates these rather than creating a shared
// module, and copying three object literals is cheaper than the import graph.
const T = {
  base: 'var(--wt-bg-base, #1a1a2e)',
  card: 'var(--wt-bg-card, #242438)',
  border: 'var(--wt-border, #2e2e4a)',
  accent: 'var(--wt-accent, #f59e0b)',
  text: 'var(--wt-text-primary, #ffffff)',
  sub: 'var(--wt-text-secondary, #94a3b8)',
  muted: 'var(--wt-text-muted, #6b7280)',
  green: 'var(--wt-green, #10b981)',
  red: 'var(--wt-red, #ef4444)',
};
const cardStyle = {
  background: T.card, border: `1px solid ${T.border}`,
  borderRadius: 'var(--wt-radius-lg, 12px)', padding: '14px 16px',
};
const sectionTitle = { fontSize: 16, fontWeight: 600, color: T.text };
const inputStyle = {
  background: T.base, border: `1px solid ${T.border}`, color: T.text,
  borderRadius: 'var(--wt-radius-md, 8px)', padding: '8px 10px', fontSize: 13, width: '100%',
};

const UNDO_SECONDS = 10;

const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());

// Studio's refusal reasons, in the salesperson's language. These are answers
// rather than errors, so each one says what actually happened.
const REFUSALS = {
  already_sent: 'Those services have already gone to this address.',
  suppressed: 'This address has unsubscribed, so nothing was sent.',
  no_services: 'Pick at least one service first.',
  invalid_services: 'That service is no longer available — reload the page.',
  too_late: 'Too late to undo — that one has already gone.',
};

// ── Module-level sub-components (never define these inside the panel) ────────

function Chip({ service, selected, alreadySent, disabled, onToggle }) {
  const active = selected || alreadySent;
  return (
    <button
      type="button"
      onClick={() => !alreadySent && !disabled && onToggle(service.key)}
      disabled={alreadySent || disabled}
      title={alreadySent ? 'Already sent to this address' : service.label}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        borderRadius: 999, padding: '5px 10px', fontSize: 12,
        cursor: alreadySent || disabled ? 'default' : 'pointer',
        border: `1px solid ${active ? T.accent : T.border}`,
        background: alreadySent
          ? 'rgba(148,163,184,0.10)'
          : selected ? 'rgba(245,158,11,0.16)' : 'transparent',
        color: alreadySent ? T.muted : selected ? T.accent : T.sub,
        opacity: alreadySent ? 0.65 : 1,
        textAlign: 'left',
      }}
    >
      {alreadySent && <Check size={11} />}
      {service.label}
    </button>
  );
}

function StatusLine({ tone, children }) {
  const colour = tone === 'error' ? T.red : tone === 'success' ? T.green : T.sub;
  return <div style={{ fontSize: 12, color: colour, marginTop: 8 }}>{children}</div>;
}

function UndoBar({ seconds, onUndo, busy }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      marginTop: 10, padding: '8px 10px', borderRadius: 8,
      background: 'rgba(16,185,129,0.12)', border: `1px solid rgba(16,185,129,0.3)`,
    }}>
      <span style={{ fontSize: 12, color: T.green }}>
        Sending… follow-up booked for 7 days
      </span>
      <button
        type="button"
        onClick={onUndo}
        disabled={busy}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          background: 'transparent', border: `1px solid ${T.green}`, color: T.green,
          borderRadius: 6, padding: '3px 9px', fontSize: 12,
          cursor: busy ? 'default' : 'pointer', whiteSpace: 'nowrap',
        }}
      >
        <Undo2 size={12} /> Undo {seconds}s
      </button>
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

export default function ServiceEmailPanel({ companyId, defaultEmail, onSent }) {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState(defaultEmail || '');
  const [selected, setSelected] = useState([]);
  const [sentServices, setSentServices] = useState([]);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState(null);      // { tone, text }
  const [pending, setPending] = useState(null);    // { id, seconds }
  const [undoing, setUndoing] = useState(false);

  // Guards the countdown interval so it can be cleared from anywhere without
  // reaching through a stale closure.
  const timerRef = useRef(null);

  // Prefill only while the field is untouched. Re-prefilling on every company
  // change would wipe an address mid-type if the parent re-rendered.
  useEffect(() => { setEmail(defaultEmail || ''); }, [companyId, defaultEmail]);

  // Catalogue — served by WorkTrackr from Studio, cached server-side.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/service-emails/catalogue', { credentials: 'include' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (alive) setServices(d.services || []);
      } catch {
        if (alive) setStatus({ tone: 'error', text: 'Could not load the service list.' });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Which services have already gone to THIS address. Refetched as the address
  // changes, because the answer is per-address: the same service can go to a
  // different person at the same company.
  const refreshSent = useCallback(async () => {
    if (!companyId) return;
    try {
      const qs = looksLikeEmail(email) ? `?email=${encodeURIComponent(email.trim())}` : '';
      const r = await fetch(`/api/service-emails/company/${companyId}${qs}`, { credentials: 'include' });
      if (!r.ok) return;
      const d = await r.json();
      setSentServices(d.sentServices || []);
    } catch { /* chip state is a nicety; Studio enforces the rule regardless */ }
  }, [companyId, email]);

  useEffect(() => {
    const t = setTimeout(refreshSent, 300); // debounce while typing an address
    return () => clearTimeout(t);
  }, [refreshSent]);

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  const toggle = (key) => {
    setStatus(null);
    setSelected((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);
  };

  const send = async () => {
    if (!looksLikeEmail(email)) {
      setStatus({ tone: 'error', text: 'That does not look like an email address.' });
      return;
    }
    if (selected.length === 0) {
      setStatus({ tone: 'error', text: 'Pick at least one service.' });
      return;
    }

    setSending(true);
    setStatus(null);
    try {
      const r = await fetch('/api/service-emails/send', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: companyId, email: email.trim(), services: selected }),
      });
      const d = await r.json().catch(() => ({}));

      if (!r.ok) {
        setStatus({ tone: 'error', text: REFUSALS[d.error] || 'Could not send — try again.' });
        return;
      }

      // Clear the selection immediately: the next thing that happens is the
      // next call, and a stale selection is how the wrong email gets sent.
      setSelected([]);
      await refreshSent();
      if (onSent) onSent();

      // Undo window. Purely a display countdown — the real window is Studio's,
      // and it will refuse a late cancel regardless of what this shows.
      setPending({ id: d.id, seconds: UNDO_SECONDS });
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        setPending((p) => {
          if (!p) return null;
          if (p.seconds <= 1) {
            clearInterval(timerRef.current);
            timerRef.current = null;
            setStatus({ tone: 'success', text: 'Sent. Follow-up booked for 7 days.' });
            return null;
          }
          return { ...p, seconds: p.seconds - 1 };
        });
      }, 1000);
    } catch {
      setStatus({ tone: 'error', text: 'Could not reach the server.' });
    } finally {
      setSending(false);
    }
  };

  const undo = async () => {
    if (!pending) return;
    setUndoing(true);
    try {
      const r = await fetch('/api/service-emails/cancel', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: pending.id }),
      });
      const d = await r.json().catch(() => ({}));

      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setPending(null);

      if (r.ok) {
        setStatus({ tone: 'success', text: 'Cancelled — nothing was sent.' });
      } else {
        setStatus({ tone: 'error', text: REFUSALS[d.error] || 'Too late to undo.' });
      }
      await refreshSent();
      if (onSent) onSent();
    } catch {
      setStatus({ tone: 'error', text: 'Could not reach the server.' });
    } finally {
      setUndoing(false);
    }
  };

  const busy = sending || !!pending;

  return (
    <div style={cardStyle}>
      <div style={{ ...sectionTitle, marginBottom: 10 }}>
        <Mail size={16} style={{ color: T.accent, verticalAlign: -2, marginRight: 6 }} />
        Send service email
      </div>

      <input
        type="email"
        value={email}
        onChange={(e) => { setEmail(e.target.value); setStatus(null); }}
        placeholder="Email address from the call"
        autoComplete="off"
        style={inputStyle}
      />

      <div style={{ fontSize: 12, color: T.muted, margin: '10px 0 6px' }}>
        What were they interested in?
      </div>

      {loading ? (
        <div style={{ fontSize: 13, color: T.sub }}>Loading services…</div>
      ) : services.length === 0 ? (
        <div style={{ fontSize: 13, color: T.sub }}>No services available.</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {services.map((s) => (
            <Chip
              key={s.key}
              service={s}
              selected={selected.includes(s.key)}
              alreadySent={sentServices.includes(s.key)}
              disabled={busy}
              onToggle={toggle}
            />
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={send}
        disabled={busy || loading}
        style={{
          marginTop: 12, width: '100%',
          background: busy || loading ? T.border : T.accent,
          color: busy || loading ? T.muted : T.base,
          border: 'none', borderRadius: 8, padding: '9px 12px',
          fontSize: 14, fontWeight: 600,
          cursor: busy || loading ? 'default' : 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}
      >
        {sending && <Loader2 size={14} className="animate-spin" />}
        {sending ? 'Sending…' : `Send${selected.length ? ` (${selected.length})` : ''}`}
      </button>

      {pending && <UndoBar seconds={pending.seconds} onUndo={undo} busy={undoing} />}
      {status && <StatusLine tone={status.tone}>{status.text}</StatusLine>}

      {!status && !pending && sentServices.length > 0 && (
        <StatusLine>Ticked services have already gone to this address.</StatusLine>
      )}
    </div>
  );
}
