// web/client/src/app/src/components/CompanyProfile.jsx
// v3.2 redesign — the company hub, rebuilt to the dark, full-width "Relationship
// Hub" layout (PageHero + People / History & notes / Overview columns + a
// full-width Services & contracts band). ALL data wiring is unchanged from the
// previous version; only the look changed, plus two additions that use existing
// endpoints: Save note (POST /api/contacts/:id/notes) and Add calendar reminder
// (POST /api/crm-events, a linked follow_up), and an editable Source dropdown.
// Reads one company (GET /api/contacts/:id), its tasks (/api/tasks?contactId=),
// its history (/api/contacts/:id/history) and its active services (contracts).
// Props: companyId (required), onBack(), onNewOrder(), onNewContract().
import React, { useEffect, useState, useRef } from 'react';
import {
  ArrowLeft, Check, Plus, Lock, X, Pencil, Trash2, Paperclip, Download,
  Phone, Users, Mail, FileText, RefreshCw, CornerUpRight, SquareCheck, Repeat,
  CalendarPlus, Calendar, User, Box, Globe, MapPin, Building2, UsersRound,
} from 'lucide-react';
import PageHero, { HeroButtonOutline } from './PageHero.jsx';
import DatePicker from './DatePicker.jsx';
import { TimePicker } from './DateTimePicker.jsx';
import { logCall } from './callLog.js';
import ServiceEmailPanel from './ServiceEmailPanel.jsx';

// Stage values are unchanged in the DB; only the FIRST label is shown as
// "Suspect" (value stays 'new' so existing data is untouched).
const STAGES = [
  { key: 'new',          label: 'Suspect' },
  { key: 'contacted',    label: 'Contacted' },
  { key: 'voicemail',    label: 'Voicemail' },
  { key: 'prospect',     label: 'Prospect' },
  { key: 'hot_prospect', label: 'Hot prospect' },
  { key: 'customer',     label: 'Customer' },
  { key: 'dead',         label: 'Dead' },
];
const SOURCES = ['Telesales', 'Door knocking', 'E-shot', 'Social media', 'Website', 'Referral'];

const PRIORITY = {
  high:   { bg: 'rgba(239,68,68,0.16)',  fg: '#f4a5a5' },
  medium: { bg: 'rgba(245,158,11,0.16)', fg: '#f5c277' },
  low:    { bg: 'rgba(16,185,129,0.16)', fg: '#7fe0c2' },
};
const HISTORY = {
  call:      { icon: Phone,         label: 'Call' },
  meeting:   { icon: Users,         label: 'Meeting' },
  follow_up: { icon: CornerUpRight, label: 'Follow-up' },
  renewal:   { icon: RefreshCw,     label: 'Renewal' },
  other:     { icon: FileText,      label: 'Note' },
  note:      { icon: FileText,      label: 'Note' },
  email:     { icon: Mail,          label: 'Email' },
  task:      { icon: SquareCheck,   label: 'Task completed' },
};
const initials = (name = '') =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';
const timeAgo = (iso) => {
  if (!iso) return '';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
};

// Build a 1-hour timed event window from a date + HH:mm time (local → ISO).
// Local YYYY-MM-DD. Using toISOString() here would shift a 00:00 event back a
// day for UK summer time, opening the calendar on the wrong date.
const ymdLocal = (iso) => {
  if (!iso) return '';           // new Date(null) is the 1970 epoch, not invalid
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const eventWindow = (date, time) => {
  const start = new Date(`${date}T${time || '09:00'}:00`);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return { start_at: start.toISOString(), end_at: end.toISOString() };
};

// "Tomorrow" / "3 days" / "Next week" for the reminder quick-date buttons.
// Steps the LOCAL calendar day, so month/year rollover and the British Summer
// Time clock changes are handled by the browser rather than by arithmetic on a
// timestamp — adding 24h in milliseconds would land on the wrong day on the
// two clock-change weekends.
const addDaysLocal = (n) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0); // midday: never near a midnight/DST edge
  d.setDate(d.getDate() + n);
  return ymdLocal(d);
};

// ── Reminder templates ───────────────────────────────────────────────────────
// Fixed list (owner's choice — not user-editable, so no storage needed).
// Each {blank} becomes a small labelled box; `label` is what sits above it.
// The finished title is assembled from these and is what lands on the calendar,
// so submitReminder is untouched and still just posts `title`.
const REMINDER_TEMPLATES = [
  { id: 'callback_ask',  chip: 'Call back',   text: 'Call back — ask for {name} regarding {subject}' },
  { id: 'callback_na',   chip: 'Not avail.',  text: 'Call back — {name} not available' },
  { id: 'send_quote',    chip: 'Send quote',  text: 'Send quote to {name} for {subject}' },
  { id: 'chase_quote',   chip: 'Chase quote', text: 'Chase quote — {name}' },
  { id: 'email',         chip: 'Email',       text: 'Email {name} regarding {subject}' },
  // Both blanks are optional, as with every other template: leave them empty
  // and fillTemplate drops the connector words too, so this reads as a plain
  // "Follow up email" — which is how the owner most often uses it.
  { id: 'follow_up_email', chip: 'Follow up email', text: 'Follow up email to {name} regarding {subject}' },
];
const BLANK_LABELS = { name: 'Ask for', subject: 'Regarding' };

// Which blanks a template needs, in the order they appear in the sentence.
const blanksOf = (tpl) => {
  if (!tpl) return [];
  const found = String(tpl.text).match(/\{(\w+)\}/g) || [];
  const seen = [];
  for (const f of found) {
    const key = f.slice(1, -1);
    if (!seen.includes(key)) seen.push(key);
  }
  return seen;
};

// Fill a template. Blanks the user hasn't typed yet are dropped along with the
// word in front of them, so a half-filled template still reads as a sentence
// ("Call back — ask for Dave") instead of leaking "{subject}" onto the calendar.
const fillTemplate = (tpl, blanks) => {
  if (!tpl) return '';
  let out = String(tpl.text);
  for (const key of blanksOf(tpl)) {
    const val = String((blanks || {})[key] || '').trim();
    if (val) {
      out = out.replace(new RegExp(`\\{${key}\\}`, 'g'), val);
    } else {
      // Drop a trailing connector ("regarding {subject}" → "") rather than
      // leaving a dangling word.
      out = out.replace(new RegExp(`\\s*\\b(?:regarding|for|to|ask for)\\s+\\{${key}\\}`, 'gi'), '');
      out = out.replace(new RegExp(`\\s*\\{${key}\\}`, 'g'), '');
    }
  }
  return out.replace(/\s+/g, ' ').replace(/\s*—\s*$/, '').trim();
};

// Human-readable file size.
const fmtSize = (b) => (b == null ? '' : b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);

// Precise date+time stamp for the timeline. The full date is ALWAYS shown
// alongside the time (e.g. "Today · 24 Jul 2026, 14:32", "Yesterday · 23 Jul
// 2026, 09:05", "27 Jun 2026, 14:32") so a note can be dated at a glance
// without hovering. Full date/time still available on hover.
const stamp = (iso) => {
  if (!iso) return '';
  const dt = new Date(iso);
  const time = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const date = dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const days = Math.floor((Date.now() - dt.getTime()) / 86400000);
  if (days <= 0) return `Today · ${date}, ${time}`;
  if (days === 1) return `Yesterday · ${date}, ${time}`;
  return `${date}, ${time}`;
};
// Company address. Stored in the `addresses` JSONB array on the contact record.
// Older records may hold objects rather than plain strings, so read both shapes.
// ── Website links ───────────────────────────────────────────────────────────
// A website saved WITHOUT "https://" — which is every one that came in via CSV
// import, since only the Add Company form tidied it up — is treated by the
// browser as a page INSIDE this app. Clicking it reloaded WorkTrackr at
// /app/www.example.com, which the app doesn't recognise, dumping the user on
// the default view (tickets) after a white flash. Prefixing at the point of use
// fixes every existing record at once, with no data change.
// It also neutralises anything odd in the stored value (e.g. a "javascript:"
// address from a dodgy spreadsheet), because it can no longer act as a scheme.
const webHref = (w) => {
  const s = String(w || '').trim();
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
};

// Build a click-to-dial link. Numbers come off the CSV import in all sorts of
// shapes — "01702 613141", "+44 (0)1702 613141", "01702 613141 / 07700 900123"
// — but a tel: link must be digits only, with an optional leading +.
//   • Only the FIRST number is used when two are stored in one field; a dialler
//     can't ring both, and dialling a mashed-together pair would be worse.
//   • "(0)" is stripped BEFORE the digits are pulled out, otherwise
//     "+44 (0)1702..." becomes 4401702... — a number that doesn't exist.
//   • Returns '' when there are no digits, so the caller renders plain text
//     instead of a dead link.
const telHref = (p) => {
  const first = String(p || '').split(/[/,;]|\bor\b/i)[0];
  const cleaned = first.replace(/\(0\)/g, '');
  const plus = cleaned.trim().startsWith('+');
  const digits = cleaned.replace(/\D/g, '');
  if (!digits) return '';
  return `tel:${plus ? '+' : ''}${digits}`;
};

// what the user reads — scheme and any trailing slash stripped off
const webLabel = (w) => String(w || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');

const addressText = (addresses) => {
  if (!Array.isArray(addresses) || addresses.length === 0) return '';
  const a = addresses[0];
  if (typeof a === 'string') return a.trim();
  if (a && typeof a === 'object') {
    return [a.line1, a.line2, a.city, a.county, a.region, a.postcode, a.country]
      .filter(Boolean).join(', ');
  }
  return '';
};

const emptyPerson = { name: '', role: '', email: '', phone: '', isDecisionMaker: false, editIndex: -1 };

// ── dark surface helpers (use the --wt-* tokens added in v3.1) ──
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
const linkBtn = { background: 'transparent', border: 'none', color: T.accent, fontSize: 13, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 };

export default function CompanyProfile({ companyId, onBack, onNewOrder, onNewContract, onOpenCalendar }) {
  const [company, setCompany] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]); // all users, for the Spotter dropdown
  const [history, setHistory] = useState([]);

  const [personForm, setPersonForm] = useState(null); // null = closed
  const [taskForm, setTaskForm] = useState(null);      // null = closed
  const [services, setServices] = useState({ loading: true, lines: [], monthlyProfit: 0, count: 0 });

  const [noteText, setNoteText] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [noteToCal, setNoteToCal] = useState(false);
  const [noteCalDate, setNoteCalDate] = useState('');
  const [noteCalTime, setNoteCalTime] = useState('09:00');
  const [dragOver, setDragOver] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const [attachNote, setAttachNote] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);
  // Neither Save note nor Add to calendar used to say anything when they
  // couldn't act — they just stopped, which reads as a broken button. These
  // hold a short explanation, and the refs let us put the cursor in the box
  // that actually needs filling in.
  const noteRef = useRef(null);
  const reminderTitleRef = useRef(null);
  const [noteHint, setNoteHint] = useState('');
  const [reminderHint, setReminderHint] = useState('');
  // Editing an existing note in the timeline. Holds { id, body } while open.
  const [editingNote, setEditingNote] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);

  // Save an edit to an existing note → PUT /api/contacts/:id/notes/:noteId
  const saveNoteEdit = async () => {
    if (!editingNote) return;
    const body = (editingNote.body || '').trim();
    if (!body) { setError('A note cannot be empty.'); return; }
    setSavingEdit(true);
    try {
      const r = await fetch(`/api/contacts/${companyId}/notes/${editingNote.id}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      setEditingNote(null);
      loadHistory();
    } catch (e) { setError(e.message || 'Could not save the change'); }
    finally { setSavingEdit(false); }
  };

  // "Add reminder" on a note → open the reminder box pre-filled from that note,
  // so a written follow-up becomes a dated calendar entry in two clicks.
  const remindAboutNote = (text) => {
    const t = String(text || '').trim();
    setReminderHint('');
    setReminderForm({
      title: t.slice(0, 80),
      date: '',
      time: '09:00',
      notes: t,
      // Opened from a note, so it starts as free text with the note's wording
      // already in the box — templates would overwrite it.
      templateId: '',
      blanks: {},
    });
  };
  const [reminderForm, setReminderForm] = useState(null); // null = closed
  const [detailsForm, setDetailsForm] = useState(null);   // company phone/email/website edit; null = closed
  const [naForm, setNaForm] = useState(null);             // next action + chase date edit; null = closed

  const loadCompany = async () => {
    const r = await fetch(`/api/contacts/${companyId}`, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    setCompany(await r.json());
  };
  const loadTasks = () =>
    fetch(`/api/tasks?contactId=${companyId}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : [])).then((d) => setTasks(Array.isArray(d) ? d : [])).catch(() => {});
  const loadHistory = () =>
    fetch(`/api/contacts/${companyId}/history`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : [])).then((d) => setHistory(Array.isArray(d) ? d : [])).catch(() => {});
  const loadAttachments = () =>
    fetch(`/api/contacts/${companyId}/attachments`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : [])).then((d) => setAttachments(Array.isArray(d) ? d : [])).catch(() => {});
  const loadServices = async () => {
    try {
      const r = await fetch(`/api/contracts?contactId=${companyId}&status=active`, { credentials: 'include' });
      const list = r.ok ? await r.json() : [];
      const details = await Promise.all(
        list.map((c) => fetch(`/api/contracts/${c.id}`, { credentials: 'include' }).then((rr) => (rr.ok ? rr.json() : null)).catch(() => null))
      );
      const lines = details.filter(Boolean).flatMap((c) => c.lines || []);
      const monthlyProfit = lines.reduce((s, l) => s + (Number(l.monthlyProfit) || 0), 0);
      setServices({ loading: false, lines, monthlyProfit, count: lines.length });
    } catch {
      setServices({ loading: false, lines: [], monthlyProfit: 0, count: 0 });
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try { setLoading(true); await loadCompany(); }
      catch (e) { if (alive) setError(e.message || 'Failed to load company'); }
      finally { if (alive) setLoading(false); }
    })();
    loadTasks();
    loadHistory();
    loadAttachments();
    loadServices();
    fetch('/api/tickets/users/list', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((d) => { if (alive) setUsers(d.users || []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [companyId]);

  // Save a crm field (stage or source) — same PUT, merging crm.
  const saveCrm = async (patch) => {
    if (!company) return;
    const prev = company;
    const nextCrm = { ...(company.crm || {}), ...patch };
    setCompany({ ...company, crm: nextCrm });
    setSaving(true);
    try {
      const r = await fetch(`/api/contacts/${companyId}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crm: nextCrm }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) { setCompany(prev); setError(e.message || 'Could not save'); }
    finally { setSaving(false); }
  };
  const setStage = (stage) => saveCrm({ salesStage: stage || null }); // '' → null = No stage
  const setSource = (source) => saveCrm({ source });
  const setSpotter = (spotterUserId) => saveCrm({ spotterUserId: spotterUserId || null });

  // Delete = soft archive (safety net). Hidden from staff; managers/admins can
  // restore it from the Companies → Archived view. Then return to the list.
  const deleteCompany = async () => {
    if (!window.confirm(`Delete ${company?.name || 'this company'}? It moves to the archive — managers and admins can restore it.`)) return;
    try {
      const nextCrm = { ...(company.crm || {}), archived: true, archivedAt: new Date().toISOString() };
      const r = await fetch(`/api/contacts/${companyId}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crm: nextCrm }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      onBack && onBack();
    } catch (e) { setError(e.message || 'Could not delete company'); }
  };

  const savePeople = async (people) => {
    const prev = company;
    setCompany({ ...company, contactPersons: people });
    try {
      const r = await fetch(`/api/contacts/${companyId}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactPersons: people }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) { setCompany(prev); setError(e.message || 'Could not save contacts'); }
  };

  const submitPerson = () => {
    if (!personForm.name.trim()) return;
    const people = Array.isArray(company.contactPersons) ? [...company.contactPersons] : [];
    const entry = {
      name: personForm.name.trim(), role: personForm.role.trim(),
      email: personForm.email.trim(), phone: personForm.phone.trim(),
      isDecisionMaker: !!personForm.isDecisionMaker,
    };
    if (personForm.editIndex >= 0) people[personForm.editIndex] = entry; else people.push(entry);
    setPersonForm(null);
    savePeople(people);
  };
  const removePerson = (i) => {
    const people = (company.contactPersons || []).filter((_, idx) => idx !== i);
    savePeople(people);
  };

  const addTask = async () => {
    if (!taskForm.title.trim()) return;
    try {
      const r = await fetch('/api/tasks', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: taskForm.title.trim(), contactId: companyId,
          dueDate: taskForm.dueDate || null, priority: taskForm.priority,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setTaskForm(null);
      loadTasks(); loadHistory();
    } catch (e) { setError(e.message || 'Could not add task'); }
  };
  const toggleTask = async (t) => {
    const next = t.status === 'done' ? 'open' : 'done';
    setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: next } : x)));
    try {
      await fetch(`/api/tasks/${t.id}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      loadHistory();
    } catch { loadTasks(); }
  };

  // Drag an email file (.eml/.txt) or selected text onto the timeline to log it
  // as a note — uses the same notes endpoint, no extra storage. (Binary files
  // like PDFs/images are noted by name only; true file storage needs the backend.)
  // Upload dropped/selected files to durable storage (DB-backed). Optional note
  // travels with the file(s). Text/emails are still logged via the note box.
  const uploadFiles = async (files) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    setUploading(true);
    try {
      for (const file of list) {
        if (file.size > 10 * 1024 * 1024) { setError(`${file.name} is over 10MB and was skipped.`); continue; }
        const fd = new FormData();
        fd.append('file', file);
        if (attachNote.trim()) fd.append('note', attachNote.trim());
        const r = await fetch(`/api/contacts/${companyId}/attachments`, { method: 'POST', credentials: 'include', body: fd });
        if (!r.ok) throw new Error(`Upload failed (HTTP ${r.status})`);
      }
      setAttachNote('');
      loadAttachments();
    } catch (e) { setError(e.message || 'Could not upload file'); }
    finally { setUploading(false); }
  };

  const deleteAttachment = async (attId) => {
    if (!window.confirm('Delete this file? This cannot be undone.')) return;
    try {
      const r = await fetch(`/api/contacts/${companyId}/attachments/${attId}`, { method: 'DELETE', credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      loadAttachments();
    } catch (e) { setError(e.message || 'Could not delete file'); }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  };

  // Save a note → POST /api/contacts/:id/notes (shows in the timeline below).
  // If "Add to calendar" is ticked, also drop it on the CRM calendar as a
  // follow-up for the chosen date (reuses the existing /api/crm-events endpoint).
  const saveNote = async () => {
    const body = noteText.trim();
    if (!body) {
      // Was a silent no-op. The most common cause is typing into the
      // attachment note box lower down, so point at the right one.
      setNoteHint('Type your note in the box above first, then press Save note.');
      if (noteRef.current) noteRef.current.focus();
      return;
    }
    setNoteHint('');
    // "Add to calendar" ticked but no date chosen used to save the note and
    // SKIP the calendar entry silently — you'd believe a reminder existed when
    // none did. Check before saving anything, so nothing is half-done.
    if (noteToCal && !noteCalDate) {
      setNoteHint('Pick a date for the calendar reminder, or untick “Add to calendar”.');
      return;
    }
    setSavingNote(true);
    try {
      const r = await fetch(`/api/contacts/${companyId}/notes`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'note', body }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (noteToCal && noteCalDate) {
        const { start_at, end_at } = eventWindow(noteCalDate, noteCalTime);
        const cr = await fetch('/api/crm-events', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contact_id: companyId, title: body.slice(0, 120), type: 'follow_up',
            // carry the note through so the calendar entry explains itself
            // instead of showing a bare title with an empty Notes section
            description: body, notes: body,
            start_at, end_at, all_day: false, status: 'planned',
          }),
        });
        if (!cr.ok) throw new Error(`Saved the note, but the calendar entry failed (HTTP ${cr.status})`);
        // an already-open calendar listens for this and reloads itself
        window.dispatchEvent(new Event('worktrackr:crm-event-created'));
      }
      setNoteText(''); setNoteToCal(false); setNoteCalDate(''); setNoteCalTime('09:00');
      loadHistory();
    } catch (e) { setError(e.message || 'Could not save note'); }
    finally { setSavingNote(false); }
  };

  // Add a calendar reminder → POST /api/crm-events (a linked follow_up that
  // lands on the CRM calendar and in this timeline).
  const submitReminder = async () => {
    const title = (reminderForm.title || '').trim();
    const date = reminderForm.date;
    const time = reminderForm.time || '09:00';
    if (!title || !date) {
      // Was a silent no-op — name the missing field rather than just stopping.
      if (!title) {
        setReminderHint('Give the reminder a name (e.g. “Call back for Christina”).');
        if (reminderTitleRef.current) reminderTitleRef.current.focus();
      } else {
        setReminderHint('Pick a date for the reminder.');
      }
      return;
    }
    setReminderHint('');
    const { start_at, end_at } = eventWindow(date, time);
    const detail = (reminderForm.notes || '').trim();
    try {
      const r = await fetch('/api/crm-events', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: companyId, title, type: 'follow_up',
          description: detail || null, notes: detail || null,
          start_at, end_at, all_day: false, status: 'planned',
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      window.dispatchEvent(new Event('worktrackr:crm-event-created'));
      setReminderForm(null);
      loadHistory();
    } catch (e) { setError(e.message || 'Could not add reminder'); }
  };

  // Save the company's own contact details (phone / email / website).
  const saveDetails = async () => {
    const prev = company;
    const w = (detailsForm.website || '').trim();
    const address = (detailsForm.address || '').trim();
    // `crm` replaces the whole column on save, so merge onto what's already there.
    const nextCrm = {
      ...(company.crm || {}),
      industry: (detailsForm.industry || '').trim(),
      companySize: (detailsForm.employees || '').trim(),
    };
    const patch = {
      phone: (detailsForm.phone || '').trim(),
      email: (detailsForm.email || '').trim(),
      website: w && !/^https?:\/\//i.test(w) ? `https://${w}` : w,
      addresses: address ? [address] : [],
      crm: nextCrm,
    };
    setCompany({ ...company, ...patch });
    setDetailsForm(null);
    try {
      const r = await fetch(`/api/contacts/${companyId}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) { setCompany(prev); setError(e.message || 'Could not save details'); }
  };

  // Save next action + chase date onto the company's crm (shows here and on the list).
  const saveNextAction = async () => {
    await saveCrm({ nextAction: (naForm.nextAction || '').trim(), chaseDate: naForm.chaseDate || null });
    setNaForm(null);
  };

  // Book the next action onto the CRM calendar as a follow-up reminder for the chase date.
  const bookNextAction = async () => {
    const title = (naForm.nextAction || '').trim() || 'Follow up';
    const date = naForm.chaseDate;
    if (!date) { setError('Pick a chase date to book it in the calendar.'); return; }
    const { start_at, end_at } = eventWindow(date, naForm.chaseTime);
    try {
      await saveCrm({ nextAction: title, chaseDate: date });
      const r = await fetch('/api/crm-events', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: companyId, title, type: 'follow_up', start_at, end_at, all_day: false, status: 'planned' }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setNaForm(null);
      loadHistory();
    } catch (e) { setError(e.message || 'Could not book reminder'); }
  };

  if (loading) return <div style={{ padding: 24, fontSize: 13, color: T.sub }}>Loading company…</div>;
  if (error && !company) return <div style={{ padding: 24, fontSize: 13, color: T.red }}>Couldn’t load company: {error}</div>;
  if (!company) return null;

  const crm = company.crm || {};
  const people = Array.isArray(company.contactPersons) ? company.contactPersons : [];
  const computedMonthly = services.monthlyProfit;
  const monthly = computedMonthly > 0 ? computedMonthly : (Number(crm.totalProfit) || 0);
  const money0 = (n) => `£${(Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const stageLabel = STAGES.find((s) => s.key === crm.salesStage)?.label || null;
  const openTasks = tasks.filter((t) => t.status === 'open');
  const today = new Date().toISOString().slice(0, 10);

  const heroActions = (
    <>
      <HeroButtonOutline icon={Check} onClick={() => setStage('customer')}>Mark won</HeroButtonOutline>
      <HeroButtonOutline icon={Plus} onClick={() => onNewOrder && onNewOrder(company)}>New order</HeroButtonOutline>
      <HeroButtonOutline icon={Repeat} onClick={() => onNewContract && onNewContract(company)}>New contract</HeroButtonOutline>
      <HeroButtonOutline icon={Trash2} onClick={deleteCompany}>Delete</HeroButtonOutline>
    </>
  );

  return (
    <div style={{ background: T.base, minHeight: '100%', padding: '16px 20px', color: T.text }}>
      <button onClick={() => onBack && onBack()}
        style={{ ...linkBtn, color: T.sub, marginBottom: 12 }}>
        <ArrowLeft size={16} /> Back to companies
      </button>

      <PageHero
        title={company.name}
        initials={initials(company.name)}
        stage={stageLabel}
        meta={[{ icon: User, label: `Account manager: ${crm.assignedTo || '—'}` }]}
        actions={heroActions}
      />

      {/* Stage / Source / next-action control strip */}
      <div style={{ ...cardStyle, marginTop: 12, display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center', fontSize: 13, color: T.sub }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          Stage
          <select value={crm.salesStage || ''} onChange={(e) => setStage(e.target.value)} disabled={saving}
            style={{ ...inputStyle, width: 'auto', padding: '5px 8px' }}>
            <option value="">No stage</option>
            {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          Source
          <select value={crm.source || ''} onChange={(e) => setSource(e.target.value)} disabled={saving}
            style={{ ...inputStyle, width: 'auto', padding: '5px 8px' }}>
            <option value="">—</option>
            {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          Spotter
          <select value={crm.spotterUserId || ''} onChange={(e) => setSpotter(e.target.value)} disabled={saving}
            style={{ ...inputStyle, width: 'auto', padding: '5px 8px' }}>
            <option value="">—</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
          </select>
        </label>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>Next action:</span>
          {naForm ? (
            <>
              <input value={naForm.nextAction} onChange={(e) => setNaForm({ ...naForm, nextAction: e.target.value })} placeholder="e.g. call back" style={{ ...inputStyle, width: 150, padding: '5px 8px' }} />
              <DatePicker value={naForm.chaseDate || ''} onChange={(v) => setNaForm({ ...naForm, chaseDate: v })} style={{ ...inputStyle, width: 'auto', padding: '5px 8px' }} />
              <TimePicker value={naForm.chaseTime || '09:00'} onChange={(v) => setNaForm({ ...naForm, chaseTime: v })} style={{ ...inputStyle, width: 'auto', padding: '5px 8px' }} />
              <button onClick={saveNextAction} style={{ background: T.accent, color: T.base, border: 'none', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Save</button>
              <button onClick={bookNextAction} style={{ background: 'transparent', color: T.accent, border: `1px solid ${T.accent}88`, borderRadius: 8, padding: '5px 10px', fontSize: 12, cursor: 'pointer' }}><CalendarPlus size={13} style={{ verticalAlign: -2, marginRight: 3 }} />Book in calendar</button>
              <button onClick={() => setNaForm(null)} style={{ background: 'transparent', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 12 }}>Cancel</button>
            </>
          ) : (
            <button onClick={() => setNaForm({ nextAction: crm.nextAction || '', chaseDate: crm.chaseDate || '' })} style={{ ...linkBtn, color: T.text }}>
              {crm.nextAction ? (
                <>
                  {crm.nextAction}
                  {crm.chaseDate && <span style={{ marginLeft: 6, color: crm.chaseDate < today ? T.red : T.sub }}>{crm.chaseDate < today ? `· overdue ${crm.chaseDate}` : `· ${crm.chaseDate}`}</span>}
                  <Pencil size={12} style={{ marginLeft: 6 }} />
                </>
              ) : (
                <span style={{ color: T.accent }}>+ Set next action</span>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Three columns: People · History & notes · Overview */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, marginTop: 12 }}>

        {/* People */}
        <div style={cardStyle}>
          {/* Company's own contact details */}
          <div style={{ marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${T.border}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', color: T.muted }}>Company details</span>
              {!detailsForm && (
                <button onClick={() => setDetailsForm({
                  phone: company.phone || '',
                  email: company.email || '',
                  website: company.website || '',
                  address: addressText(company.addresses),
                  industry: (company.crm || {}).industry || '',
                  employees: (company.crm || {}).companySize || '',
                })} style={{ ...linkBtn, color: T.muted }}><Pencil size={13} /></button>
              )}
            </div>
            {detailsForm ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <input value={detailsForm.phone} onChange={(e) => setDetailsForm({ ...detailsForm, phone: e.target.value })} placeholder="Telephone" style={inputStyle} />
                <input value={detailsForm.email} onChange={(e) => setDetailsForm({ ...detailsForm, email: e.target.value })} placeholder="Email" style={inputStyle} />
                <input value={detailsForm.website} onChange={(e) => setDetailsForm({ ...detailsForm, website: e.target.value })} placeholder="Website" style={inputStyle} />
                <input value={detailsForm.address} onChange={(e) => setDetailsForm({ ...detailsForm, address: e.target.value })} placeholder="Address" style={inputStyle} />
                <input value={detailsForm.industry} onChange={(e) => setDetailsForm({ ...detailsForm, industry: e.target.value })} placeholder="Industry" style={inputStyle} />
                <input value={detailsForm.employees} onChange={(e) => setDetailsForm({ ...detailsForm, employees: e.target.value })} placeholder="Number of employees" style={inputStyle} />
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button onClick={() => setDetailsForm(null)} style={{ ...inputStyle, width: 'auto', cursor: 'pointer', color: T.sub }}>Cancel</button>
                  <button onClick={saveDetails} style={{ background: T.accent, color: T.base, border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Save</button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 13 }}>
                <span style={{ color: company.phone ? T.text : T.muted, display: 'inline-flex', alignItems: 'center', gap: 7 }}><Phone size={13} style={{ color: T.accent, flexShrink: 0 }} />
                  {company.phone
                    ? (telHref(company.phone)
                        ? <a href={telHref(company.phone)} onClick={() => logCall({ contactId: companyId, phone: company.phone })} title={`Call ${company.phone}`} style={{ color: T.text, textDecoration: 'none' }}>{company.phone}</a>
                        : company.phone)
                    : 'No telephone'}
                </span>
                <span style={{ color: company.email ? T.text : T.muted, display: 'inline-flex', alignItems: 'center', gap: 7 }}><Mail size={13} style={{ color: T.accent, flexShrink: 0 }} />{company.email || 'No email'}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><Globe size={13} style={{ color: T.accent, flexShrink: 0 }} />
                  {company.website
                    ? <a href={webHref(company.website)} target="_blank" rel="noreferrer" style={{ color: T.text, textDecoration: 'none' }}>{webLabel(company.website)}</a>
                    : <span style={{ color: T.muted }}>No website</span>}
                </span>
                {(() => {
                  const addr = addressText(company.addresses);
                  return (
                    <span style={{ color: addr ? T.text : T.muted, display: 'inline-flex', alignItems: 'flex-start', gap: 7 }}>
                      <MapPin size={13} style={{ color: T.accent, flexShrink: 0, marginTop: 2 }} />{addr || 'No address'}
                    </span>
                  );
                })()}
                {(() => {
                  const ind = (company.crm || {}).industry || '';
                  return (
                    <span style={{ color: ind ? T.text : T.muted, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                      <Building2 size={13} style={{ color: T.accent, flexShrink: 0 }} />{ind || 'No industry'}
                    </span>
                  );
                })()}
                {(() => {
                  const emp = (company.crm || {}).companySize || '';
                  return (
                    <span style={{ color: emp ? T.text : T.muted, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                      <UsersRound size={13} style={{ color: T.accent, flexShrink: 0 }} />{emp ? `${emp} employees` : 'No employee count'}
                    </span>
                  );
                })()}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={sectionTitle}><Users size={16} style={{ color: T.accent, verticalAlign: -2, marginRight: 6 }} />People</span>
            <button onClick={() => setPersonForm({ ...emptyPerson })} style={linkBtn}><Plus size={14} /> Add person</button>
          </div>

          {personForm && (
            <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: 10, marginBottom: 8, display: 'grid', gap: 8 }}>
              <input autoFocus value={personForm.name} onChange={(e) => setPersonForm({ ...personForm, name: e.target.value })} placeholder="Name" style={inputStyle} />
              <input value={personForm.role} onChange={(e) => setPersonForm({ ...personForm, role: e.target.value })} placeholder="Role" style={inputStyle} />
              <input value={personForm.email} onChange={(e) => setPersonForm({ ...personForm, email: e.target.value })} placeholder="Email" style={inputStyle} />
              <input value={personForm.phone} onChange={(e) => setPersonForm({ ...personForm, phone: e.target.value })} placeholder="Phone" style={inputStyle} />
              <label style={{ fontSize: 13, color: T.sub, display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={personForm.isDecisionMaker} onChange={(e) => setPersonForm({ ...personForm, isDecisionMaker: e.target.checked })} /> Primary / decision maker
              </label>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => setPersonForm(null)} style={{ ...inputStyle, width: 'auto', cursor: 'pointer', color: T.sub }}>Cancel</button>
                <button onClick={submitPerson} style={{ background: T.accent, color: T.base, border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Save</button>
              </div>
            </div>
          )}

          {people.length === 0 && !personForm && <div style={{ fontSize: 13, color: T.sub, padding: '8px 0' }}>No people added yet.</div>}
          {people.map((p, i) => {
            const name = p.name || p.fullName || 'Unnamed';
            const role = p.role || p.title || p.position || '';
            const dm = p.isDecisionMaker || p.decisionMaker;
            return (
              <div key={i} style={{ background: T.base, border: `1px solid ${T.border}`, borderRadius: 8, padding: 10, marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: T.accent, color: T.base, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, flexShrink: 0 }}>{initials(name)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>
                      {name}
                      {dm && <span style={{ marginLeft: 8, fontSize: 10, color: T.green, border: `1px solid ${T.green}66`, borderRadius: 999, padding: '1px 6px' }}>Primary</span>}
                    </div>
                    {role && <div style={{ fontSize: 12, color: T.sub }}>{role}</div>}
                  </div>
                  <button onClick={() => setPersonForm({ name, role, email: p.email || '', phone: p.phone || '', isDecisionMaker: !!dm, editIndex: i })} style={{ ...linkBtn, color: T.muted }}><Pencil size={15} /></button>
                  <button onClick={() => removePerson(i)} style={{ ...linkBtn, color: T.muted }}><X size={15} /></button>
                </div>
                {(p.phone || p.email) && (
                  <div style={{ fontSize: 12, color: T.sub, marginTop: 6, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                    {p.phone && <span><Phone size={12} style={{ verticalAlign: -1, marginRight: 4, color: T.accent }} />
                      {telHref(p.phone)
                        ? <a href={telHref(p.phone)} onClick={() => logCall({ contactId: companyId, phone: p.phone })} title={`Call ${p.phone}`} style={{ color: T.sub, textDecoration: 'none' }}>{p.phone}</a>
                        : p.phone}
                    </span>}
                    {p.email && <span><Mail size={12} style={{ verticalAlign: -1, marginRight: 4, color: T.accent }} />{p.email}</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* History & notes */}
        <div
          style={{ ...cardStyle, ...(dragOver ? { outline: `2px dashed ${T.accent}`, outlineOffset: -2 } : {}) }}
          onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
          onDrop={handleDrop}
        >
          <div style={{ ...sectionTitle, marginBottom: 10 }}><Calendar size={16} style={{ color: T.accent, verticalAlign: -2, marginRight: 6 }} />History &amp; notes</div>
          {dragOver && (
            <div style={{ fontSize: 12, color: T.accent, fontWeight: 600, marginBottom: 8 }}>
              Drop files here to attach them
            </div>
          )}
          <textarea ref={noteRef} value={noteText} onChange={(e) => { setNoteText(e.target.value); if (noteHint) setNoteHint(''); }} placeholder="Log a call, note or meeting…"
            style={{ ...inputStyle, minHeight: 56, resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button onClick={saveNote} disabled={savingNote}
              style={{ background: T.accent, color: T.base, border: 'none', borderRadius: 8, padding: '7px 12px', fontSize: 13, fontWeight: 600, cursor: savingNote ? 'default' : 'pointer', opacity: (!noteText.trim() || savingNote) ? 0.5 : 1 }}>
              <FileText size={14} style={{ verticalAlign: -2, marginRight: 4 }} />{savingNote ? 'Saving…' : 'Save note'}
            </button>
            <button onClick={() => setReminderForm({ title: '', date: '', time: '09:00', notes: '', templateId: '', blanks: {} })}
              style={{ background: 'transparent', color: T.accent, border: `1px solid ${T.accent}88`, borderRadius: 8, padding: '7px 12px', fontSize: 13, cursor: 'pointer' }}>
              <CalendarPlus size={14} style={{ verticalAlign: -2, marginRight: 4 }} />Add calendar reminder
            </button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: T.sub, cursor: 'pointer', userSelect: 'none' }}>
              <input type="checkbox" checked={noteToCal} onChange={(e) => setNoteToCal(e.target.checked)} style={{ accentColor: T.accent, cursor: 'pointer' }} />
              Add to calendar
            </label>
            {noteToCal && (
              <>
                <DatePicker value={noteCalDate} onChange={(v) => setNoteCalDate(v)}
                  style={{ ...inputStyle, width: 'auto', padding: '5px 8px' }} />
                <TimePicker value={noteCalTime} onChange={(v) => setNoteCalTime(v)}
                  style={{ ...inputStyle, width: 'auto', padding: '5px 8px' }} />
              </>
            )}
          </div>
          {noteHint && (
            <div style={{ marginTop: 6, fontSize: 12.5, color: T.accent }}>{noteHint}</div>
          )}

          {/* ── Attachments ── */}
          {/* The note field below belongs to the FILE uploader, not to History &
              notes. It used to sit loose under the drop zone and was easily
              mistaken for the main note box, so it is now boxed in and labelled
              with the attachments it belongs to. */}
          <div style={{ marginTop: 12, border: `1px solid ${T.border}`, borderRadius: 10, padding: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, color: T.muted, textTransform: 'uppercase', marginBottom: 8 }}>
              Attachments
            </div>
            <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }}
              onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }} />
            <div
              onClick={() => fileInputRef.current && fileInputRef.current.click()}
              style={{
                border: `1.5px dashed ${dragOver ? T.accent : T.border}`, borderRadius: 8, padding: '12px',
                textAlign: 'center', cursor: 'pointer', background: dragOver ? 'rgba(245,158,11,0.06)' : 'transparent',
              }}
            >
              <Paperclip size={15} style={{ color: T.accent, verticalAlign: -2, marginRight: 6 }} />
              <span style={{ fontSize: 13, color: T.sub }}>{uploading ? 'Uploading…' : 'Drag files here, or click to browse'}</span>
            </div>
            <input value={attachNote} onChange={(e) => setAttachNote(e.target.value)} placeholder="Optional label for the file(s) above…"
              style={{ ...inputStyle, marginTop: 8 }} />
            <div style={{ fontSize: 11.5, color: T.muted, marginTop: 4 }}>
              Only used when you attach a file. To log a call or note, use the box at the top.
            </div>
            {attachments.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {attachments.map((a) => (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 10px' }}>
                    <Paperclip size={14} style={{ color: T.muted, flexShrink: 0 }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <a href={`/api/contacts/${companyId}/attachments/${a.id}/download`} target="_blank" rel="noreferrer"
                        style={{ fontSize: 13, color: T.text, textDecoration: 'none', fontWeight: 500 }}>{a.filename}</a>
                      <div style={{ fontSize: 11, color: T.muted }}>
                        {fmtSize(a.size_bytes)}{a.uploader_name ? ` · ${a.uploader_name}` : ''}{a.created_at ? ` · ${stamp(a.created_at)}` : ''}
                      </div>
                      {a.note && <div style={{ fontSize: 12, color: T.sub, marginTop: 2 }}>{a.note}</div>}
                    </div>
                    <a href={`/api/contacts/${companyId}/attachments/${a.id}/download`} target="_blank" rel="noreferrer"
                      title="Download" style={{ color: T.muted, flexShrink: 0, display: 'inline-flex' }}><Download size={15} /></a>
                    <button onClick={() => deleteAttachment(a.id)} title="Delete"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.muted, flexShrink: 0, display: 'inline-flex', padding: 0 }}><Trash2 size={15} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {reminderForm && (() => {
            const tpl = REMINDER_TEMPLATES.find((t) => t.id === reminderForm.templateId) || null;
            const blanks = reminderForm.blanks || {};
            const keys = blanksOf(tpl);
            // People already on this company — real data, so the commonest
            // "ask for" name is one tap instead of typing it.
            const contactNames = people
              .map((p) => String(p?.name || '').trim())
              .filter(Boolean)
              .slice(0, 4);

            // Picking a template rebuilds the title; clearing it hands the box
            // back to free typing exactly as before.
            const chooseTemplate = (id) => {
              setReminderHint('');
              if (!id) { setReminderForm({ ...reminderForm, templateId: '', blanks: {}, title: '' }); return; }
              const next = REMINDER_TEMPLATES.find((t) => t.id === id) || null;
              setReminderForm({ ...reminderForm, templateId: id, blanks: {}, title: fillTemplate(next, {}) });
            };
            const setBlank = (key, val) => {
              setReminderHint('');
              const nextBlanks = { ...blanks, [key]: val };
              setReminderForm({ ...reminderForm, blanks: nextBlanks, title: fillTemplate(tpl, nextBlanks) });
            };
            const setDate = (v) => { setReminderForm({ ...reminderForm, date: v }); if (reminderHint) setReminderHint(''); };
            // Enter anywhere in the small boxes files the reminder, so a
            // call-back is type-type-tap without reaching for the mouse.
            const onKeyDown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submitReminder(); } };

            const chipStyle = (on) => ({
              background: on ? T.accent : 'transparent',
              color: on ? T.base : T.sub,
              border: `1px solid ${on ? T.accent : T.border}`,
              borderRadius: 999, padding: '4px 10px', fontSize: 12,
              fontWeight: on ? 600 : 400, cursor: 'pointer', whiteSpace: 'nowrap',
            });

            return (
            <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: 10, marginTop: 8, display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {REMINDER_TEMPLATES.map((t) => (
                  <button key={t.id} type="button" onClick={() => chooseTemplate(reminderForm.templateId === t.id ? '' : t.id)}
                    title={t.text} style={chipStyle(reminderForm.templateId === t.id)}>{t.chip}</button>
                ))}
                {reminderForm.templateId && (
                  <button type="button" onClick={() => chooseTemplate('')} style={{ ...linkBtn, fontSize: 12 }}>Type my own</button>
                )}
              </div>

              {tpl ? (
                <>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {keys.map((key, i) => (
                      <div key={key} style={{ flex: '1 1 140px', minWidth: 0 }}>
                        <label style={{ display: 'block', fontSize: 11, color: T.sub, marginBottom: 4 }}>{BLANK_LABELS[key] || key}</label>
                        <input
                          ref={i === 0 ? reminderTitleRef : undefined}
                          autoFocus={i === 0}
                          value={blanks[key] || ''}
                          onChange={(e) => setBlank(key, e.target.value)}
                          onKeyDown={onKeyDown}
                          placeholder={key === 'name' ? 'e.g. Dave' : 'e.g. printing'}
                          style={inputStyle}
                        />
                      </div>
                    ))}
                  </div>
                  {keys.includes('name') && contactNames.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: T.muted }}>People here:</span>
                      {contactNames.map((n) => (
                        <button key={n} type="button" onClick={() => setBlank('name', n)} style={chipStyle(blanks.name === n)}>{n}</button>
                      ))}
                    </div>
                  )}
                  <div style={{ fontSize: 12.5, color: T.sub }}>
                    Calendar entry: <span style={{ color: T.text }}>{reminderForm.title || '—'}</span>
                  </div>
                </>
              ) : (
                <input ref={reminderTitleRef} autoFocus value={reminderForm.title} onChange={(e) => { setReminderForm({ ...reminderForm, title: e.target.value }); if (reminderHint) setReminderHint(''); }} onKeyDown={onKeyDown} placeholder="Reminder (e.g. call back)" style={inputStyle} />
              )}

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {[['Tomorrow', 1], ['3 days', 3], ['Next week', 7]].map(([label, n]) => {
                  const d = addDaysLocal(n);
                  return (
                    <button key={label} type="button" onClick={() => setDate(d)} style={chipStyle(reminderForm.date === d)}>{label}</button>
                  );
                })}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <DatePicker value={reminderForm.date} onChange={setDate} style={{ ...inputStyle, flex: 1 }} />
                <TimePicker value={reminderForm.time || '09:00'} onChange={(v) => setReminderForm({ ...reminderForm, time: v })} style={{ ...inputStyle, width: 'auto' }} />
              </div>
              <textarea value={reminderForm.notes || ''} onChange={(e) => setReminderForm({ ...reminderForm, notes: e.target.value })}
                placeholder="What's it about? (optional — shows on the calendar entry)"
                style={{ ...inputStyle, minHeight: 44, resize: 'vertical' }} />
              {reminderHint && (
                <div style={{ fontSize: 12.5, color: T.accent }}>{reminderHint}</div>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => { setReminderForm(null); setReminderHint(''); }} style={{ ...inputStyle, width: 'auto', cursor: 'pointer', color: T.sub }}>Cancel</button>
                <button onClick={submitReminder} style={{ background: T.accent, color: T.base, border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: (reminderForm.title || '').trim() && reminderForm.date ? 1 : 0.5 }}>Add to calendar</button>
              </div>
            </div>
            );
          })()}

          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {history.length === 0 && <div style={{ fontSize: 13, color: T.sub }}>No recent activity yet. Notes you save, calls and meetings from the CRM calendar, and completed tasks show here.</div>}
            {history.map((h) => {
              const cfg = HISTORY[h.kind] || HISTORY.other;
              const Icon = cfg.icon;
              // History ids are prefixed by source: e_ = a crm_events row (a
              // calendar entry), n_ = a note, t_ = a completed task. Only the
              // calendar ones can be opened in the calendar.
              const isCalendarEntry = String(h.id || '').startsWith('e_') && h.at;
              const dayStr = isCalendarEntry ? ymdLocal(h.at) : '';
              // n_ = a contact_notes row — the only kind that can be edited.
              const isNote = String(h.id || '').startsWith('n_');
              const rawNoteId = isNote ? String(h.id).slice(2) : '';
              const isEditing = isNote && editingNote && editingNote.id === rawNoteId;
              return (
                <div key={h.id} style={{ display: 'flex', gap: 9, fontSize: 13 }}>
                  <Icon size={15} style={{ color: T.accent, marginTop: 2, flexShrink: 0 }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    {isEditing ? (
                      <div style={{ display: 'grid', gap: 6 }}>
                        <textarea
                          autoFocus
                          value={editingNote.body}
                          onChange={(e) => setEditingNote({ ...editingNote, body: e.target.value })}
                          style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }}
                        />
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button onClick={saveNoteEdit} disabled={savingEdit || !editingNote.body.trim()}
                            style={{ background: T.accent, color: T.base, border: 'none', borderRadius: 8, padding: '5px 11px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', opacity: (savingEdit || !editingNote.body.trim()) ? 0.5 : 1 }}>
                            {savingEdit ? 'Saving…' : 'Save changes'}
                          </button>
                          <button onClick={() => setEditingNote(null)}
                            style={{ background: 'none', border: `1px solid ${T.border}`, borderRadius: 8, padding: '5px 11px', fontSize: 12.5, color: T.sub, cursor: 'pointer' }}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div style={{ color: T.text }}><span style={{ fontWeight: 600 }}>{cfg.label}</span>{h.title ? ` — ${h.title}` : ''}</div>
                        <div style={{ fontSize: 12, color: T.muted }} title={h.at ? new Date(h.at).toLocaleString() : ''}>
                          {h.actor ? `${h.actor} · ` : ''}{stamp(h.at)}
                          {h.editedAt ? ` · edited${h.editor ? ` by ${h.editor}` : ''} ${stamp(h.editedAt)}` : ''}
                        </div>
                        <div style={{ display: 'flex', gap: 12, marginTop: 2, flexWrap: 'wrap' }}>
                          {isCalendarEntry && onOpenCalendar && (
                            <button
                              onClick={() => onOpenCalendar(dayStr)}
                              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: T.accent, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                            >
                              <CalendarPlus size={12} /> View in calendar
                            </button>
                          )}
                          {isNote && (
                            <>
                              <button
                                onClick={() => setEditingNote({ id: rawNoteId, body: h.body || h.title || '' })}
                                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: T.accent, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                              >
                                <Pencil size={12} /> Edit
                              </button>
                              <button
                                onClick={() => remindAboutNote(h.body || h.title || '')}
                                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: T.accent, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                              >
                                <CalendarPlus size={12} /> Add reminder
                              </button>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Overview: send service email + stat tiles + tasks */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Sits at the TOP of the column on purpose — it is used straight
              after a call, so it should be the first thing in reach without
              scrolling. onSent reloads the timeline so the logged email shows
              in History & notes immediately. */}
          <ServiceEmailPanel
            companyId={companyId}
            defaultEmail={company?.email || ''}
            onSent={loadHistory}
          />

          <div style={cardStyle}>
            <div style={{ ...sectionTitle, marginBottom: 10 }}>Overview</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ background: T.base, borderRadius: 8, padding: 10 }}>
                <div style={{ fontSize: 12, color: T.sub }}>Monthly profit</div>
                <div style={{ fontSize: 22, fontWeight: 600, color: T.accent }}>{Number.isFinite(monthly) && monthly > 0 ? money0(monthly) : '£—'}</div>
              </div>
              <div style={{ background: T.base, borderRadius: 8, padding: 10 }}>
                <div style={{ fontSize: 12, color: T.sub }}>Active services</div>
                <div style={{ fontSize: 22, fontWeight: 600, color: T.accent }}>{services.loading ? '…' : services.count}</div>
              </div>
              <div style={{ background: T.base, borderRadius: 8, padding: 10 }}>
                <div style={{ fontSize: 12, color: T.sub }}>Open tasks</div>
                <div style={{ fontSize: 22, fontWeight: 600, color: T.accent }}>{openTasks.length}</div>
              </div>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={sectionTitle}>Tasks</span>
              <button onClick={() => setTaskForm({ title: '', dueDate: '', priority: 'medium' })} style={linkBtn}><Plus size={14} /> Add task</button>
            </div>

            {taskForm && (
              <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: 10, marginBottom: 8, display: 'grid', gap: 8 }}>
                <input autoFocus value={taskForm.title} onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })} placeholder="What needs doing?" style={inputStyle} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <DatePicker value={taskForm.dueDate} onChange={(v) => setTaskForm({ ...taskForm, dueDate: v })} style={{ ...inputStyle, flex: 1 }} />
                  <select value={taskForm.priority} onChange={(e) => setTaskForm({ ...taskForm, priority: e.target.value })} style={{ ...inputStyle, width: 'auto' }}>
                    <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
                  </select>
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button onClick={() => setTaskForm(null)} style={{ ...inputStyle, width: 'auto', cursor: 'pointer', color: T.sub }}>Cancel</button>
                  <button onClick={addTask} style={{ background: T.accent, color: T.base, border: 'none', borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Save</button>
                </div>
              </div>
            )}

            {tasks.length === 0 && !taskForm && <div style={{ fontSize: 13, color: T.sub, padding: '4px 0' }}>No tasks yet.</div>}
            {tasks.map((t) => {
              const overdue = t.status === 'open' && t.dueDate && t.dueDate < today;
              const pr = PRIORITY[t.priority] || PRIORITY.medium;
              return (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 13 }}>
                  <button onClick={() => toggleTask(t)} style={{ flexShrink: 0, width: 16, height: 16, borderRadius: 4, border: `1px solid ${T.border}`, background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                    {t.status === 'done' && <Check size={12} style={{ color: T.green }} />}
                  </button>
                  <span style={{ flex: 1, minWidth: 0, textDecoration: t.status === 'done' ? 'line-through' : 'none', color: t.status === 'done' ? T.muted : T.text }}>{t.title}</span>
                  {t.dueDate && <span style={{ fontSize: 12, color: overdue ? T.red : T.muted }}>{overdue ? 'overdue' : t.dueDate}</span>}
                  <span style={{ borderRadius: 999, padding: '1px 7px', fontSize: 10, background: pr.bg, color: pr.fg }}>{t.priority[0].toUpperCase() + t.priority.slice(1)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Services & contracts — full-width band */}
      <div style={{ ...cardStyle, marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span style={sectionTitle}><Box size={16} style={{ color: T.accent, verticalAlign: -2, marginRight: 6 }} />Services &amp; contracts</span>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {services.lines.some((l) => l.source === 'idyq') && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 8, background: 'rgba(124,116,255,0.15)', color: '#b9b3ff', padding: '2px 8px', fontSize: 11 }}>
                <Lock size={12} /> from IdoYourQuotes
              </span>
            )}
            <button onClick={() => onNewContract && onNewContract(company)} style={linkBtn}><Plus size={14} /> New contract</button>
          </div>
        </div>

        {services.loading ? (
          <div style={{ fontSize: 13, color: T.sub, padding: '20px 0', textAlign: 'center' }}>Loading services…</div>
        ) : services.lines.length === 0 ? (
          <div style={{ fontSize: 13, color: T.sub, padding: '20px 0', textAlign: 'center' }}>
            No active services yet. Activate a contract for this company to see recurring services and monthly profit here.
          </div>
        ) : (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)', gap: 8, padding: '6px 0', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: T.muted }}>
              <div>Service</div><div style={{ textAlign: 'right' }}>Charge</div><div style={{ textAlign: 'right' }}>Cost</div><div style={{ textAlign: 'right' }}>Profit</div>
            </div>
            {services.lines.map((l) => {
              const charge = (Number(l.monthlyCost) || 0) + (Number(l.monthlyProfit) || 0);
              return (
                <div key={l.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)', gap: 8, padding: '8px 0', borderTop: `1px solid ${T.border}`, fontSize: 13, alignItems: 'center' }}>
                  <div style={{ color: T.text, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {l.description}
                    <span style={{ marginLeft: 4, fontSize: 10, color: T.muted }}>{l.billingInterval === 'annual' ? '/yr ÷12' : '/mo'}</span>
                    {l.source === 'idyq' && <span style={{ marginLeft: 4, fontSize: 9.5, background: 'rgba(124,116,255,0.18)', color: '#b9b3ff', borderRadius: 4, padding: '0 4px', fontWeight: 600 }}>IDYQ</span>}
                  </div>
                  <div style={{ textAlign: 'right', color: T.sub }}>{money0(charge)}</div>
                  <div style={{ textAlign: 'right', color: T.muted }}>{money0(l.monthlyCost)}</div>
                  <div style={{ textAlign: 'right', color: T.green }}>{money0(l.monthlyProfit)}</div>
                </div>
              );
            })}
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)', gap: 8, padding: '8px', marginTop: 4, borderRadius: 8, background: 'rgba(16,185,129,0.12)', fontSize: 13, fontWeight: 600 }}>
              <div style={{ color: T.green }}>Total recurring / month</div><div /><div />
              <div style={{ textAlign: 'right', color: T.green }}>{money0(services.monthlyProfit)}</div>
            </div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 8 }}>Read-only — from this company's active contracts. Edit margins on the quote in IdoYourQuotes and re-pull, or in the contract for manual lines.</div>
          </div>
        )}
      </div>

      {error && <div style={{ fontSize: 12, color: T.red, marginTop: 12 }}>{error}</div>}
    </div>
  );
}
