// web/client/src/app/src/components/CompanyPipelineList.jsx
// Sales › Companies. The salesperson's home: companies by sales stage.
// Reads live data from GET /api/contacts?type=company (cookie auth). Sales stage
// lives in contact.crm.salesStage (new|contacted|voicemail|prospect|hot_prospect|customer|dead); account
// manager in contact.crm.assignedTo.
//
// v3.6 — rebuilt to Manus's DARK design (Concept-3 "Relationship Hub"):
//   • PIPELINE view (default): four stage columns (Suspect/Prospect/Hot prospect/
//     Customer) of cards. Each card: company name, owner avatar + name, coloured
//     source pill, "x ago" activity time, a ⋯ menu (Open / Move stage) and a
//     per-column "+ Add company".
//   • LIST view: a dark table carrying telephone, email, contact, next action +
//     chase date (overdue in red) and monthly value.
//   • A List/Pipeline toggle, search, an "All sources" dropdown filter, and
//     Add company — all to the drawing.
//
// EVERYTHING from the old light list is preserved: load, search, stage filtering
// (now the columns + a list-view filter), CSV Import, Add company, row → open
// profile, monthly value, next action, loading/error/empty states. Stage moves
// from the ⋯ menu re-send the FULL existing crm object (the contacts PUT replaces
// crm wholesale) so no other field is lost.
//
// Props (unchanged): onOpenCompany(id), onAddCompany().
import React, { useEffect, useMemo, useState } from 'react';
import { Upload, MoreHorizontal, Clock, List, Columns3, Phone, Mail, ChevronDown, Building2, SlidersHorizontal } from 'lucide-react';
import CsvImport from './CsvImport.jsx';
import CompanyFilterModal from './CompanyFilterModal.jsx';
import SalesPageLayout, {
  SalesSearch, SalesPrimaryButton, SalesSecondaryButton,
} from './SalesPageLayout.jsx';

// stage ladder — value `new` is shown as "Suspect" (the approved rename)
// Exported: CRMCalendar.jsx imports this so calendar entries are coloured from
// the SAME list the Sales page uses. Stage keys already live in six places in
// this app and drifting copies have caused real bugs — sharing this one means
// a colour change here follows through to the calendar automatically and the
// two can never disagree.
export const STAGES = [
  { key: 'new',          label: 'Suspect',      pill: 'bg-[rgba(107,114,128,0.20)] text-[#cbd5e1]', dot: '#6b7280' },
  { key: 'contacted',    label: 'Contacted',    pill: 'bg-[rgba(139,92,246,0.20)] text-[#c4b5fd]',  dot: '#8b5cf6' },
  { key: 'voicemail',    label: 'Voicemail',    pill: 'bg-[rgba(6,182,212,0.20)] text-[#67e8f9]',   dot: '#06b6d4' },
  { key: 'prospect',     label: 'Prospect',     pill: 'bg-[rgba(59,130,246,0.20)] text-[#93c5fd]',  dot: '#3b82f6' },
  { key: 'hot_prospect', label: 'Hot prospect', pill: 'bg-[rgba(245,158,11,0.20)] text-[#fcd34d]',  dot: '#f59e0b' },
  { key: 'customer',     label: 'Customer',     pill: 'bg-[rgba(16,185,129,0.20)] text-[#6ee7b7]',  dot: '#10b981' },
  { key: 'dead',         label: 'Dead',         pill: 'bg-[rgba(239,68,68,0.20)] text-[#fca5a5]',   dot: '#ef4444' },
];
const STAGE_BY_KEY = Object.fromEntries(STAGES.map((s) => [s.key, s]));

// Click-to-dial link. Kept identical to the copy in CompanyProfile.jsx: numbers
// come off the CSV import messily ("+44 (0)1702 613141", "01702 613141 / 07700
// 900123") but a tel: link must be digits only with an optional leading +.
// Only the FIRST number is dialled when two share a field, and "(0)" is removed
// BEFORE the digits are extracted or "+44 (0)1702..." becomes 4401702... which
// is not a real number. Returns '' when there are no digits so the caller can
// fall back to plain text rather than render a dead link.
const telHref = (p) => {
  const first = String(p || '').split(/[/,;]|\bor\b/i)[0];
  const cleaned = first.replace(/\(0\)/g, '');
  const plus = cleaned.trim().startsWith('+');
  const digits = cleaned.replace(/\D/g, '');
  if (!digits) return '';
  return `tel:${plus ? '+' : ''}${digits}`;
};

// Sentinel for the "No stage" filter chip: companies whose salesStage is missing
// or unrecognised (exactly the rows that render the grey "No stage" pill).
const NO_STAGE = '__nostage__';
const isNoStage = (co) => !STAGE_BY_KEY[co?.crm?.salesStage];

// ── Filter pop-up plumbing ──────────────────────────────────────────────────
// Every option offered in the Filter pop-up is derived from the companies that
// are actually loaded, so the user can never tick something that matches
// nothing (and nothing is invented). Within a group ticks are OR; across
// groups they are AND.
const GROUP_DEFS = [
  { key: 'stages',     label: 'Stage' },
  { key: 'sources',    label: 'Source' },
  { key: 'industries', label: 'Industry' },
  { key: 'sizes',      label: 'Employees' },
  { key: 'managers',   label: 'Account manager' },
  { key: 'spotters',   label: 'Spotter' },
  { key: 'statuses',   label: 'Customer status' },
  { key: 'tags',       label: 'Tags' },
  { key: 'missing',    label: 'Missing details' },
  { key: 'chase',      label: 'Chase date' },
];
const EMPTY_FILTERS = {
  ...Object.fromEntries(GROUP_DEFS.map((g) => [g.key, []])),
  addressQuery: '', // free-text "Address contains" (county/town/postcode)
};

// ── "Address contains" search ───────────────────────────────────────────────
// There is no county field — the whole address is one free-text line — and the
// source spreadsheets never had a county column, so searching INSIDE the
// address text is the only thing that can work on the real data.
// Comma-separated terms mean ANY of them ("essex, kent, london").
// Matching is on WHOLE WORDS so "Kent" doesn't drag in "Kentish Town", and it
// makes no assumption about country, so it works anywhere in the world.
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// every address entry flattened to one searchable string (tolerates the plain
// string shape AND the legacy {line1,city,postcode,…} object shape)
const addressTextOf = (co) => {
  const list = Array.isArray(co?.addresses) ? co.addresses : [];
  return list.map((a) => {
    if (typeof a === 'string') return a;
    if (a && typeof a === 'object') {
      return Object.values(a).filter((v) => typeof v === 'string' || typeof v === 'number').join(' ');
    }
    return '';
  }).join(' ');
};

function matchesAddressQuery(co, q) {
  const terms = String(q || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (!terms.length) return true;              // nothing typed = no restriction
  const hay = addressTextOf(co).toLowerCase();
  if (!hay.trim()) return false;               // no address = can't match a place
  return terms.some((t) => new RegExp(`(^|[^a-z0-9])${escapeRe(t)}([^a-z0-9]|$)`).test(hay));
}

const STATUS_LABEL  = { active: 'Active', inactive: 'Inactive', at_risk: 'At risk', prospect: 'Prospect', archived: 'Archived' };
const MISSING_LABEL = { no_phone: 'No phone', no_email: 'No email', no_website: 'No website', no_address: 'No address' };
const CHASE_LABEL   = { overdue: 'Overdue', today: 'Due today', future: 'Upcoming', none: 'No chase date' };
// groups whose options read best in a fixed order rather than alphabetically
const FIXED_ORDER = {
  stages:  [NO_STAGE, ...STAGES.map((s) => s.key)],
  missing: ['no_phone', 'no_email', 'no_website', 'no_address'],
  chase:   ['overdue', 'today', 'future', 'none'],
};

const hasText = (v) => String(v ?? '').trim() !== '';

// Address lives in contacts.addresses (JSONB array) and can legitimately be a
// plain string OR a {line1,city,postcode,…} object — tolerate both.
const hasAddress = (co) => {
  const list = Array.isArray(co?.addresses) ? co.addresses : [];
  return list.some((a) => {
    if (typeof a === 'string') return hasText(a);
    if (a && typeof a === 'object') return Object.values(a).some(hasText);
    return false;
  });
};

const chaseBucket = (co) => {
  const raw = co?.crm?.chaseDate;
  if (!raw) return 'none';
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return 'none';
  d.setHours(23, 59, 59, 999);
  const endToday = new Date();
  endToday.setHours(23, 59, 59, 999);
  if (d.getTime() < Date.now()) return 'overdue';
  if (d.getTime() <= endToday.getTime()) return 'today';
  return 'future';
};

// the value(s) a company contributes to a given filter group
function valuesFor(co, key) {
  const crm = co?.crm || {};
  switch (key) {
    case 'stages':     return [STAGE_BY_KEY[crm.salesStage] ? crm.salesStage : NO_STAGE];
    case 'sources':    return hasText(crm.source)        ? [String(crm.source).trim()]      : [];
    case 'industries': return hasText(crm.industry)      ? [String(crm.industry).trim()]    : [];
    case 'sizes':      return hasText(crm.companySize)   ? [String(crm.companySize).trim()] : [];
    case 'managers':   return hasText(crm.assignedTo)    ? [String(crm.assignedTo).trim()]  : [];
    case 'spotters':   return hasText(crm.spotterUserId) ? [String(crm.spotterUserId)]      : [];
    case 'statuses':   return hasText(crm.status)        ? [String(crm.status)]             : [];
    case 'tags':       return Array.isArray(co?.tags) ? co.tags.filter(hasText).map((t) => String(t).trim()) : [];
    case 'missing': {
      const out = [];
      if (!hasText(co?.phone))   out.push('no_phone');
      if (!hasText(co?.email))   out.push('no_email');
      if (!hasText(co?.website)) out.push('no_website');
      if (!hasAddress(co))       out.push('no_address');
      return out;
    }
    case 'chase':      return [chaseBucket(co)];
    default:           return [];
  }
}

// AND across groups, OR within a group. `skipKey` lets the caller leave one
// group out (used so the stage badge counts ignore the stage filter itself).
function matchesFilters(co, sel, skipKey) {
  // the address search always applies, whichever group is being skipped
  if (!matchesAddressQuery(co, sel?.addressQuery)) return false;
  for (const g of GROUP_DEFS) {
    if (g.key === skipKey) continue;
    const chosen = sel?.[g.key] || [];
    if (!chosen.length) continue;
    const vals = valuesFor(co, g.key);
    if (!vals.some((v) => chosen.includes(v))) return false;
  }
  return true;
}

// ── Remembering the filter between visits ───────────────────────────────────
// Opening a company UNMOUNTS this whole screen (Dashboard swaps in
// CompanyProfile), so any state held here is destroyed and rebuilt from
// scratch on the way back. The view toggle already survived because it was
// saved to the browser under 'wt_companies_view' — the filters now do the same.
const FILTERS_KEY = 'wt_companies_filters';
const SEARCH_KEY  = 'wt_companies_search';

// Rebuilt against the CURRENT filter shape rather than trusted as-is, so a
// stale or corrupted value can never break the Companies screen (which would
// otherwise be very hard for a user to get out of). Used for BOTH the browser's
// remembered filter AND saved searches coming back from the server, since a
// saved search may have been created before a filter group existed.
function coerceFilters(saved) {
  const out = { ...EMPTY_FILTERS };
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return out;
  for (const g of GROUP_DEFS) {
    if (Array.isArray(saved[g.key])) out[g.key] = saved[g.key].filter((v) => typeof v === 'string');
  }
  if (typeof saved.addressQuery === 'string') out.addressQuery = saved.addressQuery;
  return out;
}

function loadFilters() {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return EMPTY_FILTERS;
    return coerceFilters(JSON.parse(raw));
  } catch (e) {
    return EMPTY_FILTERS;
  }
}

function loadSearch() {
  try { const v = localStorage.getItem(SEARCH_KEY); return typeof v === 'string' ? v : ''; }
  catch (e) { return ''; }
}

// source → pill colour (dark, translucent). Unknown sources fall back to grey.
const SOURCE_PILL = {
  'telesales':       'bg-[rgba(245,158,11,0.18)] text-[#fcd34d]',
  'door knocking':   'bg-[rgba(139,92,246,0.18)] text-[#c4b5fd]',
  'e-shot':          'bg-[rgba(59,130,246,0.18)] text-[#93c5fd]',
  'email campaign':  'bg-[rgba(59,130,246,0.18)] text-[#93c5fd]',
  'social media':    'bg-[rgba(6,182,212,0.18)] text-[#67e8f9]',
  'website':         'bg-[rgba(16,185,129,0.18)] text-[#6ee7b7]',
  'referral':        'bg-[rgba(16,185,129,0.18)] text-[#6ee7b7]',
  'event':           'bg-[rgba(236,72,153,0.18)] text-[#f9a8d4]',
};
const sourcePill = (s) => SOURCE_PILL[String(s || '').toLowerCase()] || 'bg-[rgba(107,114,128,0.18)] text-[#cbd5e1]';

// deterministic avatar colour from a name
const AVATARS = ['#f59e0b', '#ec4899', '#8b5cf6', '#3b82f6', '#10b981', '#06b6d4'];
const avatarColor = (name) => {
  const s = String(name || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATARS[h % AVATARS.length];
};
const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? `£${n.toLocaleString()}/mo` : '—';
};

// "x ago" from a timestamp (falls back to created)
function timeAgo(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 7) return `${days} days ago`;
  const w = Math.floor(days / 7);
  if (w < 5) return w === 1 ? '1 week ago' : `${w} weeks ago`;
  const m = Math.floor(days / 30);
  if (m < 12) return m === 1 ? '1 month ago' : `${m} months ago`;
  const y = Math.floor(days / 365);
  return y === 1 ? '1 year ago' : `${y} years ago`;
}

// next action: prefer the v3.5 dated fields, fall back to the older event string
function nextActionOf(co) {
  const crm = co?.crm || {};
  const text = crm.nextAction || crm.nextCRMEvent || '';
  const chase = crm.chaseDate || null;
  let overdue = false;
  if (chase) {
    const d = new Date(chase); d.setHours(23, 59, 59, 999);
    overdue = d.getTime() < Date.now();
  }
  return { text, chase, overdue };
}
const ukDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB') : '');

// ── card ⋯ menu (Open + safe stage move) ─────────────────────────────────────
function CardMenu({ co, onOpen, onMove, onClose, onArchive }) {
  const cur = co?.crm?.salesStage;
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={(e) => { e.stopPropagation(); onClose(); }} />
      <div
        className="absolute right-2 top-9 z-20 w-44 rounded-lg border border-[#2e2e4a] bg-[#242438] py-1 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="w-full text-left px-3 py-1.5 text-[13px] text-white hover:bg-[#2a2a48]"
          onClick={(e) => { e.stopPropagation(); onClose(); onOpen(); }}
        >
          Open company
        </button>
        <div className="my-1 border-t border-[#2e2e4a]" />
        <div className="px-3 py-1 text-[11px] uppercase tracking-wide text-[#6b7280]">Move to</div>
        {STAGES.filter((s) => s.key !== cur).map((s) => (
          <button
            key={s.key}
            className="w-full text-left px-3 py-1.5 text-[13px] text-[#cbd5e1] hover:bg-[#2a2a48] flex items-center gap-2"
            onClick={(e) => { e.stopPropagation(); onClose(); onMove(s.key); }}
          >
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: s.dot }} />
            {s.label}
          </button>
        ))}
        {onArchive && (
          <>
            <div className="my-1 border-t border-[#2e2e4a]" />
            <button
              className="w-full text-left px-3 py-1.5 text-[13px] text-[#fca5a5] hover:bg-[#2a2a48]"
              onClick={(e) => { e.stopPropagation(); onClose(); onArchive(); }}
            >
              Delete company
            </button>
          </>
        )}
      </div>
    </>
  );
}

// ── a single pipeline card ───────────────────────────────────────────────────
function PipelineCard({ co, isCustomer, menuOpen, onMenu, onOpen, onMove, onCloseMenu, onArchive }) {
  const owner = co?.crm?.assignedTo;
  return (
    <div
      onClick={() => onOpen(co.id)}
      className="relative cursor-pointer rounded-lg border border-[#2e2e4a] bg-[#242438] hover:bg-[#2a2a48] p-3.5 transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-[15px] font-semibold text-white truncate">{co.name}</div>
        <button
          aria-label="Card menu"
          onClick={(e) => { e.stopPropagation(); onMenu(menuOpen ? null : co.id); }}
          className="shrink-0 -mr-1 -mt-1 p-1 rounded text-[#94a3b8] hover:text-white hover:bg-[#33334f]"
        >
          <MoreHorizontal className="w-4 h-4" />
        </button>
      </div>

      {owner && (
        <div className="mt-2 flex items-center gap-2">
          <span
            className="inline-flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-semibold text-white"
            style={{ background: avatarColor(owner) }}
          >
            {initials(owner)}
          </span>
          <span className="text-[13px] text-[#cbd5e1] truncate">{owner}</span>
        </div>
      )}

      {co?.crm?.source && (
        <div className="mt-2.5">
          <span className={`inline-block rounded-md px-2 py-0.5 text-[11px] ${sourcePill(co.crm.source)}`}>
            {co.crm.source}
          </span>
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-1.5 text-[12px] text-[#6b7280]">
        <Clock className="w-3.5 h-3.5" />
        {isCustomer ? `Active ${timeAgo(co.updatedAt)}` : timeAgo(co.updatedAt)}
      </div>

      {menuOpen && <CardMenu co={co} onOpen={() => onOpen(co.id)} onMove={(k) => onMove(co, k)} onClose={onCloseMenu} onArchive={onArchive ? () => onArchive(co) : undefined} />}
    </div>
  );
}

export default function CompanyPipelineList({ onOpenCompany, onAddCompany, isManager = false, currentUser = null }) {
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState(loadSearch);
  // Unified tick-box selection driving BOTH the stage badges (quick shortcuts)
  // and the Filter pop-up, so the two can never disagree. Remembered between
  // visits — it only resets when the user presses "Clear filters".
  const [filterSel, setFilterSel] = useState(loadFilters);
  const [showFilter, setShowFilter] = useState(false);
  const [users, setUsers] = useState([]); // for readable Spotter names

  // ── Shared saved searches ────────────────────────────────────────────────
  const [saved, setSaved] = useState([]);
  const [savedLoading, setSavedLoading] = useState(true);
  const [savedError, setSavedError] = useState('');

  const loadSaved = React.useCallback(async () => {
    setSavedLoading(true);
    setSavedError('');
    try {
      const r = await fetch('/api/saved-searches?scope=companies', { credentials: 'include' });
      if (!r.ok) throw new Error('Could not load saved searches');
      const d = await r.json();
      setSaved(Array.isArray(d.savedSearches) ? d.savedSearches : []);
    } catch (e) {
      setSavedError(e.message || 'Could not load saved searches');
      setSaved([]);
    } finally {
      setSavedLoading(false);
    }
  }, []);

  useEffect(() => { loadSaved(); }, [loadSaved]);
  const [viewMode, setViewMode] = useState(() => {
    try { const v = localStorage.getItem('wt_companies_view'); if (v === 'list' || v === 'pipeline') return v; } catch (e) { /* ignore */ }
    return 'pipeline';
  }); // 'pipeline' | 'list' — remembered between visits
  const chooseView = (m) => { setViewMode(m); try { localStorage.setItem('wt_companies_view', m); } catch (e) { /* ignore */ } };
  const [showImport, setShowImport] = useState(false);
  const [reload, setReload] = useState(0);
  const [menuOpen, setMenuOpen] = useState(null);
  const [archivedMode, setArchivedMode] = useState(false); // managers/admins: view archived companies

  // keep the saved copy in step with what's on screen
  useEffect(() => {
    try { localStorage.setItem(FILTERS_KEY, JSON.stringify(filterSel)); } catch (e) { /* ignore */ }
  }, [filterSel]);
  useEffect(() => {
    try { localStorage.setItem(SEARCH_KEY, search); } catch (e) { /* ignore */ }
  }, [search]);

  // the one and only reset — "Clear filters" puts the list back to everything
  const clearFilters = () => { setFilterSel(EMPTY_FILTERS); setSearch(''); };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        const url = archivedMode ? '/api/contacts?type=company&archived=only' : '/api/contacts?type=company';
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (alive) setCompanies(Array.isArray(data) ? data : []);
      } catch (e) {
        if (alive) setError(e.message || 'Failed to load companies');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [reload, archivedMode]);

  // staff list — turns the stored Spotter reference into a readable name
  useEffect(() => {
    let alive = true;
    fetch('/api/tickets/users/list', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((d) => { if (alive) setUsers(d.users || []); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const userName = useMemo(() => {
    const m = new Map(users.map((u) => [String(u.id), u.name || u.email || 'Unnamed user']));
    return (id) => m.get(String(id)) || 'Unknown user';
  }, [users]);

  // distinct sources present, for the "All sources" dropdown
  const sources = useMemo(() => {
    const set = new Set();
    for (const co of companies) { const s = co?.crm?.source; if (s) set.add(s); }
    return Array.from(set).sort();
  }, [companies]);

  // text search only — the base set the pop-up counts are measured against, so
  // the numbers beside each tick box don't jump around as you tick things.
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return companies;
    return companies.filter((co) => {
      const hay = [co.name, co?.crm?.assignedTo, co.primaryContact, co.email, co.phone]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [companies, search]);

  // search + every ticked group EXCEPT stage (so the stage badge counts stay
  // meaningful while a stage is selected)
  const filtered = useMemo(
    () => searched.filter((co) => matchesFilters(co, filterSel, 'stages')),
    [searched, filterSel]
  );

  const listVisible = useMemo(() => {
    const chosen = filterSel.stages || [];
    if (!chosen.length) return filtered;
    return filtered.filter((co) => chosen.includes(valuesFor(co, 'stages')[0]));
  }, [filtered, filterSel]);

  const counts = useMemo(() => {
    const c = {};
    for (const co of filtered) { const k = co?.crm?.salesStage; if (STAGE_BY_KEY[k]) c[k] = (c[k] || 0) + 1; }
    return c;
  }, [filtered]);

  const noStageCount = useMemo(() => filtered.filter(isNoStage).length, [filtered]);

  // Build the pop-up's tick-box groups from the loaded companies. Options with
  // a zero count are dropped, and a group with no options at all is hidden.
  const filterGroups = useMemo(() => {
    const labelFor = (key, v) => {
      if (key === 'stages')   return v === NO_STAGE ? 'No stage' : (STAGE_BY_KEY[v]?.label || v);
      if (key === 'statuses') return STATUS_LABEL[v] || v;
      if (key === 'missing')  return MISSING_LABEL[v] || v;
      if (key === 'chase')    return CHASE_LABEL[v] || v;
      if (key === 'spotters') return userName(v);
      return v;
    };
    const out = [];
    for (const g of GROUP_DEFS) {
      const tally = new Map();
      for (const co of searched) {
        for (const v of valuesFor(co, g.key)) tally.set(v, (tally.get(v) || 0) + 1);
      }
      if (tally.size === 0) continue;
      let options = Array.from(tally, ([value, count]) => ({ value, count, label: labelFor(g.key, value) }));
      const order = FIXED_ORDER[g.key];
      if (order) {
        options.sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value));
      } else {
        options.sort((a, b) => String(a.label).localeCompare(String(b.label), undefined, { sensitivity: 'base' }));
      }
      out.push({ key: g.key, label: g.label, options });
    }
    return out;
  }, [searched, userName]);

  const activeFilterCount = useMemo(
    () => Object.entries(filterSel).reduce((n, [k, v]) => {
      if (k === 'addressQuery') return n + (String(v || '').trim() ? 1 : 0);
      return n + (Array.isArray(v) ? v.length : 0);
    }, 0),
    [filterSel]
  );

  // toggle one stage from a badge (the pop-up writes the same state)
  const toggleStage = (key) => setFilterSel((prev) => {
    const cur = prev.stages || [];
    return { ...prev, stages: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] };
  });

  // ── Saved searches: readable summary + actions ───────────────────────────
  // Built from the labels currently on screen and stored WITH the search, so an
  // entry stays readable forever. Generated later, a Spotter saved by internal
  // reference could come back as "Unknown user" if that person's record changed.
  const summarise = (sel) => {
    const parts = [];
    const labelsFor = (key) => {
      const g = filterGroups.find((x) => x.key === key);
      const chosen = sel?.[key] || [];
      if (!g || !chosen.length) return null;
      return chosen.map((v) => g.options.find((o) => o.value === v)?.label || v).join(' + ');
    };
    const stages = labelsFor('stages');
    if (stages) parts.push(stages);
    const aq = String(sel?.addressQuery || '').trim();
    if (aq) parts.push(aq);
    for (const g of filterGroups) {
      if (g.key === 'stages') continue;
      const s = labelsFor(g.key);
      if (s) parts.push(s);
    }
    return parts.join(' · ');
  };

  // picking one runs it immediately and closes the pop-up
  const applySaved = (s) => {
    setFilterSel(coerceFilters(s?.filters));
    setShowFilter(false);
  };

  // resolves to an error string, or null on success
  const saveSearch = async (name, sel) => {
    try {
      const r = await fetch('/api/saved-searches', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'companies', name, filters: sel, summary: summarise(sel) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return d.error || 'Could not save this search';
      await loadSaved();
      return null;
    } catch (e) {
      return e?.message || 'Could not save this search';
    }
  };

  const deleteSaved = async (s) => {
    // shared with the team, so confirm before removing it for everyone
    if (!window.confirm(`Delete the saved search “${s.name}” for everyone in your team?`)) return;
    try {
      const r = await fetch(`/api/saved-searches/${s.id}`, { method: 'DELETE', credentials: 'include' });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setSavedError(d.error || 'Could not delete this search');
        return;
      }
      await loadSaved();
    } catch (e) {
      setSavedError(e?.message || 'Could not delete this search');
    }
  };

  // only the person who saved it, or a manager, sees the delete control —
  // matching what the server actually allows, so it's never a dead button
  const canDeleteSaved = (s) =>
    isManager || (currentUser?.id && String(s?.createdBy || '') === String(currentUser.id));

  // move stage safely: re-send the WHOLE crm object with only salesStage changed
  const moveStage = async (co, newKey) => {
    try {
      const nextCrm = { ...(co.crm || {}), salesStage: newKey };
      const r = await fetch(`/api/contacts/${co.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ crm: nextCrm }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setReload((n) => n + 1);
    } catch (e) {
      setError(e.message || 'Failed to move company');
    }
  };

  // Soft-delete safety net: "Delete" archives the company (PUT crm.archived).
  // Hidden from staff; managers/admins can view the archive and restore or
  // permanently delete. Reuses existing endpoints — no backend change.
  const patchCrm = async (co, patch) => {
    const r = await fetch(`/api/contacts/${co.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ crm: { ...(co.crm || {}), ...patch } }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  };
  const archiveCompany = async (co) => {
    if (!window.confirm(`Delete ${co.name}? It moves to the archive — managers and admins can restore it.`)) return;
    try { await patchCrm(co, { archived: true, archivedAt: new Date().toISOString() }); setMenuOpen(null); setReload((n) => n + 1); }
    catch (e) { setError(e.message || 'Could not delete company'); }
  };
  const restoreCompany = async (co) => {
    try { await patchCrm(co, { archived: false, archivedAt: null }); setReload((n) => n + 1); }
    catch (e) { setError(e.message || 'Could not restore company'); }
  };
  const deleteForever = async (co) => {
    if (!window.confirm(`Permanently delete ${co.name}? This cannot be undone.`)) return;
    try {
      const r = await fetch(`/api/contacts/${co.id}`, { method: 'DELETE', credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setReload((n) => n + 1);
    } catch (e) { setError(e.message || 'Could not delete company'); }
  };

  if (showImport) {
    return <CsvImport onBack={() => setShowImport(false)} onDone={() => setReload((n) => n + 1)} />;
  }

  const actions = (
    <>
      <SalesSearch dark value={search} onChange={setSearch} placeholder="Search companies…" />
      <div className="relative">
        <select
          value={(filterSel.sources || []).length === 1 ? filterSel.sources[0] : ((filterSel.sources || []).length ? '__multi__' : 'all')}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '__multi__') return; // display-only marker
            setFilterSel((prev) => ({ ...prev, sources: v === 'all' ? [] : [v] }));
          }}
          className="h-9 appearance-none rounded-lg border border-[#2e2e4a] bg-[#242438] text-white text-[13px] pl-3 pr-8 outline-none"
        >
          <option value="all">All sources</option>
          {(filterSel.sources || []).length > 1 && (
            <option value="__multi__">{filterSel.sources.length} sources selected</option>
          )}
          {sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <ChevronDown className="w-4 h-4 text-[#6b7280] absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
      </div>
      <SalesSecondaryButton dark icon={Upload} onClick={() => setShowImport(true)}>Import</SalesSecondaryButton>
      <SalesPrimaryButton dark onClick={() => onAddCompany && onAddCompany()}>Add company</SalesPrimaryButton>
      {isManager && (
        <SalesSecondaryButton dark onClick={() => { setArchivedMode((v) => { const next = !v; if (next) setViewMode('list'); else { try { const sv = localStorage.getItem('wt_companies_view'); setViewMode(sv === 'list' || sv === 'pipeline' ? sv : 'pipeline'); } catch (e) { setViewMode('pipeline'); } } return next; }); clearFilters(); }}>
          {archivedMode ? 'Active companies' : 'Archived'}
        </SalesSecondaryButton>
      )}
    </>
  );

  // toggle + (list view only) stage filter pills
  const Toggle = (
    <div className="inline-flex rounded-lg border border-[#2e2e4a] bg-[#242438] p-0.5">
      <button
        onClick={() => chooseView('list')}
        className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] ${
          viewMode === 'list' ? 'bg-[rgba(245,158,11,0.15)] text-[#fcd34d]' : 'text-[#94a3b8] hover:text-white'
        }`}
      >
        <List className="w-4 h-4" /> List view
      </button>
      <button
        onClick={() => chooseView('pipeline')}
        className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] ${
          viewMode === 'pipeline' ? 'bg-[rgba(245,158,11,0.15)] text-[#fcd34d]' : 'text-[#94a3b8] hover:text-white'
        }`}
      >
        <Columns3 className="w-4 h-4" /> Pipeline view
      </button>
    </div>
  );

  const filters = (
    <>
      {Toggle}
      {viewMode === 'list' && (
        <>
          <span className="mx-1 h-5 w-px bg-[#2e2e4a]" />
          <button
            onClick={() => setFilterSel((prev) => ({ ...prev, stages: [] }))}
            className={`rounded-full px-3 py-1.5 text-[13px] border ${
              (filterSel.stages || []).length === 0 ? 'border-[#f59e0b] bg-[rgba(245,158,11,0.15)] text-[#fcd34d]' : 'border-transparent bg-[#242438] text-[#94a3b8]'
            }`}
          >
            All <span className="opacity-60">{filtered.length}</span>
          </button>
          <button
            onClick={() => toggleStage(NO_STAGE)}
            className={`rounded-full px-3 py-1.5 text-[13px] bg-[rgba(107,114,128,0.20)] text-[#cbd5e1] ${(filterSel.stages || []).includes(NO_STAGE) ? 'outline outline-2 outline-[#f59e0b]' : ''}`}
          >
            No stage <span className="opacity-60">{noStageCount}</span>
          </button>
          {STAGES.map((s) => (
            <button
              key={s.key}
              onClick={() => toggleStage(s.key)}
              className={`rounded-full px-3 py-1.5 text-[13px] ${s.pill} ${(filterSel.stages || []).includes(s.key) ? 'outline outline-2 outline-[#f59e0b]' : ''}`}
            >
              {s.label} <span className="opacity-60">{counts[s.key] || 0}</span>
            </button>
          ))}

          {/* advanced tick-box filter — sits right after the badges */}
          <span className="mx-1 h-5 w-px bg-[#2e2e4a]" />
          <button
            onClick={() => setShowFilter(true)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] border ${
              activeFilterCount > 0
                ? 'border-[#f59e0b] bg-[rgba(245,158,11,0.15)] text-[#fcd34d]'
                : 'border-[#2e2e4a] bg-[#242438] text-[#94a3b8] hover:text-white'
            }`}
          >
            <SlidersHorizontal className="w-4 h-4" />
            Filter{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ''}
          </button>
          {(activeFilterCount > 0 || search.trim()) && (
            <button
              onClick={clearFilters}
              className="text-[13px] text-[#94a3b8] hover:text-white underline underline-offset-2"
            >
              Clear filters
            </button>
          )}
        </>
      )}
    </>
  );

  const subtitle = `Your pipeline · ${companies.length} ${companies.length === 1 ? 'company' : 'companies'}`;

  // ── PIPELINE (kanban) ──────────────────────────────────────────────────────
  const pipeline = (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
      {STAGES.map((s) => {
        const cards = filtered.filter((co) => co?.crm?.salesStage === s.key);
        return (
          <div key={s.key} className="rounded-xl border border-[#2e2e4a] bg-[rgba(36,36,56,0.45)] p-3">
            <div className="flex items-center gap-2 mb-3 px-1">
              <span className={`inline-block rounded-md px-2 py-0.5 text-[11px] uppercase tracking-wide ${s.pill}`}>{s.label}</span>
              <span className="inline-flex items-center justify-center min-w-[22px] h-[22px] rounded-full bg-[#1a1a2e] text-[12px] text-[#94a3b8] px-1.5">
                {cards.length}
              </span>
            </div>
            <div className="space-y-3">
              {cards.map((co) => (
                <PipelineCard
                  key={co.id}
                  co={co}
                  isCustomer={s.key === 'customer'}
                  menuOpen={menuOpen === co.id}
                  onMenu={setMenuOpen}
                  onCloseMenu={() => setMenuOpen(null)}
                  onOpen={(id) => onOpenCompany && onOpenCompany(id)}
                  onMove={moveStage}
                  onArchive={archiveCompany}
                />
              ))}
              <button
                onClick={() => onAddCompany && onAddCompany()}
                className="w-full rounded-lg border border-dashed border-[#33334f] text-[#6b7280] hover:text-[#94a3b8] hover:border-[#454567] text-[13px] py-3"
              >
                + Add company
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );

  // ── LIST (table) ───────────────────────────────────────────────────────────
  const LIST_GRID = 'grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,0.9fr)] gap-3';
  const list = (
    <>
      <div className={`${LIST_GRID} px-4 py-2.5 bg-[#1f1f33] text-[11px] uppercase tracking-wide text-[#6b7280]`}>
        <div>Company</div><div>Telephone</div><div>Email</div><div>Contact</div><div>Next action</div>
        <div className="text-right">Monthly value</div>
      </div>
      {loading && <div className="px-4 py-8 text-center text-[13px] text-[#94a3b8]">Loading companies…</div>}
      {error && !loading && <div className="px-4 py-8 text-center text-[13px] text-[#fca5a5]">Couldn’t load companies: {error}</div>}
      {!loading && !error && listVisible.length === 0 && (
        <div className="px-4 py-10 text-center text-[13px] text-[#94a3b8]">
          {activeFilterCount > 0 || search.trim()
            ? 'No companies match your filters. Try clearing a few.'
            : 'No companies yet. Add your first one to start the pipeline.'}
        </div>
      )}
      {!loading && !error && listVisible.map((co) => {
        const na = nextActionOf(co);
        const owner = co?.crm?.assignedTo;
        return (
          <button
            key={co.id}
            onClick={() => onOpenCompany && onOpenCompany(co.id)}
            className={`w-full text-left ${LIST_GRID} items-center px-4 py-3 border-t border-[#2e2e4a] hover:bg-[#2a2a48]`}
          >
            <div className="min-w-0">
              <div className="text-sm font-medium text-white truncate">{co.name}</div>
              <div className="mt-1 flex items-center gap-2">
                <span className={`inline-block rounded-md px-2 py-0.5 text-[11px] ${STAGE_BY_KEY[co?.crm?.salesStage]?.pill || 'bg-[rgba(107,114,128,0.20)] text-[#cbd5e1]'}`}>
                  {STAGE_BY_KEY[co?.crm?.salesStage]?.label || 'No stage'}
                </span>
                {owner && <span className="text-[11px] text-[#6b7280] truncate">{owner}</span>}
              </div>
            </div>
            <div className="min-w-0 text-[13px] text-[#cbd5e1] truncate flex items-center gap-1.5">
              {co.phone ? (
                <><Phone className="w-3.5 h-3.5 text-[#6b7280] shrink-0" />
                  {telHref(co.phone)
                    ? (
                      // stopPropagation: the whole row opens the company, so
                      // without this one click would dial AND navigate away.
                      <a href={telHref(co.phone)} onClick={(e) => e.stopPropagation()}
                        title={`Call ${co.phone}`}
                        className="truncate hover:text-[#fcd34d] hover:underline">{co.phone}</a>
                    )
                    : co.phone}
                </>
              ) : <span className="text-[#6b7280]">—</span>}
            </div>
            <div className="min-w-0 text-[13px] text-[#cbd5e1] truncate flex items-center gap-1.5">
              {co.email ? <><Mail className="w-3.5 h-3.5 text-[#6b7280] shrink-0" />{co.email}</> : <span className="text-[#6b7280]">—</span>}
            </div>
            <div className="min-w-0 text-[13px] text-[#cbd5e1] truncate">{co.primaryContact || <span className="text-[#6b7280]">—</span>}</div>
            <div className="min-w-0 text-[13px] truncate">
              {na.text ? <span className="text-[#cbd5e1]">{na.text}</span> : <span className="text-[#6b7280]">—</span>}
              {na.chase && <span className={`ml-1.5 ${na.overdue ? 'text-[#ef4444]' : 'text-[#6b7280]'}`}>({ukDate(na.chase)})</span>}
            </div>
            <div className="text-right text-[13px] text-white">{money(co?.crm?.totalProfit)}</div>
          </button>
        );
      })}
    </>
  );

  // ── ARCHIVED (managers/admins) ─────────────────────────────────────────────
  const archivedList = (
    <div className="rounded-xl border border-[#2e2e4a] overflow-hidden">
      {loading && <div className="px-4 py-8 text-center text-[13px] text-[#94a3b8]">Loading archive…</div>}
      {error && !loading && <div className="px-4 py-8 text-center text-[13px] text-[#fca5a5]">Couldn’t load archive: {error}</div>}
      {!loading && !error && listVisible.length === 0 && (
        <div className="px-4 py-10 text-center text-[13px] text-[#94a3b8]">No archived companies.</div>
      )}
      {!loading && !error && listVisible.map((co) => (
        <div key={co.id} className="flex items-center gap-3 px-4 py-3 border-t border-[#2e2e4a] first:border-t-0">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-white truncate">{co.name}</div>
            <div className="text-[11px] text-[#6b7280]">
              Archived{co?.crm?.archivedAt ? ` ${ukDate(co.crm.archivedAt)}` : ''}{co?.crm?.assignedTo ? ` · ${co.crm.assignedTo}` : ''}
            </div>
          </div>
          <button onClick={() => restoreCompany(co)}
            className="shrink-0 rounded-lg border border-[#2e2e4a] text-[#cbd5e1] hover:bg-[#2a2a48] text-[12px] px-3 py-1.5">
            Restore
          </button>
          <button onClick={() => deleteForever(co)}
            className="shrink-0 rounded-lg border border-[rgba(239,68,68,0.4)] text-[#fca5a5] hover:bg-[rgba(239,68,68,0.12)] text-[12px] px-3 py-1.5">
            Delete permanently
          </button>
        </div>
      ))}
    </div>
  );

  return (
    <>
      <SalesPageLayout
        dark
        bare={!archivedMode && viewMode === 'pipeline'}
        title={archivedMode ? 'Archived companies' : 'Companies'}
        subtitle={archivedMode ? `${companies.length} archived` : subtitle}
        icon={Building2}
        actions={actions}
        filters={archivedMode ? null : filters}
      >
        {archivedMode ? archivedList : (viewMode === 'pipeline' ? pipeline : list)}
      </SalesPageLayout>

      <CompanyFilterModal
        open={showFilter}
        groups={filterGroups}
        textFields={[{
          key: 'addressQuery',
          label: 'Address contains',
          placeholder: 'Essex, Kent, London',
          hint: 'Searches inside the company address — county, town or postcode. Separate with commas to match any of them.',
        }]}
        value={filterSel}
        saved={saved}
        savedLoading={savedLoading}
        savedError={savedError}
        onPickSaved={applySaved}
        onSaveSearch={saveSearch}
        onDeleteSaved={deleteSaved}
        canDeleteSaved={canDeleteSaved}
        onApply={(next) => { setFilterSel(next); setShowFilter(false); }}
        onClose={() => setShowFilter(false)}
      />
    </>
  );
}
