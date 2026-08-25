// web/client/src/app/src/components/HolidayManager.jsx
// Workspace › Holiday admin (managers/admins/owners only). Three tabs:
//   • Approvals — the pending-request queue with a "who else is off" clash hint,
//     Approve / Reject (with a reason).
//   • Team — every staff member: editable allowance, per-person working-week tick
//     boxes, carry-over days, a live balance, and an Adjust panel (entitlement
//     overrides: grant extra days or deduct e.g. a sick day, each with a reason).
//   • Settings — the company-wide holiday year + carry-over policy.
// All data from /api/holidays/* (manager endpoints; the backend 403s non-managers).
import React, { useEffect, useMemo, useState } from 'react';
import DatePicker from './DatePicker.jsx';
import {
  CalendarCheck, Check, X, Plus, Trash2, Loader2, AlertCircle, Save, Users, Settings as SettingsIcon, Palmtree,
  ArrowLeft, Pencil, CalendarDays, Sliders,
} from 'lucide-react';
import PageHero, { HeroButtonOutline } from './PageHero.jsx';

const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const ukDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

// A holiday date is a plain calendar day, but the API hands it back as a full
// timestamp. NEVER use toISOString()/String().slice(0,10) on it — under British
// Summer Time that shifts local midnight back a day, so 10 Aug is read as
// 9 Aug and an edit would silently move someone's holiday. Build the
// YYYY-MM-DD from LOCAL getters instead. Falsy input must be guarded too:
// new Date(null) is the 1970 epoch, not an invalid date.
const ymdLocal = (d) => {
  if (!d) return '';
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.slice(0, 10)) && !d.includes('T')) return d.slice(0, 10);
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
};

const STATUS_PILL = {
  approved: { label: 'Approved', cls: 'bg-[rgba(16,185,129,0.18)] text-[#6ee7b7]' },
  pending:  { label: 'Awaiting approval', cls: 'bg-[rgba(245,158,11,0.20)] text-[#fcd34d]' },
  rejected: { label: 'Rejected', cls: 'bg-[rgba(239,68,68,0.20)] text-[#fca5a5]' },
  cancelled:{ label: 'Cancelled', cls: 'bg-[#2e2e4a] text-[#94a3b8]' },
};
const fmt = (n) => {
  const s = (Math.round(Number(n) * 2) / 2).toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};
const initials = (name) => (name || '?').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
const overlaps = (aS, aE, bS, bE) => new Date(aS) <= new Date(bE) && new Date(bS) <= new Date(aE);

export default function HolidayManager() {
  const [tab, setTab] = useState('approvals');
  const [staff, setStaff] = useState([]);
  const [requests, setRequests] = useState([]);
  const [settings, setSettings] = useState(null);
  const [year, setYear] = useState({ yearStart: null, yearEnd: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // When set, we show that one person's full booking history instead of the
  // tabs. Held as a user id (not the person object) so a reload after an edit
  // re-reads fresh balances rather than showing a stale copy.
  const [viewUserId, setViewUserId] = useState(null);

  const loadAll = async () => {
    try {
      setLoading(true);
      const [s, r, st] = await Promise.all([
        fetch('/api/holidays/staff', { credentials: 'include' }),
        fetch('/api/holidays/requests', { credentials: 'include' }),
        fetch('/api/holidays/settings', { credentials: 'include' }),
      ]);
      if (s.status === 403 || r.status === 403) throw new Error('Manager access required');
      if (!s.ok || !r.ok || !st.ok) throw new Error('Failed to load');
      const sData = await s.json();
      setStaff(sData.staff || []);
      setYear({ yearStart: sData.yearStart, yearEnd: sData.yearEnd });
      setRequests(await r.json());
      setSettings(await st.json());
      setError(null);
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); }, []);

  const pendingCount = requests.filter((q) => q.status === 'pending').length;

  const yearLabel = year.yearStart && year.yearEnd
    ? `Holiday year · ${ukDate(year.yearStart)} – ${ukDate(year.yearEnd)}`
    : 'Holiday year not set yet';

  const TABS = [
    { id: 'approvals', label: 'Approvals', icon: CalendarCheck, badge: pendingCount },
    { id: 'team', label: 'Team', icon: Users },
    { id: 'settings', label: 'Settings', icon: SettingsIcon },
  ];

  // Per-person screen. If the person somehow isn't in the staff list any more
  // (removed while the screen was open) we fall straight back to the tabs
  // rather than rendering a broken header.
  const viewPerson = viewUserId ? staff.find((p) => p.userId === viewUserId) : null;
  if (!loading && !error && viewUserId && viewPerson) {
    return (
      <StaffDatesScreen
        person={viewPerson}
        requests={requests.filter((q) => q.userId === viewUserId)}
        onBack={() => setViewUserId(null)}
        onChanged={loadAll}
      />
    );
  }

  return (
    <div className="p-5 md:p-7 min-h-full bg-[#1a1a2e]">
      <div className="mb-5">
        <PageHero
          title="Holiday admin"
          icon={Palmtree}
          meta={[{ icon: CalendarCheck, label: yearLabel }]}
          actions={<HeroButtonOutline icon={SettingsIcon} onClick={() => setTab('settings')}>Year &amp; policy</HeroButtonOutline>}
          compact
        />
      </div>

      <div className="flex items-center gap-1 mb-5 border-b border-[#2e2e4a]">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`relative inline-flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors ${tab === t.id ? 'text-white border-[#f59e0b]' : 'text-[#94a3b8] border-transparent hover:text-white'}`}>
            <t.icon className="w-4 h-4" /> {t.label}
            {t.badge > 0 && <span className="ml-1 rounded-full bg-[rgba(245,158,11,0.20)] text-[#fcd34d] text-[10px] px-1.5 py-0.5">{t.badge}</span>}
          </button>
        ))}
      </div>

      {loading && <div className="flex items-center gap-2 text-[#94a3b8] text-sm px-1 py-8"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}
      {error && !loading && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-[rgba(239,68,68,0.10)] border border-[rgba(239,68,68,0.35)] text-[#fca5a5] text-sm">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {!loading && !error && (
        <>
          {tab === 'approvals' && <ApprovalsTab requests={requests} onChanged={loadAll} />}
          {tab === 'team' && <TeamTab staff={staff} onChanged={loadAll} onOpenPerson={setViewUserId} />}
          {tab === 'settings' && <SettingsTab settings={settings} onChanged={loadAll} />}
        </>
      )}
    </div>
  );
}

// ── Approvals ────────────────────────────────────────────────────────────────
function ApprovalsTab({ requests, onChanged }) {
  const pending = requests.filter((q) => q.status === 'pending')
    .sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
  const others = requests.filter((q) => q.status === 'approved' || q.status === 'pending');

  if (pending.length === 0) {
    return (
      <div className="rounded-xl border border-[#2e2e4a] bg-[#242438] px-4 py-12 text-center">
        <Check className="w-8 h-8 text-[#10b981] mx-auto mb-2" />
        <div className="text-white text-[15px] font-semibold">All caught up</div>
        <div className="text-[#94a3b8] text-[13px] mt-1">No holiday requests waiting for approval.</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {pending.map((q) => (
        <RequestCard key={q.id} req={q} others={others} onChanged={onChanged} />
      ))}
    </div>
  );
}

function RequestCard({ req, others, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(null);

  const clashes = useMemo(() => others.filter((o) =>
    o.id !== req.id && o.userId !== req.userId && overlaps(req.startDate, req.endDate, o.startDate, o.endDate)
  ), [others, req]);

  const act = async (kind) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/holidays/requests/${req.id}/${kind}`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: kind === 'reject' ? (reason || null) : null }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Failed');
      onChanged();
    } catch (e) {
      setErr(e.message || 'Failed'); setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-[#2e2e4a] bg-[#242438] overflow-hidden" style={{ borderLeft: '3px solid #f59e0b' }}>
      <div className="flex items-start gap-3 p-4">
        <div className="w-10 h-10 rounded-full bg-[#f59e0b] text-[#1a1a2e] flex items-center justify-center font-semibold text-[13px] flex-shrink-0">{initials(req.userName)}</div>
        <div className="flex-1 min-w-0">
          <div className="text-white font-semibold text-[14px]">{req.userName}</div>
          <div className="text-[#cbd5e1] text-[13px] mt-0.5">
            {ukDate(req.startDate)}{req.startDate !== req.endDate ? ` – ${ukDate(req.endDate)}` : ''}
            <span className="text-[#94a3b8]"> · {fmt(req.days)} day{req.days === 1 ? '' : 's'}</span>
            {(req.halfStart || req.halfEnd) && <span className="text-[#94a3b8]"> · ½</span>}
          </div>
          {req.note && <div className="text-[#94a3b8] text-[12.5px] mt-1">“{req.note}”</div>}
          {clashes.length > 0 && (
            <div className="mt-2 text-[12px] text-[#fcd34d] flex items-start gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>Also off then: {clashes.map((c) => `${c.userName} (${ukDate(c.startDate)}${c.startDate !== c.endDate ? `–${ukDate(c.endDate)}` : ''}${c.status === 'pending' ? ', pending' : ''})`).join('; ')}</span>
            </div>
          )}
        </div>
        {!rejecting && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={() => act('approve')} disabled={busy}
              className="inline-flex items-center gap-1 rounded-lg bg-[rgba(16,185,129,0.15)] border border-[rgba(16,185,129,0.45)] text-[#6ee7b7] text-[12.5px] px-3 py-1.5 hover:bg-[rgba(16,185,129,0.25)] disabled:opacity-50">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Approve
            </button>
            <button onClick={() => setRejecting(true)} disabled={busy}
              className="inline-flex items-center gap-1 rounded-lg bg-[rgba(239,68,68,0.12)] border border-[rgba(239,68,68,0.45)] text-[#fca5a5] text-[12.5px] px-3 py-1.5 hover:bg-[rgba(239,68,68,0.22)] disabled:opacity-50">
              <X className="w-3.5 h-3.5" /> Reject
            </button>
          </div>
        )}
      </div>
      {rejecting && (
        <div className="px-4 pb-4 flex items-center gap-2">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (shown to the staff member)"
            className="flex-1 px-3 py-2 rounded-lg bg-[#1a1a2e] border border-[#2e2e4a] text-[12.5px] text-white focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30" />
          <button onClick={() => act('reject')} disabled={busy}
            className="inline-flex items-center gap-1 rounded-lg bg-[rgba(239,68,68,0.15)] border border-[rgba(239,68,68,0.45)] text-[#fca5a5] text-[12.5px] px-3 py-2 disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />} Confirm reject
          </button>
          <button onClick={() => { setRejecting(false); setReason(''); }} className="text-[12.5px] text-[#94a3b8] px-2 hover:text-white">Cancel</button>
        </div>
      )}
      {err && <div className="px-4 pb-3 text-[12px] text-[#fca5a5]">{err}</div>}
    </div>
  );
}

// ── Team ─────────────────────────────────────────────────────────────────────
function TeamTab({ staff, onChanged, onOpenPerson }) {
  const [adjustFor, setAdjustFor] = useState(null);
  if (staff.length === 0) {
    return <div className="rounded-xl border border-[#2e2e4a] bg-[#242438] px-4 py-10 text-center text-[13px] text-[#94a3b8]">No staff found.</div>;
  }
  return (
    <div className="rounded-xl border border-[#2e2e4a] bg-[#242438] overflow-hidden">
      <div className="overflow-x-auto">
        <div className="min-w-[820px]">
          <div className="grid grid-cols-[minmax(0,1.4fr)_96px_168px_96px_minmax(0,1.4fr)_150px] gap-3 px-4 py-2.5 bg-[#1f1f33] text-[11px] uppercase tracking-wide text-[#6b7280]">
            <div>Person</div><div className="text-center">Allowance</div><div className="text-center">Working week</div><div className="text-center">Carry-over</div><div>Balance</div><div className="text-right">Actions</div>
          </div>
          {staff.map((p) => (
            <StaffRow key={p.userId} person={p} onChanged={onChanged} onAdjust={() => setAdjustFor(p)} onOpen={() => onOpenPerson(p.userId)} />
          ))}
        </div>
      </div>
      {adjustFor && <AdjustModal person={adjustFor} onClose={() => setAdjustFor(null)} onChanged={onChanged} />}
    </div>
  );
}

function StaffRow({ person, onChanged, onAdjust, onOpen }) {
  const [allowance, setAllowance] = useState(person.baseAllowance != null ? String(person.baseAllowance) : '');
  const [carry, setCarry] = useState(String(person.carriedOver || 0));
  const [working, setWorking] = useState(person.workingDays || '1111100');
  const [saving, setSaving] = useState(false);

  const dirty = (person.baseAllowance != null ? String(person.baseAllowance) : '') !== allowance
    || String(person.carriedOver || 0) !== carry
    || (person.workingDays || '1111100') !== working;

  const toggleDay = (i) => setWorking((w) => w.substring(0, i) + (w[i] === '1' ? '0' : '1') + w.substring(i + 1));

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch(`/api/holidays/allowances/${person.userId}`, {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          allowanceDays: allowance === '' ? null : Number(allowance),
          carryOverDays: carry === '' ? 0 : Number(carry),
          workingDays: working,
        }),
      });
      if (!r.ok) throw new Error();
      onChanged();
    } catch {
      alert('Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const numCls = 'w-full px-2 py-1.5 rounded-md bg-[#1a1a2e] border border-[#2e2e4a] text-[13px] text-white text-center focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30';

  return (
    <div className="grid grid-cols-[minmax(0,1.4fr)_96px_168px_96px_minmax(0,1.4fr)_150px] gap-3 items-center px-4 py-3 border-t border-[#2e2e4a]">
      <button onClick={onOpen} title={`View all of ${person.name}'s holiday dates`}
        className="min-w-0 flex items-center gap-2.5 text-left rounded-lg -mx-1 px-1 py-0.5 hover:bg-[#2a2a48] group">
        <div className="w-8 h-8 rounded-full bg-[#2e2e4a] text-[#cbd5e1] flex items-center justify-center text-[11px] font-semibold flex-shrink-0">{initials(person.name)}</div>
        <div className="min-w-0">
          <div className="text-[13px] text-white truncate group-hover:text-[#fcd34d] group-hover:underline">{person.name}</div>
          <div className="text-[11px] text-[#6b7280] capitalize">{person.role}</div>
        </div>
      </button>
      <div><input value={allowance} onChange={(e) => setAllowance(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="—" inputMode="decimal" className={numCls} /></div>
      <div className="flex items-center justify-center gap-1">
        {DOW.map((d, i) => (
          <button key={i} onClick={() => toggleDay(i)} title={['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'][i]}
            className={`w-[19px] h-[22px] rounded text-[10px] font-semibold ${working[i] === '1' ? 'bg-[#f59e0b] text-[#1a1a2e]' : 'bg-[#1a1a2e] text-[#6b7280] border border-[#2e2e4a]'}`}>{d}</button>
        ))}
      </div>
      <div><input value={carry} onChange={(e) => setCarry(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" className={numCls} /></div>
      <div className="text-[12px] text-[#94a3b8] leading-tight">
        {person.allowanceSet ? (
          <>
            <span className="text-white font-semibold">{fmt(person.remaining)}</span> left
            <span className="text-[#6b7280]"> · {fmt(person.taken)} taken · {fmt(person.booked)} booked · {fmt(person.pending)} pending</span>
            {person.adjustments !== 0 && <span className="text-[#fcd34d]"> · {person.adjustments > 0 ? '+' : ''}{fmt(person.adjustments)} adj</span>}
          </>
        ) : <span className="text-[#6b7280]">allowance not set</span>}
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <button onClick={onAdjust} className="text-[12px] text-[#94a3b8] border border-[#2e2e4a] rounded-md px-2.5 py-1.5 hover:bg-[#2a2a48] hover:text-white">Adjust</button>
        <button onClick={save} disabled={!dirty || saving}
          className={`inline-flex items-center gap-1 text-[12px] rounded-md px-2.5 py-1.5 ${dirty ? 'bg-[#f59e0b] text-[#1a1a2e] font-semibold' : 'bg-[#1f1f33] text-[#6b7280]'} disabled:opacity-60`}>
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save
        </button>
      </div>
    </div>
  );
}

// ── One person's full holiday history ────────────────────────────────────────
// Reached by clicking a name on the Team tab. Shows every booking that person
// has ever had — past and future, whatever its status — and lets a manager
// edit or delete any of them.
//
// NOTE: this deliberately re-uses the requests ALREADY loaded by the parent
// (GET /api/holidays/requests returns every request for the whole
// organisation, all statuses, with no date limit) rather than fetching again.
// Nothing here needs a new list endpoint.
function StaffDatesScreen({ person, requests, onBack, onChanged }) {
  const [editing, setEditing] = useState(null);
  const [adjusting, setAdjusting] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [err, setErr] = useState(null);

  // "Past" means the booking has finished. Compared at local midnight so a
  // holiday ending today still counts as current, not past.
  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);
  const isPast = (q) => { const e = new Date(q.endDate); e.setHours(0, 0, 0, 0); return e < today; };

  const upcoming = requests.filter((q) => !isPast(q)).sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
  const past = requests.filter(isPast).sort((a, b) => new Date(b.startDate) - new Date(a.startDate));

  const remove = async (q) => {
    const when = q.startDate === q.endDate ? ukDate(q.startDate) : `${ukDate(q.startDate)} – ${ukDate(q.endDate)}`;
    if (!confirm(
      `Delete this holiday for ${person.name}?\n\n${when} (${fmt(q.days)} day${q.days === 1 ? '' : 's'})\n\n`
      + 'This removes it permanently and puts the days back into their balance. It cannot be undone.'
    )) return;
    setErr(null);
    setBusyId(q.id);
    try {
      const r = await fetch(`/api/holidays/requests/${q.id}`, { method: 'DELETE', credentials: 'include' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not delete that booking');
      onChanged();
    } catch (e) {
      setErr(e.message || 'Could not delete that booking');
    } finally {
      setBusyId(null);
    }
  };

  const totalDays = requests.reduce((n, q) => (q.status === 'approved' ? n + Number(q.days || 0) : n), 0);

  return (
    <div className="p-5 md:p-7 min-h-full bg-[#1a1a2e]">
      <button onClick={onBack}
        className="inline-flex items-center gap-1.5 text-[13px] text-[#94a3b8] hover:text-white mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to Holiday admin
      </button>

      <div className="mb-5">
        <PageHero
          title={person.name}
          icon={CalendarDays}
          meta={[{
            icon: CalendarCheck,
            label: person.allowanceSet
              ? `${fmt(person.remaining)} days left of ${fmt(person.allowance)} · ${fmt(person.taken)} taken · ${fmt(person.booked)} booked · ${fmt(person.pending)} pending`
              : 'Allowance not set for this person',
          }]}
          actions={<HeroButtonOutline icon={Sliders} onClick={() => setAdjusting(true)}>Adjust entitlement</HeroButtonOutline>}
          compact
        />
      </div>

      {err && (
        <div className="flex items-center gap-2 p-3 mb-4 rounded-lg bg-[rgba(239,68,68,0.10)] border border-[rgba(239,68,68,0.35)] text-[#fca5a5] text-sm">
          <AlertCircle className="w-4 h-4" /> {err}
        </div>
      )}

      <div className="text-[12.5px] text-[#6b7280] mb-3">
        {requests.length === 0
          ? 'No holiday booked or requested yet.'
          : `${requests.length} booking${requests.length === 1 ? '' : 's'} on record · ${fmt(totalDays)} approved day${totalDays === 1 ? '' : 's'} in total.`}
      </div>

      <BookingSection title="Upcoming and current" rows={upcoming} person={person}
        busyId={busyId} onEdit={setEditing} onDelete={remove}
        empty="Nothing booked from today onwards." />

      <BookingSection title="Past" rows={past} person={person}
        busyId={busyId} onEdit={setEditing} onDelete={remove}
        empty="No past holiday on record." />

      {editing && (
        <EditBookingModal
          booking={editing}
          person={person}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onChanged(); }}
        />
      )}
      {adjusting && <AdjustModal person={person} onClose={() => setAdjusting(false)} onChanged={onChanged} />}
    </div>
  );
}

function BookingSection({ title, rows, person, busyId, onEdit, onDelete, empty }) {
  return (
    <div className="mb-5">
      <div className="text-[11px] uppercase tracking-wide text-[#6b7280] mb-2">{title}</div>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-[#2e2e4a] bg-[#242438] px-4 py-6 text-center text-[13px] text-[#6b7280]">{empty}</div>
      ) : (
        <div className="rounded-xl border border-[#2e2e4a] bg-[#242438] overflow-hidden">
          {rows.map((q, i) => (
            <BookingRow key={q.id} req={q} person={person} first={i === 0}
              busy={busyId === q.id} onEdit={() => onEdit(q)} onDelete={() => onDelete(q)} />
          ))}
        </div>
      )}
    </div>
  );
}

function BookingRow({ req, person, first, busy, onEdit, onDelete }) {
  const pill = STATUS_PILL[req.status] || STATUS_PILL.cancelled;
  const single = ymdLocal(req.startDate) === ymdLocal(req.endDate);
  const halves = [req.halfStart && 'half day at the start', req.halfEnd && !single && 'half day at the end']
    .filter(Boolean).join(', ');

  return (
    <div className={`flex items-start gap-3 px-4 py-3 ${first ? '' : 'border-t border-[#2e2e4a]'}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13.5px] text-white">
            {single ? ukDate(req.startDate) : `${ukDate(req.startDate)} – ${ukDate(req.endDate)}`}
          </span>
          <span className="text-[12px] text-[#94a3b8]">{fmt(req.days)} day{Number(req.days) === 1 ? '' : 's'}</span>
          <span className={`text-[10.5px] px-1.5 py-0.5 rounded-full ${pill.cls}`}>{pill.label}</span>
        </div>
        {halves && <div className="text-[11.5px] text-[#6b7280] mt-0.5">{halves}</div>}
        {req.note && <div className="text-[12px] text-[#cbd5e1] mt-1 break-words">{req.note}</div>}
        {req.status === 'rejected' && req.decisionNote && (
          <div className="text-[11.5px] text-[#fca5a5] mt-1">Reason: {req.decisionNote}</div>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <button onClick={onEdit} disabled={busy} title="Change these dates"
          className="inline-flex items-center gap-1 text-[12px] text-[#94a3b8] border border-[#2e2e4a] rounded-md px-2.5 py-1.5 hover:bg-[#2a2a48] hover:text-white disabled:opacity-50">
          <Pencil className="w-3.5 h-3.5" /> Edit
        </button>
        <button onClick={onDelete} disabled={busy} title="Delete this booking"
          className="inline-flex items-center gap-1 text-[12px] text-[#94a3b8] border border-[#2e2e4a] rounded-md px-2.5 py-1.5 hover:bg-[rgba(239,68,68,0.12)] hover:text-[#fca5a5] disabled:opacity-50">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} Delete
        </button>
      </div>
    </div>
  );
}

// ⚠️ DUPLICATED LOGIC — this is countWorkingDays() from web/routes/holidays.js,
// copied verbatim so the modal can show a live "that's N days" preview while
// the dates are being picked. The SERVER remains the authority: it recomputes
// the count on save and its answer is what gets stored and displayed
// afterwards. If you change one of these two, change the other, or the preview
// will disagree with what actually gets saved.
const DEFAULT_WORKING = '1111100';
function countWorkingDays(startStr, endStr, workingDays, halfStart, halfEnd) {
  const wd = (workingDays && workingDays.length === 7) ? workingDays : DEFAULT_WORKING;
  const s = new Date(`${startStr}T00:00:00Z`);
  const e = new Date(`${endStr}T00:00:00Z`);
  if (isNaN(s) || isNaN(e) || e < s) return 0;

  const idxOf = (d) => (d.getUTCDay() + 6) % 7; // 0=Mon .. 6=Sun
  let count = 0;
  const cur = new Date(s);
  while (cur <= e) {
    if (wd[idxOf(cur)] === '1') count += 1;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  if (count <= 0) return 0;

  const sameDay = startStr === endStr;
  if (halfStart && wd[idxOf(s)] === '1') count -= 0.5;
  if (!sameDay && halfEnd && wd[idxOf(e)] === '1') count -= 0.5;

  return Math.max(0, Math.round(count * 2) / 2);
}

// ── Edit one booking ─────────────────────────────────────────────────────────
function EditBookingModal({ booking, person, onClose, onSaved }) {
  const [start, setStart] = useState(ymdLocal(booking.startDate));
  const [end, setEnd] = useState(ymdLocal(booking.endDate));
  const [halfStart, setHalfStart] = useState(!!booking.halfStart);
  const [halfEnd, setHalfEnd] = useState(!!booking.halfEnd);
  const [note, setNote] = useState(booking.note || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const sameDay = start === end;
  const preview = countWorkingDays(start, end, person.workingDays, halfStart, sameDay ? false : halfEnd);
  const endBeforeStart = !!start && !!end && new Date(end) < new Date(start);

  const save = async () => {
    setErr(null);
    if (!start || !end) { setErr('Pick both a start and an end date.'); return; }
    if (endBeforeStart) { setErr('The end date is before the start date.'); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/holidays/requests/${booking.id}`, {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate: start, endDate: end,
          halfStart, halfEnd: sameDay ? false : halfEnd,
          note: note.trim() || null,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not save that change');
      onSaved();
    } catch (e) {
      setErr(e.message || 'Could not save that change');
      setBusy(false);
    }
  };

  const inputCls = 'px-3 py-2 rounded-lg bg-[#1a1a2e] border border-[#2e2e4a] text-[13px] text-white focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30';
  const statusLabel = (STATUS_PILL[booking.status] || STATUS_PILL.cancelled).label;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-[#2e2e4a] bg-[#242438] overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2e2e4a]">
          <div>
            <div className="text-white font-semibold text-[15px]">Edit holiday — {person.name}</div>
            <div className="text-[12px] text-[#94a3b8] mt-0.5">
              Changing the dates updates their balance. This stays <span className="text-[#cbd5e1]">{statusLabel.toLowerCase()}</span> — it won&apos;t need approving again.
            </div>
          </div>
          <button onClick={onClose} className="text-[#6b7280] hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5">
          <div className="flex gap-3 flex-wrap">
            <div className="flex-1 min-w-[150px]">
              <label className="block text-[11px] text-[#94a3b8] mb-1.5">From</label>
              <DatePicker value={start} onChange={setStart} className={`${inputCls} w-full text-left`} />
            </div>
            <div className="flex-1 min-w-[150px]">
              <label className="block text-[11px] text-[#94a3b8] mb-1.5">To</label>
              <DatePicker value={end} onChange={setEnd} className={`${inputCls} w-full text-left`} />
            </div>
          </div>

          <div className="flex items-center gap-4 mt-3 flex-wrap">
            <label className="inline-flex items-center gap-2 text-[12.5px] text-[#cbd5e1] cursor-pointer">
              <input type="checkbox" checked={halfStart} onChange={(e) => setHalfStart(e.target.checked)} className="accent-[#f59e0b]" />
              {sameDay ? 'Half day only' : 'First day is a half day'}
            </label>
            {!sameDay && (
              <label className="inline-flex items-center gap-2 text-[12.5px] text-[#cbd5e1] cursor-pointer">
                <input type="checkbox" checked={halfEnd} onChange={(e) => setHalfEnd(e.target.checked)} className="accent-[#f59e0b]" />
                Last day is a half day
              </label>
            )}
          </div>

          <div className="mt-3">
            <label className="block text-[11px] text-[#94a3b8] mb-1.5">Note</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional — e.g. moved at short notice" className={`${inputCls} w-full`} />
          </div>

          <div className="mt-4 px-3 py-2.5 rounded-lg bg-[#1f1f33] border border-[#2e2e4a] text-[12.5px]">
            {endBeforeStart ? (
              <span className="text-[#fca5a5]">The end date is before the start date.</span>
            ) : preview <= 0 ? (
              <span className="text-[#fca5a5]">That range has no working days for {person.name} — check their working week on the Team tab.</span>
            ) : (
              <>
                <span className="text-white font-semibold">{fmt(preview)} day{preview === 1 ? '' : 's'}</span>
                <span className="text-[#94a3b8]"> will come off their allowance</span>
                {Number(booking.days) !== preview && (
                  <span className="text-[#fcd34d]"> · was {fmt(booking.days)}</span>
                )}
              </>
            )}
          </div>

          {err && <div className="mt-3 text-[12px] text-[#fca5a5]">{err}</div>}

          <div className="flex items-center justify-end gap-2 mt-5">
            <button onClick={onClose} className="text-[13px] text-[#94a3b8] border border-[#2e2e4a] rounded-lg px-4 py-2 hover:bg-[#2a2a48] hover:text-white">Cancel</button>
            <button onClick={save} disabled={busy || endBeforeStart || preview <= 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#f59e0b] text-[#1a1a2e] font-semibold text-[13px] px-4 py-2 disabled:opacity-50">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Adjustments (override) modal ─────────────────────────────────────────────
function AdjustModal({ person, onClose, onChanged }) {
  const [list, setList] = useState(null);
  const [days, setDays] = useState('');
  const [sign, setSign] = useState('+');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const loadList = async () => {
    try {
      const r = await fetch(`/api/holidays/allowances/${person.userId}/adjustments`, { credentials: 'include' });
      setList(r.ok ? await r.json() : []);
    } catch { setList([]); }
  };
  useEffect(() => { loadList(); }, []);

  const add = async () => {
    setErr(null);
    const n = Number(days);
    if (!days || isNaN(n) || n <= 0) { setErr('Enter a number of days.'); return; }
    if (!reason.trim()) { setErr('Add a reason.'); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/holidays/allowances/${person.userId}/adjustments`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: sign === '-' ? -n : n, reason: reason.trim() }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Failed');
      setDays(''); setReason(''); setSign('+');
      await loadList();
      onChanged();
    } catch (e) {
      setErr(e.message || 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    if (!confirm('Remove this adjustment?')) return;
    try {
      const r = await fetch(`/api/holidays/allowances/${person.userId}/adjustments/${id}`, { method: 'DELETE', credentials: 'include' });
      if (!r.ok) throw new Error();
      await loadList();
      onChanged();
    } catch { alert('Could not remove.'); }
  };

  const inputCls = 'px-3 py-2 rounded-lg bg-[#1a1a2e] border border-[#2e2e4a] text-[13px] text-white focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-[#2e2e4a] bg-[#242438] overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2e2e4a]">
          <div>
            <div className="text-white font-semibold text-[15px]">Adjust entitlement — {person.name}</div>
            <div className="text-[12px] text-[#94a3b8] mt-0.5">Grant extra days, or deduct (e.g. a sick day off holiday). Each needs a reason.</div>
          </div>
          <button onClick={onClose} className="text-[#6b7280] hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5">
          <div className="flex items-end gap-2 flex-wrap">
            <div>
              <label className="block text-[11px] text-[#94a3b8] mb-1.5">Direction</label>
              <div className="flex">
                {['+', '-'].map((s) => (
                  <button key={s} onClick={() => setSign(s)}
                    className={`w-10 py-2 text-[14px] font-semibold border ${sign === s ? 'bg-[#f59e0b] text-[#1a1a2e] border-[#f59e0b]' : 'bg-[#1a1a2e] text-[#94a3b8] border-[#2e2e4a]'} ${s === '+' ? 'rounded-l-lg' : 'rounded-r-lg -ml-px'}`}>{s}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-[11px] text-[#94a3b8] mb-1.5">Days</label>
              <input value={days} onChange={(e) => setDays(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="e.g. 1 or 0.5" inputMode="decimal" className={`${inputCls} w-28`} />
            </div>
            <div className="flex-1 min-w-[160px]">
              <label className="block text-[11px] text-[#94a3b8] mb-1.5">Reason</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. sick day 5 Jul off holiday" className={`${inputCls} w-full`} />
            </div>
            <button onClick={add} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#f59e0b] text-[#1a1a2e] font-semibold text-[13px] px-4 py-2 disabled:opacity-50">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Add
            </button>
          </div>
          {err && <div className="mt-2 text-[12px] text-[#fca5a5]">{err}</div>}

          <div className="mt-5">
            {list === null ? (
              <div className="text-[12.5px] text-[#6b7280] flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</div>
            ) : list.length === 0 ? (
              <div className="text-[12.5px] text-[#6b7280]">No adjustments yet.</div>
            ) : (
              <div className="space-y-1.5">
                {list.map((a) => (
                  <div key={a.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[#1f1f33] border border-[#2e2e4a]">
                    <span className={`text-[13px] font-semibold w-12 ${a.days >= 0 ? 'text-[#6ee7b7]' : 'text-[#fca5a5]'}`}>{a.days > 0 ? '+' : ''}{fmt(a.days)}</span>
                    <span className="flex-1 min-w-0 text-[12.5px] text-[#cbd5e1] truncate">{a.reason}</span>
                    <span className="text-[11px] text-[#6b7280] whitespace-nowrap">{ukDate(a.createdAt)}</span>
                    <button onClick={() => remove(a.id)} className="text-[#6b7280] hover:text-[#fca5a5]"><Trash2 className="w-4 h-4" /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────
function SettingsTab({ settings, onChanged }) {
  const [yearStart, setYearStart] = useState(settings?.yearStart ? String(settings.yearStart).slice(0, 10) : '');
  const [yearEnd, setYearEnd] = useState(settings?.yearEnd ? String(settings.yearEnd).slice(0, 10) : '');
  const [carryAllowed, setCarryAllowed] = useState(!!settings?.carryOverAllowed);
  const [carryMax, setCarryMax] = useState(String(settings?.carryOverMaxDays || 0));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  const save = async () => {
    setErr(null); setMsg(null);
    if (yearStart && yearEnd && new Date(yearEnd) < new Date(yearStart)) { setErr('The year end is before the start.'); return; }
    setSaving(true);
    try {
      const r = await fetch('/api/holidays/settings', {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          yearStart: yearStart || null, yearEnd: yearEnd || null,
          carryOverAllowed: carryAllowed, carryOverMaxDays: carryMax === '' ? 0 : Number(carryMax),
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Failed');
      setMsg('Saved.');
      onChanged();
    } catch (e) {
      setErr(e.message || 'Failed');
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'px-3 py-2 rounded-lg bg-[#1a1a2e] border border-[#2e2e4a] text-[13px] text-white focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30';

  return (
    <div className="rounded-xl border border-[#2e2e4a] bg-[#242438] p-5 max-w-xl">
      <div className="text-white font-semibold text-[15px] mb-1">Company holiday year</div>
      <div className="text-[12.5px] text-[#94a3b8] mb-4">The window everyone’s allowance runs across (e.g. 1 Apr – 31 Mar). Days taken are counted within this window.</div>
      <div className="grid grid-cols-2 gap-3 mb-6">
        <div>
          <label className="block text-[11px] text-[#94a3b8] mb-1.5">From</label>
          <DatePicker value={yearStart} onChange={setYearStart} className={`${inputCls} w-full`} />
        </div>
        <div>
          <label className="block text-[11px] text-[#94a3b8] mb-1.5">To</label>
          <DatePicker value={yearEnd} onChange={setYearEnd} className={`${inputCls} w-full`} />
        </div>
      </div>

      <div className="text-white font-semibold text-[15px] mb-1">Carry-over</div>
      <div className="text-[12.5px] text-[#94a3b8] mb-3">Whether unused days can roll into next year, and the most that can carry.</div>
      <label className="flex items-center gap-2 text-[13px] text-[#cbd5e1] cursor-pointer mb-3">
        <input type="checkbox" checked={carryAllowed} onChange={(e) => setCarryAllowed(e.target.checked)} className="accent-[#f59e0b]" />
        Allow staff to carry unused days into next year
      </label>
      {carryAllowed && (
        <div className="mb-4 flex items-center gap-2">
          <label className="text-[12.5px] text-[#94a3b8]">Max days that can carry over</label>
          <input value={carryMax} onChange={(e) => setCarryMax(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" className={`${inputCls} w-24 text-center`} />
        </div>
      )}

      {err && <div className="mb-3 text-[12.5px] text-[#fca5a5]">{err}</div>}
      {msg && <div className="mb-3 text-[12.5px] text-[#6ee7b7]">{msg}</div>}

      <button onClick={save} disabled={saving}
        className="inline-flex items-center gap-1.5 rounded-lg bg-[#f59e0b] text-[#1a1a2e] font-semibold text-[13px] px-4 py-2 disabled:opacity-50">
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save settings
      </button>
    </div>
  );
}
