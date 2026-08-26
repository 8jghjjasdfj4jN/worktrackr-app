// web/client/src/app/src/components/CRMCalendar.jsx
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.jsx';
import { Label } from '@/components/ui/label.jsx';
import {
  Calendar, Clock, Plus, Phone, Users, Target,
  AlertTriangle, CheckCircle, X, Edit, Trash2,
  ChevronLeft, ChevronRight, Briefcase, ExternalLink,
  Sparkles, Ticket, FileText, CalendarPlus, Palmtree
} from 'lucide-react';
import { useSimulation } from '../App.jsx';
import PageHero, { HeroButtonPrimary, HeroButtonOutline } from './PageHero.jsx';
import DatePicker from './DatePicker.jsx';
import DateTimePicker from './DateTimePicker.jsx';
import { STAGES } from './CompanyPipelineList.jsx';

// FIX 1: type values are lowercase to match backend Zod schema
const eventTypes = [
  { value: 'call',       label: 'Call',       icon: Phone,         color: 'bg-[rgba(59,130,246,0.20)] text-[#93c5fd]', accent: '#3b82f6' },
  { value: 'meeting',    label: 'Meeting',     icon: Users,         color: 'bg-[rgba(16,185,129,0.20)] text-[#6ee7b7]', accent: '#10b981' },
  { value: 'follow_up',  label: 'Follow Up',   icon: Target,        color: 'bg-[rgba(139,92,246,0.20)] text-[#c4b5fd]', accent: '#8b5cf6' },
  { value: 'renewal',    label: 'Renewal',     icon: AlertTriangle, color: 'bg-[rgba(249,115,22,0.20)] text-[#fdba74]', accent: '#f97316' },
  { value: 'job',        label: 'Project',     icon: Briefcase,     color: 'bg-[rgba(245,158,11,0.16)] text-[#fcd34d]', accent: '#f59e0b' },
  { value: 'ticket',     label: 'Ticket',      icon: Ticket,        color: 'bg-[rgba(99,102,241,0.20)] text-[#a5b4fc]', accent: '#6366f1' },
  { value: 'schedule',   label: 'Schedule',    icon: Clock,         color: 'bg-[rgba(71,85,105,0.30)] text-[#cbd5e1]', accent: '#64748b' },
  { value: 'holiday',    label: 'Holiday',     icon: Palmtree,      color: 'bg-[rgba(20,184,166,0.22)] text-[#5eead4]', accent: '#14b8a6' },
];

// Stage colours come from the Sales page's own STAGES list, so "Hot prospect"
// is literally the same amber in both places and can never drift apart.
// `pill` -> the chip background/text classes, `dot` -> the left accent bar.
const STAGE_BY_KEY = Object.fromEntries(STAGES.map((s) => [s.key, s]));

// A CRM event belongs to a company when it carries a contact_id. Reminders
// created without a company (contact_id is nullable) are standalone and are
// deliberately NOT treated as unstaged — they keep their normal type colour
// and are never hidden.
const eventHasCompany = (ev) => !!(ev?.contact_id || ev?.contactId);

// The company's stage, but only if it's one we recognise. Anything missing,
// null or unknown comes back null and is treated as "no stage".
const eventStage = (ev) => {
  const key = ev?.salesStage;
  return key && STAGE_BY_KEY[key] ? key : null;
};

// Owner's rule: a company's entries stay off the calendar until it has a
// stage. This HIDES them from view only — the reminders are untouched in the
// database and reappear the moment a stage is set on the company.
const isVisibleCrmEvent = (ev) => !eventHasCompany(ev) || eventStage(ev) !== null;

// ─────────────────────────────────────────────────────────────────────────────
// MODULE-LEVEL SUB-COMPONENTS — sub-component rule: never define inside parent
// ─────────────────────────────────────────────────────────────────────────────

// Icon map for quick-action button types
const ACTION_ICONS = {
  new_ticket:        Ticket,
  new_quote:         FileText,
  schedule_followup: CalendarPlus,
};

// A single quick-action button inside the AI suggestion box
function NextActionButton({ action, onAction }) {
  const IconComp = ACTION_ICONS[action.type];
  return (
    <button
      onClick={() => onAction(action.type)}
      className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-[#fcd34d] border border-[#f59e0b]/40 rounded-lg hover:bg-[rgba(245,158,11,0.25)] transition-colors"
    >
      {IconComp && <IconComp className="w-3.5 h-3.5" />}
      {action.label}
    </button>
  );
}

// Amber AI suggestion box — appears in event detail modal after Mark Done
function NextActionBox({ suggestion, actions, loading, onAction, onDismiss }) {
  if (!loading && !suggestion) return null;

  return (
    <div className="bg-[rgba(245,158,11,0.16)] border border-[#f59e0b]/30 rounded-xl p-4">
      {loading ? (
        <div className="flex items-center gap-3">
          <div className="w-4 h-4 border-2 border-[#f59e0b] border-t-transparent rounded-full animate-spin flex-shrink-0" />
          <span className="text-[13px] text-[#fcd34d]">Analysing event and generating suggestion…</span>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 flex-1">
              <Sparkles className="w-3.5 h-3.5 text-[#f59e0b] flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-[11px] font-semibold text-[#fcd34d] uppercase tracking-wider mb-1">
                  AI Suggestion
                </p>
                <p className="text-[13px] text-[#cbd5e1] leading-relaxed">{suggestion}</p>
              </div>
            </div>
            <button
              onClick={onDismiss}
              className="p-1 rounded-lg hover:bg-[rgba(245,158,11,0.25)] text-[#6b7280] hover:text-[#cbd5e1] flex-shrink-0 transition-colors"
              title="Dismiss suggestion"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          {actions && actions.filter(a => a.type !== 'none').length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1 border-t border-[#f59e0b]/20">
              {actions
                .filter(a => a.type !== 'none')
                .map((action, i) => (
                  <NextActionButton key={i} action={action} onAction={onAction} />
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function CRMCalendar({ timezone = 'Europe/London', onTicketClick, defaultSources, calendarKind = 'sales', initialDate = null }) {
  const isDelivery = calendarKind === 'delivery';
  const { tickets = [] } = useSimulation() || {};

  const navigate = useNavigate();

  const generateTimeOptions = () => {
    const times = [];
    for (let hour = 0; hour < 24; hour++) {
      for (let minute = 0; minute < 60; minute += 15) {
        times.push(`${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`);
      }
    }
    return times;
  };

  // FIX 5: real contacts loaded from API instead of hardcoded fake users
  const [contacts, setContacts] = useState([]);

  const loadEventsFromAPI = async () => {
    try {
      const response = await fetch('/api/crm-events', { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch events');
      const rows = await response.json();
      // The API returns the company as contact_name (joined from contacts), but
      // the event detail panel reads `company`. Without this the Contact line
      // and Notes section were always blank on CRM reminders.
      return (Array.isArray(rows) ? rows : []).map((ev) => ({
        ...ev,
        company: ev.company || ev.contact_name || '',
        notes: ev.notes || ev.description || '',
        // Normalised from the API's snake_case. Without this the stage arrives
        // as contact_sales_stage, nothing reads it, and every entry silently
        // falls back to "no stage" — i.e. the whole calendar would empty out.
        salesStage: ev.salesStage || ev.contact_sales_stage || null,
      }));
    } catch (error) {
      console.error('Error loading CRM events:', error);
      return [];
    }
  };

  // Reload the work/schedule (calendar_events) stream — used by the Delivery
  // calendar after it creates, edits or deletes one of its own entries.
  const loadCalendarEvents = async () => {
    try {
      const calRes = await fetch('/api/calendar/events', { credentials: 'include' });
      if (calRes.ok) {
        const calData = await calRes.json();
        setCalendarEvents(calData.events || []);
      }
    } catch (err) {
      console.error('[CRMCalendar] Failed to reload calendar events:', err);
    }
  };

  const createDateInTimezone = (dateStr, timeStr) => {
    return new Date(`${dateStr}T${timeStr}:00`);
  };

  const addHour = (time) => {
    const [hours, minutes] = time.split(':');
    return `${(parseInt(hours) + 1).toString().padStart(2, '0')}:${minutes}`;
  };

  const [events, setEvents] = useState([]);
  const [jobEvents, setJobEvents] = useState([]);
  const [calendarEvents, setCalendarEvents] = useState([]);
  const [holidayEvents, setHolidayEvents] = useState([]);
  // Source toggles. Defaults to all-on (the Delivery blended calendar). The Sales
  // Calendar tab passes defaultSources to open pre-scoped to sales activity; the
  // user can still switch Projects/Schedule on — it's the same calendar.
  // Holidays default ON everywhere (incl. the Sales calendar) so the whole team
  // can see who's off; it isn't overridden by defaultSources unless asked.
  const [sources, setSources] = useState({ sales: true, projects: true, schedule: true, holidays: true, ...(defaultSources || {}) });
  // initialDate ('YYYY-MM-DD') lets "View in calendar" on a company's timeline
  // land on the reminder's own date — a September follow-up opens September,
  // not today, which previously made created reminders look missing.
  const [selectedDate, setSelectedDate] = useState(() => {
    if (initialDate) {
      const d0 = new Date(`${initialDate}T12:00:00`);
      if (Number.isFinite(d0.getTime())) return d0;
    }
    return new Date();
  });
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showMeetingModal, setShowMeetingModal] = useState(false);
  const [showScheduleMeetingModal, setShowScheduleMeetingModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [sendCancellationEmail, setSendCancellationEmail] = useState(true);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingEvent, setEditingEvent] = useState(null);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [viewMode, setViewMode] = useState('month');

  // AI Phase 4 — CRM Next-Action Suggestions
  const [nextAction, setNextAction] = useState(null);         // { suggestion, actions[] } | null
  const [nextActionLoading, setNextActionLoading] = useState(false);

  // FIX 1: default type is lowercase 'call'
  const [newEvent, setNewEvent] = useState({
    title: '', type: 'call', company: '', contact: '', scheduleTask: '', assignedUser: '', notes: ''
  });
  const [newMeeting, setNewMeeting] = useState({
    title: '', company: '', contact: '', date: '', time: '', assignedUser: '', notes: '', location: ''
  });
  const [scheduleMeeting, setScheduleMeeting] = useState({
    title: '', company: '', contact: '', date: '', time: '', assignedUsers: [], location: '', notes: ''
  });

  // FIX 6: load on mount only — no polling interval
  useEffect(() => {
    const init = async () => {
      const eventsData = await loadEventsFromAPI();
      setEvents(eventsData);

      // Load scheduled jobs and merge as read-only calendar items
      try {
        const jobsRes = await fetch('/api/jobs?limit=500', { credentials: 'include' });
        if (jobsRes.ok) {
          const jobsData = await jobsRes.json();
          const scheduled = (jobsData.jobs || [])
            .filter(j => j.scheduledStart && j.status !== 'cancelled')
            .map(j => ({
              id:           `job-${j.id}`,
              _isJob:       true,
              _jobId:       j.id,
              title:        `${j.jobNumber} — ${j.title}`,
              type:         'job',
              start_at:     j.scheduledStart,
              end_at:       j.scheduledEnd || j.scheduledStart,
              company:      j.contactName || '',
              contact:      j.assignedToName || '',
              status:       j.status,
              jobNumber:    j.jobNumber,
              jobTitle:     j.title,
              jobStatus:    j.status,
              notes:        j.notes || '',
            }));
          setJobEvents(scheduled);
        }
      } catch (err) {
        console.error('[CRMCalendar] Failed to load job events:', err);
      }

      // Load work/ticket calendar events (read-only) for the blended view
      try {
        const calRes = await fetch('/api/calendar/events', { credentials: 'include' });
        if (calRes.ok) {
          const calData = await calRes.json();
          setCalendarEvents(calData.events || []);
        }
      } catch (err) {
        console.error('[CRMCalendar] Failed to load calendar events:', err);
      }

      // Load approved holidays (read-only) so the whole team sees who's off.
      try {
        const holRes = await fetch('/api/holidays/calendar', { credentials: 'include' });
        if (holRes.ok) {
          const holData = await holRes.json();
          setHolidayEvents(Array.isArray(holData) ? holData : []);
        }
      } catch (err) {
        console.error('[CRMCalendar] Failed to load holidays:', err);
      }
    };
    init();
  }, []);

  // Refresh when VoiceAssistant creates a CRM event
  useEffect(() => {
    const handler = async () => {
      const eventsData = await loadEventsFromAPI();
      setEvents(eventsData);
    };
    window.addEventListener('worktrackr:crm-event-created', handler);
    return () => window.removeEventListener('worktrackr:crm-event-created', handler);
  }, []);

  // FIX 5: load real contacts on mount
  useEffect(() => {
    const fetchContacts = async () => {
      try {
        const res = await fetch('/api/contacts', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setContacts(data.contacts || data || []);
        }
      } catch (err) {
        console.error('Failed to load contacts:', err);
      }
    };
    fetchContacts();
  }, []);

  // FIX 5: returns real contact names from API
  const getAvailableUsers = () => contacts.map(c => c.name).filter(Boolean);

  // Blended read-only "Schedule" stream: standalone calendar events + scheduled tickets.
  const scheduleItems = React.useMemo(() => {
    const cal = (calendarEvents || []).map((e) => {
      const raw = e.eventDate || '';
      const dateStr = raw.includes('T') ? raw.split('T')[0] : raw.substring(0, 10);
      const t = (e.startTime || '00:00').substring(0, 5);
      return {
        id: `cal-${e.id}`, _isSchedule: true, _calId: e.id, title: e.title, type: 'schedule',
        start_at: `${dateStr}T${t}:00`, end_at: `${dateStr}T${(e.endTime || t).substring(0, 5)}:00`,
        company: '', contact: '', notes: e.notes || e.description || '',
      };
    });
    const tkt = (tickets || []).filter((t) => t.scheduled_date).map((t) => {
      const raw = String(t.scheduled_date);
      const dateStr = raw.includes('T') ? raw.split('T')[0] : raw.substring(0, 10);
      const tm = raw.includes('T') ? raw.split('T')[1].substring(0, 5) : '09:00';
      return {
        id: `tkt-${t.id}`, _isTicket: true, _ticket: t, ticketId: t.id, title: t.title, type: 'ticket',
        start_at: `${dateStr}T${tm}:00`, end_at: `${dateStr}T${tm}:00`,
        company: t.contactDetails?.company_name || '', contact: '', status: t.status, notes: t.description || '',
      };
    });
    return [...cal, ...tkt];
  }, [calendarEvents, tickets]);

  // Sort a day's blended events earliest-first by their start time. Entries
  // with no time (all-day) fall back to their date, so they sort to the top.
  const sortByTime = (arr) => [...arr].sort((a, b) => {
    const ta = new Date(a.start_at || a.startAt || a.date || 0).getTime();
    const tb = new Date(b.start_at || b.startAt || b.date || 0).getTime();
    return (isNaN(ta) ? 0 : ta) - (isNaN(tb) ? 0 : tb);
  });

  // FIX 7: check start_at (snake_case — what backend returns)
  const getEventsForDate = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
    const crm = sources.sales ? events.filter(isVisibleCrmEvent).filter(event => {
      const ts = event.start_at || event.startAt;
      if (ts) {
        const ed = new Date(ts);
        const eLocal = `${ed.getFullYear()}-${String(ed.getMonth() + 1).padStart(2, '0')}-${String(ed.getDate()).padStart(2, '0')}`;
        return eLocal === dateStr;
      }
      return event.date === dateStr;
    }) : [];
    const jobs = sources.projects ? jobEvents.filter(j => j.start_at && j.start_at.split('T')[0] === dateStr) : [];
    const sched = sources.schedule ? scheduleItems.filter(s => s.start_at && s.start_at.split('T')[0] === dateStr) : [];
    // Holidays span a date range, so show them on every day from start to end.
    const hols = sources.holidays ? holidayEvents
      .filter(h => {
        const start = String(h.startDate).slice(0, 10);
        const end = String(h.endDate).slice(0, 10);
        return dateStr >= start && dateStr <= end;
      })
      .map(h => ({
        id: `hol-${h.id}-${dateStr}`,
        _isHoliday: true,
        type: 'holiday',
        title: `${h.userName} — Holiday`,
        start_at: `${String(h.startDate).slice(0, 10)}T00:00:00`,
        company: '', contact: '', notes: '',
      })) : [];
    return sortByTime([...crm, ...jobs, ...sched, ...hols]);
  };

  const getEventTypeConfig = (type) => eventTypes.find(t => t.value === type) || eventTypes[0];

  // Colour an entry by the COMPANY'S SALES STAGE where there is one, falling
  // back to the event-type colour for everything else (holidays, projects,
  // schedule, tickets, and standalone reminders with no company). Returns the
  // same {color, accent, label} shape the type config does, so every render
  // site can use it unchanged.
  const getEventStyle = (event) => {
    const base = getEventTypeConfig(event?.type);
    const key = eventStage(event);
    if (!key) return base;
    const stage = STAGE_BY_KEY[key];
    return { ...base, color: stage.pill, accent: stage.dot, label: stage.label };
  };

  // Group an already-time-sorted day list into buckets that share the same
  // displayed time, so same-time entries can render side-by-side ("split").
  // Returns an array of arrays, in time order; all-day items bucket under '—'.
  const groupByTime = (dayEvents) => {
    const order = [];
    const map = new Map();
    for (const ev of dayEvents) {
      const ts = ev.start_at || ev.startAt;
      const key = ts ? formatTime(ts) : '—';
      if (!map.has(key)) { map.set(key, []); order.push(key); }
      map.get(key).push(ev);
    }
    return order.map(k => map.get(k));
  };

  // Read-only blended items don't open the CRM edit modal: tickets open the
  // ticket; schedule (work calendar) entries are display-only.
  const openEvent = (event) => {
    if (event._isTicket) { if (onTicketClick && event._ticket) onTicketClick(event._ticket); return; }
    if (event._isHoliday) return;
    setSelectedEvent(event);
  };

  // Clicking an empty space on the calendar opens the New Activity form,
  // pre-filled to that day (default 09:00 start — adjustable in the form).
  const openCreateForDate = (day, time = '09:00') => {
    const y = day.getFullYear();
    const m = String(day.getMonth() + 1).padStart(2, '0');
    const d = String(day.getDate()).padStart(2, '0');
    setSelectedDate(day);
    setNewEvent({ title: '', type: 'call', company: '', contact: '', scheduleTask: `${y}-${m}-${d}T${time}`, assignedUser: '', notes: '' });
    setShowCreateModal(true);
  };

  const formatTime = (dateTimeStr) => {
    if (!dateTimeStr) return '';
    return new Date(dateTimeStr).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  };

  const formatDate = (dateTimeStr) => {
    if (!dateTimeStr) return '';
    return new Date(dateTimeStr).toLocaleDateString('en-GB', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  // FIX 2: send start_at / end_at. FIX 1: type is already lowercase 'meeting'
  const createMeeting = async () => {
    if (!newMeeting.title.trim() || !newMeeting.date || !newMeeting.time) return;
    const meetingEntry = {
      title: newMeeting.title,
      type: 'meeting',
      company: newMeeting.company,
      contact: newMeeting.contact,
      start_at: `${newMeeting.date}T${newMeeting.time}:00`,
      end_at: `${newMeeting.date}T${addHour(newMeeting.time)}:00`,
      assigned_user: newMeeting.assignedUser,
      status: 'planned',
      notes: newMeeting.notes,
      location: newMeeting.location
    };
    try {
      await fetch('/api/crm-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(meetingEntry)
      });
      const eventsData = await loadEventsFromAPI();
      setEvents(eventsData);
    } catch (error) {
      console.error('Error creating meeting:', error);
    }
    setNewMeeting({ title: '', company: '', contact: '', date: '', time: '', assignedUser: '', notes: '', location: '' });
    setShowMeetingModal(false);
  };

  const scheduleFromEvent = (event) => {
    setScheduleMeeting({
      title: `Follow-up meeting for ${event.company}`,
      company: event.company,
      contact: event.contact || '',
      date: '', time: '', assignedUsers: [], location: '',
      notes: `Follow-up for ${event.service || 'service'} renewal`
    });
    setShowScheduleMeetingModal(true);
  };

  // FIX 2: start_at / end_at. FIX 3: sendMeetingInvitations() call removed
  const createScheduledMeeting = async () => {
    if (!scheduleMeeting.title.trim() || !scheduleMeeting.date || !scheduleMeeting.time) return;
    const startDateTime = createDateInTimezone(scheduleMeeting.date, scheduleMeeting.time);
    const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000);
    const meetingEntry = {
      title: scheduleMeeting.title,
      type: 'meeting',
      company: scheduleMeeting.company,
      contact: scheduleMeeting.contact,
      start_at: startDateTime.toISOString(),
      end_at: endDateTime.toISOString(),
      assigned_users: scheduleMeeting.assignedUsers,
      status: 'planned',
      notes: scheduleMeeting.notes,
      location: scheduleMeeting.location
    };
    try {
      await fetch('/api/crm-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(meetingEntry)
      });
      const eventsData = await loadEventsFromAPI();
      setEvents(eventsData);
    } catch (error) {
      console.error('Error creating scheduled meeting:', error);
    }
    setScheduleMeeting({ title: '', company: '', contact: '', date: '', time: '', assignedUsers: [], location: '', notes: '' });
    setShowScheduleMeetingModal(false);
  };

  const deleteEvent = async () => {
    if (!selectedEvent) return;
    try {
      if (selectedEvent._isSchedule) {
        await fetch(`/api/calendar/events/${selectedEvent._calId}`, {
          method: 'DELETE',
          credentials: 'include'
        });
        await loadCalendarEvents();
      } else {
        await fetch(`/api/crm-events/${selectedEvent.id}`, {
          method: 'DELETE',
          credentials: 'include'
        });
        const eventsData = await loadEventsFromAPI();
        setEvents(eventsData);
      }
    } catch (error) {
      console.error('Error deleting event:', error);
    }
    setShowDeleteConfirm(false);
    setSelectedEvent(null);
    setNextAction(null);
    setSendCancellationEmail(true);
  };

  // FIX 7: read start_at from event
  const openEditModal = (event) => {
    const ts = event.start_at || event.startAt;
    setEditingEvent({
      ...event,
      date: ts ? new Date(ts).toISOString().split('T')[0] : '',
      time: ts ? new Date(ts).toTimeString().slice(0, 5) : '',
      assignedUsers: event.assigned_users || event.assignedUsers || []
    });
    setShowEditModal(true);
    setSelectedEvent(null);
  };

  // FIX 2: send start_at / end_at
  const saveEditedEvent = async () => {
    if (!editingEvent.title || !editingEvent.date || !editingEvent.time) {
      alert('Please fill in all required fields');
      return;
    }
    const startDateTime = createDateInTimezone(editingEvent.date, editingEvent.time);
    const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000);

    // Delivery/schedule entries live in calendar_events — update via that route.
    if (editingEvent._isSchedule) {
      const pad = (n) => String(n).padStart(2, '0');
      const endTime = `${pad(endDateTime.getHours())}:${pad(endDateTime.getMinutes())}`;
      try {
        await fetch(`/api/calendar/events/${editingEvent._calId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            title: editingEvent.title,
            description: editingEvent.notes || '',
            eventDate: editingEvent.date,
            startTime: editingEvent.time,
            endTime,
            notes: editingEvent.notes || ''
          })
        });
        await loadCalendarEvents();
      } catch (error) {
        console.error('Error updating calendar event:', error);
      }
      setShowEditModal(false);
      setEditingEvent(null);
      return;
    }

    const updatedEvent = {
      ...editingEvent,
      start_at: startDateTime.toISOString(),
      end_at: endDateTime.toISOString()
    };
    try {
      await fetch(`/api/crm-events/${editingEvent.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(updatedEvent)
      });
      const eventsData = await loadEventsFromAPI();
      setEvents(eventsData);
    } catch (error) {
      console.error('Error updating event:', error);
    }
    setShowEditModal(false);
    setEditingEvent(null);
  };

  // FIX 4: mark done handler — also fires AI next-action suggestion (AI Phase 4)
  const markEventDone = async (event) => {
    try {
      await fetch(`/api/crm-events/${event.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: 'done' })
      });
      const eventsData = await loadEventsFromAPI();
      setEvents(eventsData);
      setSelectedEvent(prev => prev ? { ...prev, status: 'done' } : null);

      // Fire next-action suggestion — non-blocking, never prevents modal close
      setNextActionLoading(true);
      setNextAction(null);
      try {
        const res = await fetch(`/api/summaries/crm-event/${event.id}/next-action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            company: event.company  || '',
            contact: event.contact  || '',
          })
        });
        if (res.ok) {
          const data = await res.json();
          setNextAction(data);
        }
      } catch (aiErr) {
        console.error('[CRMCalendar] Next-action fetch error:', aiErr);
        // Silent fail — suggestion box simply won't appear
      } finally {
        setNextActionLoading(false);
      }
    } catch (error) {
      console.error('Error marking event done:', error);
    }
  };

  // Handle quick-action button clicks from the AI suggestion box
  const handleNextAction = (actionType) => {
    const contact = selectedEvent?.contact || '';
    const company = selectedEvent?.company || '';
    if (actionType === 'new_ticket') {
      setSelectedEvent(null);
      setNextAction(null);
      navigate('/app/tickets/new', { state: { prefillContact: contact, prefillCompany: company } });
    } else if (actionType === 'new_quote') {
      setSelectedEvent(null);
      setNextAction(null);
      navigate('/app/crm/quotes/new', { state: { prefillContact: contact, prefillCompany: company } });
    } else if (actionType === 'schedule_followup') {
      // Pre-fill the schedule meeting modal with this event's contact/company
      const ev = selectedEvent;
      setNextAction(null);
      setSelectedEvent(null);
      scheduleFromEvent(ev);
    }
  };

  const generateCalendarDays = () => {
    const year = selectedDate.getFullYear();
    const month = selectedDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const startDate = new Date(firstDay);
    startDate.setDate(startDate.getDate() - firstDay.getDay());
    const days = [];
    const currentDate = new Date(startDate);
    for (let i = 0; i < 42; i++) {
      days.push(new Date(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }
    return days;
  };

  const getWeekDays = () => {
    const startOfWeek = new Date(selectedDate);
    const diff = startOfWeek.getDate() - startOfWeek.getDay();
    startOfWeek.setDate(diff);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(startOfWeek);
      d.setDate(startOfWeek.getDate() + i);
      return d;
    });
  };

  const getWeekRange = () => {
    const weekDays = getWeekDays();
    const s = weekDays[0], e = weekDays[6];
    if (s.getMonth() === e.getMonth()) {
      return `${s.getDate()}–${e.getDate()} ${s.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`;
    }
    return `${s.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${e.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  };

  const calendarDays = generateCalendarDays();
  const todayEvents = getEventsForDate(selectedDate);

  const inputClass = "w-full px-3 py-2 text-[13px] border border-[#2e2e4a] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#f59e0b]/30 focus:border-[#f59e0b]";
  const labelClass = "block text-[11px] font-semibold text-[#6b7280] uppercase tracking-wider mb-1.5";

  return (
    <div className="space-y-5 p-5 md:p-7 min-h-full bg-[#1a1a2e]">

      {/* Page header */}
      <PageHero
        title="Calendar"
        icon={Calendar}
        meta={[{ label: 'Jobs, tickets, meetings and follow-ups — all in one place' }]}
        actions={
          <>
            <Select value={viewMode} onValueChange={setViewMode}>
              <SelectTrigger className="w-28 text-[13px] border-[#2e2e4a] bg-[#242438] text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[#242438] border-[#2e2e4a] text-white">
                <SelectItem value="day">Day</SelectItem>
                <SelectItem value="week">Week</SelectItem>
                <SelectItem value="month">Month</SelectItem>
              </SelectContent>
            </Select>
            <HeroButtonPrimary icon={Plus} onClick={() => setShowCreateModal(true)}>{isDelivery ? 'Add Entry' : 'Add Activity'}</HeroButtonPrimary>
            {!isDelivery && (
              <HeroButtonOutline icon={Calendar} onClick={() => {
                const dateStr = selectedDate.toISOString().split('T')[0];
                setNewMeeting(prev => ({ ...prev, date: dateStr, time: '09:00' }));
                setShowMeetingModal(true);
              }}>Book Meeting</HeroButtonOutline>
            )}
          </>
        }
        compact
      />

      {/* Calendar navigation */}
      <div className="bg-[#242438] rounded-xl border border-[#2e2e4a] px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              const d = new Date(selectedDate);
              if (viewMode === 'day') d.setDate(d.getDate() - 1);
              else if (viewMode === 'week') d.setDate(d.getDate() - 7);
              else d.setMonth(d.getMonth() - 1);
              setSelectedDate(d);
            }}
            className="p-1.5 rounded-lg border border-[#2e2e4a] hover:bg-[#1f1f33] transition-colors"
          >
            <ChevronLeft className="w-4 h-4 text-[#cbd5e1]" />
          </button>
          <h2 className="text-[14px] font-semibold text-white min-w-[200px] text-center">
            {viewMode === 'day' && selectedDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            {viewMode === 'week' && getWeekRange()}
            {viewMode === 'month' && selectedDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
          </h2>
          <button
            onClick={() => {
              const d = new Date(selectedDate);
              if (viewMode === 'day') d.setDate(d.getDate() + 1);
              else if (viewMode === 'week') d.setDate(d.getDate() + 7);
              else d.setMonth(d.getMonth() + 1);
              setSelectedDate(d);
            }}
            className="p-1.5 rounded-lg border border-[#2e2e4a] hover:bg-[#1f1f33] transition-colors"
          >
            <ChevronRight className="w-4 h-4 text-[#cbd5e1]" />
          </button>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {[
            { key: 'sales',    label: 'Sales',    dot: '#15803d' },
            { key: 'projects', label: 'Projects', dot: '#b8860b' },
            { key: 'schedule', label: 'Schedule', dot: '#4338ca' },
            { key: 'holidays', label: 'Holidays', dot: '#14b8a6' },
          ].map((s) => (
            <button
              key={s.key}
              onClick={() => setSources((prev) => ({ ...prev, [s.key]: !prev[s.key] }))}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] rounded-lg border transition-colors ${sources[s.key] ? 'border-[#2e2e4a] text-[#cbd5e1] bg-[#242438]' : 'border-transparent text-[#6b7280] bg-[#1f1f33]'}`}
            >
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: sources[s.key] ? s.dot : '#cbd5e1' }} />
              {s.label}
            </button>
          ))}
          <button
            onClick={() => setSelectedDate(new Date())}
            className="px-3 py-1.5 text-[13px] font-medium text-[#cbd5e1] border border-[#2e2e4a] rounded-lg hover:bg-[#1f1f33] transition-colors"
          >
            Today
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Calendar grid */}
        <div className="lg:col-span-2 bg-[#242438] rounded-xl border border-[#2e2e4a] overflow-hidden">
          <div className="px-5 py-3 border-b border-[#2e2e4a]">
            <h3 className="text-[13px] font-semibold text-[#cbd5e1]">
              {viewMode === 'day' && selectedDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
              {viewMode === 'week' && `Week — ${getWeekRange()}`}
              {viewMode === 'month' && 'Month View'}
            </h3>
          </div>
          <div className="p-4">

            {/* Day view */}
            {viewMode === 'day' && (
              <div className="space-y-3">
                <div className="text-center p-4 bg-[#1f1f33] rounded-lg border border-[#2e2e4a]">
                  <h3 className="text-[14px] font-semibold text-[#cbd5e1]">
                    {selectedDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
                  </h3>
                  <p className="text-[12px] text-[#6b7280] mt-0.5">
                    {todayEvents.length} event{todayEvents.length !== 1 ? 's' : ''} scheduled
                  </p>
                </div>
                {todayEvents.length === 0 ? (
                  <div
                    onClick={() => openCreateForDate(selectedDate)}
                    className="text-center py-10 text-[13px] text-[#6b7280] rounded-lg border border-dashed border-[#2e2e4a] cursor-pointer hover:bg-[rgba(245,158,11,0.08)] hover:text-[#cbd5e1] transition-colors"
                  >
                    <Calendar className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    No events scheduled — click to add one
                  </div>
                ) : (
                  groupByTime(todayEvents).map((grp, gi) => (
                    <div key={gi} className="flex gap-3">
                      {grp.map(event => {
                        const tc = getEventStyle(event);
                        const ts = event.start_at || event.startAt;
                        return (
                          <div
                            key={event.id}
                            onClick={() => openEvent(event)}
                            style={{ borderLeft: `4px solid ${tc.accent}` }}
                            className="flex-1 min-w-0 p-4 border border-[#2e2e4a] rounded-lg hover:bg-[rgba(245,158,11,0.16)] cursor-pointer transition-colors"
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${tc.color}`}>{tc.label}</span>
                                <span className="text-[13px] font-medium text-white truncate">{event.title}</span>
                              </div>
                              <span className="text-[12px] text-[#6b7280] flex-shrink-0 ml-2">{ts && formatTime(ts)}</span>
                            </div>
                            <div className="mt-2 text-[12px] text-[#94a3b8] space-y-0.5">
                              <p><span className="font-medium">Company:</span> {event.company}</p>
                              {event.contact && <p><span className="font-medium">Contact:</span> {event.contact}</p>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))
                )}
                {todayEvents.length > 0 && (
                  <div
                    onClick={() => openCreateForDate(selectedDate)}
                    className="text-center py-3 text-[12px] text-[#6b7280] rounded-lg border border-dashed border-[#2e2e4a] cursor-pointer hover:bg-[rgba(245,158,11,0.08)] hover:text-[#cbd5e1] transition-colors"
                  >
                    + Add an activity on this day
                  </div>
                )}
              </div>
            )}

            {/* Week view */}
            {viewMode === 'week' && (
              <div className="grid grid-cols-7 gap-1">
                {getWeekDays().map((day, index) => {
                  const dayEvents = getEventsForDate(day);
                  const isToday = day.toDateString() === new Date().toDateString();
                  return (
                    <div
                      key={index}
                      onClick={() => openCreateForDate(day)}
                      title="Click an empty space to add an activity"
                      className="border border-[#2e2e4a] rounded-lg p-2 min-h-[100px] cursor-pointer hover:bg-[rgba(245,158,11,0.08)] transition-colors"
                    >
                      <div className={`text-center mb-2 ${isToday ? 'text-[#f59e0b] font-bold' : 'text-[#94a3b8]'}`}>
                        <div className="text-[10px] font-semibold uppercase tracking-wider">
                          {day.toLocaleDateString('en-GB', { weekday: 'short' })}
                        </div>
                        <div className={`text-[14px] mt-0.5 ${isToday ? 'bg-[#f59e0b] text-[#1a1a2e] rounded-full w-7 h-7 flex items-center justify-center mx-auto' : ''}`}>
                          {day.getDate()}
                        </div>
                      </div>
                      <div className="space-y-1">
                        {groupByTime(dayEvents).map((grp, gi) => (
                          <div key={gi} className="flex gap-1">
                            {grp.map(event => {
                              const tc = getEventStyle(event);
                              const ts = event.start_at || event.startAt;
                              return (
                                <div
                                  key={event.id}
                                  onClick={(e) => { e.stopPropagation(); openEvent(event); }}
                                  style={{ borderLeft: `3px solid ${tc.accent}` }}
                                  className={`flex-1 min-w-0 text-[10px] p-1 rounded cursor-pointer truncate ${tc.color}`}
                                  title={`${event.title} — ${ts && formatTime(ts)}`}
                                >
                                  {event.title}
                                </div>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Month view */}
            {viewMode === 'month' && (
              <>
                <div className="grid grid-cols-7 gap-1 mb-1">
                  {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
                    <div key={d} className="p-2 text-center text-[11px] font-semibold text-[#6b7280] uppercase tracking-wider">{d}</div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-1">
                  {calendarDays.map((day, index) => {
                    const isCurrentMonth = day.getMonth() === selectedDate.getMonth();
                    const isToday = day.toDateString() === new Date().toDateString();
                    const isSelected = day.toDateString() === selectedDate.toDateString();
                    const dayEvents = getEventsForDate(day);
                    return (
                      <div
                        key={index}
                        onClick={() => openCreateForDate(day)}
                        title="Click an empty space to add an activity"
                        className={`min-h-[72px] p-1 border rounded-lg cursor-pointer transition-colors
                          ${isCurrentMonth ? 'bg-[#242438]' : 'bg-[#1f1f33] text-[#6b7280]'}
                          ${isToday ? 'border-[#f59e0b] bg-[rgba(245,158,11,0.16)]' : 'border-[#2e2e4a]'}
                          ${isSelected ? 'ring-2 ring-[#f59e0b]/40' : ''}
                          hover:bg-[rgba(245,158,11,0.16)]`}
                      >
                        <div className="text-[12px] font-medium mb-1">{day.getDate()}</div>
                        <div className="space-y-0.5">
                          {groupByTime(dayEvents).map((grp, gi) => (
                            <div key={gi} className="flex gap-0.5">
                              {grp.map(event => {
                                const tc = getEventStyle(event);
                                return (
                                  <div
                                    key={event.id}
                                    onClick={(e) => { e.stopPropagation(); openEvent(event); }}
                                    style={{ borderLeft: `3px solid ${tc.accent}` }}
                                    className={`flex-1 min-w-0 text-[10px] pl-1 pr-1 py-0.5 rounded truncate cursor-pointer ${tc.color}`}
                                    title={event.title}
                                  >
                                    {event.title}
                                  </div>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">

          {/* Events for selected date */}
          <div className="bg-[#242438] rounded-xl border border-[#2e2e4a] overflow-hidden">
            <div className="px-5 py-3 border-b border-[#2e2e4a]">
              <h3 className="text-[13px] font-semibold text-[#cbd5e1]">
                {selectedDate.toLocaleDateString('en-GB', { weekday: 'long', month: 'long', day: 'numeric' })}
              </h3>
            </div>
            <div className="p-4">
              {todayEvents.length === 0 ? (
                <p className="text-[13px] text-[#6b7280] text-center py-4">No events scheduled</p>
              ) : (
                <div className="space-y-2">
                  {todayEvents.map(event => {
                    const tc = getEventStyle(event);
                    const IconComponent = tc.icon;
                    const ts = event.start_at || event.startAt;
                    const te = event.end_at || event.endAt;
                    return (
                      <div
                        key={event.id}
                        onClick={() => openEvent(event)}
                        style={{ borderLeft: `4px solid ${tc.accent}` }}
                        className="border border-[#2e2e4a] rounded-lg p-3 hover:bg-[rgba(245,158,11,0.16)] cursor-pointer transition-colors"
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <IconComponent className="w-3.5 h-3.5 text-[#6b7280]" />
                              <span className="text-[13px] font-medium text-white truncate">{event.title}</span>
                            </div>
                            <div className="text-[11px] text-[#94a3b8] space-y-0.5">
                              {ts && <div>🕐 {formatTime(ts)}{te ? ` – ${formatTime(te)}` : ''}</div>}
                              <div>🏢 {event.company}</div>
                              {event.contact && <div>👤 {event.contact}</div>}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium ${tc.color}`}>
                              {tc.label}
                            </span>
                            {event.status === 'done'
                              ? <CheckCircle className="w-3.5 h-3.5 text-[#6ee7b7]" />
                              : <Clock className="w-3.5 h-3.5 text-[#f59e0b]" />
                            }
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Stats */}
          <div className="bg-[#242438] rounded-xl border border-[#2e2e4a] overflow-hidden">
            <div className="px-5 py-3 border-b border-[#2e2e4a]">
              <h3 className="text-[13px] font-semibold text-[#cbd5e1]">This Month</h3>
            </div>
            <div className="p-4 space-y-3">
              {[
                { label: 'Total Events', value: events.length, color: 'text-white' },
                // FIX 8: lowercase status values to match backend
                { label: 'Completed', value: events.filter(e => e.status === 'done').length, color: 'text-[#6ee7b7]' },
                { label: 'Pending', value: events.filter(e => e.status === 'planned').length, color: 'text-[#f59e0b]' },
                { label: 'Renewals', value: events.filter(e => e.type === 'renewal').length, color: 'text-[#fdba74]' },
              ].map(({ label, value, color }) => (
                <div key={label} className="flex justify-between items-center">
                  <span className="text-[13px] text-[#94a3b8]">{label}</span>
                  <span className={`text-[13px] font-semibold ${color}`}>{value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── CREATE ACTIVITY MODAL ── */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-[#242438] rounded-xl border border-[#2e2e4a] shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#2e2e4a]">
              <h2 className="text-[15px] font-semibold text-white">{isDelivery ? 'Add Calendar Entry' : 'Add CRM Activity'}</h2>
              <button onClick={() => setShowCreateModal(false)} className="p-1.5 rounded-lg hover:bg-[#1f1f33] text-[#94a3b8]">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className={labelClass}>Title</label>
                <input className={inputClass} value={newEvent.title} onChange={e => setNewEvent({...newEvent, title: e.target.value})} placeholder={isDelivery ? 'Entry title' : 'Activity title'} />
              </div>
              {!isDelivery && (
                <>
                  <div>
                    <label className={labelClass}>Type</label>
                    <Select value={newEvent.type} onValueChange={v => setNewEvent({...newEvent, type: v})}>
                      <SelectTrigger className="text-[13px] border-[#2e2e4a] bg-[#242438] text-white"><SelectValue /></SelectTrigger>
                      <SelectContent className="bg-[#242438] border-[#2e2e4a] text-white">
                        {eventTypes.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className={labelClass}>Company</label>
                    <input className={inputClass} value={newEvent.company} onChange={e => setNewEvent({...newEvent, company: e.target.value})} placeholder="Company name" />
                  </div>
                  <div>
                    <label className={labelClass}>Contact</label>
                    <input className={inputClass} value={newEvent.contact} onChange={e => setNewEvent({...newEvent, contact: e.target.value})} placeholder="Contact person" />
                  </div>
                </>
              )}
              <div>
                <label className={labelClass}>{isDelivery ? 'Date & time *' : 'Schedule Task *'}</label>
                <DateTimePicker value={newEvent.scheduleTask} onChange={(v) => setNewEvent({...newEvent, scheduleTask: v})} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Notes</label>
                <textarea className={inputClass} value={newEvent.notes} onChange={e => setNewEvent({...newEvent, notes: e.target.value})} placeholder="Additional notes..." rows={3} />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#2e2e4a]">
              <button onClick={() => setShowCreateModal(false)} className="px-4 py-2 text-[13px] font-medium text-[#cbd5e1] border border-[#2e2e4a] rounded-lg hover:bg-[#1f1f33]">Cancel</button>
              <button
                onClick={async () => {
                  if (!newEvent.title.trim() || !newEvent.scheduleTask) {
                    alert(isDelivery ? 'Please fill in Title and Date & time' : 'Please fill in Title and Schedule Task');
                    return;
                  }
                  const scheduleDateTime = new Date(newEvent.scheduleTask);
                  const endDateTime = new Date(scheduleDateTime.getTime() + 60 * 60 * 1000);
                  try {
                    if (isDelivery) {
                      // Delivery calendar → create a schedule (calendar_events) entry.
                      const pad = (n) => String(n).padStart(2, '0');
                      const eventDate = `${scheduleDateTime.getFullYear()}-${pad(scheduleDateTime.getMonth() + 1)}-${pad(scheduleDateTime.getDate())}`;
                      const startTime = `${pad(scheduleDateTime.getHours())}:${pad(scheduleDateTime.getMinutes())}`;
                      const endTime = `${pad(endDateTime.getHours())}:${pad(endDateTime.getMinutes())}`;
                      await fetch('/api/calendar/events', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({
                          title: newEvent.title,
                          description: newEvent.notes,
                          eventDate, startTime, endTime,
                          notes: newEvent.notes,
                          eventType: 'work'
                        })
                      });
                      await loadCalendarEvents();
                    } else {
                      // Sales calendar → create a CRM activity.
                      const activityEntry = {
                        title: newEvent.title,
                        type: newEvent.type,
                        company: newEvent.company,
                        contact: newEvent.contact,
                        start_at: scheduleDateTime.toISOString(),
                        end_at: endDateTime.toISOString(),
                        assigned_user: newEvent.assignedUser,
                        status: 'planned',
                        notes: newEvent.notes
                      };
                      await fetch('/api/crm-events', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify(activityEntry)
                      });
                      const eventsData = await loadEventsFromAPI();
                      setEvents(eventsData);
                    }
                  } catch (error) {
                    console.error('Error creating event:', error);
                  }
                  setShowCreateModal(false);
                  setNewEvent({ title: '', type: 'call', company: '', contact: '', scheduleTask: '', assignedUser: '', notes: '' });
                }}
                className="px-4 py-2 text-[13px] font-medium text-[#1a1a2e] bg-[#f59e0b] hover:bg-[#d97706] rounded-lg"
              >
                {isDelivery ? 'Create Entry' : 'Create Activity'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── EVENT DETAIL MODAL ── */}
      {selectedEvent && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-[#242438] rounded-xl border border-[#2e2e4a] shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#2e2e4a]">
              <h2 className="text-[15px] font-semibold text-white">
                {selectedEvent._isSchedule ? 'Calendar Entry' : selectedEvent._isJob ? 'Scheduled Project' : 'Event Details'}
              </h2>
              <button onClick={() => { setSelectedEvent(null); setNextAction(null); }} className="p-1.5 rounded-lg hover:bg-[#1f1f33] text-[#94a3b8]">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* ── SCHEDULE (calendar_events) variant ── */}
            {selectedEvent._isSchedule ? (
              <>
                <div className="p-6 space-y-4">
                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-lg bg-[rgba(100,116,139,0.20)] border border-[#64748b]/30 flex-shrink-0">
                      <Clock className="w-4 h-4 text-[#cbd5e1]" />
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold text-[#6b7280] uppercase tracking-wider">Calendar Entry</p>
                      <h3 className="text-[14px] font-semibold text-white mt-0.5">{selectedEvent.title}</h3>
                    </div>
                  </div>
                  <div className="space-y-2 text-[13px]">
                    {(selectedEvent.start_at) && (
                      <>
                        <div><span className="font-medium text-[#cbd5e1]">Date:</span> <span className="text-[#94a3b8]">{formatDate(selectedEvent.start_at)}</span></div>
                        <div>
                          <span className="font-medium text-[#cbd5e1]">Time:</span>{' '}
                          <span className="text-[#94a3b8]">
                            {formatTime(selectedEvent.start_at)}
                            {selectedEvent.end_at && selectedEvent.end_at !== selectedEvent.start_at ? ` – ${formatTime(selectedEvent.end_at)}` : ''}
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                  {selectedEvent.notes && (
                    <div>
                      <p className="text-[11px] font-semibold text-[#6b7280] uppercase tracking-wider mb-1">Notes</p>
                      <p className="text-[13px] text-[#94a3b8]">{selectedEvent.notes}</p>
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap justify-end gap-2 px-6 py-4 border-t border-[#2e2e4a]">
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium text-[#fca5a5] border border-[rgba(239,68,68,0.4)] rounded-lg hover:bg-[rgba(239,68,68,0.15)]"
                  >
                    <Trash2 className="w-4 h-4" /> Delete
                  </button>
                  <button
                    onClick={() => { setSelectedEvent(null); setNextAction(null); }}
                    className="px-3 py-2 text-[13px] font-medium text-[#cbd5e1] border border-[#2e2e4a] rounded-lg hover:bg-[#1f1f33]"
                  >
                    Close
                  </button>
                  <button
                    onClick={() => openEditModal(selectedEvent)}
                    className="flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium text-[#cbd5e1] border border-[#2e2e4a] rounded-lg hover:bg-[#1f1f33]"
                  >
                    <Edit className="w-4 h-4" /> Edit
                  </button>
                </div>
              </>
            ) : selectedEvent._isJob ? (
              <>
                <div className="p-6 space-y-4">
                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-lg bg-[rgba(245,158,11,0.16)] border border-[#f59e0b]/20 flex-shrink-0">
                      <Briefcase className="w-4 h-4 text-[#f59e0b]" />
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold text-[#6b7280] uppercase tracking-wider">{selectedEvent.jobNumber}</p>
                      <h3 className="text-[14px] font-semibold text-white mt-0.5">{selectedEvent.jobTitle}</h3>
                    </div>
                  </div>
                  <div className="space-y-2 text-[13px]">
                    {(selectedEvent.start_at) && (
                      <>
                        <div><span className="font-medium text-[#cbd5e1]">Date:</span> <span className="text-[#94a3b8]">{formatDate(selectedEvent.start_at)}</span></div>
                        <div>
                          <span className="font-medium text-[#cbd5e1]">Time:</span>{' '}
                          <span className="text-[#94a3b8]">
                            {formatTime(selectedEvent.start_at)}
                            {selectedEvent.end_at && selectedEvent.end_at !== selectedEvent.start_at
                              ? ` – ${formatTime(selectedEvent.end_at)}`
                              : ''}
                          </span>
                        </div>
                      </>
                    )}
                    {selectedEvent.company && (
                      <div><span className="font-medium text-[#cbd5e1]">Contact:</span> <span className="text-[#94a3b8]">{selectedEvent.company}</span></div>
                    )}
                    {selectedEvent.contact && (
                      <div><span className="font-medium text-[#cbd5e1]">Assigned to:</span> <span className="text-[#94a3b8]">{selectedEvent.contact}</span></div>
                    )}
                    <div>
                      <span className="font-medium text-[#cbd5e1]">Status:</span>{' '}
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ml-1 ${
                        selectedEvent.jobStatus === 'scheduled'   ? 'bg-[rgba(59,130,246,0.20)] text-[#93c5fd]' :
                        selectedEvent.jobStatus === 'in_progress' ? 'bg-[rgba(245,158,11,0.20)] text-[#fcd34d]' :
                        selectedEvent.jobStatus === 'on_hold'     ? 'bg-[rgba(107,114,128,0.20)] text-[#94a3b8]' :
                        selectedEvent.jobStatus === 'completed'   ? 'bg-[rgba(16,185,129,0.20)] text-[#6ee7b7]' :
                        selectedEvent.jobStatus === 'invoiced'    ? 'bg-[rgba(139,92,246,0.20)] text-[#c4b5fd]' :
                        'bg-[rgba(239,68,68,0.20)] text-[#fca5a5]'
                      }`}>
                        {selectedEvent.jobStatus?.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase())}
                      </span>
                    </div>
                  </div>
                  {selectedEvent.notes && (
                    <div>
                      <p className="text-[11px] font-semibold text-[#6b7280] uppercase tracking-wider mb-1">Notes</p>
                      <p className="text-[13px] text-[#94a3b8]">{selectedEvent.notes}</p>
                    </div>
                  )}
                </div>
                <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#2e2e4a]">
                  <button
                    onClick={() => { setSelectedEvent(null); setNextAction(null); }}
                    className="px-3 py-2 text-[13px] font-medium text-[#cbd5e1] border border-[#2e2e4a] rounded-lg hover:bg-[#1f1f33]"
                  >
                    Close
                  </button>
                  <button
                    onClick={() => { setSelectedEvent(null); setNextAction(null); navigate(`/app/jobs/${selectedEvent._jobId}`); }}
                    className="flex items-center gap-2 px-4 py-2 text-[13px] font-medium text-[#1a1a2e] bg-[#f59e0b] hover:bg-[#d97706] rounded-lg"
                  >
                    <ExternalLink className="w-3.5 h-3.5" /> View Project
                  </button>
                </div>
              </>
            ) : (
              /* ── CRM event variant (unchanged) ── */
              <>
                <div className="p-6 space-y-4">
                  <div>
                    <h3 className="text-[15px] font-semibold text-white">{selectedEvent.title}</h3>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium mt-1 ${getEventStyle(selectedEvent).color}`}>
                      {getEventStyle(selectedEvent).label}
                    </span>
                  </div>
                  <div className="space-y-2 text-[13px]">
                    <div><span className="font-medium text-[#cbd5e1]">Company:</span> <span className="text-[#94a3b8]">{selectedEvent.company}</span></div>
                    <div><span className="font-medium text-[#cbd5e1]">Contact:</span> <span className="text-[#94a3b8]">{selectedEvent.contact}</span></div>
                    {(selectedEvent.start_at || selectedEvent.startAt) && (
                      <>
                        <div><span className="font-medium text-[#cbd5e1]">Date:</span> <span className="text-[#94a3b8]">{formatDate(selectedEvent.start_at || selectedEvent.startAt)}</span></div>
                        <div><span className="font-medium text-[#cbd5e1]">Time:</span> <span className="text-[#94a3b8]">{formatTime(selectedEvent.start_at || selectedEvent.startAt)} – {formatTime(selectedEvent.end_at || selectedEvent.endAt)}</span></div>
                      </>
                    )}
                    {selectedEvent.assigned_user && (
                      <div><span className="font-medium text-[#cbd5e1]">Assigned to:</span> <span className="text-[#94a3b8]">{selectedEvent.assigned_user}</span></div>
                    )}
                    {selectedEvent.assigned_users && selectedEvent.assigned_users.length > 0 && (
                      <div><span className="font-medium text-[#cbd5e1]">Assigned to:</span> <span className="text-[#94a3b8]">{selectedEvent.assigned_users.join(', ')}</span></div>
                    )}
                    <div>
                      <span className="font-medium text-[#cbd5e1]">Status:</span>{' '}
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${selectedEvent.status === 'done' ? 'bg-[rgba(16,185,129,0.20)] text-[#6ee7b7]' : 'bg-[rgba(245,158,11,0.16)] text-[#f59e0b]'}`}>
                        {selectedEvent.status === 'done' ? 'Done' : 'Planned'}
                      </span>
                    </div>
                    {selectedEvent.location && (
                      <div><span className="font-medium text-[#cbd5e1]">Location:</span> <span className="text-[#94a3b8]">{selectedEvent.location}</span></div>
                    )}
                  </div>
                  {selectedEvent.notes && (
                    <div>
                      <p className="text-[11px] font-semibold text-[#6b7280] uppercase tracking-wider mb-1">Notes</p>
                      <p className="text-[13px] text-[#94a3b8]">{selectedEvent.notes}</p>
                    </div>
                  )}

                  {/* AI Phase 4 — Next-Action Suggestion box */}
                  <NextActionBox
                    loading={nextActionLoading}
                    suggestion={nextAction?.suggestion}
                    actions={nextAction?.actions}
                    onAction={handleNextAction}
                    onDismiss={() => setNextAction(null)}
                  />
                </div>
                <div className="flex flex-col sm:flex-row sm:justify-between gap-2 px-6 py-4 border-t border-[#2e2e4a]">
                  <button
                    onClick={() => scheduleFromEvent(selectedEvent)}
                    className="flex items-center gap-2 px-3 py-2 text-[13px] font-medium text-[#cbd5e1] border border-[#2e2e4a] rounded-lg hover:bg-[#1f1f33]"
                  >
                    <Calendar className="w-4 h-4" /> Schedule Meeting
                  </button>
                  <div className="flex flex-wrap gap-2 justify-end">
                    <button
                      onClick={() => setShowDeleteConfirm(true)}
                      className="flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium text-[#fca5a5] border border-[rgba(239,68,68,0.4)] rounded-lg hover:bg-[rgba(239,68,68,0.15)]"
                    >
                      <Trash2 className="w-4 h-4" /> Delete
                    </button>
                    <button
                      onClick={() => { setSelectedEvent(null); setNextAction(null); }}
                      className="px-3 py-2 text-[13px] font-medium text-[#cbd5e1] border border-[#2e2e4a] rounded-lg hover:bg-[#1f1f33]"
                    >
                      Close
                    </button>
                    <button
                      onClick={() => openEditModal(selectedEvent)}
                      className="flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium text-[#cbd5e1] border border-[#2e2e4a] rounded-lg hover:bg-[#1f1f33]"
                    >
                      <Edit className="w-4 h-4" /> Edit
                    </button>
                    {/* FIX 4: Mark Done button now has onClick wired to PUT /api/crm-events/:id */}
                    {selectedEvent.status !== 'done' && (
                      <button
                        onClick={() => markEventDone(selectedEvent)}
                        className="flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium text-[#1a1a2e] bg-[#f59e0b] hover:bg-[#d97706] rounded-lg"
                      >
                        <CheckCircle className="w-4 h-4" /> Mark Done
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── BOOK MEETING MODAL ── */}
      {showMeetingModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-[#242438] rounded-xl border border-[#2e2e4a] shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#2e2e4a]">
              <h3 className="text-[15px] font-semibold text-white">Book Customer Meeting</h3>
              <button onClick={() => setShowMeetingModal(false)} className="p-1.5 rounded-lg hover:bg-[#1f1f33] text-[#94a3b8]">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className={labelClass}>Meeting Title</label>
                <input className={inputClass} value={newMeeting.title} onChange={e => setNewMeeting(p => ({...p, title: e.target.value}))} placeholder="e.g. Site visit with Acme Corp" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Company</label>
                  <input className={inputClass} value={newMeeting.company} onChange={e => setNewMeeting(p => ({...p, company: e.target.value}))} placeholder="Company name" />
                </div>
                <div>
                  <label className={labelClass}>Contact</label>
                  <input className={inputClass} value={newMeeting.contact} onChange={e => setNewMeeting(p => ({...p, contact: e.target.value}))} placeholder="Contact name" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Date</label>
                  <DatePicker value={newMeeting.date} onChange={(v) => setNewMeeting(p => ({...p, date: v}))} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Time</label>
                  <Select value={newMeeting.time} onValueChange={v => setNewMeeting(p => ({...p, time: v}))}>
                    <SelectTrigger className="text-[13px] border-[#2e2e4a] bg-[#242438] text-white"><SelectValue placeholder="Select time" /></SelectTrigger>
                    <SelectContent className="max-h-60 bg-[#242438] border-[#2e2e4a] text-white">
                      {generateTimeOptions().map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <label className={labelClass}>Assigned User</label>
                <Select value={newMeeting.assignedUser} onValueChange={v => setNewMeeting(p => ({...p, assignedUser: v}))}>
                  <SelectTrigger className="text-[13px] border-[#2e2e4a] bg-[#242438] text-white"><SelectValue placeholder="Select user" /></SelectTrigger>
                  <SelectContent className="bg-[#242438] border-[#2e2e4a] text-white">
                    {getAvailableUsers().map(u => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className={labelClass}>Location</label>
                <input className={inputClass} value={newMeeting.location} onChange={e => setNewMeeting(p => ({...p, location: e.target.value}))} placeholder="Meeting location or address" />
              </div>
              <div>
                <label className={labelClass}>Notes</label>
                <textarea className={inputClass} value={newMeeting.notes} onChange={e => setNewMeeting(p => ({...p, notes: e.target.value}))} rows={3} placeholder="Meeting agenda, objectives, etc." />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#2e2e4a]">
              <button onClick={() => setShowMeetingModal(false)} className="px-4 py-2 text-[13px] font-medium text-[#cbd5e1] border border-[#2e2e4a] rounded-lg hover:bg-[#1f1f33]">Cancel</button>
              <button onClick={createMeeting} className="px-4 py-2 text-[13px] font-medium text-[#1a1a2e] bg-[#f59e0b] hover:bg-[#d97706] rounded-lg">Book Meeting</button>
            </div>
          </div>
        </div>
      )}

      {/* ── SCHEDULE MEETING MODAL ── */}
      {showScheduleMeetingModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-[#242438] rounded-xl border border-[#2e2e4a] shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#2e2e4a]">
              <h3 className="text-[15px] font-semibold text-white">Schedule Customer Meeting</h3>
              <button onClick={() => setShowScheduleMeetingModal(false)} className="p-1.5 rounded-lg hover:bg-[#1f1f33] text-[#94a3b8]">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className={labelClass}>Meeting Title</label>
                <input className={inputClass} value={scheduleMeeting.title} onChange={e => setScheduleMeeting(p => ({...p, title: e.target.value}))} placeholder="e.g. Follow-up meeting with customer" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Company</label>
                  <input className={inputClass} value={scheduleMeeting.company} onChange={e => setScheduleMeeting(p => ({...p, company: e.target.value}))} placeholder="Company name" />
                </div>
                <div>
                  <label className={labelClass}>Contact</label>
                  <input className={inputClass} value={scheduleMeeting.contact} onChange={e => setScheduleMeeting(p => ({...p, contact: e.target.value}))} placeholder="Contact name" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Date</label>
                  <DatePicker value={scheduleMeeting.date} onChange={(v) => setScheduleMeeting(p => ({...p, date: v}))} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Time</label>
                  <Select value={scheduleMeeting.time} onValueChange={v => setScheduleMeeting(p => ({...p, time: v}))}>
                    <SelectTrigger className="text-[13px] border-[#2e2e4a] bg-[#242438] text-white"><SelectValue placeholder="Select time" /></SelectTrigger>
                    <SelectContent className="max-h-60 bg-[#242438] border-[#2e2e4a] text-white">
                      {generateTimeOptions().map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {/* FIX 5: real users from contacts API */}
              <div>
                <label className={labelClass}>Assign Users</label>
                <div className="grid grid-cols-2 gap-2 mt-1">
                  {getAvailableUsers().map(user => (
                    <label key={user} className="flex items-center gap-2 cursor-pointer text-[13px]">
                      <input
                        type="checkbox"
                        checked={scheduleMeeting.assignedUsers.includes(user)}
                        onChange={e => {
                          setScheduleMeeting(p => ({
                            ...p,
                            assignedUsers: e.target.checked
                              ? [...p.assignedUsers, user]
                              : p.assignedUsers.filter(u => u !== user)
                          }));
                        }}
                        className="rounded"
                      />
                      <span className="text-[#cbd5e1]">{user}</span>
                    </label>
                  ))}
                  {getAvailableUsers().length === 0 && (
                    <p className="text-[12px] text-[#6b7280] col-span-2">No contacts found — add contacts in the Contacts section first</p>
                  )}
                </div>
              </div>
              {/* FIX 9: free text location input — fake getCustomerLocations() removed */}
              <div>
                <label className={labelClass}>Location</label>
                <input className={inputClass} value={scheduleMeeting.location} onChange={e => setScheduleMeeting(p => ({...p, location: e.target.value}))} placeholder="Enter meeting location or address" />
              </div>
              <div>
                <label className={labelClass}>Notes</label>
                <textarea className={inputClass} value={scheduleMeeting.notes} onChange={e => setScheduleMeeting(p => ({...p, notes: e.target.value}))} rows={3} placeholder="Meeting agenda, objectives, preparation notes..." />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#2e2e4a]">
              <button onClick={() => setShowScheduleMeetingModal(false)} className="px-4 py-2 text-[13px] font-medium text-[#cbd5e1] border border-[#2e2e4a] rounded-lg hover:bg-[#1f1f33]">Cancel</button>
              <button onClick={createScheduledMeeting} className="px-4 py-2 text-[13px] font-medium text-[#1a1a2e] bg-[#f59e0b] hover:bg-[#d97706] rounded-lg">Schedule Meeting</button>
            </div>
          </div>
        </div>
      )}

      {/* ── DELETE CONFIRM MODAL ── */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-[#242438] rounded-xl border border-[#2e2e4a] shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#2e2e4a]">
              <h3 className="text-[15px] font-semibold text-white">Delete Event</h3>
              <button onClick={() => { setShowDeleteConfirm(false); setSendCancellationEmail(true); setNextAction(null); }} className="p-1.5 rounded-lg hover:bg-[#1f1f33] text-[#94a3b8]">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-[13px] text-[#94a3b8]">Are you sure you want to delete this event? This action cannot be undone.</p>
              <div className="bg-[#1f1f33] border border-[#2e2e4a] rounded-lg p-3">
                <p className="text-[13px] font-medium text-[#cbd5e1]">{selectedEvent?.title}</p>
                <p className="text-[12px] text-[#6b7280] mt-0.5">{selectedEvent?.company}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#2e2e4a]">
              <button onClick={() => { setShowDeleteConfirm(false); setSendCancellationEmail(true); setNextAction(null); }} className="px-4 py-2 text-[13px] font-medium text-[#cbd5e1] border border-[#2e2e4a] rounded-lg hover:bg-[#1f1f33]">Cancel</button>
              <button onClick={deleteEvent} className="px-4 py-2 text-[13px] font-medium text-white bg-[#ef4444] hover:bg-[#dc2626] rounded-lg">Delete Event</button>
            </div>
          </div>
        </div>
      )}

      {/* ── EDIT EVENT MODAL ── */}
      {showEditModal && editingEvent && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-[#242438] rounded-xl border border-[#2e2e4a] shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#2e2e4a]">
              <h3 className="text-[15px] font-semibold text-white">{editingEvent._isSchedule ? 'Edit Calendar Entry' : 'Edit Event'}</h3>
              <button onClick={() => { setShowEditModal(false); setEditingEvent(null); }} className="p-1.5 rounded-lg hover:bg-[#1f1f33] text-[#94a3b8]">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className={labelClass}>Event Title *</label>
                <input className={inputClass} value={editingEvent.title} onChange={e => setEditingEvent(p => ({...p, title: e.target.value}))} placeholder="Enter event title" />
              </div>
              {!editingEvent._isSchedule && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelClass}>Company</label>
                    <input className={inputClass} value={editingEvent.company || ''} onChange={e => setEditingEvent(p => ({...p, company: e.target.value}))} placeholder="Company name" />
                  </div>
                  <div>
                    <label className={labelClass}>Contact</label>
                    <input className={inputClass} value={editingEvent.contact || ''} onChange={e => setEditingEvent(p => ({...p, contact: e.target.value}))} placeholder="Contact person" />
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Date *</label>
                  <DatePicker value={editingEvent.date} onChange={(v) => setEditingEvent(p => ({...p, date: v}))} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>Time *</label>
                  <Select value={editingEvent.time} onValueChange={v => setEditingEvent(p => ({...p, time: v}))}>
                    <SelectTrigger className="text-[13px] border-[#2e2e4a] bg-[#242438] text-white"><SelectValue placeholder="Select time" /></SelectTrigger>
                    <SelectContent className="max-h-60 bg-[#242438] border-[#2e2e4a] text-white">
                      {generateTimeOptions().map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {/* FIX 5: real users from contacts API in edit modal */}
              {!editingEvent._isSchedule && (
                <div>
                  <label className={labelClass}>Assign Users</label>
                  <div className="grid grid-cols-2 gap-2 mt-1">
                    {getAvailableUsers().map(user => (
                      <label key={user} className="flex items-center gap-2 cursor-pointer text-[13px]">
                        <input
                          type="checkbox"
                          checked={(editingEvent.assignedUsers || []).includes(user)}
                          onChange={e => {
                            setEditingEvent(p => ({
                              ...p,
                              assignedUsers: e.target.checked
                                ? [...(p.assignedUsers || []), user]
                                : (p.assignedUsers || []).filter(u => u !== user)
                            }));
                          }}
                          className="rounded"
                        />
                        <span className="text-[#cbd5e1]">{user}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {!editingEvent._isSchedule && (
                <div>
                  <label className={labelClass}>Location</label>
                  <input className={inputClass} value={editingEvent.location || ''} onChange={e => setEditingEvent(p => ({...p, location: e.target.value}))} placeholder="Event location" />
                </div>
              )}
              <div>
                <label className={labelClass}>Notes</label>
                <textarea className={inputClass} value={editingEvent.notes || ''} onChange={e => setEditingEvent(p => ({...p, notes: e.target.value}))} rows={3} placeholder="Additional notes" />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#2e2e4a]">
              <button onClick={() => { setShowEditModal(false); setEditingEvent(null); }} className="px-4 py-2 text-[13px] font-medium text-[#cbd5e1] border border-[#2e2e4a] rounded-lg hover:bg-[#1f1f33]">Cancel</button>
              <button onClick={saveEditedEvent} className="px-4 py-2 text-[13px] font-medium text-[#1a1a2e] bg-[#f59e0b] hover:bg-[#d97706] rounded-lg">Save Changes</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
