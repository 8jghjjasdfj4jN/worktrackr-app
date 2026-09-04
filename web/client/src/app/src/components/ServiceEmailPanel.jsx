// web/client/src/app/src/components/ServiceEmailPanel.jsx
//
// "Send service email" — the panel on the company profile.
//
// The whole point is speed between calls: type the address you were just
// given, add a name if you got one, tap the button. No writing, no modal, no
// navigation.
//
// Sep 2026: reduced from a twelve-service chip grid to a single introduction
// email. There is nothing to pick any more, so the grid is gone and the button
// carries the name of the one thing it sends. The service key still travels as
// an array because the bridge, the database column and Studio's API all speak
// arrays — narrowing that would be a far wider change than it is worth.
//
// A separate file rather than a section inside CompanyProfile.jsx for two
// reasons. It keeps a 1,200-line file from growing further, and it makes the
// sub-component rule easy to hold: every piece below is defined at module
// level, so nothing unmounts and remounts on re-render. Defining a
// sub-component inside the panel's function body would destroy focus in the
// address input on every keystroke — the same bug that bit CRM contacts.
//
// Props:
//   companyId    (required) contacts.id
//   defaultEmail (optional) contacts.email, used to prefill
//   defaultName  (optional) contacts.primary_contact, used to prefill
//   onSent       (optional) called after a send settles, so the parent can
//                           refresh the history timeline

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Mail, Undo2, Loader2 } from 'lucide-react';

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

// Must match SERVICE_EMAIL_UNDO_SECONDS in Studio's service-email-sender.js.
// Studio owns the real window; this is only the countdown the caller sees. Set
// it longer than Studio's and the Undo button stays clickable after the email
// has already gone.
const UNDO_SECONDS = 5;

// Confirmation polling. Studio's ticker claims the row shortly after the undo
// window closes, so the first look usually still reads 'queued'. Six tries at
// 2s covers the normal case with room for a slow SES round trip.
const CONFIRM_ATTEMPTS = 6;
const CONFIRM_INTERVAL_MS = 2000;

const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());

// Studio's refusal reasons, in the salesperson's language. These are answers
// rather than errors, so each one says what actually happened.
const REFUSALS = {
  already_sent: 'This address has already had the introduction from this company.',
  suppressed: 'This address has unsubscribed, so nothing was sent.',
  no_services: 'The service list did not load — reload the page.',
  invalid_services: 'The service list is out of date — reload the page.',
  too_late: 'Too late to undo — that one has already gone.',
};

// ── Module-level sub-components (never define these inside the panel) ────────

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
      <span style={{ fontSize: 12, color: T.green }}>Sending…</span>
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

export default function ServiceEmailPanel({ companyId, defaultEmail, defaultName, onSent }) {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState(defaultEmail || '');
  const [name, setName] = useState(defaultName || '');
  const [alreadySent, setAlreadySent] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState(null);      // { tone, text }
  const [pending, setPending] = useState(null);    // { id, seconds }
  const [undoing, setUndoing] = useState(false);

  // Guards the countdown interval so it can be cleared from anywhere without
  // reaching through a stale closure.
  const timerRef = useRef(null);

  // Prefill only on company change. Re-prefilling on every render would wipe an
  // address mid-type if the parent re-rendered.
  useEffect(() => { setEmail(defaultEmail || ''); }, [companyId, defaultEmail]);
  useEffect(() => { setName(defaultName || ''); }, [companyId, defaultName]);

  // Catalogue — served by WorkTrackr from Studio, cached server-side for 5
  // minutes. One service now, but still read over the wire so the label can be
  // changed in Studio without redeploying WorkTrackr.
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

  // Has this address already had it from this company? Refetched as the address
  // changes, because the answer is per-address: the same email can go to a
  // different person at the same company.
  const refreshSent = useCallback(async () => {
    if (!companyId) return;
    try {
      const qs = looksLikeEmail(email) ? `?email=${encodeURIComponent(email.trim())}` : '';
      const r = await fetch(`/api/service-emails/company/${companyId}${qs}`, { credentials: 'include' });
      if (!r.ok) return;
      const d = await r.json();
      setAlreadySent((d.sentServices || []).length > 0);
    } catch { /* a nicety; Studio enforces the rule regardless */ }
  }, [companyId, email]);

  useEffect(() => {
    const t = setTimeout(refreshSent, 300); // debounce while typing an address
    return () => clearTimeout(t);
  }, [refreshSent]);

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  // Ask Studio what actually happened. Polled rather than asked once, because
  // the row is claimed by the ticker a moment after the undo window closes and
  // the first look often still says 'queued'.
  //
  // sendId is WorkTrackr's LOCAL mirror id — the `id` from the send response,
  // not `remoteId`. The status route resolves the Studio id itself.
  const confirmSend = useCallback(async (sendId) => {
    setStatus({ tone: null, text: 'Checking it went…' });

    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
      await new Promise(r => setTimeout(r, CONFIRM_INTERVAL_MS));
      try {
        const r = await fetch(
          `/api/service-emails/status/${encodeURIComponent(sendId)}`,
          { credentials: 'include' },
        );
        if (!r.ok) continue;
        const d = await r.json();

        if (d.status === 'sent') {
          setStatus({ tone: 'success', text: 'Sent — confirmed by Sweetbyte Studio.' });
          if (onSent) onSent();
          return;
        }
        if (d.status === 'failed') {
          setStatus({
            tone: 'error',
            text: d.error ? `NOT sent: ${d.error}` : 'NOT sent — the send failed.',
          });
          if (onSent) onSent();
          return;
        }
        if (d.status === 'cancelled') {
          setStatus({ tone: 'error', text: 'Cancelled — nothing was sent.' });
          return;
        }
        // 'queued' or 'unknown' — keep waiting.
      } catch { /* keep trying; a blip shouldn't end the check */ }
    }

    // Ran out of attempts. Say so honestly rather than claiming success.
    setStatus({
      tone: 'error',
      text: 'Could not confirm it sent — check before calling again.',
    });
  }, [companyId, onSent]);

  const send = async () => {
    if (!looksLikeEmail(email)) {
      setStatus({ tone: 'error', text: 'That does not look like an email address.' });
      return;
    }
    if (!services.length) {
      setStatus({ tone: 'error', text: 'The service list did not load — reload the page.' });
      return;
    }

    setSending(true);
    setStatus(null);
    try {
      const r = await fetch('/api/service-emails/send', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactId: companyId,
          email: email.trim(),
          // Always sent, even when empty. An empty string means "no name" and
          // the server honours it; sending null would make a cleared box
          // indistinguishable from an older client that never had one, and the
          // server would fall back to the stored contact.
          contactName: name.trim(),
          services: [services[0].key],
        }),
      });
      const d = await r.json().catch(() => ({}));

      if (!r.ok) {
        setStatus({ tone: 'error', text: REFUSALS[d.error] || 'Could not send — try again.' });
        return;
      }

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
            // Do NOT claim success here. The countdown finishing only means the
            // undo window closed; SES may still reject the message. Saying
            // "Sent." at this point is how a failed send looked successful for
            // the whole of the first week this feature existed.
            confirmSend(d.id);
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
  const label = services.length ? services[0].label : 'Send';
  const blocked = busy || loading || alreadySent;

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

      <input
        type="text"
        value={name}
        onChange={(e) => { setName(e.target.value); setStatus(null); }}
        placeholder="Their name (optional)"
        autoComplete="off"
        style={{ ...inputStyle, marginTop: 8 }}
      />

      <div style={{ fontSize: 11, color: T.muted, marginTop: 6 }}>
        Leave the name blank and the email opens with "Hi there".
      </div>

      <button
        type="button"
        onClick={send}
        disabled={blocked}
        style={{
          marginTop: 12, width: '100%',
          background: blocked ? T.border : T.accent,
          color: blocked ? T.muted : T.base,
          border: 'none', borderRadius: 8, padding: '9px 12px',
          fontSize: 14, fontWeight: 600,
          cursor: blocked ? 'default' : 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}
      >
        {sending && <Loader2 size={14} className="animate-spin" />}
        {sending ? 'Sending…' : loading ? 'Loading…' : label}
      </button>

      {pending && <UndoBar seconds={pending.seconds} onUndo={undo} busy={undoing} />}
      {status && <StatusLine tone={status.tone}>{status.text}</StatusLine>}

      {!status && !pending && alreadySent && (
        <StatusLine>Already sent to this address from this company.</StatusLine>
      )}
    </div>
  );
}
